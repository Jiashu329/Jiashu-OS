import Foundation
import HealthKit
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

    private func completedQuery<Value>(error: Error? = nil, empty: Value, value: Value) async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            NativeHealthQueryCompletion.complete(error: error, emptyValue: empty, value: { value }) {
                continuation.resume(with: $0)
            }
        }
    }

    func testEmptyHistoricalDayDoesNotStopFollowingDaysOrTurnIntoZero() async throws {
        let noData = NSError(domain: HKErrorDomain, code: HKError.Code.errorNoData.rawValue,
                             userInfo: [NSLocalizedDescriptionKey: "No data available for the specified predicate."])
        let inputs: [(String, Double?, Error?)] = [
            ("2026-11-13", nil, nil), ("2026-11-14", nil, noData),
            ("2026-11-15", 0, nil), ("2026-11-16", 1_234, nil),
        ]
        var rows: [NativeHealthMeasurement] = []
        for (day, sample, error) in inputs {
            let value: Double? = try await completedQuery(error: error, empty: nil, value: sample)
            if let value { rows.append(measurement(value: value, day: day)) }
        }
        let snapshot = NativeHealthSnapshot(capturedAt: capture, measurements: rows)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: snapshot.encodePayload()) as? [String: Any])
        let exported = try XCTUnwrap(object["measurements"] as? [[String: Any]])
        XCTAssertEqual(exported.count, 2)
        XCTAssertEqual(exported.compactMap { $0["value"] as? Double }, [0, 1_234])
        XCTAssertFalse(rows.contains(where: { $0.id.hasSuffix("2026-11-14") }))
    }

    func testEmptySampleQueriesDoNotBlockOtherHealthMetrics() async throws {
        let noData = NSError(domain: HKErrorDomain, code: HKError.Code.errorNoData.rawValue)
        let weights: [NativeHealthMeasurement] = try await completedQuery(error: noData, empty: [], value: [])
        let sleep: [NativeHealthSleepSegment] = try await completedQuery(error: noData, empty: [], value: [])
        XCTAssertTrue(weights.isEmpty)
        XCTAssertTrue(sleep.isEmpty)
        var rows = weights
        rows.append(measurement(metric: "active_energy", value: 321))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: NativeHealthSnapshot(capturedAt: capture, measurements: rows).encodePayload()) as? [String: Any])
        let exported = try XCTUnwrap(object["measurements"] as? [[String: Any]])
        XCTAssertEqual(exported.compactMap { $0["metric"] as? String }, ["active_energy"])
    }

    func testNoDataStillUsesTheExistingEmptySnapshotHandling() async throws {
        let noData = NSError(domain: HKErrorDomain, code: HKError.Code.errorNoData.rawValue)
        var evaluatedValue = false
        let value: Double? = try await withCheckedThrowingContinuation { continuation in
            NativeHealthQueryCompletion.complete(error: noData, emptyValue: nil, value: {
                evaluatedValue = true
                return 9.0
            }) { continuation.resume(with: $0) }
        }
        XCTAssertNil(value)
        XCTAssertFalse(evaluatedValue, "A failed query cannot expose a stale result")
        XCTAssertThrowsError(try NativeHealthSnapshot(capturedAt: capture, measurements: []).encodePayload()) { error in
            guard case NativeHealthError.noReadableData = error else { return XCTFail("Expected the existing localized no-readable-data state") }
        }
    }

    func testOnlyHealthKitNoDataIsTreatedAsAnEmptyQuery() async {
        let errors: [Error] = [
            NSError(domain: "synthetic.network", code: HKError.Code.errorNoData.rawValue),
            NSError(domain: HKErrorDomain, code: HKError.Code.errorAuthorizationDenied.rawValue),
            NSError(domain: HKErrorDomain, code: HKError.Code.errorDatabaseInaccessible.rawValue),
            NSError(domain: "synthetic.network", code: 1, userInfo: [NSLocalizedDescriptionKey: "No data available for the specified predicate."]),
            CancellationError(), NativeHealthError.queryTimedOut,
        ]
        for error in errors {
            do {
                let _: Double? = try await completedQuery(error: error, empty: nil, value: 1)
                XCTFail("A real query failure must not be converted into missing data")
            } catch let observed {
                XCTAssertEqual((observed as NSError).domain, (error as NSError).domain)
                XCTAssertEqual((observed as NSError).code, (error as NSError).code)
            }
        }
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

    func testCutoffUsesStableExportPrecisionWithoutMovingIntoTheFuture() throws {
        let base = date("2026-11-16T08:00:00+08:00")
        for fraction in [0.0, 0.0002, 0.0004, 0.0006, 0.0009, 0.0011, 0.0016, 0.9998] {
            let raw = base.addingTimeInterval(fraction)
            let cutoff = try NativeHealthCalendar.cutoff(raw)
            XCTAssertLessThanOrEqual(cutoff, raw)
            XCTAssertLessThan(raw.timeIntervalSince(cutoff), 0.001001)
            XCTAssertEqual(try NativeHealthCalendar.cutoff(cutoff), cutoff)
            XCTAssertEqual(date(NativeHealthCalendar.timestamp(cutoff)), cutoff)
        }
    }

    func testSubmillisecondCaptureCanExportCurrentStepsAndEnergy() throws {
        let base = date("2026-11-16T08:00:00+08:00")
        for fraction in [0.0004, 0.0006, 0.0009] {
            let raw = base.addingTimeInterval(fraction)
            let window = try XCTUnwrap(NativeHealthCalendar.windows(days: 1, capturedAt: raw).first)
            let rows = [("steps", "count", 1234.0), ("active_energy", "kcal", 123.4)].map { metric, unit, value in
                NativeHealthMeasurement(id: metric + ":" + window.day, metric: metric, value: value, unit: unit,
                    startDate: NativeHealthCalendar.timestamp(window.start), endDate: NativeHealthCalendar.timestamp(window.end),
                    source: "apple-health-merged", aggregation: "daily")
            }
            let snapshot = NativeHealthSnapshot(capturedAt: raw, measurements: rows)
            let payload = try snapshot.encodePayload()
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
            let exportedAt = try XCTUnwrap(json["exportedAt"] as? String)
            XCTAssertEqual(date(exportedAt), base)
            XCTAssertEqual(rows.map(\.endDate), [exportedAt, exportedAt])
            XCTAssertEqual(try snapshot.encodePayload(), payload)
        }
    }

    func testOngoingSleepClipsToTheSamePrecisionAsItsExportedWindow() throws {
        let base = date("2026-11-16T08:00:00+08:00")
        for fraction in [0.0004, 0.0006, 0.0009] {
            let raw = base.addingTimeInterval(fraction)
            let window = try NativeHealthCalendar.sleepWindow(day: "2026-11-16", capturedAt: raw)
            let samples = [0, 1, 2].map { state in
                NativeHealthSleepSegment(start: window.start.addingTimeInterval(-3600), end: raw.addingTimeInterval(3600),
                    state: state, source: "watch", isWatch: true)
            }
            let row = try XCTUnwrap(NativeHealthSleepAggregation.measurement(segments: samples, window: window))
            XCTAssertEqual(row.value, 20, accuracy: 1e-8)
            XCTAssertEqual(row.sleepStages?.inBed ?? -1, 20, accuracy: 1e-8)
            XCTAssertEqual(row.sleepStages?.awake ?? -1, 20, accuracy: 1e-8)
            XCTAssertEqual(row.sleepTiming?.wake, NativeHealthCalendar.timestamp(base))
            XCTAssertEqual(row.sleepTiming?.clipped, true)
            _ = try NativeHealthSnapshot(capturedAt: raw, measurements: [row]).encodePayload()
        }
    }

    func testCutoffKeepsShanghaiMidnightAndNoonInTheirActualReportWindows() throws {
        let midnight = date("2026-11-17T00:00:00+08:00")
        let before = midnight.addingTimeInterval(-0.0002)
        let beforeWindows = try NativeHealthCalendar.windows(days: 1, capturedAt: before)
        XCTAssertEqual(beforeWindows.map(\.day), ["2026-11-16"])
        XCTAssertEqual(NativeHealthCalendar.timestamp(try XCTUnwrap(beforeWindows.last).end), "2026-11-16T15:59:59.999Z")
        let justAfter = midnight.addingTimeInterval(0.0002)
        let afterWindows = try NativeHealthCalendar.windows(days: 2, capturedAt: justAfter)
        XCTAssertEqual(afterWindows.map(\.day), ["2026-11-16"], "a sub-millisecond today cannot encode a positive interval yet")
        XCTAssertEqual(afterWindows.last?.end, midnight)
        let noon = date("2026-11-16T12:00:00+08:00")
        let sleep = try NativeHealthCalendar.sleepWindow(day: "2026-11-16", capturedAt: noon.addingTimeInterval(-0.0002))
        XCTAssertEqual(NativeHealthCalendar.timestamp(sleep.end), "2026-11-16T03:59:59.999Z")
    }

    func testPrecisionFixStillRejectsActuallyFutureOrInvalidRecords() throws {
        let base = date("2026-11-16T08:00:00+08:00")
        let raw = base.addingTimeInterval(0.0004)
        let future = NativeHealthMeasurement(id: "future-weight", metric: "weight", value: 68, unit: "kg",
            startDate: NativeHealthCalendar.timestamp(base.addingTimeInterval(0.001)), endDate: nil,
            source: "scale", aggregation: "sample")
        XCTAssertThrowsError(try NativeHealthSnapshot(capturedAt: raw, measurements: [future]).encodePayload())
        let valid = NativeHealthMeasurement(id: "valid-weight", metric: "weight", value: 68, unit: "kg",
            startDate: NativeHealthCalendar.timestamp(base), endDate: nil, source: "scale", aggregation: "sample")
        _ = try NativeHealthSnapshot(capturedAt: raw, measurements: [valid]).encodePayload()
        let invalid = NativeHealthSleepSegment(start: base, end: base.addingTimeInterval(-1), state: 1, source: "watch", isWatch: true)
        let window = try NativeHealthCalendar.sleepWindow(day: "2026-11-16", capturedAt: capture)
        XCTAssertThrowsError(try NativeHealthSleepAggregation.measurement(segments: [invalid], window: window))
    }

    func testSubmillisecondSleepKeepsItsValueWhenTimingBoundsCannotBeRepresented() throws {
        let base = date("2026-11-16T01:00:00+08:00")
        let sample = NativeHealthSleepSegment(start: base.addingTimeInterval(0.0001), end: base.addingTimeInterval(0.0002),
            state: 1, source: "watch", isWatch: true)
        let row = try XCTUnwrap(NativeHealthSleepAggregation.measurement(segments: [sample], window: window()))
        XCTAssertGreaterThan(row.value, 0)
        XCTAssertNil(row.sleepTiming, "equal encoded timing bounds cannot claim a positive sleep bout")
        _ = try NativeHealthSnapshot(capturedAt: capture, measurements: [row]).encodePayload()
    }
}
