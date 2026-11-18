import XCTest
@testable import JiashuHealthProbe

final class NativeHealthWorkspaceTests: XCTestCase {
    private func date(_ value: String) -> Date { ISO8601DateFormatter().date(from:value)! }
    private func json(_ value: String) throws -> NativeJSON { try JSONDecoder().decode(NativeJSON.self,from:Data(value.utf8)) }

    func testCustomRangeUsesShanghaiCalendarAndIncludesBothEndpoints() throws {
        let now = date("2026-11-16T16:05:00Z")
        let range = try NativeHealthWorkspaceRange(from:date("2026-11-15T16:00:00Z"),to:now,now:now)
        XCTAssertEqual(range.from,"2026-11-16"); XCTAssertEqual(range.to,"2026-11-17"); XCTAssertEqual(range.days,2)
        let chart = NativeHealthWorkspaceFormat.path("health",query:range.query)
        let export = NativeHealthWorkspaceFormat.path("health/export",query:range.query)
        XCTAssertEqual(URLComponents(string:chart)?.queryItems,URLComponents(string:export)?.queryItems)
        XCTAssertThrowsError(try NativeHealthWorkspaceRange(from:now,to:now.addingTimeInterval(86400),now:now))
        XCTAssertThrowsError(try NativeHealthWorkspaceRange(from:now.addingTimeInterval(-360*86400),to:now,now:now))
    }

    func testSleepCircularMeanDoesNotTurnMidnightIntoNoon() {
        let mean = NativeWorkspaceSleepSummary.circular([1430.0,10.0])
        XCTAssertEqual(mean.0,"00:00"); XCTAssertEqual(mean.1!,10,accuracy:0.0001)
        XCTAssertNil(NativeWorkspaceSleepSummary.circular([60]).1)
        XCTAssertNil(NativeWorkspaceSleepSummary.circular([0,720]).0)
    }

    func testClippedAndLegacySleepAreExcludedFromTimingNotFromRecordedCoverage() throws {
        let points = try [
            #"{"day":"2026-11-14","value":7,"sleepTiming":{"onset":"2026-11-13T15:50:00Z","wake":"2026-11-13T23:00:00Z","method":"longest-sleep-group-v1","clipped":false}}"#,
            #"{"day":"2026-11-15","value":6,"sleepTiming":{"onset":"2026-11-14T04:00:00Z","wake":"2026-11-14T10:00:00Z","method":"longest-sleep-group-v1","clipped":true}}"#,
            #"{"day":"2026-11-16","value":8}"#
        ].map { try XCTUnwrap(NativeWorkspaceHealthPoint(json($0))) }
        let summary = NativeWorkspaceSleepSummary(points)
        XCTAssertEqual(summary.recordedDays,3); XCTAssertEqual(summary.timingDays,1); XCTAssertEqual(summary.clippedDays,1)
        XCTAssertEqual(summary.onset,"23:50"); XCTAssertNil(summary.onsetDeviation)
        XCTAssertEqual(summary.wake,"07:00"); XCTAssertNil(summary.wakeDeviation)
    }

    func testSleepSharesWeightActualHoursAndExcludeAwakeInBedAndInvalidTotals() throws {
        let points = try [
            #"{"day":"2026-11-14","value":2,"sleepStages":{"deep":1,"core":1,"rem":0,"unspecified":0,"awake":2,"inBed":4}}"#,
            #"{"day":"2026-11-15","value":8,"sleepStages":{"deep":1,"core":7,"rem":0,"unspecified":0,"awake":0,"inBed":8}}"#,
            #"{"day":"2026-11-16","value":6,"sleepStages":{"deep":1,"core":1,"rem":0,"unspecified":0,"awake":0,"inBed":6}}"#
        ].map { try XCTUnwrap(NativeWorkspaceHealthPoint(json($0))) }
        let summary = NativeWorkspaceSleepSummary(points)
        XCTAssertEqual(summary.stageDays,2); XCTAssertEqual(summary.stages["deep"],20); XCTAssertEqual(summary.stages["core"],80)
        XCTAssertNil(summary.stages["awake"]); XCTAssertNil(summary.stages["inBed"])
    }

