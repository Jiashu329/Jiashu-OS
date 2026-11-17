import Foundation
import SwiftUI

/// Transport values stay inside typed native feature views. Money encoded as a
/// server string remains a string, preserving its exact decimal representation.
enum NativeJSON: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([NativeJSON])
    case object([String: NativeJSON])

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let array = try? value.decode([NativeJSON].self) { self = .array(array) }
        else { self = .object(try value.decode([String: NativeJSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .string(let item): try value.encode(item)
        case .array(let items): try value.encode(items)
        case .object(let items): try value.encode(items)
        }
    }

    subscript(_ key: String) -> NativeJSON { objectValue[key] ?? .null }
    var stringValue: String? { if case .string(let value) = self { return value }; return nil }
    var doubleValue: Double? { if case .number(let value) = self { return value }; return nil }
    var intValue: Int? {
        guard let value = doubleValue, value.isFinite, value.rounded(.towardZero) == value,
              value >= Double(Int.min), value < Double(Int.max) else { return nil }
        return Int(value)
    }
    var boolValue: Bool? { if case .bool(let value) = self { return value }; return nil }
    var arrayValue: [NativeJSON] { if case .array(let values) = self { return values }; return [] }
    var objectValue: [String: NativeJSON] { if case .object(let values) = self { return values }; return [:] }
    var isNull: Bool { self == .null }
    static func optional(_ value: String?) -> NativeJSON { value.map(NativeJSON.string) ?? .null }
    static func integer(_ value: Int) -> NativeJSON { .number(Double(value)) }
    static func optionalNumber(_ value: Double?) -> NativeJSON { value.map(NativeJSON.number) ?? .null }
    func encodedData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

/// A feature owns one user's visible state. Resetting the account cancels its
/// task and makes late successes and failures incapable of repopulating it.
@MainActor
final class NativeFeatureStore: ObservableObject {
    @Published private(set) var data: NativeJSON = .null
    @Published private(set) var error: String?
    @Published private(set) var busy = false
    private(set) var userID: String
    private var token: String
    private let api: NativeAPI
    private var generation = UUID()
    private var operationID = UUID()
    private var operationTask: Task<NativeJSON, Error>?

    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID
    }

    func reset(token: String, userID: String) {
        operationTask?.cancel(); operationTask = nil
        generation = UUID(); operationID = UUID()
        self.token = token; self.userID = userID
        data = .null; error = nil; busy = false
    }

    func clearError() { error = nil }

    func load(path: String) async {
        _ = await perform(path: path)
    }

    @discardableResult
    func perform(path: String, method: String = "GET", body: NativeJSON? = nil,
                 headers: [String: String] = [:], reloadPath: String? = nil) async -> NativeJSON? {
        let api = api, credential = token
        return await perform {
            let result = try await api.json(path: path, method: method, token: credential, body: body, headers: headers)
            if let reloadPath { return try await api.json(path: reloadPath, token: credential) }
            return result
        }
    }

    @discardableResult
    func perform(_ operation: @escaping @MainActor () async throws -> NativeJSON, publish: Bool = true) async -> NativeJSON? {
        guard !busy else { return nil }
        let owner = userID, epoch = generation, identifier = UUID()
        operationID = identifier; busy = true; error = nil
        let task = Task { try await operation() }
        operationTask = task
        defer {
            if generation == epoch && operationID == identifier && userID == owner {
                busy = false; operationTask = nil
            }
        }
        do {
            let result = try await task.value
            guard generation == epoch && operationID == identifier && userID == owner, !Task.isCancelled else { return nil }
            if publish { data = result }
            return result
        } catch is CancellationError { return nil }
        catch {
            guard generation == epoch && operationID == identifier && userID == owner else { return nil }
            self.error = error.localizedDescription
            return nil
        }
    }
}

enum NativeWorkspaceFormat {
    static func timestamp(_ value: String?) -> String {
        guard let value, let date = NativeDates.parse(value) else { return value ?? "暂无记录" }
        return NativeActionDates.formatted(date, pattern: "yyyy-MM-dd HH:mm")
    }
    static func day(_ value: Date) -> String { NativeActionDates.day(value) }
    static func query(_ values: [String: String]) -> String {
        var parts = URLComponents()
        parts.queryItems = values.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return parts.percentEncodedQuery ?? ""
    }
    static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? ""
    }
}
