import SwiftUI
import Charts

struct NativeHealthWorkspaceRoot: View {
    let api: NativeAPI
    let token: String
    let userID: String
    var body: some View {
        List {
            Section("了解自己的变化") {
                NavigationLink("健康趋势与睡眠") { NativeHealthRangeWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("查看与更正记录") { NativeHealthRecordsWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("每日目标") { NativeHealthGoalsWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("体重计划") { NativeWeightPlanWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("健康助手") { NativeHealthAssistantWorkspace(api: api, token: token, userID: userID) }
            }
        }.navigationTitle("健康")
    }
}

struct NativeWorkspaceHealthPoint: Identifiable {
    let day: String
    let value: Double
    let source: String?
    let measuredAt: String?
    let stages: NativeJSON
    let timing: NativeJSON
    var id: String { day }
    init?(_ row: NativeJSON) {
        guard let day = row["day"].stringValue, NativeHealthWorkspaceFormat.date(day) != nil,
              let value = row["value"].doubleValue, value.isFinite else { return nil }
        self.day = day; self.value = value; self.source = row["source"].stringValue
        self.measuredAt = row["measuredAt"].stringValue; self.stages = row["sleepStages"]; self.timing = row["sleepTiming"]
    }
}

struct NativeWorkspaceSleepSummary {
    let recordedDays: Int
    let timingDays: Int
    let clippedDays: Int
    let stageDays: Int
    let onset: String?
    let wake: String?
    let onsetDeviation: Double?
    let wakeDeviation: Double?
    let stages: [String:Double]

    static let stageKeys = ["deep", "core", "rem", "unspecified"]
    static func validTiming(_ point: NativeWorkspaceHealthPoint) -> (Date,Date)? {
        guard point.timing["method"].stringValue == "longest-sleep-group-v1",
              let onset = point.timing["onset"].stringValue.flatMap(NativeDates.parse),
              let wake = point.timing["wake"].stringValue.flatMap(NativeDates.parse), wake > onset else { return nil }
        return (onset,wake)
    }
    static func validStages(_ point: NativeWorkspaceHealthPoint) -> Bool {
        let keys = stageKeys + ["awake", "inBed"]
        return keys.allSatisfy { point.stages[$0].doubleValue.map { $0.isFinite && (0...24).contains($0) } ?? false }
            && abs(stageKeys.reduce(0) { $0 + (point.stages[$1].doubleValue ?? 0) } - point.value) < 0.00000001
    }
    static func circular(_ minutes: [Double]) -> (String?,Double?) {
        guard !minutes.isEmpty else { return (nil,nil) }
        let sine = minutes.reduce(0) { $0 + sin($1 / 1440 * 2 * .pi) }
        let cosine = minutes.reduce(0) { $0 + cos($1 / 1440 * 2 * .pi) }
        guard hypot(sine,cosine) / Double(minutes.count) >= 0.05 else { return (nil,nil) }
        let mean = (atan2(sine,cosine) / (2 * .pi) * 1440 + 1440).truncatingRemainder(dividingBy: 1440)
        let rounded = Int(mean.rounded()) % 1440
        let deviation = minutes.count < 2 ? nil : minutes.reduce(0) { total,value in total + min(abs(value-mean),1440-abs(value-mean)) } / Double(minutes.count)
        return (String(format:"%02d:%02d",rounded/60,rounded%60),deviation)
    }
    init(_ points: [NativeWorkspaceHealthPoint]) {
        recordedDays = points.count
        let timed = points.filter { Self.validTiming($0) != nil && $0.timing["clipped"].boolValue != true }
        timingDays = timed.count; clippedDays = points.filter { Self.validTiming($0) != nil && $0.timing["clipped"].boolValue == true }.count
        let staged = points.filter(Self.validStages); stageDays = staged.count
        func minute(_ date: Date) -> Double {
            Double(NativeActionDates.calendar.component(.hour, from: date)*60 + NativeActionDates.calendar.component(.minute, from: date))
        }
        let first = Self.circular(timed.compactMap { Self.validTiming($0).map { minute($0.0) } })
        let last = Self.circular(timed.compactMap { Self.validTiming($0).map { minute($0.1) } })
        onset = first.0; onsetDeviation = first.1; wake = last.0; wakeDeviation = last.1
        let sums = Dictionary(uniqueKeysWithValues:Self.stageKeys.map { key in (key,staged.reduce(0) { $0 + ($1.stages[key].doubleValue ?? 0) }) })
        let total = sums.values.reduce(0,+)
        stages = total > 0 ? sums.mapValues { $0 / total * 100 } : [:]
    }
}

struct NativeHealthPeriodStatistics: Equatable {
    let recordedDays: Int
    let totalDays: Int
    let recordedDayMean: Double?

    init(points: [NativeWorkspaceHealthPoint],range: NativeHealthWorkspaceRange) {
        var daily: [String:Double] = [:]
        for point in points where point.day >= range.from && point.day <= range.to && point.value.isFinite {
            daily[point.day] = point.value
        }
        recordedDays = daily.count; totalDays = range.days
        recordedDayMean = daily.isEmpty ? nil:daily.values.reduce(0,+) / Double(daily.count)
    }
}

enum NativeHealthChartCalendar {
    static func domain(_ range: NativeHealthWorkspaceRange) -> ClosedRange<Date> {
        let first = NativeHealthWorkspaceFormat.date(range.from)!
        let last = NativeHealthWorkspaceFormat.date(range.to)!
        let end = NativeActionDates.calendar.date(byAdding: .day, value: 1, to: last)!
        return first...end
    }
    static func ticks(_ range: NativeHealthWorkspaceRange) -> [Date] {
        let start = domain(range).lowerBound
        let last = range.days - 1
        let offsets = Set([0, last / 3, last * 2 / 3, last]).sorted()
        return offsets.compactMap { NativeActionDates.calendar.date(byAdding: .day, value: $0, to: start) }
    }
}

enum NativeHealthPeriodComparison {
    static func previousRange(for current: NativeHealthWorkspaceRange,now: Date = Date()) throws -> NativeHealthWorkspaceRange {
        guard let start = NativeHealthWorkspaceFormat.date(current.from),
              let previousStart = NativeActionDates.calendar.date(byAdding:.day,value:-current.days,to:start),
              let previousEnd = NativeActionDates.calendar.date(byAdding:.day,value:-1,to:start) else {
            throw NativeHealthWorkspaceError.invalid("无法读取上一时段，请调整日期。")
        }
        return try NativeHealthWorkspaceRange(from:previousStart,to:previousEnd,now:now)
    }
    static func points(in response: NativeJSON,metric: String) -> [NativeWorkspaceHealthPoint] {
        let rows: NativeJSON = metric == "body_fat" ? response["bodyComposition"]["points"]:response["summary"]["metrics"][metric]["points"]
        return rows.arrayValue.compactMap(NativeWorkspaceHealthPoint.init).sorted { $0.day < $1.day }
    }
}

private struct NativeHealthPeriodComparisonSnapshot {
    let metric: String
    let currentRange: NativeHealthWorkspaceRange
    let previousRange: NativeHealthWorkspaceRange
    let current: NativeHealthPeriodStatistics
    let previous: NativeHealthPeriodStatistics
    var meanDifference: Double? {
        guard let current = current.recordedDayMean,let previous = previous.recordedDayMean else { return nil }
        return current - previous
    }
}

struct NativeHealthRangeWorkspace: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @State private var from = NativeActionDates.calendar.date(byAdding:.day,value:-29,to:Date())!
    @State private var to = Date()
    @State private var metric = "steps"
    @State private var data: NativeJSON = .null
    @State private var loadedRange: NativeHealthWorkspaceRange?
    @State private var busy = false
    @State private var message: String?
    @State private var exportDocument: NativeHealthJSONDocument?
    @State private var exporting = false
    @State private var editingRange = false
    @State private var entryMetric: QuickEntryMetric?
    @State private var choosingEntryMetric = false
    @State private var inspectedDate: Date?
    @State private var goalSettings: NativeGoalSettings?
    @State private var goalMessage: String?
    @State private var comparison: NativeHealthPeriodComparisonSnapshot?
    @State private var comparisonMessage: String?
    @State private var comparisonExpanded = false
    @State private var comparing = false
    @State private var readGeneration = UUID()
    @State private var comparisonGeneration = UUID()
    @State private var goalGeneration = UUID()
    init(api: NativeAPI,token: String,userID: String,initialMetric: String? = nil,initialFrom: String? = nil,initialTo: String? = nil) {
        self.api = api; self.token = token; self.userID = userID
        let end: Date = initialTo.flatMap(NativeHealthWorkspaceFormat.date) ?? Date()
        let start: Date = initialFrom.flatMap(NativeHealthWorkspaceFormat.date) ?? NativeActionDates.calendar.date(byAdding:.day,value:-29,to:end)!
        _from = State(initialValue:start); _to = State(initialValue:end)
        let allowed: [String] = NativeHealthWorkspaceFormat.metricKeys + ["body_fat"]
        _metric = State(initialValue:initialMetric.flatMap { allowed.contains($0) ? $0:nil } ?? "steps")
    }
    private var points: [NativeWorkspaceHealthPoint] {
        NativeHealthPeriodComparison.points(in:data,metric:metric)
    }
    var body: some View {
        List {
            Section {
                Picker("指标",selection:$metric) {
                    ForEach(NativeHealthWorkspaceFormat.metricKeys + ["body_fat"],id:\.self) { Text(NativeHealthWorkspaceFormat.metric($0)).tag($0) }
                }.disabled(busy)
                Menu {
                    ForEach([7,30,90,180,360],id:\.self) { days in Button("最近\(days)天") { selectRecentDays(days) } }
                    Button("自定日期…") { editingRange = true }
                } label: { Label(rangeSelectionLabel,systemImage:"calendar") }
                .disabled(busy)
            }
            if busy { Section { ProgressView("正在读取所选范围…") } }
            NativeHealthWorkspaceMessage(message:message)
            if let loadedRange {
                Section(loadedRange.label) {
                    Text("\(Set(points.map(\.day)).count) / \(loadedRange.days) 天有记录，缺失不补零。")
                    if let last = points.last { LabeledContent("最新值",value:NativeHealthWorkspaceFormat.number(last.value) + " " + NativeHealthWorkspaceFormat.unit(metric)) }
                    if !points.isEmpty { chart.frame(height:230) }
                    inspectedDayReadout
                    goalReference
                    if metric != "body_fat" {
                        NavigationLink("查看这段记录") {
                            NativeHealthRecordsWorkspace(api:api,token:token,userID:userID,initialMetric:metric,initialFrom:loadedRange.from,initialTo:loadedRange.to)
                        }
                        NavigationLink {
                            NativeHealthAssistantWorkspace(api:api,token:token,userID:userID,initialMetric:metric,initialFrom:loadedRange.from,initialTo:loadedRange.to,initialQuestion:"这段记录有哪些值得关注的变化？")
                        } label: { Label("问问这段记录",systemImage:"sparkles") }
                    } else { Text("估算体脂暂不支持助手分析。").font(.caption).foregroundStyle(.secondary) }
                    DisclosureGroup("导出与数据说明") {
                        Button("导出此范围的健康记录") { Task { await export(loadedRange) } }.disabled(busy)
                        Text("导出包含相同日期内的健康记录，未知值保持未知。").font(.caption).foregroundStyle(.secondary)
                    }
                }
                comparisonSection
                if metric == "sleep" { sleepSections }
                if metric == "body_fat" {
                    Section("配对依据") {
                        Text("仅配对同一来源且测量时刻完全相同的体重和去脂体重；估算值不是直接测得的体脂。")
                        LabeledContent("未配对体重",value:NativeHealthWorkspaceFormat.text(data["bodyComposition"]["unmatchedWeightCount"]))
                        LabeledContent("未配对去脂体重",value:NativeHealthWorkspaceFormat.text(data["bodyComposition"]["unmatchedLeanCount"]))
                        LabeledContent("无效配对",value:NativeHealthWorkspaceFormat.text(data["bodyComposition"]["invalidPairCount"]))
                    }
                }
                Section {
                    DisclosureGroup("每日记录与来源") {
                    ForEach(points.reversed()) { point in
                        VStack(alignment:.leading,spacing:5) {
                            LabeledContent(point.day,value:NativeHealthWorkspaceFormat.number(point.value) + " " + NativeHealthWorkspaceFormat.unit(metric))
                            Text(point.source ?? "来源未知").font(.caption).foregroundStyle(.secondary)
                            if let stamp = point.measuredAt { Text(stamp).font(.caption2).foregroundStyle(.secondary) }
                        }
                    }
                    if points.isEmpty { Text("所选指标在此范围没有记录。") }
                    }
                }
            }
        }.navigationTitle("健康趋势")
            .environment(\.timeZone,NativeActionDates.timeZone)
            .toolbar {
                ToolbarItem(placement:.topBarTrailing) {
                    Button { beginQuickEntry() } label: { Image(systemName:"plus") }
                        .accessibilityLabel("补记健康数据").disabled(busy)
                }
            }
            .task { if loadedRange == nil { await load() }; await loadCurrentGoals() }
            .onChange(of:metric) { _,_ in inspectedDate = nil; invalidateComparison() }
            .sheet(isPresented:$editingRange) {
                NativeHealthDateRangeEditor(from:from,to:to) { first,last in from = first; to = last; Task { await load() } }
            }
            .sheet(item:$entryMetric) { selected in
                HealthQuickEntryView(api:api,token:token,userID:userID,initialMetric:selected) { await load() }
            }
            .confirmationDialog("选择要补记的原始指标",isPresented:$choosingEntryMetric,titleVisibility:.visible) {
                Button("体重") { entryMetric = .weight }
                Button("去脂体重") { entryMetric = .leanBodyMass }
                Button("取消",role:.cancel) { }
            } message: { Text("估算体脂由体重和去脂体重计算，不能直接补记。请选择实际测量的指标。") }
            .fileExporter(isPresented:$exporting,document:exportDocument,contentType:.json,defaultFilename:"jiashu-health-\(loadedRange?.from ?? "")_\(loadedRange?.to ?? "")") { result in
                if case .failure(let error) = result { message = error.localizedDescription }
            }
    }
    private var chart: some View {
        Chart {
            ForEach(points) { point in
                if let date = NativeHealthWorkspaceFormat.date(point.day) {
                    if metric == "sleep" {
                        if NativeWorkspaceSleepSummary.validStages(point) {
                            ForEach(NativeWorkspaceSleepSummary.stageKeys,id:\.self) { key in
                                BarMark(x:.value("日期",date,unit:.day,calendar:NativeActionDates.calendar),y:.value("小时",point.stages[key].doubleValue ?? 0))
                                    .foregroundStyle(by:.value("睡眠分期",stageLabel(key)))
                            }
                        } else { BarMark(x:.value("日期",date,unit:.day,calendar:NativeActionDates.calendar),y:.value("小时",point.value)).foregroundStyle(by:.value("睡眠分期","未分期")) }
                    } else if metric == "steps" || metric == "active_energy" {
                        BarMark(x:.value("日期",date,unit:.day,calendar:NativeActionDates.calendar),y:.value("数值",point.value)).foregroundStyle(.teal)
                    } else {
                        LineMark(x:.value("日期",date),y:.value("数值",point.value)).foregroundStyle(.teal)
                        PointMark(x:.value("日期",date),y:.value("数值",point.value)).foregroundStyle(.teal)
                    }
                }
            }
            if let target = currentGoal {
                RuleMark(y:.value("当前目标（参考）",target))
                    .foregroundStyle(.secondary).lineStyle(StrokeStyle(lineWidth:1,dash:[5,4]))
            }
            if let inspectedDate {
                RuleMark(x:.value("选中日期",NativeActionDates.calendar.startOfDay(for:inspectedDate)))
                    .foregroundStyle(.secondary).lineStyle(StrokeStyle(lineWidth:1))
            }
        }
        .chartXScale(domain: chartDomain)
        .chartXAxis {
            AxisMarks(values: loadedRange.map(NativeHealthChartCalendar.ticks) ?? []) { value in
                AxisGridLine()
                AxisTick()
                if let date = value.as(Date.self) {
                    AxisValueLabel(anchor: value.index == 0 ? .topLeading : value.index == value.count - 1 ? .topTrailing : .top) {
                        Text(NativeActionDates.formatted(date, pattern: "M/d")).fixedSize()
                    }
                }
            }
        }
        .chartXSelection(value:$inspectedDate)
        .accessibilityLabel("所选范围的" + NativeHealthWorkspaceFormat.metric(metric) + "，缺失日期留空")
    }
    private var chartDomain: ClosedRange<Date> {
        if let loadedRange { return NativeHealthChartCalendar.domain(loadedRange) }
        let start = NativeActionDates.calendar.startOfDay(for: Date())
        return start...start.addingTimeInterval(86_400)
    }
    @ViewBuilder private var inspectedDayReadout: some View {
        if let inspectedDate {
            let day: String = NativeActionDates.day(inspectedDate)
            let point: NativeWorkspaceHealthPoint? = points.first { $0.day == day }
            let unit: String = NativeHealthWorkspaceFormat.unit(metric)
            let value: String = point.map { NativeHealthWorkspaceFormat.number($0.value) + " " + unit } ?? "暂无记录"
            let announcement: String = "选中 \(day)，\(value)"
            LabeledContent(day,value:value).font(.subheadline)
                .accessibilityElement(children:.combine).accessibilityLabel(announcement).accessibilityAddTraits(.updatesFrequently)
        }
    }
    private var supportsGoalReference: Bool { ["steps","sleep","active_energy"].contains(metric) }
    private var currentGoal: Double? {
        let value: Double?
        switch metric {
        case "steps": value = goalSettings?.targets.steps
        case "sleep": value = goalSettings?.targets.sleep
        case "active_energy": value = goalSettings?.targets.activeEnergy
        default: value = nil
        }
        guard let value,value.isFinite,value > 0 else { return nil }; return value
    }
    @ViewBuilder private var goalReference: some View {
        if supportsGoalReference {
            if let target = currentGoal {
                let unit: String = NativeHealthWorkspaceFormat.unit(metric)
                let value: String = NativeHealthWorkspaceFormat.number(target) + " " + unit
                LabeledContent("当前目标（参考）",value:value).font(.footnote)
                DisclosureGroup("目标说明") { Text("虚线是当前目标，不代表历史达标情况。").font(.caption).foregroundStyle(.secondary) }
            } else if goalSettings != nil { Text("尚未设置此指标的每日目标。").font(.caption).foregroundStyle(.secondary) }
            if let goalMessage { Text(goalMessage).font(.caption).foregroundStyle(.secondary) }
            NavigationLink("目标与生效历史") { NativeHealthGoalsWorkspace(api:api,token:token,userID:userID) }
        }
    }
    @ViewBuilder private var comparisonSection: some View {
        if let loadedRange {
            Section {
                DisclosureGroup("对比上一时段",isExpanded:$comparisonExpanded) {
                    if let comparison,comparison.currentRange == loadedRange,comparison.metric == metric {
                        comparisonContents(comparison)
                    }
                    if comparing { ProgressView("读取上一时段…") }
                    if let comparisonMessage { Text(comparisonMessage).font(.footnote).foregroundStyle(.secondary) }
                    Button(comparison == nil ? "读取并对比":"重新对比") { Task { await comparePreviousPeriod() } }
                        .disabled(busy || comparing)
                }
            }
        }
    }
    private func comparisonContents(_ snapshot: NativeHealthPeriodComparisonSnapshot) -> some View {
        let unit: String = NativeHealthWorkspaceFormat.unit(snapshot.metric)
        let difference: String
        if let delta = snapshot.meanDifference {
            let sign: String = delta > 0 ? "+":""
            let number: String = NativeHealthWorkspaceFormat.number(delta)
            difference = "\(sign)\(number) \(unit)"
        } else { difference = "暂无可比日均" }
        return VStack(alignment:.leading,spacing:12) {
            comparisonPeriodRow("当前时段",range:snapshot.currentRange,stats:snapshot.current,unit:unit)
            comparisonPeriodRow("上一时段",range:snapshot.previousRange,stats:snapshot.previous,unit:unit)
            LabeledContent("记录日均差值",value:difference)
            Text("均值只用有记录的日期，缺失不补0。两期覆盖不同，差值不能直接代表改善或下降，也不说明变化原因。")
                .font(.caption).foregroundStyle(.secondary)
            if snapshot.currentRange.to == NativeActionDates.day(Date()) {
                Text("今天尚未结束，今日记录仍可能更新。").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private func comparisonPeriodRow(_ title: String,range: NativeHealthWorkspaceRange,stats: NativeHealthPeriodStatistics,unit: String) -> some View {
        let mean: String = NativeHealthWorkspaceFormat.number(stats.recordedDayMean)
        let amount: String = "\(mean) \(unit)"
        let coverage: String = "有记录 \(stats.recordedDays) / \(stats.totalDays) 天"
        return VStack(alignment:.leading,spacing:4) {
            Text(title).font(.subheadline.weight(.semibold))
            Text(range.label).font(.caption).foregroundStyle(.secondary)
            LabeledContent("有记录日均",value:amount)
            Text(coverage).font(.caption).foregroundStyle(.secondary)
        }
    }
    @ViewBuilder private var sleepSections: some View {
        sleepSummarySection
        sleepTimingSection
        if loadedRange != nil { sleepWeeklySection }
    }
    private var sleepSummarySection: some View {
        let summary = NativeWorkspaceSleepSummary(points)
        let onset: String = summary.onset ?? "暂无完整时刻"
        let wake: String = summary.wake ?? "暂无完整时刻"
        let onsetDeviation: String = NativeHealthWorkspaceFormat.number(summary.onsetDeviation) + " 分钟"
        let wakeDeviation: String = NativeHealthWorkspaceFormat.number(summary.wakeDeviation) + " 分钟"
        let coverage: String = "完整时刻 \(summary.timingDays) 天；窗口截断 \(summary.clippedDays) 天；分期 \(summary.stageDays) 天。跨午夜按圆周平均，至少2天才给出偏离；旧版总时长不推算时刻。"
        return Section("主睡眠作息与规律") {
            LabeledContent("平均入睡",value:onset)
            LabeledContent("入睡平均偏离",value:onsetDeviation)
            LabeledContent("平均起床",value:wake)
            LabeledContent("起床平均偏离",value:wakeDeviation)
            Text(coverage).font(.footnote).foregroundStyle(.secondary)
            ForEach(NativeWorkspaceSleepSummary.stageKeys,id:\.self) { key in sleepStageRow(key,summary:summary,suffix:"占比") }
        }
    }
    private var sleepTimingSection: some View {
        Section {
            DisclosureGroup("真实睡眠时刻") { ForEach(points.reversed()) { point in sleepTimingRow(point) } }
        }
    }
    private func sleepTimingRow(_ point: NativeWorkspaceHealthPoint) -> some View {
        let onset: String = NativeHealthWorkspaceFormat.clock(point.timing["onset"].stringValue)
        let wake: String = NativeHealthWorkspaceFormat.clock(point.timing["wake"].stringValue)
        let detail: String = "入睡 \(onset) · 起床 \(wake)"
        let timingStatus: String
        if point.timing["clipped"].boolValue == true { timingStatus = "窗口截断，不参与规律性计算" }
        else if NativeWorkspaceSleepSummary.validTiming(point) == nil { timingStatus = "仅有总时长，时刻未知" }
        else { timingStatus = "同来源最长主睡眠组的真实时刻" }
        return VStack(alignment:.leading,spacing:4) {
            Text(point.day).font(.headline)
            Text(detail)
            Text(timingStatus).font(.caption).foregroundStyle(.secondary)
        }
    }
    private struct SleepWeek: Identifiable {
        let from: String
        let to: String
        let summary: NativeWorkspaceSleepSummary
        var id: String { from }
    }
    private var sleepWeeks: [SleepWeek] {
        guard let range = loadedRange,let first = NativeHealthWorkspaceFormat.date(range.from) else { return [] }
        let source: [NativeWorkspaceHealthPoint] = points
        return stride(from:0,to:range.days,by:7).map { offset -> SleepWeek in
            let startDate: Date = NativeActionDates.calendar.date(byAdding:.day,value:offset,to:first)!
            let endDate: Date = NativeActionDates.calendar.date(byAdding:.day,value:min(offset+6,range.days-1),to:first)!
            let start: String = NativeActionDates.day(startDate)
            let end: String = NativeActionDates.day(endDate)
            let daily: [NativeWorkspaceHealthPoint] = source.filter { $0.day >= start && $0.day <= end }
            return SleepWeek(from:start,to:end,summary:NativeWorkspaceSleepSummary(daily))
        }
    }
    private var sleepWeeklySection: some View {
        Section {
            DisclosureGroup("分周作息与分期") { ForEach(sleepWeeks) { week in sleepWeekRow(week) } }
        }
    }
    private func sleepWeekRow(_ week: SleepWeek) -> some View {
        let title: String = "\(week.from) — \(week.to)"
        let onset: String = week.summary.onset ?? "未知"
        let wake: String = week.summary.wake ?? "未知"
        let detail: String = "完整时刻 \(week.summary.timingDays) 天 · \(onset) / \(wake)"
        return DisclosureGroup(title) {
            Text(detail)
            ForEach(NativeWorkspaceSleepSummary.stageKeys,id:\.self) { key in sleepStageRow(key,summary:week.summary,suffix:"") }
        }
    }
    private func sleepStageRow(_ key: String,summary: NativeWorkspaceSleepSummary,suffix: String) -> some View {
        let title: String = stageLabel(key) + suffix
        let percent: String = NativeHealthWorkspaceFormat.number(summary.stages[key]) + "%"
        return LabeledContent(title,value:percent)
    }
    private var rangeSelectionLabel: String {
        let calendar = NativeActionDates.calendar
        let end = calendar.startOfDay(for:to)
        let today = calendar.startOfDay(for:Date())
        let count = (calendar.dateComponents([.day],from:calendar.startOfDay(for:from),to:end).day ?? -1) + 1
        if end == today && [7,30,90,180,360].contains(count) { return "最近\(count)天" }
        return "自定日期"
    }
    private func selectRecentDays(_ days: Int) {
        let end = Date()
        from = NativeActionDates.calendar.date(byAdding:.day,value:1-days,to:end)!
        to = end
        Task { await load() }
    }
    private func beginQuickEntry() {
        guard !busy else { return }
        if let selected = QuickEntryMetric(rawValue:metric) { entryMetric = selected }
        else { choosingEntryMetric = true }
    }
    private func stageLabel(_ key: String) -> String { ["deep":"深度","core":"核心","rem":"REM","unspecified":"未分类"][key] ?? key }
    private func invalidateComparison() {
        comparisonGeneration = UUID(); comparison = nil; comparisonMessage = nil; comparing = false
    }
    private func load() async {
        guard !busy else { return }
        let generation = UUID(),requestedMetric = metric
        readGeneration = generation; busy = true; message = nil; invalidateComparison()
        defer { if readGeneration == generation { busy = false } }
        do {
            let range = try NativeHealthWorkspaceRange(from:from,to:to)
            let result = try await api.json(path:NativeHealthWorkspaceFormat.path("health",query:range.query),token:token)
            guard !Task.isCancelled,readGeneration == generation,metric == requestedMetric,
                  NativeActionDates.day(from) == range.from,NativeActionDates.day(to) == range.to else { return }
            guard result["range"]["from"].stringValue == range.from, result["range"]["to"].stringValue == range.to else { throw NativeAPIError.invalidResponse }
            data = result; loadedRange = range; inspectedDate = nil
        } catch { if readGeneration == generation,!Task.isCancelled { message = error.localizedDescription } }
    }
    private func loadCurrentGoals() async {
        guard !Task.isCancelled else { return }
        let generation = UUID(); goalGeneration = generation
        do {
            let result = try await api.goals(token:token)
            guard !Task.isCancelled,goalGeneration == generation else { return }
            goalSettings = result; goalMessage = nil
        } catch {
            if goalGeneration == generation,!Task.isCancelled { goalSettings = nil; goalMessage = "目标参考暂时无法读取。" }
        }
    }
    private func comparePreviousPeriod() async {
        guard !busy,!comparing,let range = loadedRange else { return }
        let requestedMetric = metric,generation = UUID()
        let currentPoints: [NativeWorkspaceHealthPoint] = points
        comparisonGeneration = generation; comparing = true; comparisonMessage = nil
        defer { if comparisonGeneration == generation { comparing = false } }
        do {
            let previous = try NativeHealthPeriodComparison.previousRange(for:range)
            let response = try await api.json(path:NativeHealthWorkspaceFormat.path("health",query:previous.query),token:token)
            guard !Task.isCancelled,comparisonGeneration == generation,metric == requestedMetric,loadedRange == range else { return }
            guard response["range"]["from"].stringValue == previous.from,response["range"]["to"].stringValue == previous.to else { throw NativeAPIError.invalidResponse }
            let previousPoints: [NativeWorkspaceHealthPoint] = NativeHealthPeriodComparison.points(in:response,metric:requestedMetric)
            comparison = NativeHealthPeriodComparisonSnapshot(metric:requestedMetric,currentRange:range,previousRange:previous,
                current:NativeHealthPeriodStatistics(points:currentPoints,range:range),previous:NativeHealthPeriodStatistics(points:previousPoints,range:previous))
        } catch {
            if comparisonGeneration == generation,!Task.isCancelled { comparisonMessage = error.localizedDescription }
        }
    }
    private func export(_ range: NativeHealthWorkspaceRange) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let result = try await api.json(path:NativeHealthWorkspaceFormat.path("health/export",query:range.query),token:token)
            exportDocument = NativeHealthJSONDocument(data:try result.encodedData()); exporting = true
        } catch { message = error.localizedDescription }
    }
}

private struct NativeHealthDateRangeEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var from: Date
    @State private var to: Date
    @State private var message: String?
    let onApply: (Date,Date) -> Void
    init(from: Date,to: Date,onApply: @escaping (Date,Date) -> Void) {
        _from = State(initialValue:from); _to = State(initialValue:to); self.onApply = onApply
    }
    var body: some View {
        NavigationStack {
            Form {
                DatePicker("开始日期",selection:$from,in:...Date(),displayedComponents:.date)
                DatePicker("结束日期",selection:$to,in:...Date(),displayedComponents:.date)
                Text("最多选择360天，包含开始与结束当天。日期按北京时间统计。").font(.footnote).foregroundStyle(.secondary)
                if let message { Text(message).foregroundStyle(.red) }
            }.navigationTitle("查看哪段时间")
                .navigationBarTitleDisplayMode(.inline)
                .environment(\.timeZone,NativeActionDates.timeZone)
                .toolbar {
                    ToolbarItem(placement:.cancellationAction) { Button("取消") { dismiss() } }
                    ToolbarItem(placement:.confirmationAction) {
                        Button("查看") {
                            do { _ = try NativeHealthWorkspaceRange(from:from,to:to); onApply(from,to); dismiss() }
                            catch { message = error.localizedDescription }
                        }
                    }
                }
        }
    }
}
