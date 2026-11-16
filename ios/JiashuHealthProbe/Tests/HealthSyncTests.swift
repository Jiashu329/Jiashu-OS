import Foundation
import XCTest
@testable import JiashuHealthProbe

final class HealthSyncTests: XCTestCase {
    private func date(_ value: String) -> Date { NativeHealthCalendar.parseTimestamp(value)! }
    private var capture: Date { date("2026-11-16T15:00:00+08:00") }
    private func window(_ day: String = "2026-11-16") throws -> NativeHealthWindow {
        try NativeHealthCalendar.sleepWindow(day: day, capturedAt: capture)
    }
    private func segment(_ start: String, _ end: String, _ state: Int, source: String = "watch", watch: Bool = true) -> NativeHealthSleepSegment {
        NativeHealthSleepSegment(start: date(start), end: date(end), state: state, source: source, isWatch: watch)
    }
    private func measurement(metric: String = "steps", value: Double = 0, day: String = "2026-11-16") -> NativeHealthMeasurement {
        NativeHealthMeasurement(id: "healthkit-merged-" + metric + ":" + day, metric: metric, value: value,
                                unit: metric == "steps" ? "count" : "kcal", startDate: day + "T00:00:00+08:00",
                                endDate: day + "T12:00:00+08:00", source: "apple-health-merged", aggregation: "daily")
    }

    func testCalendarWindowsUseShanghaiRegardlessOfSystemTimezone() throws {
        let now = date("2026-11-16T01:00:00+08:00")
        let windows = try NativeHealthCalendar.windows(days: 2, capturedAt: now)
        XCTAssertEqual(windows.map(\.day), ["2026-11-15", "2026-11-16"])
        XCTAssertEqual(windows[1].start, date("2026-11-15T16:00:00Z"))
        XCTAssertEqual(windows[1].end, now)
        let exactMidnight = try NativeHealthCalendar.windows(days: 2, capturedAt: date("2026-11-16T00:00:00+08:00"))
        XCTAssertEqual(exactMidnight.map(\.day), ["2026-11-15"], "zero-duration today is omitted without invalidating yesterday")
    }

    func testSleepWindowsAreNoonToNoonAndMorningIsOnlyElapsedTime() throws {
        let full = try window()
        XCTAssertEqual(full.start, date("2026-11-15T12:00:00+08:00"))
        XCTAssertEqual(full.end, date("2026-11-16T12:00:00+08:00"))
        let morning = try NativeHealthCalendar.sleepWindow(day: "2026-11-16", capturedAt: date("2026-11-16T08:00:00+08:00"))
        XCTAssertEqual(morning.end, date("2026-11-16T08:00:00+08:00"))
    }

    func testOverlappingGenericAndDetailedSleepDoesNotDoubleCount() throws {
        let samples = [
            segment("2026-11-15T23:00:00+08:00", "2026-11-16T07:00:00+08:00", 1),
            segment("2026-11-15T23:00:00+08:00", "2026-11-16T03:00:00+08:00", 3),
            segment("2026-11-16T03:00:00+08:00", "2026-11-16T05:00:00+08:00", 4),
            segment("2026-11-16T05:00:00+08:00", "2026-11-16T07:00:00+08:00", 5),
            segment("2026-11-15T22:00:00+08:00", "2026-11-16T08:00:00+08:00", 0),
        ]
        let result = try XCTUnwrap(NativeHealthSleepAggregation.measurement(segments: samples, window: window()))
        XCTAssertEqual(result.value, 8, accuracy: 1e-8)
        XCTAssertEqual(result.sleepStages?.core, 4)
        XCTAssertEqual(result.sleepStages?.deep, 2)
        XCTAssertEqual(result.sleepStages?.rem, 2)
        XCTAssertEqual(result.sleepStages?.unspecified, 0)
        XCTAssertEqual(result.sleepStages?.inBed, 10)
        XCTAssertEqual(result.sleepTiming?.onset, "2026-11-15T15:00:00.000Z")
        XCTAssertEqual(result.sleepTiming?.wake, "2026-11-15T23:00:00.000Z")
        XCTAssertEqual(result.sleepTiming?.clipped, false)
        _ = try NativeHealthSnapshot(capturedAt: capture, measurements: [result]).encodePayload()
    }

    func testConflictingDetailedStagesBecomeUnspecified() throws {
        let samples = [segment("2026-11-16T01:00:00+08:00", "2026-11-16T03:00:00+08:00", 3),
                       segment("2026-11-16T02:00:00+08:00", "2026-11-16T04:00:00+08:00", 4)]
        let result = try XCTUnwrap(NativeHealthSleepAggregation.measurement(segments: samples, window: window()))
        XCTAssertEqual(result.value, 3)
        XCTAssertEqual(result.sleepStages?.core, 1)
        XCTAssertEqual(result.sleepStages?.deep, 1)
        XCTAssertEqual(result.sleepStages?.unspecified, 1)
    }

    func testSleepSelectsOneSourceAndPrefersWatchWithoutAddingPhone() throws {
        let samples = [segment("2026-11-16T01:00:00+08:00", "2026-11-16T07:00:00+08:00", 1, source: "watch"),
                       segment("2026-11-15T22:00:00+08:00", "2026-11-16T08:00:00+08:00", 1, source: "phone", watch: false)]
        let result = try XCTUnwrap(NativeHealthSleepAggregation.measurement(segments: samples, window: window()))
        XCTAssertEqual(result.source, "watch")
        XCTAssertEqual(result.value, 6)
        let reversed = try NativeHealthSleepAggregation.measurement(segments: Array(samples.reversed()), window: window())
        XCTAssertEqual(result, reversed, "query arrival order cannot change the selected source")
    }

