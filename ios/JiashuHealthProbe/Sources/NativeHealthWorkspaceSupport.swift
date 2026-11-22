import Foundation
import Security
import SwiftUI
import UniformTypeIdentifiers

enum NativeHealthWorkspaceError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}

struct NativeHealthWorkspaceRange: Equatable, Codable {
    let from: String
    let to: String
    let days: Int

    init(from: Date, to: Date, now: Date = Date()) throws {
        let calendar = NativeActionDates.calendar
        let first = calendar.startOfDay(for: from)
        let last = calendar.startOfDay(for: to)
        let count = (calendar.dateComponents([.day], from: first, to: last).day ?? -1) + 1
        guard (1...360).contains(count), last <= calendar.startOfDay(for: now),
              NativeActionDates.day(first) >= "1970-01-01", NativeActionDates.day(last) <= "2100-12-31" else {
            throw NativeHealthWorkspaceError.invalid("请选择截至今天、包含起止两日且不超过360天的有效日期范围。")
        }
        self.from = NativeActionDates.day(first); self.to = NativeActionDates.day(last); self.days = count
    }
    var query: [URLQueryItem] { [URLQueryItem(name: "from", value: from), URLQueryItem(name: "to", value: to)] }
    var label: String { from + " — " + to }
}

enum NativeHealthWorkspaceFormat {
    static let metricKeys = ["weight", "lean_body_mass", "steps", "active_energy", "sleep"]
    static func metric(_ key: String) -> String {
        ["weight":"体重", "lean_body_mass":"去脂体重", "steps":"步数", "active_energy":"活动能量", "sleep":"睡眠", "body_fat":"估算体脂率",
         "heart_rate":"日均心率", "resting_heart_rate":"静息心率", "oxygen_saturation":"血氧"][key] ?? key
    }
    static func unit(_ key: String) -> String {
        ["weight":"kg", "lean_body_mass":"kg", "steps":"步", "active_energy":"千卡", "sleep":"小时", "body_fat":"%",
         "heart_rate":"次/分", "resting_heart_rate":"次/分", "oxygen_saturation":"%"][key] ?? ""
    }
    static func number(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "未知" }
        return value.formatted(.number.precision(.fractionLength(0...2)))
    }
    static func text(_ value: NativeJSON) -> String { value.stringValue ?? number(value.doubleValue) }
    static func path(_ path: String, query: [URLQueryItem]) -> String {
        var parts = URLComponents(); parts.path = path; parts.queryItems = query
        return parts.string ?? path
    }
    static func encodedSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }
    static func clock(_ value: String?) -> String {
        guard let value, let date = NativeDates.parse(value) else { return "未提供" }
        return NativeActionDates.formatted(date, pattern: "HH:mm")
    }
    static func date(_ value: String) -> Date? {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = NativeActionDates.calendar; formatter.timeZone = NativeActionDates.timeZone
        formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard let date = formatter.date(from: value), NativeActionDates.day(date) == value else { return nil }; return date
    }
    static func definiteRejection(_ error: Error) -> Bool {
        if case NativeAPIError.server(let status, _, _, _) = error { return [400, 403, 404, 409, 413, 415, 422].contains(status) }
        return false
    }
}

/// The original operation is frozen before its first request. The Keychain key
/// includes both owner and feature, and never contains an access token.
struct NativeHealthWorkspaceMutation: Codable, Equatable {
    let id: String
    let path: String
    let method: String
    let body: NativeJSON
    let headers: [String: String]
    let label: String

    init(path: String, method: String, body: NativeJSON, headers: [String:String] = [:], label: String, id: UUID = UUID()) {
        self.id = id.uuidString.lowercased(); self.path = path; self.method = method; self.body = body
        self.headers = headers; self.label = label
    }
    var requestHeaders: [String:String] {
        var result = headers; result["Idempotency-Key"] = id; return result
    }
    func send(api: NativeAPI, token: String) async throws -> NativeJSON {
        try await api.json(path: path, method: method, token: token, body: body, headers: requestHeaders)
    }
}

struct NativeHealthWorkspaceMutationStore {
    let userID: String
    let scope: String
    private var query: [String:Any] {
        [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:"com.jiashu.healthprobe.health-workspace.v1",
         kSecAttrAccount as String:userID + ":" + scope]
    }
    func load() throws -> NativeHealthWorkspaceMutation? {
        var search = query; search[kSecReturnData as String] = true; search[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(search as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw NativeActionInputError.keychain(status) }
        return try JSONDecoder().decode(NativeHealthWorkspaceMutation.self, from: data)
    }
    func save(_ operation: NativeHealthWorkspaceMutation) throws {
        let data = try JSONEncoder().encode(operation)
        let fields: [String:Any] = [kSecValueData as String:data, kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, fields as CFDictionary)
        if status == errSecItemNotFound {
            var addition = query; fields.forEach { addition[$0.key] = $0.value }; status = SecItemAdd(addition as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NativeActionInputError.keychain(status) }
    }
    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeActionInputError.keychain(status) }
    }
}

struct NativeHealthWorkspaceFormDraft: Codable, Equatable {
    var fields: [String:String]
    var dates: [String:Date]
    var snapshot: NativeJSON
}

struct NativeHealthJSONDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }; self.data = data
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

struct NativeHealthWorkspaceMessage: View {
    let message: String?
    var body: some View {
        if let message { Section { Text(message).foregroundStyle(.secondary).textSelection(.enabled) } }
    }
}
