import Foundation
import Security
import SwiftUI

enum NativeNutritionFields {
    static let keys = ["calories", "carbs", "protein", "fat"]
    static func title(_ key: String) -> String {
        ["calories": "热量", "carbs": "碳水化合物", "protein": "蛋白质", "fat": "脂肪"][key] ?? key
    }
    static func source(_ key: String?) -> String {
        ["manual": "手动核对", "label": "包装标签", "catalog": "食物库", "ai": "AI估算", "unknown": "未知"][key ?? "unknown"] ?? "未知"
    }
    static func value(_ value: NativeJSON, unit: String = "") -> String {
        guard let text = value.stringValue ?? value.doubleValue.map({ $0.formatted(.number.precision(.fractionLength(0...1))) }) else { return "未知" }
        return text + (unit.isEmpty ? "" : " " + unit)
    }
    static func nullable(_ text: String) throws -> NativeJSON {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .null }
        guard text.range(of: #"^\d+(?:\.\d)?$"#, options: .regularExpression) != nil,
              let number = Double(text), number.isFinite, number <= 20_000 else {
            throw NativeActionInputError.invalid("营养值需为0–20000之间的数字，最多一位小数；未知时留空。")
        }
        return .string(text)
    }
    static func meal(_ key: String?) -> String {
        ["breakfast": "早餐", "lunch": "午餐", "dinner": "晚餐", "snack": "加餐"][key ?? ""] ?? "待选餐次"
    }
    static func selection(_ snapshot: NativeJSON) -> NativeJSON {
        guard let id = snapshot["id"].stringValue ?? snapshot["foodId"].stringValue,
              let amount = snapshot["amount"].doubleValue, let unit = snapshot["unit"].stringValue else { return .null }
        var fields: [String: NativeJSON] = ["id": .string(id), "amount": .number(amount), "unit": .string(unit)]
        if let release = snapshot["catalogRelease"].stringValue { fields["catalogRelease"] = .string(release) }
        return .object(fields)
    }
}

struct NativeNutritionDraft: Identifiable, Codable, Equatable {
    let id: UUID
    var date: String
    var meal: String
    var name: String
    var portion: String
    var note: String
    var nutrients: [String: String]
    var provenance: [String: NativeJSON]
    var food: NativeJSON
    var warnings: [String]
    var original: NativeJSON

    init(_ raw: NativeJSON = .null, date: String = NativeActionDates.day(Date()), meal: String = "lunch") {
        id = UUID()
        self.date = raw["date"].stringValue ?? date
        self.meal = raw["meal"].stringValue ?? meal
        name = raw["name"].stringValue ?? ""
        portion = raw["portion"].stringValue ?? ""
        note = raw["note"].stringValue ?? ""
        nutrients = Dictionary(uniqueKeysWithValues: NativeNutritionFields.keys.map { key in
            (key, raw[key].stringValue ?? "")
        })
        provenance = raw["provenance"].objectValue
        food = NativeNutritionFields.selection(raw["food"])
        warnings = raw["warnings"].arrayValue.compactMap(\.stringValue)
        original = raw
    }

    mutating func changeIdentity(name: String? = nil, portion: String? = nil) {
        if let name { self.name = name }
        if let portion { self.portion = portion }
        food = .null
        for key in NativeNutritionFields.keys where ["ai", "catalog"].contains(provenance[key]?["source"].stringValue ?? "") {
            nutrients[key] = ""
            provenance[key] = .object(["source": .string("unknown")])
        }
    }

    mutating func setNutrient(_ key: String, text: String) {
        nutrients[key] = text
        var origin = provenance[key]?.objectValue ?? [:]
        origin["source"] = .string(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "unknown" : "manual")
        provenance[key] = .object(origin)
    }

    func payload() throws -> NativeJSON {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, trimmedName.utf16.count <= 100, portion.utf16.count <= 100, note.utf16.count <= 500,
              QuickEntryMeal.allCases.contains(where: { $0.rawValue == meal }),
              let parsed = NativeChartDates.parse(date), NativeActionDates.day(parsed) == date,
              date >= "1970-01-01", date <= NativeActionDates.day(Date()) else {
            throw NativeActionInputError.invalid("请核对食物名称、日期、餐次、份量及备注。")
        }
        var object: [String: NativeJSON] = ["date": .string(date), "meal": .string(meal), "name": .string(trimmedName),
            "portion": .string(portion), "note": .string(note)]
        var origins: [String: NativeJSON] = [:]
        for key in NativeNutritionFields.keys {
            let value = try NativeNutritionFields.nullable(nutrients[key] ?? "")
            object[key] = value
            var origin = provenance[key]?.objectValue ?? [:]
            if value == .null { origin["source"] = .string("unknown") }
            else if origin["source"]?.stringValue == nil { origin["source"] = .string("manual") }
            if origin["source"]?.stringValue == "catalog", food == .null { origin["source"] = .string("manual") }
            origins[key] = .object(origin)
        }
        if food != .null { object["food"] = food }
        object["provenance"] = .object(origins)
        return .object(object)
    }
}

