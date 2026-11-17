import Foundation

struct NativeBackupFile: Equatable, Sendable {
    let name: String
    let data: Data
}
struct NativeBackupSummary: Equatable, Sendable {
    let format: String
    let exportedAt: String
    let rows: Int
    let files: Int
}

/// Backup volume hashes sign JSON property order, not a sorted re-encoding.
/// Keep original value bytes through file sharing, selection and HTTP wrapping.
enum NativeBackupCodec {
    static let groupLimit = 16 * 1024 * 1024 + 128 * 1024
    static let fileLimit = 8 * 1024 * 1024

    static func split(_ data: Data) throws -> [NativeBackupFile] {
        let info = try inspect(data)
        if info.format == "single" { return [NativeBackupFile(name: "jiashu-backup-" + dateLabel(info.exportedAt) + ".json", data: data)] }
        let slices = try RawBackupJSON.object(data)
        guard let manifest = slices["manifest"], let list = slices["volumes"] else { throw NativeBackupError.invalid }
        let volumes = try RawBackupJSON.array(list)
        guard !volumes.isEmpty, volumes.count <= 8 else { throw NativeBackupError.invalid }
        let prefix = "jiashu-backup-" + dateLabel(info.exportedAt)
        return [NativeBackupFile(name: prefix + "-manifest.json", data: manifest)] + volumes.enumerated().map {
            NativeBackupFile(name: prefix + "-part-" + String($0.offset + 1) + ".json", data: $0.element)
        }
    }

    static func assemble(_ files: [NativeBackupFile]) throws -> Data {
        guard !files.isEmpty, files.count <= 9 else { throw NativeBackupError.invalid }
        guard files.reduce(0, { $0 + $1.data.count }) <= groupLimit else { throw NativeBackupError.tooLarge }
        if files.count == 1 {
            _ = try inspect(files[0].data)
            return files[0].data
        }
        var manifest: Data?
        var volumes: [(Int, Data)] = []
        var indices = Set<Int>()
        for file in files {
            guard file.data.count <= fileLimit else { throw NativeBackupError.tooLarge }
            let value = try object(file.data)
            switch value["kind"] as? String {
            case "jiashu-os-backup-manifest":
                guard manifest == nil else { throw NativeBackupError.invalid }
                manifest = file.data
            case "jiashu-os-backup-volume":
                guard let index = value["partIndex"] as? Int, (1...8).contains(index), indices.insert(index).inserted else { throw NativeBackupError.invalid }
                volumes.append((index, file.data))
            default: throw NativeBackupError.invalid
            }
        }
        guard let manifest, !volumes.isEmpty else { throw NativeBackupError.missingVolumes }
        let metadata = try object(manifest)
        guard let descriptions = metadata["volumes"] as? [[String: Any]], descriptions.count == volumes.count,
              indices == Set(1...volumes.count) else { throw NativeBackupError.missingVolumes }
        let setID = metadata["setId"] as? String
        for (_, data) in volumes {
            let volume = try object(data)
            guard volume["setId"] as? String == setID, volume["exportedAt"] as? String == metadata["exportedAt"] as? String,
                  volume["totalParts"] as? Int == volumes.count else { throw NativeBackupError.mixedVolumes }
        }
        var result = Data("{\"kind\":\"jiashu-os-backup-set\",\"version\":1,\"manifest\":".utf8)
        result.append(manifest); result.append(Data(",\"volumes\":[".utf8))
        for (index, value) in volumes.sorted(by: { $0.0 < $1.0 }).enumerated() {
            if index > 0 { result.append(44) }
            result.append(value.1)
        }
        result.append(Data("]}".utf8)); _ = try inspect(result)
        return result
    }

    static func inspect(_ data: Data) throws -> NativeBackupSummary {
        guard data.count <= groupLimit else { throw NativeBackupError.tooLarge }
        let value = try object(data)
        if value["kind"] as? String == "jiashu-os-backup-set" {
            guard value["version"] as? Int == 1, let manifest = value["manifest"] as? [String: Any],
                  let volumes = value["volumes"] as? [[String: Any]], !volumes.isEmpty, volumes.count <= 8,
                  manifest["kind"] as? String == "jiashu-os-backup-manifest",
                  let descriptions = manifest["volumes"] as? [[String: Any]], descriptions.count == volumes.count,
                  let date = manifest["exportedAt"] as? String, let rows = manifest["totalRows"] as? Int,
                  (0...40_000).contains(rows) else { throw NativeBackupError.invalid }
            return NativeBackupSummary(format: "volumes", exportedAt: date, rows: rows, files: volumes.count + 1)
        }
        guard data.count <= fileLimit, value["kind"] as? String == "jiashu-os-backup",
              let version = value["version"] as? Int, [1, 2].contains(version),
              let date = value["exportedAt"] as? String, let tables = value["tables"] as? [String: Any],
              tables.values.allSatisfy({ $0 is [Any] }) else { throw NativeBackupError.invalid }
        let rows = tables.values.reduce(0) { $0 + (($1 as? [Any])?.count ?? 0) }
        guard rows <= 20_000 else { throw NativeBackupError.tooLarge }
        return NativeBackupSummary(format: "single", exportedAt: date, rows: rows, files: 1)
    }

