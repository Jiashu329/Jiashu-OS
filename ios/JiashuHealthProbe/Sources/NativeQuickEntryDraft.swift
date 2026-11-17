import Foundation
import Combine

/// Strings are preserved exactly, including incomplete input and unknown blank
/// nutrition values. Loading a draft never creates or submits an operation.
struct NativeQuickEntryDraft: Codable, Equatable {
    var isNutrition: Bool
    var metric: String
    var date: Date
    var time: Date
    var value: String
    var note: String
    var foodName: String
    var meal: String
    var portion: String
    var carbs: String
    var protein: String
    var fat: String

    func validateShape() throws {
        guard QuickEntryMetric(rawValue: metric) != nil, QuickEntryMeal(rawValue: meal) != nil else {
            throw NativeWorkspacePersistenceError.corrupted
        }
    }
    func operation(now: Date = Date()) throws -> NativePendingEntry {
        try validateShape()
        if isNutrition {
            return try NativePendingEntry.nutrition(name: foodName, meal: QuickEntryMeal(rawValue: meal)!, portion: portion,
                calories: value, note: note, date: date, now: now, carbs: carbs, protein: protein, fat: fat)
        }
        return try NativePendingEntry.health(metric: QuickEntryMetric(rawValue: metric)!, value: value,
            date: date, time: time, reason: note, capturedAt: now)
    }
}

@MainActor
final class NativeQuickEntryDraftRecovery: ObservableObject {
    @Published private(set) var recovery: NativeQuickEntryDraft?
    @Published private(set) var hasLoaded = false
    private let persistence: NativeWorkspacePersistence
    var canWrite: Bool { hasLoaded && recovery == nil }

    init(userID: String, persistence: NativeWorkspacePersistence? = nil) {
        self.persistence = persistence ?? NativeWorkspacePersistence(userID: userID, scope: "quick-entry.unfinished", maximumBytes: 128 * 1024)
    }
    func read() throws {
        hasLoaded = false
        let saved = try persistence.load(NativeQuickEntryDraft.self)
        try saved?.validateShape()
        recovery = saved
        hasLoaded = true
    }
    func restore() throws -> NativeQuickEntryDraft {
        guard hasLoaded, let saved = recovery else { throw NativeWorkspacePersistenceError.unavailable }
        recovery = nil
        return saved
    }
    func discard() throws {
        try persistence.clear()
        recovery = nil
        hasLoaded = true
    }
    func save(_ draft: NativeQuickEntryDraft) throws {
        guard canWrite else { throw NativeWorkspacePersistenceError.unavailable }
        do { try persistence.save(draft) }
        catch { hasLoaded = false; throw error }
    }
    /// Called only once an immutable pending operation is securely stored, or
    /// after a server acknowledgement. Submitted operation recovery has priority.
    func clearAfterPendingStored() throws { try discard() }
}
