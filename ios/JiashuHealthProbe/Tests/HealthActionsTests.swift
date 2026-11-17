import XCTest
@testable import JiashuHealthProbe

final class HealthActionsTests: XCTestCase {
    private func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }
    private func object(_ operation: NativePendingEntry) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: operation.body) as? [String: Any])
    }

    func testNutritionDistinguishesUnknownFromConfirmedZero() throws {
        let now = date("2026-11-16T08:00:00Z")
        let missing = try NativePendingEntry.nutrition(name: "米饭", meal: .lunch, portion: "一碗", calories: "", note: "", date: now, now: now)
        let zero = try NativePendingEntry.nutrition(name: "水", meal: .lunch, portion: "一杯", calories: "0", note: "", date: now, now: now)
        XCTAssertTrue(try object(missing)["calories"] is NSNull)
        XCTAssertEqual(try object(zero)["calories"] as? String, "0")
        XCTAssertEqual(missing.path, "health/nutrition")
    }

    func testNutritionRejectsExcessivePrecisionAndFutureDay() throws {
        let now = date("2026-11-16T08:00:00Z")
        XCTAssertThrowsError(try NativePendingEntry.nutrition(name: "米饭", meal: .lunch, portion: "", calories: "12.34", note: "", date: now, now: now))
        XCTAssertThrowsError(try NativePendingEntry.nutrition(name: "米饭", meal: .lunch, portion: "", calories: "12", note: "", date: date("2026-11-17T08:00:00Z"), now: now))
    }

    func testDailyHealthCreateOmitsSampleTimeAndKeepsRealZero() throws {
        let now = date("2026-11-16T08:00:00Z")
        let operation = try NativePendingEntry.health(metric: .steps, value: "0", date: now, time: now, reason: "核对", capturedAt: now)
        let data = try object(operation)
        XCTAssertEqual(data["metric"] as? String, "steps")
        XCTAssertEqual(data["value"] as? Double, 0)
        XCTAssertEqual(data["date"] as? String, "2026-11-16")
        XCTAssertNil(data["time"])
        XCTAssertThrowsError(try NativePendingEntry.health(metric: .steps, value: "1.2", date: now, time: now, reason: "", capturedAt: now))
    }

    func testWeightCreateUsesShanghaiMeasurementTime() throws {
        let now = date("2026-11-16T16:30:00Z")
        let operation = try NativePendingEntry.health(metric: .weight, value: "70.25", date: now, time: now, reason: "", capturedAt: now)
        let data = try object(operation)
        XCTAssertEqual(data["date"] as? String, "2026-11-17")
        XCTAssertEqual(data["time"] as? String, "00:30:00")
        XCTAssertThrowsError(try NativePendingEntry.health(metric: .weight, value: "70", date: now, time: now.addingTimeInterval(60), reason: "", capturedAt: now))
    }

    func testPendingEntryRoundTripFreezesBodyAndRequestID() throws {
        let now = date("2026-11-16T08:00:00Z")
        let id = UUID(uuidString: "e9dca4ad-af21-45e7-8d12-b008dcc53761")!
        let original = try NativePendingEntry.health(metric: .sleep, value: "7.5", date: now, time: now, reason: "", capturedAt: now, requestID: id)
        let restored = try JSONDecoder().decode(NativePendingEntry.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(restored, original)
        XCTAssertEqual(restored.requestID, "e9dca4ad-af21-45e7-8d12-b008dcc53761")
        XCTAssertEqual(try object(restored)["capturedAt"] as? String, "2026-11-16T08:00:00.000Z")
    }

    func testReviewMissingAverageIsNotDecodedAsZero() throws {
        let json = #"{"weekStart":"2026-11-16","cutoffDay":"2026-11-16","isCurrent":true,"metrics":[{"metric":"steps","label":"步数","unit":"步","currentAverage":null,"previousAverage":0,"currentRecordedDays":0,"previousRecordedDays":1}]}"#
        let review = try JSONDecoder().decode(NativeWeeklyDetails.self, from: Data(json.utf8))
        XCTAssertNil(review.metrics[0].currentAverage)
        XCTAssertEqual(review.metrics[0].previousAverage, 0)
        XCTAssertEqual(review.metrics[0].currentRecordedDays, 0)
    }

    func testNutritionDayDecodesUnknownMacrosAndConfirmedZero() throws {
        let json = #"{"date":"2026-11-16","entries":[{"id":"meal-1","meal":"lunch","name":"食物","portion":"一份","note":"","calories":"0.0","carbs":null,"protein":"2.0","fat":null,"deleted":false}],"summary":{"entryCount":1,"knownCount":1,"unknownCount":0,"knownCalories":"0.0","nutrients":{"calories":{"total":"0.0","knownCount":1,"unknownCount":0},"carbs":{"total":null,"knownCount":0,"unknownCount":1},"protein":{"total":"2.0","knownCount":1,"unknownCount":0},"fat":{"total":null,"knownCount":0,"unknownCount":1}}},"dayStatus":{"complete":false,"meals":{"breakfast":"unrecorded","lunch":"recorded","dinner":"unrecorded","snack":"unrecorded"}}}"#
        let day = try JSONDecoder().decode(NativeNutritionDay.self, from: Data(json.utf8))
        XCTAssertEqual(day.entries[0].calories, "0.0")
        XCTAssertNil(day.entries[0].carbs)
        XCTAssertEqual(day.summary.nutrients["carbs"]?.unknownCount, 1)
        XCTAssertNil(day.summary.nutrients["carbs"]?.total)
        XCTAssertFalse(day.dayStatus.complete)
    }

    func testQuickNutritionRetainsEachNutrientsProvenance() throws {
        let now = date("2026-11-16T08:00:00Z")
        let entry = try NativePendingEntry.nutrition(name: "食物", meal: .lunch, portion: "", calories: "", note: "", date: now, now: now, carbs: "0", protein: "12.5")
        let data = try object(entry)
        XCTAssertTrue(data["calories"] is NSNull)
        XCTAssertEqual(data["carbs"] as? String, "0")
        XCTAssertEqual(data["protein"] as? String, "12.5")
        XCTAssertTrue(data["fat"] is NSNull)
        let origins = try XCTUnwrap(data["provenance"] as? [String: [String: String]])
        XCTAssertEqual(origins["carbs"]?["source"], "manual")
        XCTAssertEqual(origins["fat"]?["source"], "unknown")
    }

    func testSundayActionSaveAndRetryStayBoundToLoadedWeekAfterMonday() throws {
        let sunday = date("2026-11-22T15:59:00Z")
        let monday = date("2026-11-22T16:01:00Z")
        let loadedWeek = NativeActionDates.day(NativeActionDates.monday(sunday))
        let currentWeek = NativeActionDates.day(NativeActionDates.monday(monday))
        XCTAssertNotEqual(loadedWeek, currentWeek)
        let pending = NativeWeeklyActionCommand(weekStart: loadedWeek, text: "饭后走动三次", status: .completed,
            feedback: "已完成", expectedRevision: 4)
        // This is the encoder used by the actual save API, not a separate test payload.
        let firstSubmission = try pending.encodedBody()
        let retry = try pending.encodedBody()
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: retry) as? [String: Any])
        XCTAssertEqual(payload["weekStart"] as? String, "2026-11-16")
        XCTAssertNotEqual(payload["weekStart"] as? String, currentWeek)
        XCTAssertEqual(payload["expectedRevision"] as? Int, 4)
        XCTAssertEqual(firstSubmission, retry)
    }
    private func unfinishedDraft(now: Date, note: String = "合成说明") -> NativeQuickEntryDraft {
        NativeQuickEntryDraft(isNutrition: true, metric: "lean_body_mass", date: now, time: now,
            value: "", note: note, foodName: "米饭", meal: "dinner", portion: "半碗", carbs: "0", protein: "12.5", fat: "")
    }

    func testUnfinishedQuickEntryPreservesAllFieldsAndUnknownVersusZero() throws {
        let now = date("2026-11-16T08:00:00Z")
        let original = unfinishedDraft(now: now)
        let restored = try JSONDecoder().decode(NativeQuickEntryDraft.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(restored, original)
        XCTAssertEqual(restored.value, "")
        XCTAssertEqual(restored.carbs, "0")
        let operation = try restored.operation(now: now)
        let payload = try object(operation)
        XCTAssertTrue(payload["calories"] is NSNull)
        XCTAssertEqual(payload["carbs"] as? String, "0")
        XCTAssertEqual(payload["protein"] as? String, "12.5")
        XCTAssertEqual(payload["meal"] as? String, "dinner")
        XCTAssertTrue(payload["fat"] is NSNull)
    }

    @MainActor
    func testQuickEntryRecoveryRequiresExplicitRestoreBeforeReplacingStoredDraft() throws {
        let user = "synthetic-quick-entry-" + UUID().uuidString
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(user)
        let persistence = NativeWorkspacePersistence(userID: user, scope: "quick-entry.unfinished", directory: directory,
            service: user, maximumBytes: 2048)
        defer { try? persistence.clear(); try? FileManager.default.removeItem(at: directory) }
        let original = unfinishedDraft(now: date("2026-11-16T08:00:00Z"))
        try persistence.save(original)
        let recovery = NativeQuickEntryDraftRecovery(userID: user, persistence: persistence)
        try recovery.read()
        XCTAssertEqual(recovery.recovery, original)
        XCTAssertFalse(recovery.canWrite)
        var callerSelection = unfinishedDraft(now: date("2026-11-15T08:00:00Z"))
        callerSelection.metric = "weight"; callerSelection.isNutrition = false
        XCTAssertThrowsError(try recovery.save(callerSelection))
        XCTAssertEqual(try persistence.load(NativeQuickEntryDraft.self), original)
        XCTAssertEqual(callerSelection.metric, "weight", "Reading recovery must not replace the caller's selected metric or date")
        XCTAssertEqual(try recovery.restore(), original)
        XCTAssertTrue(recovery.canWrite)
        try recovery.save(callerSelection)
        XCTAssertEqual(try persistence.load(NativeQuickEntryDraft.self), callerSelection)
    }

    @MainActor
    func testFailedDraftSaveCannotOverwriteUnreconciledDraftAndPendingOperationTakesPriority() throws {
        let user = "synthetic-quick-entry-" + UUID().uuidString
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(user)
        let persistence = NativeWorkspacePersistence(userID: user, scope: "quick-entry.unfinished", directory: directory,
            service: user, maximumBytes: 512)
        let pendingStore = NativePendingEntryStore(userID: user)
        defer { try? persistence.clear(); try? pendingStore.clear(); try? FileManager.default.removeItem(at: directory) }
        let now = date("2026-11-16T08:00:00Z")
        let original = unfinishedDraft(now: now)
        let recovery = NativeQuickEntryDraftRecovery(userID: user, persistence: persistence)
        try recovery.read(); try recovery.save(original)
        XCTAssertThrowsError(try recovery.save(unfinishedDraft(now: now, note: String(repeating: "x", count: 2048))))
        XCTAssertFalse(recovery.canWrite)
        XCTAssertThrowsError(try recovery.save(unfinishedDraft(now: now, note: "unreconciled replacement")))
        XCTAssertEqual(try persistence.load(NativeQuickEntryDraft.self), original)
        try recovery.read()
        XCTAssertEqual(try recovery.restore(), original)
        let pending = try original.operation(now: now)
        try pendingStore.save(pending)
        try recovery.clearAfterPendingStored()
        XCTAssertNil(try persistence.load(NativeQuickEntryDraft.self))
        XCTAssertEqual(try pendingStore.load(), pending, "Ordinary draft cleanup must preserve the immutable submitted operation")
    }

}