    func testEqualSourcesHaveDeterministicTieBreak() throws {
        let samples = [segment("2026-11-16T01:00:00+08:00", "2026-11-16T07:00:00+08:00", 1, source: "b"),
                       segment("2026-11-16T01:00:00+08:00", "2026-11-16T07:00:00+08:00", 1, source: "a")]
        XCTAssertEqual(try NativeHealthSleepAggregation.measurement(segments: samples, window: window())?.source, "a")
    }

    func testAwakeAndInBedOnlyNeverBecomeZeroSleep() throws {
        let samples = [segment("2026-11-16T01:00:00+08:00", "2026-11-16T07:00:00+08:00", 0),
                       segment("2026-11-16T01:00:00+08:00", "2026-11-16T07:00:00+08:00", 2)]
        XCTAssertNil(try NativeHealthSleepAggregation.measurement(segments: samples, window: window()))
        XCTAssertNil(try NativeHealthSleepAggregation.measurement(segments: [], window: window()))
    }

    func testNapCannotMoveLongestNightWakeTime() throws {
        let samples = [segment("2026-11-15T13:00:00+08:00", "2026-11-15T14:00:00+08:00", 1),
                       segment("2026-11-15T23:00:00+08:00", "2026-11-16T07:00:00+08:00", 1)]
        let result = try XCTUnwrap(NativeHealthSleepAggregation.measurement(segments: samples, window: window()))
        XCTAssertEqual(result.value, 9)
        XCTAssertEqual(result.sleepTiming?.wake, "2026-11-15T23:00:00.000Z")
    }

    func testClippedSleepTimingNeverPretendsWindowEdgeIsRealTime() throws {
        let samples = [segment("2026-11-15T10:00:00+08:00", "2026-11-15T14:00:00+08:00", 1)]
        let result = try XCTUnwrap(NativeHealthSleepAggregation.measurement(segments: samples, window: window()))
        XCTAssertEqual(result.value, 2)
        XCTAssertEqual(result.sleepTiming?.clipped, true)
        XCTAssertEqual(result.sleepTiming?.onset, "2026-11-15T04:00:00.000Z")
    }

    func testZeroAndAllFiveMetricsUseExistingServerEnvelope() throws {
        let weight = NativeHealthMeasurement(id: "healthkit-weight:sample-uuid", metric: "weight", value: 68.2, unit: "kg",
                                             startDate: "2026-11-16T08:00:00+08:00", endDate: nil, source: "apple-health-mass:source", aggregation: "sample")
        let lean = NativeHealthMeasurement(id: "healthkit-lean:sample-uuid", metric: "lean_body_mass", value: 53, unit: "kg",
                                           startDate: "2026-11-16T08:00:00+08:00", endDate: nil, source: "apple-health-mass:source", aggregation: "sample")
        let sleep = try XCTUnwrap(NativeHealthSleepAggregation.measurement(segments: [segment("2026-11-15T23:00:00+08:00", "2026-11-16T07:00:00+08:00", 1)], window: window()))
        let snapshot = NativeHealthSnapshot(capturedAt: capture, measurements: [measurement(), measurement(metric: "active_energy", value: 361.5), weight, lean, sleep])
        let data = try snapshot.encodePayload()
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rows = try XCTUnwrap(json["measurements"] as? [[String: Any]])
        XCTAssertEqual(json["source"] as? String, "apple-health-shortcuts")
        XCTAssertEqual(json["timezone"] as? String, "Asia/Shanghai")
        XCTAssertEqual(rows.count, 5)
        XCTAssertEqual(rows[0]["value"] as? Double, 0)
        XCTAssertEqual(Set(rows.compactMap { $0["metric"] as? String }), ["steps", "active_energy", "sleep", "weight", "lean_body_mass"])
        XCTAssertEqual(try snapshot.encodePayload(), data, "same snapshot has stable bytes for retry")
    }

    func testOversizedOrDuplicateSnapshotsFailWithoutTruncation() throws {
        let mass = (0..<1_001).map { index in
            NativeHealthMeasurement(id: "healthkit-weight:\(index)", metric: "weight", value: 68, unit: "kg",
                                    startDate: "2026-11-16T08:00:00+08:00", endDate: nil, source: "watch", aggregation: "sample")
        }
        XCTAssertThrowsError(try NativeHealthSnapshot(capturedAt: capture, measurements: mass).encodePayload())
        XCTAssertThrowsError(try NativeHealthSnapshot(capturedAt: capture, measurements: [measurement(), measurement()]).encodePayload())
        XCTAssertThrowsError(try NativeHealthSnapshot(capturedAt: capture, measurements: []).encodePayload())
    }

    func testInvalidValuesAndFutureSamplesAreRejected() throws {
        for value in [Double.nan, Double.infinity, -1, 200_001, 1.5] {
            XCTAssertThrowsError(try NativeHealthSnapshot(capturedAt: capture, measurements: [measurement(value: value)]).encodePayload())
        }
        let tomorrow = measurement(day: "2026-11-17")
        XCTAssertThrowsError(try NativeHealthSnapshot(capturedAt: capture, measurements: [tomorrow]).encodePayload())
        XCTAssertThrowsError(try NativeHealthCalendar.windows(days: 0, capturedAt: capture))
        XCTAssertThrowsError(try NativeHealthCalendar.windows(days: 91, capturedAt: capture))
    }
}