    func testRecordEditFreezesBothRevisionsAndDoesNotConvertMissingToZero() throws {
        let record = try json(#"{"recordKey":"weight:watch/entry+1","metric":"weight","day":"2026-11-17","revision":4,"base":{"exportedAt":"2026-11-17T01:00:00Z"}}"#)
        let operation = try NativeHealthRecordRequest.operation(record:record,action:"correct",value:"70.25",reason:"核对")
        XCTAssertEqual(operation.body["expectedRevision"].intValue,4)
        XCTAssertEqual(operation.body["expectedBaseExportedAt"].stringValue,"2026-11-17T01:00:00Z")
        XCTAssertEqual(operation.body["value"].doubleValue,70.25)
        XCTAssertTrue(operation.path.contains("%2F")); XCTAssertTrue(operation.path.contains("%2B"))
        XCTAssertThrowsError(try NativeHealthRecordRequest.operation(record:record,action:"correct",value:"",reason:""))
        let hide = try NativeHealthRecordRequest.operation(record:record,action:"hide",value:"0",reason:"")
        XCTAssertNil(hide.body.objectValue["value"])
        let restored = try JSONDecoder().decode(NativeHealthWorkspaceMutation.self,from:JSONEncoder().encode(operation))
        XCTAssertEqual(restored,operation); XCTAssertEqual(restored.requestHeaders["Idempotency-Key"],operation.id)
    }

    func testTrendRecordDayFocusQueriesOneShanghaiDayAndRetainsTheOriginalRange() throws {
        let now = date("2026-11-17T16:05:00Z")
        let context = try XCTUnwrap(NativeHealthRecordDayContext.initial(day:"2026-11-17",metric:"weight",
            from:"2026-11-01",to:"2026-11-18",now:now))
        XCTAssertEqual(context.day,"2026-11-17")
        XCTAssertEqual(context.date,date("2026-11-16T16:00:00Z"))
        XCTAssertEqual(context.metric,"weight")
        XCTAssertEqual(context.dayRange.days,1)
        XCTAssertEqual(context.dayRange.query,[URLQueryItem(name:"from",value:"2026-11-17"),URLQueryItem(name:"to",value:"2026-11-17")])
        XCTAssertEqual(context.trendRange.from,"2026-11-01")
        XCTAssertEqual(context.trendRange.to,"2026-11-18")
    }

    func testRecordDayFocusRequiresAnExplicitValidDateWithoutChangingTheManagementDefault() {
        let now = date("2026-11-18T02:00:00Z")
        XCTAssertNil(NativeHealthRecordDayContext.initial(day:nil,metric:"weight",from:"2026-11-01",to:"2026-11-18",now:now))
        for day in ["2026-10-31","2026-11-19","2026-02-30","2026-11-2","invalid"] {
            XCTAssertNil(NativeHealthRecordDayContext.initial(day:day,metric:"weight",from:"2026-11-01",to:"2026-11-18",now:now),day)
        }
        XCTAssertNil(NativeHealthRecordDayContext.initial(day:"2026-11-17",metric:"body_fat",from:"2026-11-01",to:"2026-11-18",now:now))
        XCTAssertNil(NativeHealthRecordDayContext.initial(day:"2026-11-17",metric:"all",from:"2026-11-01",to:"2026-11-18",now:now))
        XCTAssertNil(NativeHealthRecordDayContext.initial(day:"2026-11-17",metric:"weight",from:nil,to:nil,now:now))
        // A date with no observation is still the requested day; it must not
        // jump to the latest record or silently widen the query.
        XCTAssertEqual(NativeHealthRecordDayContext.initial(day:"2026-11-12",metric:"sleep",
            from:"2026-11-01",to:"2026-11-18",now:now)?.dayRange.from,"2026-11-12")
    }

    func testReturningAfterHidingOrRestoringARecordKeepsTheInspectedDay() throws {
        let now = date("2026-11-18T02:00:00Z")
        let context = try XCTUnwrap(NativeHealthRecordDayContext.initial(day:"2026-11-17",metric:"weight",
            from:"2026-11-01",to:"2026-11-18",now:now))
        func point(_ day: String,_ value: Double) throws -> NativeWorkspaceHealthPoint {
            try XCTUnwrap(NativeWorkspaceHealthPoint(.object(["day":.string(day),"value":.number(value)])))
        }
        let hidden = try [point("2026-11-16",62)]
        let dayAfterHide = NativeHealthTrendSelection.day(context.date,points:hidden,range:context.trendRange)
        XCTAssertEqual(dayAfterHide,context.day)
        XCTAssertNil(hidden.first { $0.day == dayAfterHide })
        XCTAssertEqual(NativeHealthTrendSelection.day(nil,points:hidden,range:context.trendRange),"2026-11-16")
        let restored = try hidden + [point(context.day,61.5)]
        let dayAfterRestore = NativeHealthTrendSelection.day(context.date,points:restored,range:context.trendRange)
        XCTAssertEqual(dayAfterRestore,context.day)
        XCTAssertEqual(restored.first { $0.day == dayAfterRestore }?.value,61.5)
        XCTAssertEqual(context.trendRange.from,"2026-11-01")
        XCTAssertEqual(context.trendRange.to,"2026-11-18")
    }

    func testGoalReplacementContainsExplicitNullsAndStableEffectiveDate() throws {
        let now = date("2026-11-16T16:01:00Z")
        let body = try NativeHealthGoalRequest.body(fields:["steps":"8000","sleep":""],effectiveFrom:now,revision:3,now:now)
        XCTAssertEqual(body["targets"]["sleep"],.null); XCTAssertEqual(body["targets"]["active_energy"],.null)
        XCTAssertEqual(body["targets"].objectValue.count,3)
        XCTAssertEqual(body["effectiveFrom"].stringValue,"2026-11-17")
        XCTAssertEqual(body["expectedRevision"].intValue,3)
        XCTAssertThrowsError(try NativeHealthGoalRequest.body(fields:["steps":"0"],effectiveFrom:now,revision:3,now:now))
        let operation = NativeHealthWorkspaceMutation(path:"health/goals",method:"PUT",body:body,label:"目标")
        let saved: NativeJSON = .object(["revision":.number(4),"targets":body["targets"],"effectiveFrom":body["effectiveFrom"]])
        XCTAssertTrue(NativeHealthGoalRequest.matchesSaved(operation,response:saved))
        XCTAssertFalse(NativeHealthGoalRequest.matchesSaved(operation,response:.object(["revision":.number(5),"targets":body["targets"],"effectiveFrom":body["effectiveFrom"]])))
    }

    func testImportRequiresServerPreviewAndExplicitSourceConfirmation() throws {
        let payload = try NativeHealthFileImport.decode(Data(#"{"version":1,"source":"apple-health-shortcuts","timezone":"Asia/Shanghai","exportedAt":"2026-11-17T01:00:00Z","measurements":[]}"#.utf8))
        let preview: NativeJSON = .object(["token":.string("frozen-preview"),"sourceChanges":.number(1)])
        XCTAssertThrowsError(try NativeHealthFileImport.operation(payload:payload,preview:preview,confirmSources:false))
        let operation = try NativeHealthFileImport.operation(payload:payload,preview:preview,confirmSources:true)
        XCTAssertEqual(operation.body,payload); XCTAssertEqual(operation.headers["X-Import-Preview"],"frozen-preview")
        XCTAssertEqual(operation.headers["X-Confirm-Source-Changes"],"true")
        XCTAssertNil(operation.headers["X-Sync-Device"])
        XCTAssertEqual(operation.body["measurements"].arrayValue.count,0)
        XCTAssertThrowsError(try NativeHealthFileImport.decode(Data(repeating:32,count:512*1024+1)))
        XCTAssertThrowsError(try NativeHealthFileImport.decode(Data(#"{"version":1,"measurements":null}"#.utf8)))
    }

    func testAssistantScopeConsentAndHistoryStayBoundToCustomRange() throws {
        let now = date("2026-11-17T02:00:00Z")
        let range = try NativeHealthWorkspaceRange(from:now.addingTimeInterval(-86400),to:now,now:now)
        let turns = (1...6).map { NativeHealthAssistantTurn(question:"问题\($0)",answer:"回答\($0)") }
        let body = try NativeHealthAssistantRequest.body(question:"  这两天的睡眠怎样？  ",range:range,metrics:["sleep"],nutrition:false,goals:false,scopeKey:"scope-from-preview",history:turns)
        XCTAssertEqual(body["shareHealthData"],.bool(true)); XCTAssertEqual(body["historyScope"].stringValue,"scope-from-preview")
        XCTAssertEqual(body["from"].stringValue,range.from); XCTAssertEqual(body["to"].stringValue,range.to)
        XCTAssertNil(body.objectValue["days"])
        XCTAssertEqual(body["scope"]["metrics"],.array([.string("sleep")]))
        XCTAssertEqual(body["scope"]["includeNutrition"],.bool(false))
        XCTAssertEqual(body["history"].arrayValue.count,8)
        XCTAssertEqual(body["history"].arrayValue.first?["content"].stringValue,"问题3")
        XCTAssertNil(body.objectValue["context"]); XCTAssertNil(body.objectValue["measurements"])
        XCTAssertThrowsError(try NativeHealthAssistantRequest.body(question:"问题",range:range,metrics:[],nutrition:false,goals:false,scopeKey:"scope",history:[]))
    }

    func testWeightPlanRecoveryAcknowledgesOnlyMatchingVersionAndFields() throws {
        let now = date("2026-11-17T02:00:00Z")
        let plan = try NativeWeightPlanRequest.plan(baseline:"75",target:"70",start:now,deadline:now.addingTimeInterval(90*86400),enabled:true,now:now)
        var fields = plan.objectValue; fields["expectedRevision"] = .number(7)
        let operation = NativeHealthWorkspaceMutation(path:"health/weight-plan",method:"PUT",body:.object(fields),label:"计划")
        var saved = plan.objectValue; saved["revision"] = .number(8)
        XCTAssertTrue(NativeWeightPlanRequest.matchesSaved(operation,response:.object(["settings":.object(saved)])))
        saved["targetWeight"] = .number(69)
        XCTAssertFalse(NativeWeightPlanRequest.matchesSaved(operation,response:.object(["settings":.object(saved)])))
        XCTAssertThrowsError(try NativeWeightPlanRequest.plan(baseline:"",target:"70",start:now,deadline:now.addingTimeInterval(86400),enabled:true,now:now))
    }

    func testWeeklyReviewInitialLinkAcceptsOnlyRealPastOrCurrentMondays() {
        let now = date("2026-11-17T02:00:00Z")
        XCTAssertEqual(NativeWeeklyReviewWeek.initial("2026-11-09",now:now),"2026-11-09")
        XCTAssertEqual(NativeWeeklyReviewWeek.initial("2026-11-16",now:now),"2026-11-16")
        for invalid in ["2026-11-17","2026-11-23","2026-02-30","2026-1-16","invalid"] {
            XCTAssertEqual(NativeWeeklyReviewWeek.initial(invalid,now:now),"2026-11-16")
        }
        XCTAssertFalse(NativeWeeklyReviewWeek.isMonday("2026-11-17"))
    }

    func testWeeklyActionRecoveryKeepsOriginalOwnerWeekRevisionAndBytesAfterMonday() throws {
        let sunday = date("2026-11-22T15:59:00Z"),monday = date("2026-11-22T16:01:00Z")
        let oldWeek = NativeActionDates.day(NativeActionDates.monday(sunday))
        XCTAssertNotEqual(oldWeek,NativeActionDates.day(NativeActionDates.monday(monday)))
        let baseline = NativeWeeklyActionCommand(weekStart:oldWeek,text:"饭后走动",status:.planned,feedback:"",expectedRevision:6)
        let original = NativeWeeklyActionCommand(weekStart:oldWeek,text:" 饭后走动三次 ",status:.completed,feedback:" 周末完成 ",expectedRevision:6)
        let frozen = NativeWeeklyActionRecovery(ownerID:"owner-a",command:original,baseline:baseline,submitted:true)
        let restored = try JSONDecoder().decode(NativeWeeklyActionRecovery.self,from:JSONEncoder().encode(frozen)).validated(ownerID:"owner-a")
        XCTAssertTrue(restored.submitted); XCTAssertEqual(restored.command.weekStart,"2026-11-16")
        XCTAssertEqual(restored.command.expectedRevision,6)
        XCTAssertEqual(try restored.command.encodedBody(),try original.encodedBody())
        XCTAssertThrowsError(try restored.validated(ownerID:"owner-b"))
        XCTAssertEqual(NativeWeeklyReviewWeek.initial(restored.command.weekStart,now:monday),"2026-11-16")
    }

    func testWeeklyRecoverySeparatesUnsubmittedIncompleteFieldsFromFrozenRequest() throws {
        let unfinished = NativeWeeklyActionCommand(weekStart:"2026-11-16",text:"",status:.planned,feedback:"尚未填写行动",expectedRevision:2)
        let draft = NativeWeeklyActionRecovery(ownerID:"owner",command:unfinished,baseline:nil,submitted:false)
        XCTAssertEqual(try draft.validated(ownerID:"owner").command,unfinished)
        XCTAssertThrowsError(try unfinished.encodedBody())
        XCTAssertThrowsError(try NativeWeeklyActionRecovery(ownerID:"owner",command:unfinished,baseline:nil,submitted:true).validated(ownerID:"owner"))
    }

    func testWeeklyLostResponseReconciliationRequiresNextRevisionAndExactSameWeekContent() {
        let original = NativeWeeklyActionCommand(weekStart:"2026-11-16",text:" 走动三次 ",status:.completed,feedback:" 已完成 ",expectedRevision:4)
        let matching = NativeWeeklyActionEntry(weekStart:"2026-11-16",text:"走动三次",status:.completed,feedback:"已完成",revision:5)
        XCTAssertTrue(original.matchesSaved(matching)); XCTAssertFalse(original.matchesSaved(nil))
        XCTAssertFalse(original.matchesSaved(NativeWeeklyActionEntry(weekStart:"2026-11-23",text:matching.text,status:matching.status,feedback:matching.feedback,revision:5)))
        XCTAssertFalse(original.matchesSaved(NativeWeeklyActionEntry(weekStart:matching.weekStart,text:matching.text,status:matching.status,feedback:matching.feedback,revision:6)))
        XCTAssertFalse(original.matchesSaved(NativeWeeklyActionEntry(weekStart:matching.weekStart,text:"另一设备的行动",status:matching.status,feedback:matching.feedback,revision:5)))
    }

    func testWeeklyUnfinishedRecoveryUsesEncryptedOwnerScopedPersistence() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let service = "weekly-recovery-tests-" + UUID().uuidString
        let owner = NativeWorkspacePersistence(userID:"owner-a",scope:"weekly-health-action",directory:directory,service:service)
        let other = NativeWorkspacePersistence(userID:"owner-b",scope:"weekly-health-action",directory:directory,service:service)
        defer { try? owner.clear(); try? other.clear(); try? FileManager.default.removeItem(at:directory) }
        let command = NativeWeeklyActionCommand(weekStart:"2026-11-16",text:"未提交的私密行动",status:.planned,feedback:"",expectedRevision:3)
        let draft = NativeWeeklyActionRecovery(ownerID:"owner-a",command:command,baseline:nil,submitted:false)
        try owner.save(draft)
        XCTAssertEqual(try owner.load(NativeWeeklyActionRecovery.self),draft)
        XCTAssertNil(try other.load(NativeWeeklyActionRecovery.self))
        let files = try FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:nil)
        XCTAssertEqual(files.count,1)
        let encrypted = try Data(contentsOf:files[0])
        XCTAssertNil(encrypted.range(of:Data(command.text.utf8)))
    }
}
