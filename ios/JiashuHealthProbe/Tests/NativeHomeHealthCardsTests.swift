import XCTest
@testable import JiashuHealthProbe

final class NativeHomeHealthCardsTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-11-17T08:00:00Z")!

    func testMissingAndUnavailableValuesStayDistinctFromRecordedZero() {
        let recordedZero = metric("steps", value: 0, day: "2026-11-17", points: [("2026-11-17", 0)])
        let loaded = NativeHomeHealthSnapshot(overview: overview([recordedZero]), health: nil, now: now)
        XCTAssertTrue(loaded.hasSource)
        XCTAssertEqual(loaded.metric("steps").value, 0)
        XCTAssertEqual(loaded.metric("steps").observedDays7, 1)
        XCTAssertNil(loaded.metric("active_energy").value)
        XCTAssertNil(loaded.metric("sleep").value)
        XCTAssertNil(loaded.sleepDeepHours)
        let unavailable = NativeHomeHealthSnapshot(overview: nil, health: nil, now: now)
        XCTAssertFalse(unavailable.hasSource)
        XCTAssertNil(unavailable.metric("steps").value)
        XCTAssertEqual(NativeHomeHealthData.number(unavailable.metric("steps").value), "—")
    }

    func testBodyFatUsesTheServersOwnValueAndDateInsteadOfLatestMassRatio() {
        let input = [metric("weight", value: 60, day: "2026-11-17"),
                     metric("lean_body_mass", value: 45, day: "2026-11-16"),
                     metric("body_fat", value: 22.5, day: "2026-11-15")]
        let loaded = NativeHomeHealthSnapshot(overview: overview(input), health: nil, now: now)
        XCTAssertEqual(loaded.metric("weight").day, "2026-11-17")
        XCTAssertEqual(loaded.metric("body_fat").day, "2026-11-15")
        XCTAssertEqual(loaded.metric("body_fat").value, 22.5)
        let unpaired = NativeHomeHealthSnapshot(overview: overview(Array(input.prefix(2))), health: nil, now: now)
        XCTAssertNil(unpaired.metric("body_fat").value)
        let response = health([summary("weight", points: [point("2026-11-17", 60)]),
                               summary("lean_body_mass", points: [point("2026-11-16", 45)])])
        let fallback = NativeHomeHealthSnapshot(overview: nil, health: response, now: now)
        XCTAssertEqual(fallback.metric("weight").value, 60)
        XCTAssertNil(fallback.metric("body_fat").value)
    }

    func testRecordedDayMeanUsesUniqueDaysAndRetainsTheResponseWindowAfterMidnight() {
        let raw = metric("steps", value: 6, day: "2026-11-17",
                         points: [("2026-11-10", 999), ("2026-11-11", 0), ("2026-11-11", 2), ("2026-11-17", 6)])
        let tomorrow = ISO8601DateFormatter().date(from: "2026-11-18T08:00:00Z")!
        let loaded = NativeHomeHealthSnapshot(overview: overview([raw]), health: nil, now: tomorrow)
        XCTAssertEqual(loaded.today, "2026-11-18")
        XCTAssertEqual(loaded.windowEnd, "2026-11-17")
        XCTAssertEqual(loaded.metric("steps").points.map(\.day), ["2026-11-11", "2026-11-17"])
        XCTAssertEqual(loaded.metric("steps").average7, 4)
        XCTAssertEqual(loaded.metric("steps").observedDays7, 2)
        XCTAssertEqual(NativeHomeHealthData.recentDays(ending: loaded.windowEnd).first, "2026-11-11")
        XCTAssertEqual(NativeHomeHealthData.recentDays(ending: loaded.windowEnd).last, "2026-11-17")
    }

    func testDeepSleepRequiresTheSameRecordedDayTotalAndValidStageSum() {
        let sleep = metric("sleep", value: 7, day: "2026-11-17")
        let stages = NativeSleepStages(unspecified: 0, core: 4, deep: 1, rem: 2, awake: 0.3, inBed: 7.5)
        func deep(_ points: [NativeTrendPoint]) -> Double? {
            NativeHomeHealthSnapshot(overview: overview([sleep]), health: health([summary("sleep", points: points)]), now: now).sleepDeepHours
        }
        XCTAssertNil(deep([point("2026-11-16", 7, stages: stages)]))
        XCTAssertNil(deep([point("2026-11-17", 6, stages: stages)]))
        XCTAssertNil(deep([point("2026-11-17", 7)]))
        XCTAssertEqual(deep([point("2026-11-17", 7, stages: stages)]), 1)
        let inconsistent = NativeSleepStages(unspecified: 0, core: 4, deep: 1, rem: 1, awake: 0.3, inBed: 7.5)
        XCTAssertNil(deep([point("2026-11-17", 7, stages: inconsistent)]))
        let zeroDeep = NativeSleepStages(unspecified: 0, core: 5, deep: 0, rem: 2, awake: 0.3, inBed: 7.5)
        XCTAssertEqual(deep([point("2026-11-17", 7, stages: zeroDeep)]), 0)
    }

    func testWeightAttainmentUsesTheServerPercentageAndStatus() throws {
        let day = "2026-11-17"
        XCTAssertEqual(try plan(average: 61.8, percent: 55).attainment(for: day), .measured(percent: 55, status: .active))
        XCTAssertEqual(try plan(average: 65, percent: 0).attainment(for: day), .measured(percent: 0, status: .active))
        XCTAssertEqual(try plan(average: 59, percent: 100, status: "achieved").attainment(for: day),
                       .measured(percent: 100, status: .achieved))
        XCTAssertEqual(try plan(average: 62, percent: 50, status: "ended").attainment(for: day),
                       .measured(percent: 50, status: .ended))
        XCTAssertEqual(NativeHomeWeightAttainment.displayPercent(99.95), 99.9)
        XCTAssertEqual(NativeHomeWeightAttainment.displayPercent(100), 100)
    }

    func testWeightAttainmentDistinguishesNoPlanDisabledAndMissingMeasurements() throws {
        let day = "2026-11-17"
        XCTAssertEqual(try plan(enabled: nil).attainment(for: day), .noPlan)
        XCTAssertEqual(try plan(enabled: false).attainment(for: day), .disabled)
        XCTAssertEqual(try plan(status: "missing").attainment(for: day), .missingWeight)
        XCTAssertEqual(try plan(status: "ended").attainment(for: day), .missingWeight)
        XCTAssertEqual(try plan(direction: "gain", average: 66, percent: 50).attainment(for: day), .gain)
        XCTAssertEqual(try plan(direction: "maintain", average: 64).attainment(for: day), .maintain)
    }

    func testWeightAttainmentRejectsStaleAndInconsistentResponses() throws {
        XCTAssertThrowsError(try plan(average: 61.8, percent: 55).attainment(for: "2026-11-18"))
        XCTAssertThrowsError(try plan(average: 59, percent: 105).attainment(for: "2026-11-17"))
        XCTAssertThrowsError(try plan(average: 61.8).attainment(for: "2026-11-17"))
        XCTAssertThrowsError(try plan(percent: 0).attainment(for: "2026-11-17"))
        let malformed = Data(#"{"today":"2026-11-17","observations":{"average7":null},"progress":null}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(NativeHomeWeightPlanReview.self, from: malformed))
    }

    func testInvalidAndUndatedLatestValuesCannotAppearAsMeasurements() {
        let inputs = [metric("steps", value: .infinity, day: "2026-11-17"),
                      metric("sleep", value: 25, day: "2026-11-17"),
                      metric("weight", value: 62, day: nil),
                      metric("body_fat", value: 23, day: "2026-11-18")]
        let loaded = NativeHomeHealthSnapshot(overview: overview(inputs), health: nil, now: now)
        for key in ["steps", "sleep", "weight", "body_fat"] {
            XCTAssertNil(loaded.metric(key).value, key)
            XCTAssertNil(loaded.metric(key).day, key)
        }
        let invalidDay = overview([metric("weight", value: 62, day: "2026-02-30")])
        XCTAssertNil(NativeHomeHealthSnapshot(overview: invalidDay, health: nil, now: now).metric("weight").value)
    }

    private func plan(enabled: Bool? = true, direction: String = "loss", average: Double? = nil,
                      percent: Double? = nil, status: String = "active") throws -> NativeHomeWeightPlanReview {
        let target = direction == "gain" ? 68 : direction == "maintain" ? 64 : 60
        let planSettings: [String: Any]? = enabled.map { ["enabled": $0, "baselineWeight": 64, "targetWeight": target] }
        let settings = planSettings.map { $0 as Any } ?? NSNull()
        let progress: Any = enabled == true
            ? ["direction": direction, "progressPercent": percent.map { $0 as Any } ?? NSNull(), "status": status]
            : NSNull()
        let response: [String: Any] = ["today": "2026-11-17", "settings": settings, "progress": progress,
                                      "observations": ["latestWeight": 57, "average7": average.map { $0 as Any } ?? NSNull()]]
        return try JSONDecoder().decode(NativeHomeWeightPlanReview.self, from: JSONSerialization.data(withJSONObject: response))
    }

    private func metric(_ key: String, value: Double?, day: String?, points: [(String, Double)] = []) -> NativeHomeMetric {
        NativeHomeMetric(metric: key, label: key, value: value, unit: "", day: day, freshness: "current",
                         points: points.map { NativeDayPoint(day: $0.0, value: $0.1) }, average7: 999, observedDays7: 7)
    }

    private func overview(_ metrics: [NativeHomeMetric]) -> NativeOverview {
        NativeOverview(asOf: "2026-11-17T08:00:00Z", today: "2026-11-17",
                       health: NativeOverviewHealth(status: "ready", lastSync: nil, metrics: metrics, recordedMetricCount: metrics.count),
                       priorities: [], finance: nil, nutrition: nil, modules: nil)
    }

    private func point(_ day: String, _ value: Double, stages: NativeSleepStages? = nil) -> NativeTrendPoint {
        NativeTrendPoint(day: day, value: value, measuredAt: day + "T00:10:00Z", source: "watch", sleepStages: stages)
    }

    private func summary(_ key: String, points: [NativeTrendPoint]) -> NativeMetricSummary {
        NativeMetricSummary(metric: key, label: key, unit: "", latestValue: points.last?.value,
                            latestDate: points.last?.measuredAt, points: points)
    }

    private func health(_ metrics: [NativeMetricSummary]) -> NativeHealthResponse {
        let summaries = Dictionary(uniqueKeysWithValues: metrics.map { ($0.metric, $0) })
        return NativeHealthResponse(summary: NativeHealthSummary(metrics: summaries, measurementCount: metrics.count, lastMeasurementAt: nil),
                                    measurements: [], lastSync: nil)
    }
}
