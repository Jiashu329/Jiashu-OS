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
}
