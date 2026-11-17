import SwiftUI
import Charts

struct NativeHealthWorkspaceRoot: View {
    let api: NativeAPI
    let token: String
    let userID: String
    var body: some View {
        List {
            Section("健康工作区") {
                NavigationLink("自选日期、来源与睡眠分析") { NativeHealthRangeWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("健康记录与修改历史") { NativeHealthRecordsWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("目标、生效历史与达成日历") { NativeHealthGoalsWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("体重计划与历史周期") { NativeWeightPlanWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("健康助手") { NativeHealthAssistantWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("同步诊断、文件导入与批次回退") { NativeHealthSyncWorkspace(api: api, token: token, userID: userID) }
            }
        }.navigationTitle("健康工作区")
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
    private var points: [NativeWorkspaceHealthPoint] {
        let rows = metric == "body_fat" ? data["bodyComposition"]["points"] : data["summary"]["metrics"][metric]["points"]
        return rows.arrayValue.compactMap(NativeWorkspaceHealthPoint.init).sorted { $0.day < $1.day }
    }
    var body: some View {
        List {
            Section("日期（北京时间）") {
                DatePicker("开始",selection:$from,in:...Date(),displayedComponents:.date)
                DatePicker("结束",selection:$to,in:...Date(),displayedComponents:.date)
                Button("读取此范围") { Task { await load() } }.disabled(busy)
                Picker("指标",selection:$metric) { ForEach(NativeHealthWorkspaceFormat.metricKeys + ["body_fat"],id:\.self) { Text(NativeHealthWorkspaceFormat.metric($0)).tag($0) } }
            }
            if let loadedRange {
                Section(loadedRange.label) {
                    Text("\(Set(points.map(\.day)).count) / \(loadedRange.days) 天有记录，缺失不补零。")
                    if let last = points.last { LabeledContent("最新值",value:NativeHealthWorkspaceFormat.number(last.value) + " " + NativeHealthWorkspaceFormat.unit(metric)) }
                    if !points.isEmpty { chart.frame(height:230) }
                    Button("导出相同日期的健康 JSON 文件") { Task { await export(loadedRange) } }.disabled(busy)
                }
                if metric == "sleep" { sleepSections }
                if metric == "body_fat" {
                    Section("配对依据") {
                        Text("仅配对同一来源且测量时刻完全相同的体重和去脂体重；估算值不是直接测得的体脂。")
                        LabeledContent("未配对体重",value:NativeHealthWorkspaceFormat.text(data["bodyComposition"]["unmatchedWeightCount"]))
                        LabeledContent("未配对去脂体重",value:NativeHealthWorkspaceFormat.text(data["bodyComposition"]["unmatchedLeanCount"]))
                        LabeledContent("无效配对",value:NativeHealthWorkspaceFormat.text(data["bodyComposition"]["invalidPairCount"]))
                    }
                }
                Section("每日值与真实来源") {
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
            if busy { ProgressView("读取中…") }
            NativeHealthWorkspaceMessage(message:message)
        }.navigationTitle("健康范围与来源")
            .environment(\.timeZone,NativeActionDates.timeZone)
            .task { if loadedRange == nil { await load() } }
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
                                BarMark(x:.value("日期",date),y:.value("小时",point.stages[key].doubleValue ?? 0))
                                    .foregroundStyle(by:.value("睡眠分期",stageLabel(key)))
                            }
                        } else { BarMark(x:.value("日期",date),y:.value("小时",point.value)).foregroundStyle(by:.value("睡眠分期","未分期")) }
                    } else { PointMark(x:.value("日期",date),y:.value("数值",point.value)).foregroundStyle(.teal) }
                }
            }
        }.accessibilityLabel("所选范围的" + NativeHealthWorkspaceFormat.metric(metric) + "，缺失日期留空")
    }
    @ViewBuilder private var sleepSections: some View {
        let summary = NativeWorkspaceSleepSummary(points)
        Section("主睡眠作息与规律") {
            LabeledContent("平均入睡",value:summary.onset ?? "暂无完整时刻")
            LabeledContent("入睡平均偏离",value:NativeHealthWorkspaceFormat.number(summary.onsetDeviation) + " 分钟")
            LabeledContent("平均起床",value:summary.wake ?? "暂无完整时刻")
            LabeledContent("起床平均偏离",value:NativeHealthWorkspaceFormat.number(summary.wakeDeviation) + " 分钟")
            Text("完整时刻 \(summary.timingDays) 天；窗口截断 \(summary.clippedDays) 天；分期 \(summary.stageDays) 天。跨午夜按圆周平均，至少2天才给出偏离；旧版总时长不推算时刻。")
                .font(.footnote).foregroundStyle(.secondary)
            ForEach(NativeWorkspaceSleepSummary.stageKeys,id:\.self) { key in LabeledContent(stageLabel(key) + "占比",value:NativeHealthWorkspaceFormat.number(summary.stages[key]) + "%") }
        }
        Section("真实时刻明细") {
            ForEach(points.reversed()) { point in
                VStack(alignment:.leading,spacing:4) {
                    Text(point.day).font(.headline)
                    Text("入睡 " + NativeHealthWorkspaceFormat.clock(point.timing["onset"].stringValue) + " · 起床 " + NativeHealthWorkspaceFormat.clock(point.timing["wake"].stringValue))
                    Text(point.timing["clipped"].boolValue == true ? "窗口截断，不参与规律性计算" : NativeWorkspaceSleepSummary.validTiming(point) == nil ? "仅有总时长，时刻未知" : "同来源最长主睡眠组的真实时刻").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        if let range = loadedRange, let first = NativeHealthWorkspaceFormat.date(range.from) {
            Section("分周规律与分期") {
                ForEach(Array(stride(from:0,to:range.days,by:7)),id:\.self) { offset in
                    let start = NativeActionDates.day(NativeActionDates.calendar.date(byAdding:.day,value:offset,to:first)!)
                    let end = NativeActionDates.day(NativeActionDates.calendar.date(byAdding:.day,value:min(offset+6,range.days-1),to:first)!)
                    let week = NativeWorkspaceSleepSummary(points.filter { $0.day >= start && $0.day <= end })
                    DisclosureGroup(start + " — " + end) {
                        Text("完整时刻 \(week.timingDays) 天 · " + (week.onset ?? "未知") + " / " + (week.wake ?? "未知"))
                        ForEach(NativeWorkspaceSleepSummary.stageKeys,id:\.self) { key in LabeledContent(stageLabel(key),value:NativeHealthWorkspaceFormat.number(week.stages[key]) + "%") }
                    }
                }
            }
        }
    }
    private func stageLabel(_ key: String) -> String { ["deep":"深度","core":"核心","rem":"REM","unspecified":"未分类"][key] ?? key }
    private func load() async {
        guard !busy else { return }; busy = true; message = nil; defer { busy = false }
        do {
            let range = try NativeHealthWorkspaceRange(from:from,to:to)
            let result = try await api.json(path:NativeHealthWorkspaceFormat.path("health",query:range.query),token:token)
            data = result; loadedRange = range
        } catch { message = error.localizedDescription }
    }
    private func export(_ range: NativeHealthWorkspaceRange) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let result = try await api.json(path:NativeHealthWorkspaceFormat.path("health/export",query:range.query),token:token)
            exportDocument = NativeHealthJSONDocument(data:try result.encodedData()); exporting = true
        } catch { message = error.localizedDescription }
    }
}
