import XCTest
@testable import JiashuHealthProbe

final class NativeHealthUXTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from:"2026-11-17T08:00:00Z")!

    func testChartAssistantContextRetainsTheExactLoadedMetricAndCalendarRange() throws {
        let selection = NativeHealthAssistantSelection.initial(metric:"sleep",from:"2026-11-02",to:"2026-11-08",now:now)
        let range = try selection.range(now:now)
        XCTAssertEqual(range.from,"2026-11-02")
        XCTAssertEqual(range.to,"2026-11-08")
        XCTAssertEqual(range.days,7)
        XCTAssertEqual(selection.metrics,["sleep"])
        XCTAssertFalse(selection.nutrition)
        XCTAssertFalse(selection.goals)
        let request = try NativeHealthAssistantRequest.body(question:"看看这段睡眠",range:range,metrics:selection.metrics,nutrition:selection.nutrition,goals:selection.goals,scopeKey:"preview-sleep-scope",history:[])
        XCTAssertEqual(request["from"].stringValue,range.from)
        XCTAssertEqual(request["to"].stringValue,range.to)
        XCTAssertEqual(request["scope"]["metrics"],.array([.string("sleep")]))
        XCTAssertEqual(request["scope"]["includeNutrition"],.bool(false))
    }

    func testUnsupportedBodyFatContextCannotSilentlyShareOtherMetrics() {
        let selection = NativeHealthAssistantSelection.initial(metric:"body_fat",from:"2026-11-02",to:"2026-11-08",now:now)
        XCTAssertTrue(selection.metrics.isEmpty)
        XCTAssertFalse(selection.nutrition)
        XCTAssertThrowsError(try selection.range(now:now))
    }

    func testEditingAssistantScopeIsAnIndependentDraftUntilExplicitApply() {
        let original = NativeHealthAssistantSelection.initial(metric:"weight",from:"2026-11-01",to:"2026-11-07",now:now)
        var draft = original
        draft.metrics = ["sleep"]
        draft.nutrition = true
        XCTAssertEqual(original.metrics,["weight"])
        XCTAssertFalse(original.nutrition)
        XCTAssertTrue(draft.needsNewConversation(comparedWith:original,hasConversation:true))
        XCTAssertFalse(draft.needsNewConversation(comparedWith:original,hasConversation:false))
        XCTAssertFalse(original.needsNewConversation(comparedWith:original,hasConversation:true))
    }

    func testOptingIntoWeeklySuggestionChangesOnlyTextInTheLoadedActionDraft() throws {
        let original = NativeWeeklyActionCommand(weekStart:"2026-11-09",text:"原来的行动",status:.completed,feedback:"已经完成两次",expectedRevision:8)
        let proposal = try NativeWeeklySuggestionDraft.applying("  饭后走动三次  ",to:original)
        XCTAssertEqual(proposal.text,"饭后走动三次")
        XCTAssertEqual(proposal.weekStart,original.weekStart)
        XCTAssertEqual(proposal.expectedRevision,8)
        XCTAssertEqual(proposal.status,original.status)
        XCTAssertEqual(proposal.feedback,original.feedback)
        XCTAssertEqual(original.text,"原来的行动")
        XCTAssertTrue(NativeWeeklySuggestionDraft.needsReplacementConfirmation(current:original.text,proposal:proposal.text))
        XCTAssertFalse(NativeWeeklySuggestionDraft.needsReplacementConfirmation(current:"",proposal:proposal.text))
        XCTAssertFalse(NativeWeeklySuggestionDraft.needsReplacementConfirmation(current:proposal.text,proposal:" " + proposal.text + " "))
        XCTAssertThrowsError(try NativeWeeklySuggestionDraft.applying("",to:original))
    }

    func testPreviousComparisonPeriodHasEqualCalendarLengthWithoutOverlapAcrossLeapDay() throws {
        let from = try XCTUnwrap(NativeHealthWorkspaceFormat.date("2024-03-01"))
        let to = try XCTUnwrap(NativeHealthWorkspaceFormat.date("2024-03-07"))
        let current = try NativeHealthWorkspaceRange(from:from,to:to,now:now)
        let previous = try NativeHealthPeriodComparison.previousRange(for:current,now:now)
        XCTAssertEqual(previous.from,"2024-02-23")
        XCTAssertEqual(previous.to,"2024-02-29")
        XCTAssertEqual(previous.days,current.days)
        XCTAssertLessThan(previous.to,current.from)
        let firstSupported = try XCTUnwrap(NativeHealthWorkspaceFormat.date("1970-01-01"))
        let earliest = try NativeHealthWorkspaceRange(from:firstSupported,to:firstSupported,now:now)
        XCTAssertThrowsError(try NativeHealthPeriodComparison.previousRange(for:earliest,now:now))
    }

    func testPeriodMeansUseObservedDaysAndKeepMissingDistinctFromRecordedZero() throws {
        let from = try XCTUnwrap(NativeHealthWorkspaceFormat.date("2026-11-01"))
        let to = try XCTUnwrap(NativeHealthWorkspaceFormat.date("2026-11-03"))
        let range = try NativeHealthWorkspaceRange(from:from,to:to,now:now)
        func point(_ day: String,_ value: Double) throws -> NativeWorkspaceHealthPoint {
            try XCTUnwrap(NativeWorkspaceHealthPoint(.object(["day":.string(day),"value":.number(value)])))
        }
        let points = try [point("2026-11-01",0),point("2026-11-03",12),point("2026-10-31",900),point("2026-11-04",9000)]
        let partial = NativeHealthPeriodStatistics(points:points,range:range)
        XCTAssertEqual(partial.recordedDays,2)
        XCTAssertEqual(partial.totalDays,3)
        XCTAssertEqual(partial.recordedDayMean,6)
        let missing = NativeHealthPeriodStatistics(points:[],range:range)
        XCTAssertEqual(missing.recordedDays,0)
        XCTAssertNil(missing.recordedDayMean)
        let zero = NativeHealthPeriodStatistics(points:try [point("2026-11-01",0)],range:range)
        XCTAssertEqual(zero.recordedDays,1)
        XCTAssertEqual(zero.recordedDayMean,0)
        let repeatedDay = NativeHealthPeriodStatistics(points:try [point("2026-11-01",4),point("2026-11-01",8)],range:range)
        XCTAssertEqual(repeatedDay.recordedDays,1)
        XCTAssertEqual(repeatedDay.recordedDayMean,8)
    }
}