    static func request(action: String, backup: Data, previewHash: String? = nil) throws -> Data {
        _ = try inspect(backup)
        guard ["preview", "restore"].contains(action) else { throw NativeBackupError.invalid }
        if action == "restore" {
            guard let previewHash, previewHash.count == 64, previewHash.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw NativeBackupError.previewRequired }
        } else if previewHash != nil { throw NativeBackupError.invalid }
        var result = Data(("{\"action\":\"" + action + "\",\"backup\":").utf8)
        result.append(backup)
        if let previewHash { result.append(Data((",\"previewHash\":\"" + previewHash + "\"").utf8)) }
        result.append(125)
        guard result.count <= groupLimit else { throw NativeBackupError.tooLarge }
        return result
    }

    static func value(_ key: String, in data: Data) throws -> Data? { try RawBackupJSON.object(data)[key] }
    private static func dateLabel(_ text: String) -> String {
        let value = String(text.prefix(10))
        return value.count == 10 && value.allSatisfy({ "0123456789-".contains($0) }) ? value : "export"
    }
    static func object(_ data: Data) throws -> [String: Any] {
        do {
            guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeBackupError.invalid }
            return value
        } catch { throw NativeBackupError.invalid }
    }
}

enum NativeBackupError: LocalizedError {
    case invalid, tooLarge, missingVolumes, mixedVolumes, previewRequired
    var errorDescription: String? {
        switch self {
        case .invalid: return "请选择完整的 Jiashu OS 备份 JSON；文件未提交。"
        case .tooLarge: return "单文件最多 8 MiB、20,000 行；完整分卷组最多 16 MiB、40,000 行。"
        case .missingVolumes: return "请选择清单和全部分卷，不能缺卷或重复选择。"
        case .mixedVolumes: return "这些分卷不属于同一次备份，请重新选择。"
        case .previewRequired: return "请先核对服务器恢复预览，再确认恢复。"
        }
    }
}

private struct RawBackupJSON {
    let bytes: [UInt8]
    var index = 0
    mutating func whitespace() { while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 } }
    mutating func take(_ byte: UInt8) throws { whitespace(); guard index < bytes.count, bytes[index] == byte else { throw NativeBackupError.invalid }; index += 1 }
    mutating func string() throws -> Range<Int> {
        whitespace(); let start = index; try take(34)
        while index < bytes.count {
            let value = bytes[index]; index += 1
            if value == 34 { return start..<index }
            if value == 92 { guard index < bytes.count else { throw NativeBackupError.invalid }; index += 1 }
        }
        throw NativeBackupError.invalid
    }
    mutating func value(depth: Int = 0) throws -> Range<Int> {
        guard depth < 64 else { throw NativeBackupError.invalid }
        whitespace(); let start = index
        guard index < bytes.count else { throw NativeBackupError.invalid }
        if bytes[index] == 34 { return try string() }
        if bytes[index] == 123 || bytes[index] == 91 {
            let open = bytes[index], close: UInt8 = open == 123 ? 125 : 93
            index += 1; whitespace()
            if index < bytes.count && bytes[index] == close { index += 1; return start..<index }
            while true {
                if open == 123 { _ = try string(); try take(58) }
                _ = try value(depth: depth + 1); whitespace()
                guard index < bytes.count else { throw NativeBackupError.invalid }
                if bytes[index] == close { index += 1; return start..<index }
                try take(44)
            }
        }
        while index < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[index]) { index += 1 }
        guard index > start else { throw NativeBackupError.invalid }
        return start..<index
    }
    static func object(_ data: Data) throws -> [String: Data] {
        _ = try NativeBackupCodec.object(data)
        var parser = RawBackupJSON(bytes: Array(data)); try parser.take(123); parser.whitespace()
        var result: [String: Data] = [:]
        if parser.index < parser.bytes.count && parser.bytes[parser.index] == 125 { return result }
        while true {
            let keyRange = try parser.string()
            let key = try JSONDecoder().decode(String.self, from: Data(parser.bytes[keyRange]))
            guard result[key] == nil else { throw NativeBackupError.invalid }
            try parser.take(58); let range = try parser.value()
            result[key] = Data(parser.bytes[range]); parser.whitespace()
            guard parser.index < parser.bytes.count else { throw NativeBackupError.invalid }
            if parser.bytes[parser.index] == 125 { return result }
            try parser.take(44)
        }
    }
    static func array(_ data: Data) throws -> [Data] {
        guard (try JSONSerialization.jsonObject(with: data)) is [Any] else { throw NativeBackupError.invalid }
        var parser = RawBackupJSON(bytes: Array(data)); try parser.take(91); parser.whitespace()
        var result: [Data] = []
        if parser.index < parser.bytes.count && parser.bytes[parser.index] == 93 { return result }
        while true {
            let range = try parser.value(); result.append(Data(parser.bytes[range])); parser.whitespace()
            guard parser.index < parser.bytes.count else { throw NativeBackupError.invalid }
            if parser.bytes[parser.index] == 93 { return result }
            try parser.take(44)
        }
    }
}
