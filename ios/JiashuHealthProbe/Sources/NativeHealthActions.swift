import Foundation
import Security

enum QuickEntryMetric: String, CaseIterable, Identifiable {
    case weight, leanBodyMass = "lean_body_mass", steps, activeEnergy = "active_energy", sleep
    var id: String { rawValue }
    var title: String {
        switch self {
        case .weight: return "体重"
        case .leanBodyMass: return "去脂体重"
        case .steps: return "步数"
        case .activeEnergy: return "活动能量"
        case .sleep: return "睡眠时长"
        }
    }
    var unit: String {
        switch self {
        case .weight, .leanBodyMass: return "kg"
        case .steps: return "步"
        case .activeEnergy: return "千卡"
        case .sleep: return "小时"
        }
    }
    var isSample: Bool { self == .weight || self == .leanBodyMass }
    var acceptedRange: ClosedRange<Double> {
        switch self {
        case .weight: return 10...600
        case .leanBodyMass: return 1...600
        case .steps: return 0...200_000
        case .activeEnergy: return 0...20_000
        case .sleep: return 0...24
        }
    }
}

enum QuickEntryMeal: String, CaseIterable, Identifiable {
    case breakfast, lunch, dinner, snack
    var id: String { rawValue }
    var title: String {
        switch self {
        case .breakfast: return "早餐"
        case .lunch: return "午餐"
        case .dinner: return "晚餐"
        case .snack: return "加餐"
        }
    }
}

enum NativeActionInputError: LocalizedError {
    case invalid(String)
    case keychain(OSStatus)
    var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .keychain: return "暂时无法安全保存本次操作，请解锁手机后重试。"
        }
    }
}

enum NativeActionDates {
    static let timeZone = TimeZone(identifier: "Asia/Shanghai")!
    static var calendar: Calendar {
        var result = Calendar(identifier: .gregorian)
        result.timeZone = timeZone
        result.firstWeekday = 2
        return result
    }
    static func day(_ date: Date) -> String { formatted(date, pattern: "yyyy-MM-dd") }
    static func time(_ date: Date) -> String { formatted(date, pattern: "HH:mm:ss") }
    static func formatted(_ date: Date, pattern: String) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }
    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
    static func monday(_ date: Date) -> Date {
        let start = calendar.startOfDay(for: date)
        let offset = (calendar.component(.weekday, from: start) + 5) % 7
        return calendar.date(byAdding: .day, value: -offset, to: start)!
    }
}

struct NativePendingEntry: Codable, Equatable {
    let requestID: String
    let path: String
    let label: String
    let body: Data

    static func health(metric: QuickEntryMetric, value: String, date: Date, time: Date,
                       reason: String, capturedAt: Date = Date(), requestID: UUID = UUID()) throws -> NativePendingEntry {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.range(of: #"^\d+(?:\.\d+)?$"#, options: .regularExpression) != nil,
              let number = Double(trimmed), number.isFinite, metric.acceptedRange.contains(number),
              metric != .steps || number.rounded() == number else {
            throw NativeActionInputError.invalid("请填写有效的\(metric.title)数值，单位为\(metric.unit)。")
        }
        let day = NativeActionDates.day(date)
        guard day <= NativeActionDates.day(capturedAt), day >= "1970-01-01", reason.count <= 500 else {
            throw NativeActionInputError.invalid("请核对记录日期和说明。")
        }
        var body: [String: Any] = ["metric": metric.rawValue, "value": number, "date": day,
                                   "capturedAt": NativeActionDates.timestamp(capturedAt), "reason": reason]
        if metric.isSample {
            let timeString = NativeActionDates.time(time)
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.calendar = NativeActionDates.calendar
            formatter.timeZone = NativeActionDates.timeZone
            formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
            guard let measured = formatter.date(from: day + " " + timeString), measured <= capturedAt else {
                throw NativeActionInputError.invalid("测量时间不能晚于现在。")
            }
            body["time"] = timeString
        }
        return NativePendingEntry(requestID: requestID.uuidString.lowercased(), path: "health/records",
                                  label: metric.title + " · " + day,
                                  body: try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]))
    }

    static func nutrition(name: String, meal: QuickEntryMeal, portion: String, calories: String,
                          note: String, date: Date, now: Date = Date(), requestID: UUID = UUID(),
                          carbs: String = "", protein: String = "", fat: String = "") throws -> NativePendingEntry {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 100, portion.count <= 100, note.count <= 500,
              NativeActionDates.day(date) <= NativeActionDates.day(now), NativeActionDates.day(date) >= "1970-01-01" else {
            throw NativeActionInputError.invalid("请填写食物名称并核对日期，名称最多100字，备注最多500字。")
        }
        var body: [String: Any] = ["date": NativeActionDates.day(date), "meal": meal.rawValue,
                                   "name": name, "portion": portion, "note": note]
        var provenance: [String: Any] = [:]
        for (key, supplied) in [("calories", calories), ("carbs", carbs), ("protein", protein), ("fat", fat)] {
            let text = supplied.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                guard text.range(of: #"^\d+(?:\.\d)?$"#, options: .regularExpression) != nil,
                      let value = Double(text), value.isFinite, value <= 20_000 else {
                    throw NativeActionInputError.invalid("营养值请填写0–20000之间的数字，最多一位小数；未知时留空。")
                }
            }
            body[key] = text.isEmpty ? NSNull() : text as Any
            provenance[key] = ["source": text.isEmpty ? "unknown" : "manual"]
        }
        body["provenance"] = provenance
        return NativePendingEntry(requestID: requestID.uuidString.lowercased(), path: "health/nutrition",
                                  label: meal.title + " · " + name,
                                  body: try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]))
    }
}

