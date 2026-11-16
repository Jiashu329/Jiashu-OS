import Foundation
import XCTest
@testable import JiashuHealthProbe

final class StepCoreTests: XCTestCase {
    private func date(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }

    private func snapshot(values: [Int?], capturedAt: String = "2026-11-16T08:04:40+08:00") throws -> StepSnapshot {
        let captured = date(capturedAt)
        let windows = try StepCalendar.windows(endingOn: captured, dayCount: values.count, capturedAt: captured)
        return StepSnapshot(capturedAt: captured, days: zip(windows, values).map { window, value in
            DailySteps(day: window.day, startDate: window.startDate, endDate: window.endDate, steps: value)
        })
    }

    func testShanghaiDaysStayTogetherAcrossUTCDateBoundary() throws {
        let captured = date("2026-11-16T08:04:40+08:00")
        let windows = try StepCalendar.windows(endingOn: date("2026-11-13T12:00:00+08:00"), dayCount: 1, capturedAt: captured)
        XCTAssertEqual(windows[0].day, "2026-11-13")
        XCTAssertEqual(windows[0].startDate, date("2026-11-12T16:00:00Z"))
        XCTAssertEqual(windows[0].endDate, date("2026-11-13T16:00:00Z"))
        XCTAssertNil(windows[0].steps)
    }

    func testRangeIsAscendingAndTodayEndsAtCaptureInstant() throws {
        let captured = date("2026-11-16T08:04:40+08:00")
        let windows = try StepCalendar.windows(endingOn: captured, dayCount: 7, capturedAt: captured)
        XCTAssertEqual(windows.map(\.day), ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"])
        XCTAssertEqual(windows.last?.endDate, captured)
        XCTAssertEqual(windows.first?.endDate, windows[1].startDate)
    }

    func testLeapDayAndYearBoundaryUseCalendarArithmetic() throws {
        let leap = try StepCalendar.windows(endingOn: date("2028-03-01T01:00:00+08:00"), dayCount: 3,
                                             capturedAt: date("2028-03-01T01:00:00+08:00"))
        XCTAssertEqual(leap.map(\.day), ["2028-02-28", "2028-02-29", "2028-03-01"])
        let year = try StepCalendar.windows(endingOn: date("2027-01-01T01:00:00+08:00"), dayCount: 2,
                                             capturedAt: date("2027-01-01T01:00:00+08:00"))
        XCTAssertEqual(year.map(\.day), ["2026-12-31", "2027-01-01"])
    }

    func testFutureEmptyAndUnsupportedRangesAreRejected() {
        let captured = date("2026-11-16T08:04:40+08:00")
        XCTAssertThrowsError(try StepCalendar.windows(endingOn: date("2026-11-17T00:00:00+08:00"), dayCount: 1, capturedAt: captured))
        for count in [0, 91, -1] {
            XCTAssertThrowsError(try StepCalendar.windows(endingOn: captured, dayCount: count, capturedAt: captured))
        }
        let midnight = date("2026-11-16T00:00:00+08:00")
        XCTAssertThrowsError(try StepCalendar.windows(endingOn: midnight, dayCount: 1, capturedAt: midnight))
        XCTAssertThrowsError(try StepCalendar.windows(endingOn: date("1970-01-01T12:00:00+08:00"), dayCount: 1, capturedAt: captured))
    }

    func testActualZeroIsExportedWhileMissingDayIsOmitted() throws {
        let data = try StepExport.jsonData(for: snapshot(values: [0, nil, 12_244]))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rows = try XCTUnwrap(json["measurements"] as? [[String: Any]])
        XCTAssertEqual(json["version"] as? Int, 1)
        XCTAssertEqual(json["source"] as? String, "apple-health-shortcuts")
        XCTAssertEqual(json["timezone"] as? String, "Asia/Shanghai")
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.map { $0["value"] as? Int }, [0, 12_244])
        XCTAssertTrue(rows.allSatisfy { $0["source"] as? String == "apple-health-merged" })
        XCTAssertEqual(rows[0]["startDate"] as? String, "2026-11-13T16:00:00.000Z")
        XCTAssertEqual(rows[1]["endDate"] as? String, "2026-11-16T00:04:40.000Z")
    }

    func testMissingAndInvalidNumbersDoNotBecomeZero() throws {
        XCTAssertThrowsError(try StepExport.jsonData(for: snapshot(values: [nil, nil])))
        XCTAssertThrowsError(try StepExport.jsonData(for: snapshot(values: [-1])))
        XCTAssertThrowsError(try StepExport.jsonData(for: snapshot(values: [200_001])))
        XCTAssertEqual(try StepCalendar.wholeSteps(from: 0), 0)
        XCTAssertEqual(try StepCalendar.wholeSteps(from: 12_243.6), 12_244)
        for value in [Double.nan, Double.infinity, -1, 200_001] {
            XCTAssertThrowsError(try StepCalendar.wholeSteps(from: value))
        }
    }

    func testPreviewURLContainsOnlySingleEncodedManualPayload() throws {
        let source = try snapshot(values: [12_244])
        XCTAssertEqual(StepExport.websiteURL.absoluteString, "https://www.treefund.asia")
        XCTAssertNil(StepExport.websiteURL.query)
        XCTAssertNil(StepExport.websiteURL.fragment)
        let url = try StepExport.previewURL(for: source)
        XCTAssertEqual(url.scheme, "https")
        XCTAssertEqual(url.host, "www.treefund.asia")
        XCTAssertEqual(url.path, "/sync")
        XCTAssertNil(url.query, "Health data must stay out of server-visible query parameters")
        let fragment = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedFragment)
        XCTAssertTrue(fragment.hasPrefix("payload="))
        let decoded = try XCTUnwrap(String(fragment.dropFirst("payload=".count)).removingPercentEncoding)
        XCTAssertEqual(Data(decoded.utf8), try StepExport.jsonData(for: source))
        XCTAssertFalse(fragment.contains("device="))
        XCTAssertFalse(fragment.contains("single-source-v2"))
        XCTAssertFalse(fragment.contains("%257B"))
    }

    func testLargeRangeKeepsFileExportButRefusesOverlongPreview() throws {
        let source = try snapshot(values: Array(repeating: 12_244, count: 90))
        XCTAssertNoThrow(try StepExport.jsonData(for: source))
        XCTAssertThrowsError(try StepExport.previewURL(for: source))
    }

    func testDuplicateOrPartialHistoricalDaysAreRejected() throws {
        let source = try snapshot(values: [12_244])
        let day = source.days[0]
        let duplicate = StepSnapshot(capturedAt: source.capturedAt, days: [day, day])
        XCTAssertThrowsError(try StepExport.jsonData(for: duplicate))
        let partial = DailySteps(day: day.day, startDate: day.startDate,
                                endDate: day.startDate.addingTimeInterval(60), steps: 100)
        XCTAssertThrowsError(try StepExport.jsonData(for: StepSnapshot(capturedAt: source.capturedAt, days: [partial])))
    }
}