struct NativeNutritionCommand: Codable, Equatable {
    let requestID: String
    let path: String
    let method: String
    let title: String
    let body: NativeJSON
    init(path: String, method: String = "POST", title: String, body: NativeJSON, requestID: UUID = UUID()) {
        self.requestID = requestID.uuidString.lowercased(); self.path = path
        self.method = method; self.title = title; self.body = body
    }
}

private struct NativeNutritionPendingStore {
    let userID: String
    private var persistence: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: userID, scope: "nutrition-pending-command") }
    func load() throws -> NativeNutritionCommand? { try persistence.load(NativeNutritionCommand.self) }
    func save(_ command: NativeNutritionCommand) throws { try persistence.save(command) }
    func clear() throws { try persistence.clear() }
}

@MainActor
final class NativeNutritionContext: ObservableObject {
    let api: NativeAPI; let token: String; let userID: String
    @Published private(set) var pending: NativeNutritionCommand?
    @Published private(set) var busy = false
    @Published private(set) var persistenceReady = false
    @Published var error: String?
    @Published private(set) var changes = 0
    init(api: NativeAPI, token: String, userID: String) { self.api = api; self.token = token; self.userID = userID }
    func restorePending() {
        do { pending = try NativeNutritionPendingStore(userID: userID).load(); persistenceReady = true }
        catch { self.error = error.localizedDescription }
    }
    @discardableResult func write(_ command: NativeNutritionCommand) async -> NativeJSON? {
        guard !busy else { return nil }
        if !persistenceReady { restorePending() }
        guard persistenceReady else { return nil }
        if pending != nil && pending != command { error = "请先在饮食首页核对待确认的原操作。"; return nil }
        let retrying = pending != nil
        busy = true; error = nil
        defer { busy = false }
        do {
            try NativeNutritionPendingStore(userID: userID).save(command); pending = command
            let result = try await api.json(path: command.path, method: command.method, token: token, body: command.body,
                headers: ["Idempotency-Key": command.requestID])
            try NativeNutritionPendingStore(userID: userID).clear(); pending = nil; changes += 1
            return result
        } catch let failure as NativeAPIError {
            if retrying, case .server(let status, _, _, _) = failure, status == 409 {
                do {
                    if let result = try await reconcile(command) {
                        try NativeNutritionPendingStore(userID: userID).clear(); pending = nil; changes += 1
                        return result
                    }
                } catch { self.error = error.localizedDescription + " 原操作仍待核对。"; return nil }
            }
            if case .server(let status, _, _, _) = failure, [400, 404, 409, 413, 415, 422].contains(status) {
                do { try NativeNutritionPendingStore(userID: userID).clear(); pending = nil }
                catch { self.error = error.localizedDescription; return nil }
            }
            error = failure.localizedDescription + (pending == nil ? "" : " 原提交已保留，可在饮食首页继续核对。")
        } catch { self.error = error.localizedDescription + " 原提交已保留，请继续核对同一操作。" }
        return nil
    }
    func retry() async { if let pending { _ = await write(pending) } }

    private func reconcile(_ command: NativeNutritionCommand) async throws -> NativeJSON? {
        guard let expected = command.body["expectedRevision"].intValue else { return nil }
        let response: NativeJSON, actual: NativeJSON, fields: [String]
        if command.path == "health/nutrition/goals", command.method == "PUT" {
            response = try await api.json(path: command.path, token: token); actual = response["goals"]
            fields = NativeNutritionFields.keys
        } else if command.path == "health/nutrition/status", command.method == "PATCH", let day = command.body["date"].stringValue {
            response = try await api.json(path: command.path + "?date=" + day, token: token); actual = response["dayStatus"]
            fields = ["complete", "meals"]
        } else if command.method == "PATCH", command.path.split(separator: "/").count == 3 {
            response = try await api.json(path: command.path, token: token); actual = response["entry"]
            fields = command.body.objectValue.keys.filter { $0 != "expectedRevision" }
        } else { return nil }
        guard let revision = actual["revision"].intValue, revision > expected else { return nil }
        guard fields.allSatisfy({ key in
            if NativeNutritionFields.keys.contains(key), let left = command.body[key].stringValue, let right = actual[key].stringValue {
                return Decimal(string: left) == Decimal(string: right)
            }
            if key == "food" { return NativeNutritionFields.selection(command.body[key]) == NativeNutritionFields.selection(actual[key]) }
            return command.body[key] == actual[key]
        }) else { return nil }
        return response
    }
}

struct NativeNutritionErrorRow: View {
    let text: String?
    var body: some View { if let text { Text(text).foregroundStyle(.red).font(.footnote).textSelection(.enabled) } }
}