/// Stores only the original submitted operation, separately from login credentials.
/// The owner key prevents a different signed-in account from recovering this body.
struct NativePendingEntryStore {
    let userID: String
    private let service = "com.jiashu.healthprobe.pending-entry.v1"
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: userID]
    }
    func load() throws -> NativePendingEntry? {
        var search = query
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw NativeActionInputError.keychain(status) }
        return try JSONDecoder().decode(NativePendingEntry.self, from: data)
    }
    func save(_ entry: NativePendingEntry) throws {
        let data = try JSONEncoder().encode(entry)
        let changes: [String: Any] = [kSecValueData as String: data,
                                      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            var addition = query
            changes.forEach { addition[$0.key] = $0.value }
            status = SecItemAdd(addition as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NativeActionInputError.keychain(status) }
    }
    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeActionInputError.keychain(status) }
    }
}

struct NativeEntryReceipt: Decodable { let replayed: Bool? }

struct NativeWeeklyDetails: Decodable {
    struct Metric: Decodable, Identifiable {
        let metric: String
        let label: String
        let unit: String
        let currentAverage: Double?
        let previousAverage: Double?
        let currentRecordedDays: Int
        let previousRecordedDays: Int
        var id: String { metric }
    }
    struct Focus: Decodable {
        struct Item: Decodable, Identifiable {
            let id: String
            let title: String
            let evidence: String
            let interpretation: String
        }
        struct Suggestion: Decodable { let text: String; let label: String }
        let headline: String
        let summary: String
        let coverageNote: String
        let primary: Item?
        let secondary: [Item]
        let suggestedAction: Suggestion?
    }
    let weekStart: String
    let cutoffDay: String
    let isCurrent: Bool
    let metrics: [Metric]
    let focus: Focus?
}

enum NativeWeeklyActionStatus: String, Codable, CaseIterable, Identifiable {
    case planned, completed, notCompleted = "not_completed"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .planned: return "计划中"
        case .completed: return "已完成"
        case .notCompleted: return "未完成"
        }
    }
}

struct NativeWeeklyActionEntry: Codable {
    let weekStart: String
    let text: String
    let status: NativeWeeklyActionStatus
    let feedback: String
    let revision: Int
}
struct NativeWeeklyActionEnvelope: Decodable {
    let action: NativeWeeklyActionEntry?
}

/// Captures both the execution week and its revision when editing starts.
/// Submission and retries use this snapshot even if the calendar week changes.
struct NativeWeeklyActionCommand: Encodable, Equatable {
    let weekStart: String
    let text: String
    let status: NativeWeeklyActionStatus
    let feedback: String
    let expectedRevision: Int

    func encodedBody() throws -> Data {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 200, feedback.count <= 500 else {
            throw NativeActionInputError.invalid("请填写一项200字以内的行动，反馈最多500字。")
        }
        let object: [String: Any] = ["weekStart": weekStart, "text": trimmed,
            "status": status.rawValue, "feedback": feedback, "expectedRevision": expectedRevision]
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}

struct NativeNutritionDay: Decodable {
    struct Entry: Decodable, Identifiable {
        let id: String
        let meal: String
        let name: String
        let portion: String
        let note: String
        let calories: String?
        let carbs: String?
        let protein: String?
        let fat: String?
        let deleted: Bool
    }
    struct Nutrient: Decodable {
        let total: String?
        let knownCount: Int
        let unknownCount: Int
    }
    struct Summary: Decodable {
        let entryCount: Int
        let knownCount: Int
        let unknownCount: Int
        let knownCalories: String?
        let nutrients: [String: Nutrient]
    }
    struct DayStatus: Decodable {
        let complete: Bool
        let meals: [String: String]
    }
    let date: String
    let entries: [Entry]
    let summary: Summary
    let dayStatus: DayStatus
}

extension NativeAPI {
    func nutritionDay(token: String, date: String) async throws -> NativeNutritionDay {
        try await request(path: "health/nutrition?date=" + date, token: token)
    }
    func saveQuickEntry(token: String, entry: NativePendingEntry) async throws -> NativeEntryReceipt {
        try await request(path: entry.path, method: "POST", token: token, body: entry.body,
                          headers: ["Idempotency-Key": entry.requestID])
    }
    func weeklyDetails(token: String, week: String) async throws -> NativeWeeklyDetails {
        try await request(path: "health/review?week=" + week, token: token)
    }
    func weeklyAction(token: String, week: String) async throws -> NativeWeeklyActionEntry? {
        let response: NativeWeeklyActionEnvelope = try await request(path: "health/actions?week=" + week, token: token)
        return response.action
    }
    func saveWeeklyAction(token: String, week: String, text: String, status: NativeWeeklyActionStatus,
                          feedback: String, expectedRevision: Int) async throws -> NativeWeeklyActionEntry? {
        try await saveWeeklyAction(token: token, command: NativeWeeklyActionCommand(weekStart: week, text: text,
            status: status, feedback: feedback, expectedRevision: expectedRevision))
    }
    func saveWeeklyAction(token: String, command: NativeWeeklyActionCommand) async throws -> NativeWeeklyActionEntry? {
        let body = try command.encodedBody()
        let result: NativeWeeklyActionEnvelope = try await request(path: "health/actions", method: "PUT", token: token, body: body)
        return result.action
    }
}
