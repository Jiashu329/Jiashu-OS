import Foundation
import XCTest
@testable import JiashuHealthProbe

final class NativeBackupTests: XCTestCase {
    private let timestamp = "2026-11-17T08:00:00.000Z"
    private var single: Data {
        Data(#"{"kind":"jiashu-os-backup","version":2,"exportedAt":"2026-11-17T08:00:00.000Z","tables":{"health_measurements":[{"z":1e-7,"a":"escaped \\\/ \"quote\" \u4f60","amount_minor":"900719925474099312345"}],"health_syncs":[]}}"#.utf8)
    }

    /// These small shape fixtures exercise local file transport only. The CI
    /// Swift→Node contract separately verifies full production table validation
    /// and real server-generated SHA-256 manifests over 20,001 valid records.
    private func group() -> (Data, [NativeBackupFile]) {
        let setID = String(repeating: "a", count: 64)
        let p1 = Data(("{\"kind\":\"jiashu-os-backup-volume\",\"version\":1,\"setId\":\"" + setID
            + "\",\"exportedAt\":\"" + timestamp + "\",\"partIndex\":1,\"totalParts\":2,\"tables\":{\"health_measurements\":[{\"z\":1e-7,\"a\":\"first\\u4f60\"}],\"health_syncs\":[]}}").utf8)
        let p2 = Data(("{\"kind\":\"jiashu-os-backup-volume\",\"version\":1,\"setId\":\"" + setID
            + "\",\"exportedAt\":\"" + timestamp + "\",\"partIndex\":2,\"totalParts\":2,\"tables\":{\"health_measurements\":[],\"health_syncs\":[{\"note\":\"second\\\\value\"}]}}").utf8)
        let descriptor = "[{\"partIndex\":1,\"rowCount\":1,\"byteLength\":\(p1.count),\"sha256\":\"" + setID
            + "\"},{\"partIndex\":2,\"rowCount\":1,\"byteLength\":\(p2.count),\"sha256\":\"" + setID + "\"}]"
        let manifest = Data(("{\"kind\":\"jiashu-os-backup-manifest\",\"version\":1,\"backupVersion\":2,\"setId\":\"" + setID
            + "\",\"exportedAt\":\"" + timestamp + "\",\"totalRows\":2,\"volumes\":" + descriptor + "}").utf8)
        var data = Data("{\"kind\":\"jiashu-os-backup-set\",\"version\":1,\"manifest\":".utf8)
        data.append(manifest); data.append(Data(",\"volumes\":[".utf8)); data.append(p1); data.append(44); data.append(p2); data.append(Data("]}".utf8))
        return (data, [NativeBackupFile(name: "manifest.json", data: manifest), NativeBackupFile(name: "part1.json", data: p1), NativeBackupFile(name: "part2.json", data: p2)])
    }

    func testSingleBackupAndRequestWrappingPreserveRawJSONBytes() throws {
        let files = try NativeBackupCodec.split(single)
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(files[0].data, single)
        XCTAssertEqual(try NativeBackupCodec.assemble(files), single)
        let preview = try NativeBackupCodec.request(action: "preview", backup: single)
        XCTAssertEqual(try NativeBackupCodec.value("backup", in: preview), single)
        let hash = String(repeating: "b", count: 64)
        let restore = try NativeBackupCodec.request(action: "restore", backup: single, previewHash: hash)
        XCTAssertEqual(try NativeBackupCodec.value("backup", in: restore), single)
        XCTAssertEqual(try NativeBackupCodec.object(restore)["previewHash"] as? String, hash)
        XCTAssertEqual(try NativeBackupCodec.inspect(single).rows, 1)
    }

    func testSplitAndUnorderedAssemblyKeepManifestAndEveryVolumeByteForByte() throws {
        let (raw, expectedFiles) = group()
        let split = try NativeBackupCodec.split(raw)
        XCTAssertEqual(split.map(\.data), expectedFiles.map(\.data))
        let assembled = try NativeBackupCodec.assemble(Array(expectedFiles.reversed()))
        XCTAssertEqual(assembled, raw)
        let summary = try NativeBackupCodec.inspect(assembled)
        XCTAssertEqual(summary.format, "volumes")
        XCTAssertEqual(summary.files, 3)
        XCTAssertEqual(summary.rows, 2)
        XCTAssertEqual(try NativeBackupCodec.value("backup", in: NativeBackupCodec.request(action: "preview", backup: assembled)), raw)
    }

    func testMissingDuplicateAndMixedVolumesCannotBeAssembled() throws {
        let (_, files) = group()
        XCTAssertThrowsError(try NativeBackupCodec.assemble([files[0], files[1]]))
        XCTAssertThrowsError(try NativeBackupCodec.assemble([files[0], files[1], files[1]]))
        XCTAssertThrowsError(try NativeBackupCodec.assemble([files[0], files[0], files[1]]))
        XCTAssertThrowsError(try NativeBackupCodec.assemble([files[1], files[2]]))
        let mixed = NativeBackupFile(name: "other.json", data: Data(String(decoding: files[2].data, as: UTF8.self)
            .replacingOccurrences(of: String(repeating: "a", count: 64), with: String(repeating: "c", count: 64)).utf8))
        XCTAssertThrowsError(try NativeBackupCodec.assemble([files[0], files[1], mixed]))
        XCTAssertThrowsError(try NativeBackupCodec.assemble([files[0]]))
    }

    func testMalformedDocumentsAndUnsupportedActionsAreRejected() throws {
        for raw in ["[]", "null", "{}", "{\"kind\":\"other\"}", "{\"kind\":\"jiashu-os-backup\",\"version\":3}", "{\"kind\":"] {
            XCTAssertThrowsError(try NativeBackupCodec.inspect(Data(raw.utf8)))
        }
        XCTAssertThrowsError(try NativeBackupCodec.request(action: "delete", backup: single))
        XCTAssertThrowsError(try NativeBackupCodec.request(action: "restore", backup: single))
        XCTAssertThrowsError(try NativeBackupCodec.request(action: "restore", backup: single, previewHash: String(repeating: "A", count: 64)))
        XCTAssertThrowsError(try NativeBackupCodec.request(action: "preview", backup: single, previewHash: String(repeating: "a", count: 64)))
        XCTAssertThrowsError(try NativeBackupCodec.assemble([]))
        XCTAssertThrowsError(try NativeBackupCodec.assemble(Array(repeating: NativeBackupFile(name: "extra.json", data: single), count: 10)))
    }

    func testFileGroupAndRowLimitsRejectWithoutTruncation() throws {
        XCTAssertThrowsError(try NativeBackupCodec.inspect(Data(repeating: 32, count: NativeBackupCodec.groupLimit + 1)))
        let (_, files) = group()
        let huge = NativeBackupFile(name: "oversize-part.json", data: Data(repeating: 32, count: NativeBackupCodec.fileLimit + 1))
        XCTAssertThrowsError(try NativeBackupCodec.assemble([files[0], huge]))
        let rows = Array(repeating: "{}", count: 20_001).joined(separator: ",")
        let raw = Data(("{\"kind\":\"jiashu-os-backup\",\"version\":2,\"exportedAt\":\"" + timestamp + "\",\"tables\":{\"health_measurements\":[" + rows + "]}}").utf8)
        XCTAssertThrowsError(try NativeBackupCodec.inspect(raw))
        let tooManyRows = Data(String(decoding: group().0, as: UTF8.self).replacingOccurrences(of: "\"totalRows\":2", with: "\"totalRows\":40001").utf8)
        XCTAssertThrowsError(try NativeBackupCodec.inspect(tooManyRows))
    }

    func testRawValueExtractionHandlesEscapedQuotesAndRejectsDuplicateRootKeys() throws {
        let value = Data(#"{"backup":{"z":1e-7,"a":"braces { [ ] } quote \" slash \\\/"},"other":"done"}"#.utf8)
        let extracted = try XCTUnwrap(NativeBackupCodec.value("backup", in: value))
        XCTAssertEqual(String(decoding: extracted, as: UTF8.self), #"{"z":1e-7,"a":"braces { [ ] } quote \" slash \\\/"}"#)
        XCTAssertThrowsError(try NativeBackupCodec.value("backup", in: Data(#"{"backup":{},"backup":{}}"#.utf8)))
    }
}
