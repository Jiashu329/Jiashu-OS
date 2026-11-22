import SwiftUI
import Charts

struct NativeHealthWorkspaceRoot: View {
    let api: NativeAPI
    let token: String
    let userID: String
    var body: some View {
        List {
            Section("了解自己的变化") {
                NavigationLink("健康趋势") { NativeHealthRangeWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("查看与更正记录") { NativeHealthRecordsWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("每日目标") { NativeHealthGoalsWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("体重计划") { NativeWeightPlanWorkspace(api: api, token: token, userID: userID) }
                NavigationLink("健康助手") { NativeHealthAssistantWorkspace(api: api, token: token, userID: userID) }
            }
        }.nativeGeometricPage().navigationTitle("健康")
    }
}

struct NativeWorkspaceHealthPoint: Identifiable {
    let day: String
    let value: Double
    let source: String?
    let measuredAt: String?
    let stages: NativeJSON
    let timing: NativeJSON
    let bounds: ClosedRange<Double>?
    var id: String { day }
    init?(_ row: NativeJSON) {
        guard let day = row["day"].stringValue, NativeHealthWorkspaceFormat.date(day) != nil,
              let value = row["value"].doubleValue, value.isFinite else { return nil }
        self.day = day; self.value = value; self.source = row["source"].stringValue
        self.measuredAt = row["measuredAt"].stringValue; self.stages = row["sleepStages"]; self.timing = row["sleepTiming"]
        self.bounds = nil
    }

    init(day: String, value: Double, measuredAt: String? = nil, bounds: ClosedRange<Double>? = nil) {
        self.day = day
        self.value = value
        self.measuredAt = measuredAt
        self.bounds = bounds
        self.source = "苹果健康"
        self.stages = .null
        self.timing = .null
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

/// One accepted response owns both its dates and its observations.
struct NativeHealthTrendSnapshot {
    let response: NativeJSON
    let range: NativeHealthWorkspaceRange
    private let metrics: [String: [NativeWorkspaceHealthPoint]]

    init(response: NativeJSON, range: NativeHealthWorkspaceRange) throws {
        guard response["range"]["from"].stringValue == range.from,
              response["range"]["to"].stringValue == range.to else { throw NativeAPIError.invalidResponse }
        self.response = response
        self.range = range
        var result: [String: [NativeWorkspaceHealthPoint]] = [:]
        for metric in NativeHealthWorkspaceFormat.metricKeys + ["body_fat"] {
            var daily: [String: NativeWorkspaceHealthPoint] = [:]
            for point in NativeHealthPeriodComparison.points(in: response, metric: metric)
                where point.day >= range.from && point.day <= range.to {
                daily[point.day] = point
            }
            result[metric] = daily.keys.sorted().compactMap { daily[$0] }
        }
        metrics = result
    }

    func points(metric: String) -> [NativeWorkspaceHealthPoint] { metrics[metric] ?? [] }
}

enum NativeHealthTrendSelection {
    static func day(_ candidate: Date?, points: [NativeWorkspaceHealthPoint], range: NativeHealthWorkspaceRange) -> String {
        if let candidate {
            let day = NativeActionDates.day(candidate)
            return min(range.to, max(range.from, day))
        }
        return points.last(where: { $0.day >= range.from && $0.day <= range.to })?.day ?? range.to
    }

    static func segments(_ points: [NativeWorkspaceHealthPoint]) -> [[NativeWorkspaceHealthPoint]] {
        var result: [[NativeWorkspaceHealthPoint]] = []
        var current: [NativeWorkspaceHealthPoint] = []
        for point in points.sorted(by: { $0.day < $1.day }) {
            if let previous = current.last,
               let date = NativeHealthWorkspaceFormat.date(previous.day),
               let next = NativeActionDates.calendar.date(byAdding: .day, value: 1, to: date),
               NativeActionDates.day(next) != point.day {
                result.append(current)
                current = []
            }
            current.append(point)
        }
        if !current.isEmpty { result.append(current) }
        return result
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
    private struct AppleReadScope: Equatable {
        let range: NativeHealthWorkspaceRange?
        let updatedAt: String?
    }

    private struct AppleReadIssue {
        let range: NativeHealthWorkspaceRange
        let message: String
        let canRetry: Bool
    }

    let api: NativeAPI
    let token: String
    let userID: String
    let appleActivityLastSync: String?
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var from = NativeActionDates.calendar.date(byAdding: .day, value: -29, to: Date())!
    @State private var to = Date()
    @State private var metric = "steps"
    @State private var snapshot: NativeHealthTrendSnapshot?
    @State private var appleSnapshot: NativeAppleActivityResponse?
    @State private var appleReadIssue: AppleReadIssue?
    @State private var appleReadGeneration = UUID()
    @State private var busy = false
    @State private var readMessage: String?
    @State private var actionMessage: String?
    @State private var exportDocument: NativeHealthJSONDocument?
    @State private var exportFilename = "jiashu-health"
    @State private var exporting = false
    @State private var preparingExport = false
    @State private var editingRange = false
    @State private var editingInspectedDay = false
    @State private var showingDailyDetails = false
    @State private var expandedWorkoutID: String?
    @State private var expandedDayWorkoutID: String?
    @State private var pendingWorkoutNavigation: Bool
    @State private var entryMetric: QuickEntryMetric?
    @State private var choosingEntryMetric = false
    @State private var inspectedDate: Date?
    @State private var recordContext: NativeHealthRecordDayContext?
    @State private var recordsPresented = false
    @State private var needsRecordsRefresh = false
    @State private var goalSettings: NativeGoalSettings?
    @State private var goalMessage: String?
    @State private var comparison: NativeHealthPeriodComparisonSnapshot?
    @State private var comparisonMessage: String?
    @State private var showingComparison = false
    @State private var showingPairing = false
    @State private var comparing = false
    @State private var readGeneration = UUID()
    @State private var comparisonGeneration = UUID()
    @State private var goalGeneration = UUID()

    init(api: NativeAPI, token: String, userID: String, initialMetric: String? = nil, initialFrom: String? = nil,
         initialTo: String? = nil, initialTopic: NativeHealthTrendTopic? = nil, initialDay: String? = nil,
         initialWorkoutID: String? = nil, appleActivityLastSync: String? = nil) {
        self.api = api; self.token = token; self.userID = userID
        self.appleActivityLastSync = appleActivityLastSync
        let now = Date()
        let defaultStart = NativeActionDates.calendar.date(byAdding: .day, value: -29, to: now)!
        let day = initialDay.flatMap(NativeHealthWorkspaceFormat.date).flatMap {
            $0 <= now ? $0 : nil
        }
        let end = initialTo.flatMap(NativeHealthWorkspaceFormat.date)
            ?? day.flatMap { $0 < NativeActionDates.calendar.startOfDay(for: defaultStart) ? $0 : nil } ?? now
        let start = initialFrom.flatMap(NativeHealthWorkspaceFormat.date)
            ?? NativeActionDates.calendar.date(byAdding: .day, value: -29, to: end)!
        let range = try? NativeHealthWorkspaceRange(from: start, to: end, now: now)
        _from = State(initialValue: range == nil ? defaultStart : start)
        _to = State(initialValue: range == nil ? now : end)
        let selectedTopic = initialTopic ?? (initialWorkoutID == nil ? NativeHealthTrendTopic.forMetric(initialMetric) : .activity)
        _metric = State(initialValue: initialMetric.flatMap { selectedTopic.metrics.contains($0) ? $0 : nil } ?? selectedTopic.defaultMetric)
        _inspectedDate = State(initialValue: day)
        _showingDailyDetails = State(initialValue: day != nil)
        _expandedWorkoutID = State(initialValue: initialWorkoutID)
        _pendingWorkoutNavigation = State(initialValue: initialMetric == "workouts" || initialWorkoutID != nil)
    }

    private var data: NativeJSON { snapshot?.response ?? .null }
    private var loadedRange: NativeHealthWorkspaceRange? { snapshot?.range }
    private var topic: NativeHealthTrendTopic { NativeHealthTrendTopic.forMetric(metric) }
    private var isVitalMetric: Bool { topic == .heart || topic == .oxygen }
    private var points: [NativeWorkspaceHealthPoint] { currentPoints(metric) }
    private var requestedRange: NativeHealthWorkspaceRange? { try? NativeHealthWorkspaceRange(from: from, to: to) }
    private var hasCurrentRange: Bool { requestedRange != nil && requestedRange == loadedRange }
    private var currentAppleSnapshot: NativeAppleActivityResponse? {
        guard let range = requestedRange, appleSnapshot?.from == range.from, appleSnapshot?.to == range.to else { return nil }
        return appleSnapshot
    }
    private var currentAppleIssue: AppleReadIssue? {
        appleReadIssue?.range == requestedRange ? appleReadIssue : nil
    }
    private var hasChartData: Bool { isVitalMetric ? currentAppleSnapshot != nil : hasCurrentRange }
    private var selectedDay: String? {
        guard let range = requestedRange else { return nil }
        return NativeHealthTrendSelection.day(inspectedDate, points: points, range: range)
    }
    private var selectedDate: Date? { selectedDay.flatMap(NativeHealthWorkspaceFormat.date) }
    private var selectedPoint: NativeWorkspaceHealthPoint? { points.first { $0.day == selectedDay } }
    private var mean: Double? {
        guard let range = loadedRange else { return nil }
        return NativeHealthPeriodStatistics(points: points, range: range).recordedDayMean
    }
    private var isMassMetric: Bool { ["weight", "lean_body_mass", "body_fat"].contains(metric) }
    private var selectionBinding: Binding<Date?> {
        Binding(get: { selectedDate }, set: { value in
            guard let value, let range = requestedRange else { return }
            let day = NativeHealthTrendSelection.day(value, points: points, range: range)
            selectDay(day)
        })
    }

    var body: some View {
        ScrollViewReader { scroll in
            ScrollView {
                trendContent
                    .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 24)
                    .frame(maxWidth: 680).frame(maxWidth: .infinity)
            }
            .onChange(of: currentAppleSnapshot != nil || currentAppleIssue != nil, initial: true) { _, canOpenWorkouts in
                guard canOpenWorkouts, pendingWorkoutNavigation, topic == .activity else { return }
                pendingWorkoutNavigation = false
                scroll.scrollTo("health-trend-workouts", anchor: .top)
            }
        }
        .nativeGeometricPage().navigationTitle("健康趋势")
        .environment(\.timeZone, NativeActionDates.timeZone)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                moreMenu
                if !isVitalMetric {
                    Button { beginQuickEntry() } label: { Image(systemName: "plus") }
                        .accessibilityLabel("补记健康数据").disabled(busy)
                }
            }
        }
        .task { await refresh() }
        .task(id: AppleReadScope(range: requestedRange, updatedAt: appleActivityLastSync)) { await loadAppleActivity() }
        .refreshable { await refreshAll() }
        .onChange(of: recordsPresented) { wasPresented, isPresented in
            if wasPresented, !isPresented { flushRecordsRefresh() }
        }
        .onChange(of: busy) { _, isBusy in
            if !isBusy { flushRecordsRefresh() }
        }
        .navigationDestination(isPresented: $recordsPresented) {
            if let context = recordContext {
                NativeHealthRecordsWorkspace(api: api, token: token, userID: userID,
                                             initialMetric: context.metric, initialFrom: context.trendRange.from,
                                             initialTo: context.trendRange.to, initialDay: context.day)
            }
        }
        .sheet(isPresented: $editingRange) {
            NativeHealthDateRangeEditor(from: from, to: to) { first, last in
                changeRange(from: first, to: last)
            }
        }
        .sheet(isPresented: $editingInspectedDay) {
            if let range = requestedRange { inspectedDaySheet(range) }
        }
        .sheet(item: $entryMetric) { selected in
            HealthQuickEntryView(api: api, token: token, userID: userID, initialMetric: selected,
                                 initialDate: hasCurrentRange ? selectedDate ?? min(to, Date()) : min(to, Date())) { await load() }
        }
        .sheet(isPresented: $showingComparison) { comparisonSheet }
        .sheet(isPresented: $showingPairing) { pairingSheet }
        .confirmationDialog("补记原始测量", isPresented: $choosingEntryMetric, titleVisibility: .visible) {
            Button("体重") { entryMetric = .weight }
            Button("去脂体重") { entryMetric = .leanBodyMass }
            Button("取消", role: .cancel) { }
        } message: { Text("估算体脂不能直接补记，请选择实际测量的指标。") }
        .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: exportFilename) { result in
            if case .failure(let error) = result { actionMessage = error.localizedDescription }
        }
    }

    private var trendContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            rangeControls
            topics
            if !isVitalMetric { readStatus }
            if let range = requestedRange {
                focusCard(range)
                dailyDetails(range)
                if showingDailyDetails, let workouts = workoutsOnSelectedDay, !workouts.isEmpty,
                   topic != .activity || workouts.count != currentAppleSnapshot?.workouts.count {
                    NativeHealthTrendWorkouts(title: "当天训练", workouts: workouts, unavailableText: "",
                                              expandedID: $expandedDayWorkoutID)
                }
                if topic == .activity {
                    periodWorkouts.id("health-trend-workouts")
                } else if topic == .sleep {
                    selectedSleepBreakdown
                }
                if !isVitalMetric, hasCurrentRange {
                    summaryCards
                    recordLinks(range)
                    goalReference
                    dataDetails(range)
                    if topic == .sleep { sleepDetails }
                }
            }
            if let actionMessage { NativeInlineNotice(actionMessage, tone: .attention).font(.footnote) }
        }
    }

    private var rangeControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            if typeSize.isAccessibilitySize {
                Menu {
                    rangeOptions([7, 30, 90, 180, 360])
                } label: {
                    Label(recentDaysLabel, systemImage: "calendar")
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(12)
                        .nativeGeometricCard(fill: NativePalette.surface, corner: 16, compactCorner: 7)
                }.disabled(busy).accessibilityLabel("时间范围，" + recentDaysLabel)
            } else {
                HStack(spacing: 8) {
                    HStack(spacing: 4) {
                        ForEach([7, 30, 90], id: \.self) { days in
                            Button { selectRecentDays(days) } label: {
                                Text("\(days)天").font(.subheadline.weight(.medium))
                                    .lineLimit(1).minimumScaleFactor(0.7)
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                    .nativeGeometricCard(fill: isRecentSelection(days) ? NativePalette.soft : .clear, corner: 12, compactCorner: 6)
                            }
                            .buttonStyle(NativePressStyle())
                            .accessibilityLabel("最近\(days)天")
                            .accessibilityAddTraits(isRecentSelection(days) ? .isSelected : [])
                        }
                    }.padding(3)
                    .nativeGeometricCard(fill: NativePalette.surface, corner: 16, compactCorner: 7)
                    Menu {
                        rangeOptions([180, 360])
                    } label: {
                        Image(systemName: "calendar").frame(width: 44, height: 50)
                            .nativeGeometricCard(fill: NativePalette.surface, corner: 15, compactCorner: 6)
                    }.accessibilityLabel("更多时间范围")
                }.disabled(busy)
            }
            rangeLabel
        }.foregroundStyle(NativePalette.ink)
    }

    @ViewBuilder private func rangeOptions(_ days: [Int]) -> some View {
        ForEach(days, id: \.self) { count in
            Button("最近\(count)天") { selectRecentDays(count) }
        }
        Button("自定日期…") { editingRange = true }
    }

    private var recentDaysLabel: String {
        guard let count = requestedRange?.days, [7, 30, 90, 180, 360].contains(count), isRecentSelection(count) else {
            return "自定日期"
        }
        return "最近\(count)天"
    }

    private var rangeLabel: some View {
        Text((requestedRange.map(compactRange) ?? "自定日期") + " · 北京时间")
            .font(.caption).foregroundStyle(NativePalette.muted)
    }

    private var topics: some View {
        VStack(spacing: 8) {
            if typeSize.isAccessibilitySize {
                ForEach(NativeHealthTrendTopic.allCases) { key in topicCard(key) }
            } else {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    ForEach(NativeHealthTrendTopic.allCases.dropLast()) { key in topicCard(key) }
                }
                topicCard(.body)
            }
        }
        .accessibilityElement(children: .contain).accessibilityLabel("健康指标分组")
    }

    private func topicCard(_ key: NativeHealthTrendTopic) -> some View {
        let info = topicReadout(key)
        return NativeHealthTrendTopicCard(topic: key, value: info.value, note: info.note, selected: topic == key) {
            guard topic != key else { return }
            setMetric(key.defaultMetric)
        }
    }

    private func topicReadout(_ key: NativeHealthTrendTopic) -> (value: String, note: String) {
        switch key {
        case .activity:
            let training = currentAppleSnapshot.map { NativeHealthTrendWorkouts.summary($0.workouts) } ?? appleAvailabilityText
            return (display(currentPoints("steps").last?.value, metric: "steps"), training)
        case .sleep:
            guard let latest = currentPoints("sleep").last else { return ("—", legacyAvailabilityText) }
            return (display(latest.value, metric: "sleep"), monthDay(latest.day) + "醒来")
        case .heart:
            if let rest = currentPoints("resting_heart_rate").last {
                return (display(rest.value, metric: "resting_heart_rate"), "静息 · " + monthDay(rest.day))
            }
            if let average = currentPoints("heart_rate").last {
                return (display(average.value, metric: "heart_rate"), "日均 · " + monthDay(average.day))
            }
            return ("—", appleAvailabilityText)
        case .oxygen:
            guard let day = currentAppleSnapshot?.vitals.last(where: { $0.oxygenSaturation != nil }),
                  let oxygen = day.oxygenSaturation else { return ("—", appleAvailabilityText) }
            return (display(oxygen.latest, metric: "oxygen_saturation"),
                    "最近 · " + monthDay(day.day) + " " + NativeHealthWorkspaceFormat.clock(oxygen.measuredAt))
        case .body:
            guard let latest = currentPoints("weight").last else { return ("—", legacyAvailabilityText) }
            let fat = currentPoints("body_fat").last(where: { $0.day == latest.day })
            return (display(latest.value, metric: "weight"), fat.map { "估算体脂 " + display($0.value, metric: "body_fat") } ?? monthDay(latest.day) + "测量")
        }
    }

    @ViewBuilder private var metricChoices: some View {
        if topic.metrics.count > 1 {
            let selection = Binding(get: { metric }, set: { setMetric($0) })
            if typeSize.isAccessibilitySize {
                Picker("健康指标", selection: selection) { metricOptions }
                    .pickerStyle(.menu)
            } else {
                Picker("健康指标", selection: selection) { metricOptions }
                    .pickerStyle(.segmented)
            }
        }
    }

    private var metricOptions: some View {
        ForEach(topic.metrics, id: \.self) { key in Text(NativeHealthWorkspaceFormat.metric(key)).tag(key) }
    }

    private func setMetric(_ key: String) {
        guard key != metric else { return }
        if inspectedDate == nil { inspectedDate = selectedDate }
        metric = key
        invalidateComparison()
    }

    private var moreMenu: some View {
        Menu {
            Button("刷新记录", systemImage: "arrow.clockwise") { Task { await refresh() } }.disabled(busy)
            if hasCurrentRange, let range = loadedRange {
                Button("导出基础健康记录", systemImage: "square.and.arrow.up") { Task { await export(range) } }
                    .disabled(busy || preparingExport)
            }
            NavigationLink("目标与生效历史") { NativeHealthGoalsWorkspace(api: api, token: token, userID: userID) }
        } label: { Image(systemName: "ellipsis").frame(minWidth: 32, minHeight: 44) }
            .accessibilityLabel("健康趋势选项")
    }

    @ViewBuilder private var readStatus: some View {
        if busy {
            ProgressView(hasCurrentRange ? "正在更新…" : "读取所选时段…")
                .font(.caption).tint(NativePalette.accent)
        }
        if let readMessage {
            VStack(alignment: .leading, spacing: 8) {
                Text(hasCurrentRange ? "更新失败，显示上次读取的记录" : "未能读取所选时段").font(.subheadline)
                HStack(spacing: 20) {
                    Button("重试") { Task { await load() } }.disabled(busy)
                    if !hasCurrentRange, loadedRange != nil {
                        Button("返回上次时段") { restoreLoadedRange() }.disabled(busy)
                    }
                }.font(.subheadline).buttonStyle(NativePressStyle())
                DisclosureGroup("详情") { Text(readMessage).font(.caption).textSelection(.enabled) }
                    .font(.caption).foregroundStyle(NativePalette.muted)
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .nativeGeometricCard(fill: NativePalette.surface)
        }
    }

    private func focusCard(_ range: NativeHealthWorkspaceRange) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            let title = metric == "heart_rate" ? "心率" : NativeHealthWorkspaceFormat.metric(metric)
            Text(title + "趋势").font(.headline).accessibilityAddTraits(.isHeader)
            metricChoices
            if isVitalMetric, currentAppleIssue != nil { appleReadNotice }
            if hasChartData {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        focusedValue.fixedSize(horizontal: true, vertical: false)
                        Spacer(minLength: 4)
                        coverage(range)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        focusedValue
                        coverage(range)
                    }
                }
                if isVitalMetric { vitalLegend }
                chart.frame(height: 230)
                if let vitalNote { Text(vitalNote).font(.caption).foregroundStyle(NativePalette.muted) }
                if !selectionStatus.isEmpty { Text(selectionStatus).font(.caption).foregroundStyle(NativePalette.muted) }
            } else if isVitalMetric, currentAppleIssue == nil {
                ProgressView("正在读取苹果健康记录…").font(.subheadline)
            }
        }
        .padding(16).foregroundStyle(NativePalette.ink)
        .frame(maxWidth: .infinity, alignment: .leading)
        .nativeGeometricCard(fill: NativePalette.surface, compactCorner: 8, compactAt: .bottomTrailing)
        .accessibilityIdentifier("health-trend-focus")
    }

    private func coverage(_ range: NativeHealthWorkspaceRange) -> some View {
        Text("有记录 \(points.count)/\(range.days) 天")
            .font(.caption).foregroundStyle(NativePalette.muted)
    }

    private var vitalLegend: some View {
        HStack(spacing: 12) {
            Label(metric == "oxygen_saturation" ? "血氧日均" : NativeHealthWorkspaceFormat.metric(metric),
                  systemImage: "circle.fill").foregroundStyle(topic.accent)
            if metric == "heart_rate" { Label("最低–最高", systemImage: "line.diagonal") }
        }.font(.caption).foregroundStyle(NativePalette.muted)
    }

    private var vitalNote: String? {
        guard let day = selectedDay, isVitalMetric, let value = appleDay(day) else { return nil }
        if metric == "heart_rate", let bounds = selectedPoint?.bounds {
            return "当天范围 " + NativeHealthWorkspaceFormat.number(bounds.lowerBound) + "–"
                + display(bounds.upperBound, metric: metric)
        }
        if metric == "resting_heart_rate", let resting = value.restingHeartRate {
            return "记录时间 " + NativeHealthWorkspaceFormat.clock(resting.measuredAt)
        }
        if metric == "oxygen_saturation", let oxygen = value.oxygenSaturation {
            return "最近 " + display(oxygen.latest, metric: metric) + "（"
                + NativeHealthWorkspaceFormat.clock(oxygen.measuredAt) + "）· \(oxygen.count) 次采样"
        }
        return nil
    }

    private var focusedValue: some View {
        VStack(alignment: .leading, spacing: 4) {
            let state = selectedPoint != nil && selectedDay == points.last?.day ? "最新记录" : "单日记录"
            Text(selectedDay.map { monthDay($0) + " · " + state } ?? state)
                .font(.caption).foregroundStyle(NativePalette.muted)
            valueReadout(selectedPoint?.value, font: .largeTitle)
                .accessibilityLabel(selectedAnnouncement)
        }
    }

    private func valueReadout(_ value: Double?, font: Font) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(formattedValue(value)).font(font.weight(.semibold)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.5)
            if value != nil, metric != "sleep" {
                Text(NativeHealthWorkspaceFormat.unit(metric)).font(.caption).foregroundStyle(NativePalette.muted)
            }
        }.accessibilityElement(children: .combine)
    }

    @ViewBuilder private func dayPicker(_ range: NativeHealthWorkspaceRange) -> some View {
        let first = NativeHealthWorkspaceFormat.date(range.from)!
        let last = NativeHealthWorkspaceFormat.date(range.to)!
        let selection = Binding(get: { selectedDate ?? last }, set: { selectDay(NativeActionDates.day($0)) })
        if typeSize.isAccessibilitySize {
            Button { editingInspectedDay = true } label: {
                Label(NativeActionDates.formatted(selection.wrappedValue, pattern: "M月d日"), systemImage: "calendar")
                    .font(.subheadline).frame(minHeight: 44).padding(.horizontal, 9)
                    .nativeGeometricCard(fill: NativePalette.surface, corner: 10, compactCorner: 5)
            }.buttonStyle(NativePressStyle())
                .accessibilityLabel("查看单日记录日期，" + NativeActionDates.day(selection.wrappedValue))
        } else {
            DatePicker("查看日期", selection: selection, in: first...last, displayedComponents: .date)
                .labelsHidden().datePickerStyle(.compact).fixedSize()
                .accessibilityLabel("查看单日记录日期")
        }
    }

    private func inspectedDaySheet(_ range: NativeHealthWorkspaceRange) -> some View {
        let first = NativeHealthWorkspaceFormat.date(range.from)!
        let last = NativeHealthWorkspaceFormat.date(range.to)!
        let selection = Binding(get: { selectedDate ?? last }, set: { selectDay(NativeActionDates.day($0)) })
        return NavigationStack {
            Form {
                DatePicker("日期", selection: selection, in: first...last, displayedComponents: .date)
                    .datePickerStyle(.graphical)
            }.nativeGeometricPage().navigationTitle("查看日期")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { editingInspectedDay = false } } }
        }
    }

    private func dayNavigation(_ range: NativeHealthWorkspaceRange) -> some View {
        HStack(spacing: 8) {
            Button { shiftSelection(-1) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }
                .disabled(selectedDay == range.from).accessibilityLabel("查看前一天")
            Spacer(minLength: 0)
            dayPicker(range)
            Spacer(minLength: 0)
            Button { shiftSelection(1) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }
                .disabled(selectedDay == range.to).accessibilityLabel("查看后一天")
        }.buttonStyle(NativePressStyle()).foregroundStyle(NativePalette.accent)
    }

    private func dailyDetails(_ range: NativeHealthWorkspaceRange) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("日详情").font(.headline).accessibilityAddTraits(.isHeader)
            dayNavigation(range)
            if let day = selectedDay {
                DisclosureGroup(showingDailyDetails ? "收起当天明细" : "查看当天明细", isExpanded: $showingDailyDetails) {
                    dayRows(day).padding(.top, 12)
                }.font(.subheadline)
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .nativeGeometricCard(corner: 20, compactCorner: 7)
        .accessibilityIdentifier("health-trend-day-details")
    }

    private func dayRows(_ day: String) -> some View {
        let sleep = point("sleep", on: day)
        let steps = point("steps", on: day)
        let energy = point("active_energy", on: day)
        let weight = point("weight", on: day)
        let fat = point("body_fat", on: day)
        let heart = appleDay(day)
        let sleepTimes = sleep.flatMap(NativeWorkspaceSleepSummary.validTiming).map {
            NativeActionDates.formatted($0.0, pattern: "HH:mm") + " → " + NativeActionDates.formatted($0.1, pattern: "HH:mm")
        }
        let activity = [steps.map { display($0.value, metric: "steps") }, energy.map { display($0.value, metric: "active_energy") }]
            .compactMap { $0 }.joined(separator: " · ")
        let workoutSummary = workoutsOnSelectedDay.map(NativeHealthTrendWorkouts.summary) ?? appleAvailabilityText
        let heartValue = heart?.heartRate.map { "日均 " + display($0.average, metric: "heart_rate") } ?? appleAvailabilityText
        let restingNote = heart?.restingHeartRate.map {
            "静息 " + display($0.value, metric: "resting_heart_rate") + " · " + NativeHealthWorkspaceFormat.clock($0.measuredAt)
        } ?? "暂无已同步静息心率"
        let oxygenValue = heart?.oxygenSaturation.map { "最近 " + display($0.latest, metric: "oxygen_saturation") } ?? appleAvailabilityText
        let oxygenNote = heart?.oxygenSaturation.map {
            NativeHealthWorkspaceFormat.clock($0.measuredAt) + " 采样 · 当天 \($0.count) 次"
        } ?? "暂无已同步采样"
        return VStack(alignment: .leading, spacing: 12) {
            NativeHealthTrendDayRow(topic: .sleep, title: "昨晚睡眠", value: sleep.map { display($0.value, metric: "sleep") } ?? legacyAvailabilityText,
                                    note: sleepTimes ?? "按醒来日归属")
            Divider()
            NativeHealthTrendDayRow(topic: .activity, title: "全天活动", value: activity.isEmpty ? legacyAvailabilityText : activity,
                                    note: workoutSummary)
            Divider()
            NativeHealthTrendDayRow(topic: .heart, title: "心率", value: heartValue, note: restingNote)
            Divider()
            NativeHealthTrendDayRow(topic: .oxygen, title: "血氧", value: oxygenValue, note: oxygenNote)
            Divider()
            NativeHealthTrendDayRow(topic: .body, title: "体重与体成分", value: weight.map { display($0.value, metric: "weight") } ?? legacyAvailabilityText,
                                    note: fat.map { "估算体脂 " + display($0.value, metric: "body_fat") } ?? "暂无估算体脂")
        }.foregroundStyle(NativePalette.ink)
    }

    private var periodWorkouts: some View {
        VStack(alignment: .leading, spacing: 8) {
            if currentAppleIssue != nil { appleReadNotice }
            NativeHealthTrendWorkouts(title: "训练记录", workouts: currentAppleSnapshot?.workouts,
                                      unavailableText: appleAvailabilityText, expandedID: $expandedWorkoutID)
        }
    }

    @ViewBuilder private var appleReadNotice: some View {
        if let issue = currentAppleIssue {
            VStack(alignment: .leading, spacing: 6) {
                NativeInlineNotice(currentAppleSnapshot == nil ? issue.message : "更新失败，显示上次读取的苹果健康记录。",
                                   tone: issue.canRetry ? .error : .neutral)
                if issue.canRetry { Button("重试读取苹果健康记录") { Task { await loadAppleActivity() } }.frame(minHeight: 44) }
            }
        }
    }

    private var workoutsOnSelectedDay: [NativeAppleActivityWorkout]? {
        guard let day = selectedDay else { return nil }
        return currentAppleSnapshot?.workouts.filter { workout in
            NativeDates.parse(workout.startDate).map(NativeActionDates.day) == day
        }
    }

    private var chart: some View {
        let chartPoints = points
        let selected = selectedDay
        return Chart {
            if isMassMetric || isVitalMetric {
                ForEach(Array(NativeHealthTrendSelection.segments(chartPoints).enumerated()), id: \.offset) { index, segment in
                    ForEach(segment) { point in
                        if let date = NativeHealthWorkspaceFormat.date(point.day) {
                            if let bounds = point.bounds {
                                RuleMark(x: .value("日期", date), yStart: .value("最低", bounds.lowerBound),
                                         yEnd: .value("最高", bounds.upperBound))
                                    .foregroundStyle(topic.accent.opacity(0.32)).lineStyle(StrokeStyle(lineWidth: 2))
                            }
                            LineMark(x: .value("日期", date), y: .value("数值", point.value), series: .value("连续记录", index))
                                .foregroundStyle(topic.accent)
                            PointMark(x: .value("日期", date), y: .value("数值", point.value))
                                .foregroundStyle(topic.accent).symbolSize(point.day == selected ? 38 : 18)
                        }
                    }
                }
            } else {
                ForEach(chartPoints) { point in dailyBar(point, selected: selected) }
            }
            if let target = currentGoal {
                RuleMark(y: .value("当前目标（参考）", target))
                    .foregroundStyle(NativePalette.muted.opacity(0.7)).lineStyle(StrokeStyle(lineWidth: 1, dash: [5, 4]))
            }
            if let selectedDate {
                RuleMark(x: .value("选中日期", selectedDate))
                    .foregroundStyle(NativePalette.accent.opacity(0.5)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .chartXScale(domain: chartDomain).chartYScale(domain: chartYDomain)
        .chartXAxis {
            AxisMarks(values: chartTicks) { value in
                AxisGridLine().foregroundStyle(NativePalette.muted.opacity(0.12))
                AxisTick().foregroundStyle(NativePalette.muted.opacity(0.3))
                if let date = value.as(Date.self) {
                    AxisValueLabel(anchor: value.index == 0 ? .topLeading : value.index == value.count - 1 ? .topTrailing : .top) {
                        Text(NativeActionDates.formatted(date, pattern: "M/d")).font(.caption2).fixedSize()
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) {
                AxisGridLine().foregroundStyle(NativePalette.muted.opacity(0.15))
                AxisValueLabel()
            }
        }
        .chartForegroundStyleScale(domain: ["深睡", "核心", "REM", "未分类", "未分期"],
                                   range: [NativePalette.accent, NativePalette.accent.opacity(0.45), NativePalette.peach, NativePalette.muted.opacity(0.55), NativePalette.muted])
        .chartLegend(metric == "sleep" ? Visibility.visible : .hidden)
        .chartXSelection(value: selectionBinding)
        .overlay {
            if points.isEmpty {
                Text("这段时间暂无记录").font(.subheadline).foregroundStyle(NativePalette.muted).allowsHitTesting(false)
            }
        }
        .accessibilityLabel(NativeHealthWorkspaceFormat.metric(metric) + "趋势，缺失日期留空")
        .accessibilityValue(selectedAnnouncement)
    }

    @ChartContentBuilder private func dailyBar(_ point: NativeWorkspaceHealthPoint, selected: String?) -> some ChartContent {
        if let date = NativeHealthWorkspaceFormat.date(point.day) {
            if metric == "sleep" {
                if NativeWorkspaceSleepSummary.validStages(point) {
                    ForEach(NativeWorkspaceSleepSummary.stageKeys, id: \.self) { key in
                        BarMark(x: .value("日期", date, unit: .day, calendar: NativeActionDates.calendar),
                                y: .value("小时", point.stages[key].doubleValue ?? 0))
                            .foregroundStyle(by: .value("睡眠分期", stageLabel(key)))
                    }
                } else {
                    BarMark(x: .value("日期", date, unit: .day, calendar: NativeActionDates.calendar), y: .value("小时", point.value))
                        .foregroundStyle(by: .value("睡眠分期", "未分期"))
                }
            } else {
                BarMark(x: .value("日期", date, unit: .day, calendar: NativeActionDates.calendar), y: .value("数值", point.value))
                    .foregroundStyle(point.day == selected ? topic.accent : topic.accent.opacity(0.5))
            }
            if point.value == 0 {
                PointMark(x: .value("日期", date), y: .value("数值", 0.0))
                    .foregroundStyle(NativePalette.accent).symbolSize(24)
            }
        }
    }

    private var chartDomain: ClosedRange<Date> {
        if let requestedRange { return NativeHealthChartCalendar.domain(requestedRange) }
        let start = NativeActionDates.calendar.startOfDay(for: Date())
        return start...start.addingTimeInterval(86_400)
    }
    private var chartTicks: [Date] {
        guard let range = requestedRange else { return [] }
        let ticks = NativeHealthChartCalendar.ticks(range)
        guard typeSize.isAccessibilitySize, let first = ticks.first, let last = ticks.last else { return ticks }
        return first == last ? [first] : [first, last]
    }
    private var chartYDomain: ClosedRange<Double> {
        let values = points.flatMap { point in
            point.bounds.map { [point.value, $0.lowerBound, $0.upperBound] } ?? [point.value]
        }
        if (isMassMetric || isVitalMetric), let minimum = values.min(), let maximum = values.max() {
            let padding = max(0.2, (maximum - minimum) * 0.15)
            let low = max(0, minimum - padding)
            let high = max(low + 0.2, maximum + padding)
            return low...(topic == .oxygen ? min(100, high) : high)
        }
        let maximum = max(values.max() ?? 0, currentGoal ?? 0)
        return 0...max(1, maximum * 1.15)
    }

    private var summaryCards: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(alignment: .top, spacing: 8))
        return layout {
            VStack(alignment: .leading, spacing: 5) {
                Text(isMassMetric ? "日均测量值" : "记录日均").font(.caption).foregroundStyle(NativePalette.muted)
                valueReadout(mean, font: .title3)
            }.padding(14).frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
                .nativeGeometricCard(fill: NativePalette.surface, corner: 19, compactCorner: 7, compactAt: .topTrailing)
                .accessibilityHint("仅计算有记录的日期，缺失日期不补零")
            Button { showingComparison = true } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text("上期对比").font(.caption).foregroundStyle(NativePalette.muted)
                    HStack(spacing: 6) {
                        Text(comparisonSummary).font(.subheadline.weight(.semibold))
                        Image(systemName: "arrow.up.right").font(.caption)
                    }
                }.padding(14).frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
                    .nativeGeometricCard(fill: NativePalette.peach, corner: 19, compactCorner: 7, compactAt: .topLeading)
            }.buttonStyle(NativePressStyle()).disabled(busy)
        }.foregroundStyle(NativePalette.ink)
    }

    private func recordLinks(_ range: NativeHealthWorkspaceRange) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 20) { recordLinkItems(range) }
            VStack(alignment: .leading, spacing: 4) { recordLinkItems(range) }
        }.font(.subheadline).foregroundStyle(NativePalette.accent).buttonStyle(NativePressStyle())
    }
    @ViewBuilder private func recordLinkItems(_ range: NativeHealthWorkspaceRange) -> some View {
        if metric == "body_fat" {
            Button { showingPairing = true } label: { Label("估算依据", systemImage: "square.stack.3d.up").frame(minHeight: 44) }
        } else {
            Button { openRecords(range) } label: {
                Label("查看记录", systemImage: "list.bullet").frame(minHeight: 44)
            }.disabled(busy)
            NavigationLink {
                NativeHealthAssistantWorkspace(api: api, token: token, userID: userID, initialMetric: metric,
                                               initialFrom: range.from, initialTo: range.to, initialQuestion: "这段记录有哪些值得关注的变化？")
            } label: { Label("问问记录", systemImage: "sparkles").frame(minHeight: 44) }
        }
    }

    private var currentGoal: Double? {
        let value: Double?
        switch metric {
        case "steps": value = goalSettings?.targets.steps
        case "sleep": value = goalSettings?.targets.sleep
        case "active_energy": value = goalSettings?.targets.activeEnergy
        default: value = nil
        }
        guard let value, value.isFinite, value > 0 else { return nil }
        return value
    }
    @ViewBuilder private var goalReference: some View {
        if let target = currentGoal {
            Text("当前目标（参考） " + formattedValue(target) + (metric == "sleep" ? "" : " " + NativeHealthWorkspaceFormat.unit(metric)))
                .font(.caption).foregroundStyle(NativePalette.muted)
        }
    }

    @ViewBuilder private var selectedSleepBreakdown: some View {
        if hasCurrentRange {
            VStack(alignment: .leading, spacing: 12) {
                Text("睡眠分期").font(.headline).accessibilityAddTraits(.isHeader)
                if let day = selectedDay { Text(monthDay(day) + "醒来").font(.caption).foregroundStyle(NativePalette.muted) }
                if let point = selectedPoint, NativeWorkspaceSleepSummary.validStages(point) {
                    sleepStageBand(point)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 112), alignment: .leading)], alignment: .leading, spacing: 12) {
                        ForEach(NativeWorkspaceSleepSummary.stageKeys, id: \.self) { key in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 5) {
                                    Circle().fill(stageColor(key)).frame(width: 7, height: 7).accessibilityHidden(true)
                                    Text(stageLabel(key)).font(.caption).foregroundStyle(NativePalette.muted)
                                }
                                Text(formattedValue(point.stages[key].doubleValue)).font(.subheadline).monospacedDigit()
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                } else {
                    Text("这一天暂无已同步睡眠分期。").font(.subheadline).foregroundStyle(NativePalette.muted)
                }
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .nativeGeometricCard(fill: NativePalette.surface, corner: 20, compactCorner: 7)
        }
    }

    @ViewBuilder private func sleepStageBand(_ point: NativeWorkspaceHealthPoint) -> some View {
        if point.value > 0 {
            GeometryReader { geometry in
                HStack(spacing: 0) {
                    ForEach(NativeWorkspaceSleepSummary.stageKeys, id: \.self) { key in
                        stageColor(key).frame(width: geometry.size.width * CGFloat((point.stages[key].doubleValue ?? 0) / point.value))
                    }
                }
            }
            .frame(height: 8).clipShape(Capsule()).accessibilityHidden(true)
        }
    }

    private func dataDetails(_ range: NativeHealthWorkspaceRange) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            DisclosureGroup("数据与来源") {
                VStack(alignment: .leading, spacing: 14) {
                    Text(range.label).font(.caption).foregroundStyle(NativePalette.muted)
                    Button("导出基础健康记录") { Task { await export(range) } }.disabled(busy || preparingExport)
                    Text("导出此时段的步数、活动能量、睡眠、体重和去脂体重。").font(.caption).foregroundStyle(NativePalette.muted)
                    if ["steps", "sleep", "active_energy"].contains(metric) {
                        if currentGoal != nil {
                            Text("横向虚线是当前目标，不代表历史达标情况。").font(.caption).foregroundStyle(NativePalette.muted)
                        } else if goalSettings != nil {
                            Text("尚未设置此指标的每日目标。").font(.caption).foregroundStyle(NativePalette.muted)
                        }
                        if let goalMessage { Text(goalMessage).font(.caption).foregroundStyle(NativePalette.muted) }
                        NavigationLink("目标与生效历史") { NativeHealthGoalsWorkspace(api: api, token: token, userID: userID) }
                    }
                    if points.isEmpty { Text("所选指标暂无记录。").foregroundStyle(NativePalette.muted) }
                    ForEach(points.reversed()) { point in sourceRow(point) }
                }.padding(.top, 12)
            }.font(.subheadline)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .nativeGeometricCard(fill: NativePalette.surface, corner: 20, compactCorner: 7)
    }
    private func sourceRow(_ point: NativeWorkspaceHealthPoint) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent(point.day, value: formattedValue(point.value) + (metric == "sleep" ? "" : " " + NativeHealthWorkspaceFormat.unit(metric)))
            Text(point.source ?? "来源未知").font(.caption).foregroundStyle(NativePalette.muted)
            if let stamp = point.measuredAt {
                let label = NativeDates.parse(stamp).map { NativeActionDates.formatted($0, pattern: "yyyy/M/d HH:mm") } ?? stamp
                Text(label).font(.caption2).foregroundStyle(NativePalette.muted)
            }
        }.accessibilityElement(children: .combine)
    }

    private var comparisonSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let comparison, comparison.currentRange == loadedRange, comparison.metric == metric {
                        comparisonContents(comparison)
                    }
                    if comparing { ProgressView("读取上一时段…") }
                    if let comparisonMessage { NativeInlineNotice(comparisonMessage, tone: .attention) }
                    Button(comparison == nil ? "重试" : "重新对比") { Task { await comparePreviousPeriod() } }
                        .disabled(busy || comparing).frame(minHeight: 44)
                }.padding(20).frame(maxWidth: 680).frame(maxWidth: .infinity)
            }.nativeGeometricPage().navigationTitle("上期对比").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showingComparison = false } } }
                .task { if comparison == nil { await comparePreviousPeriod() } }
                .onDisappear { comparisonGeneration = UUID(); comparing = false }
        }
    }
    private func comparisonContents(_ value: NativeHealthPeriodComparisonSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            comparisonPeriodRow("本期", range: value.currentRange, stats: value.current)
            comparisonPeriodRow("上期", range: value.previousRange, stats: value.previous)
            LabeledContent("记录日均差", value: differenceLabel(value.meanDifference))
                .font(.headline).padding(16).nativeGeometricCard(fill: NativePalette.soft, corner: 20, compactCorner: 7)
            DisclosureGroup("记录覆盖与说明") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("本期 \(value.current.recordedDays)/\(value.current.totalDays) 天；上期 \(value.previous.recordedDays)/\(value.previous.totalDays) 天有记录。")
                    Text("缺失不补零。覆盖不同时，差值不能直接说明改善或下降。")
                    if value.currentRange.to == NativeActionDates.day(Date()) {
                        Text("本期包含尚未结束的日期，记录仍可能更新。")
                    }
                }.font(.caption).foregroundStyle(NativePalette.muted).padding(.top, 8)
            }.font(.subheadline)
        }.foregroundStyle(NativePalette.ink)
    }
    private func comparisonPeriodRow(_ title: String, range: NativeHealthWorkspaceRange, stats: NativeHealthPeriodStatistics) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(.subheadline.weight(.semibold))
                Spacer(minLength: 8)
                Text(compactRange(range)).font(.caption).foregroundStyle(NativePalette.muted)
            }
            valueReadout(stats.recordedDayMean, font: .title2)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .nativeGeometricCard(fill: NativePalette.surface, corner: 20, compactCorner: 7)
    }

    private var pairingSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let range = loadedRange { Text(range.label).font(.caption).foregroundStyle(NativePalette.muted) }
                    Text("仅用同一来源、同一测量时刻的体重与去脂体重估算，不是直接测得的体脂。").font(.subheadline)
                    LabeledContent("未配对体重", value: NativeHealthWorkspaceFormat.text(data["bodyComposition"]["unmatchedWeightCount"]))
                    LabeledContent("未配对去脂体重", value: NativeHealthWorkspaceFormat.text(data["bodyComposition"]["unmatchedLeanCount"]))
                    LabeledContent("无效配对", value: NativeHealthWorkspaceFormat.text(data["bodyComposition"]["invalidPairCount"]))
                }.padding(20).frame(maxWidth: 680).frame(maxWidth: .infinity)
            }.nativeGeometricPage().navigationTitle("估算依据").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showingPairing = false } } }
        }
    }

    private var sleepDetails: some View {
        VStack(alignment: .leading, spacing: 14) {
            DisclosureGroup("作息与分期详情") {
                VStack(alignment: .leading, spacing: 16) {
                    sleepSummary
                    DisclosureGroup("真实睡眠时刻") {
                        VStack(alignment: .leading, spacing: 14) { ForEach(points.reversed()) { point in sleepTimingRow(point) } }.padding(.top, 10)
                    }
                    DisclosureGroup("分周作息与分期") {
                        VStack(alignment: .leading, spacing: 14) { ForEach(sleepWeeks) { week in sleepWeekRow(week) } }.padding(.top, 10)
                    }
                }.padding(.top, 14)
            }.font(.subheadline)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .nativeGeometricCard(fill: NativePalette.surface, corner: 20, compactCorner: 7)
    }
    private var sleepSummary: some View {
        let summary = NativeWorkspaceSleepSummary(points)
        return VStack(alignment: .leading, spacing: 10) {
            LabeledContent("平均入睡", value: summary.onset ?? "暂无完整时刻")
            LabeledContent("入睡平均偏离", value: minuteLabel(summary.onsetDeviation))
            LabeledContent("平均起床", value: summary.wake ?? "暂无完整时刻")
            LabeledContent("起床平均偏离", value: minuteLabel(summary.wakeDeviation))
            ForEach(NativeWorkspaceSleepSummary.stageKeys, id: \.self) { key in sleepStageRow(key, summary: summary) }
            DisclosureGroup("计算依据") {
                Text("完整时刻 \(summary.timingDays) 天；窗口截断 \(summary.clippedDays) 天；分期 \(summary.stageDays) 天。至少2天才计算偏离，旧版总时长不推算时刻。")
                    .font(.caption).foregroundStyle(NativePalette.muted)
            }
        }
    }
    private func sleepTimingRow(_ point: NativeWorkspaceHealthPoint) -> some View {
        let onset = NativeHealthWorkspaceFormat.clock(point.timing["onset"].stringValue)
        let wake = NativeHealthWorkspaceFormat.clock(point.timing["wake"].stringValue)
        let status: String
        if point.timing["clipped"].boolValue == true { status = "窗口截断，不参与规律计算" }
        else if NativeWorkspaceSleepSummary.validTiming(point) == nil { status = "仅有总时长，时刻未知" }
        else { status = "同来源最长主睡眠组" }
        return VStack(alignment: .leading, spacing: 4) {
            Text(point.day).font(.subheadline.weight(.semibold))
            Text("入睡 \(onset) · 起床 \(wake)").font(.subheadline)
            Text(status).font(.caption).foregroundStyle(NativePalette.muted)
        }
    }
    private struct SleepWeek: Identifiable {
        let from: String
        let to: String
        let summary: NativeWorkspaceSleepSummary
        var id: String { from }
    }
    private var sleepWeeks: [SleepWeek] {
        guard let range = loadedRange, let first = NativeHealthWorkspaceFormat.date(range.from) else { return [] }
        return stride(from: 0, to: range.days, by: 7).map { offset in
            let startDate = NativeActionDates.calendar.date(byAdding: .day, value: offset, to: first)!
            let endDate = NativeActionDates.calendar.date(byAdding: .day, value: min(offset + 6, range.days - 1), to: first)!
            let firstDay = NativeActionDates.day(startDate)
            let lastDay = NativeActionDates.day(endDate)
            let daily = points.filter { $0.day >= firstDay && $0.day <= lastDay }
            return SleepWeek(from: firstDay, to: lastDay, summary: NativeWorkspaceSleepSummary(daily))
        }
    }
    private func sleepWeekRow(_ week: SleepWeek) -> some View {
        DisclosureGroup(week.from + " — " + week.to) {
            VStack(alignment: .leading, spacing: 10) {
                Text((week.summary.onset ?? "未知") + " / " + (week.summary.wake ?? "未知")).font(.subheadline)
                ForEach(NativeWorkspaceSleepSummary.stageKeys, id: \.self) { key in sleepStageRow(key, summary: week.summary) }
            }.padding(.top, 10)
        }
    }
    private func sleepStageRow(_ key: String, summary: NativeWorkspaceSleepSummary) -> some View {
        let percent = summary.stages[key].map { NativeHealthWorkspaceFormat.number($0) + "%" } ?? "暂无分期"
        return LabeledContent(stageLabel(key) + "占比", value: percent)
    }

    private var selectionStatus: String {
        if selectedPoint != nil, selectedDay == NativeActionDates.day(Date()), ["steps", "active_energy"].contains(metric) { return "截至目前" }
        return ""
    }
    private var selectedAnnouncement: String {
        let day = selectedDay ?? "日期未知"
        guard let point = selectedPoint else { return day + "，暂无记录" }
        return day + "，" + formattedValue(point.value) + (metric == "sleep" ? "" : " " + NativeHealthWorkspaceFormat.unit(metric))
    }
    private var comparisonSummary: String {
        guard let comparison, comparison.currentRange == loadedRange, comparison.metric == metric else { return "查看日均差" }
        return differenceLabel(comparison.meanDifference)
    }
    private func formattedValue(_ value: Double?) -> String {
        formattedValue(value, metric: metric)
    }
    private func formattedValue(_ value: Double?, metric: String) -> String {
        guard let value, value.isFinite else { return "—" }
        if metric == "sleep" {
            let minutes = Int((max(0, value) * 60).rounded())
            return "\(minutes / 60)时\(minutes % 60)分"
        }
        return NativeHealthWorkspaceFormat.number(value)
    }
    private func display(_ value: Double?, metric: String) -> String {
        let unit = NativeHealthWorkspaceFormat.unit(metric)
        let text = formattedValue(value, metric: metric)
        guard value != nil, metric != "sleep", !unit.isEmpty else { return text }
        return text + (unit == "%" ? "" : " ") + unit
    }
    private func monthDay(_ value: String) -> String {
        guard let date = NativeHealthWorkspaceFormat.date(value) else { return value }
        return NativeActionDates.formatted(date, pattern: "M月d日")
    }
    private func differenceLabel(_ value: Double?) -> String {
        guard let value else { return "暂无可比日均" }
        let number = NativeHealthWorkspaceFormat.number(value)
        return (value > 0 ? "+" : "") + number + " " + NativeHealthWorkspaceFormat.unit(metric)
    }
    private func minuteLabel(_ value: Double?) -> String {
        guard let value else { return "暂无可比记录" }
        return NativeHealthWorkspaceFormat.number(value) + " 分钟"
    }
    private func compactRange(_ range: NativeHealthWorkspaceRange) -> String {
        guard let first = NativeHealthWorkspaceFormat.date(range.from), let last = NativeHealthWorkspaceFormat.date(range.to) else { return range.label }
        let pattern = range.from.prefix(4) == range.to.prefix(4) ? "M/d" : "yyyy/M/d"
        return NativeActionDates.formatted(first, pattern: pattern) + "–" + NativeActionDates.formatted(last, pattern: pattern)
    }
    private func isRecentSelection(_ days: Int) -> Bool {
        requestedRange?.days == days && requestedRange?.to == NativeActionDates.day(Date())
    }
    private func stageLabel(_ key: String) -> String { ["deep": "深睡", "core": "核心", "rem": "REM", "unspecified": "未分类"][key] ?? key }
    private func stageColor(_ key: String) -> Color {
        switch key {
        case "deep": return NativePalette.accent
        case "core": return NativePalette.accent.opacity(0.45)
        case "rem": return NativePalette.peach
        default: return NativePalette.muted.opacity(0.55)
        }
    }
    private func shiftSelection(_ offset: Int) {
        guard let date = selectedDate, let range = requestedRange,
              let next = NativeActionDates.calendar.date(byAdding: .day, value: offset, to: date) else { return }
        selectDay(NativeHealthTrendSelection.day(next, points: points, range: range))
    }
    private func selectDay(_ day: String) {
        guard day != selectedDay || inspectedDate == nil else { return }
        inspectedDate = NativeHealthWorkspaceFormat.date(day)
        showingDailyDetails = true
        expandedDayWorkoutID = nil
    }
    private func openRecords(_ range: NativeHealthWorkspaceRange) {
        guard !busy, hasCurrentRange, let day = selectedDay,
              let context = NativeHealthRecordDayContext(day: day, metric: metric, trendRange: range) else { return }
        // Freeze even a following-latest selection: hiding its last observation
        // must return to this day rather than jump to a different sample.
        inspectedDate = context.date
        recordContext = context
        needsRecordsRefresh = true
        recordsPresented = true
    }
    private func flushRecordsRefresh() {
        guard needsRecordsRefresh, !busy, !recordsPresented else { return }
        Task { await load() }
    }
    private func selectRecentDays(_ days: Int) {
        let end = Date()
        let start = NativeActionDates.calendar.date(byAdding: .day, value: 1 - days, to: end)!
        changeRange(from: start, to: end)
    }
    private func changeRange(from start: Date, to end: Date) {
        guard let range = try? NativeHealthWorkspaceRange(from: start, to: end), range != requestedRange else { return }
        let previousDay = selectedDay
        from = start; to = end
        if let previousDay, previousDay >= range.from, previousDay <= range.to {
            inspectedDate = NativeHealthWorkspaceFormat.date(previousDay)
        } else {
            inspectedDate = NativeHealthWorkspaceFormat.date(range.to)
            expandedWorkoutID = nil
            expandedDayWorkoutID = nil
        }
        readMessage = nil
        Task { await load() }
    }
    private func restoreLoadedRange() {
        guard let range = loadedRange else { return }
        from = NativeHealthWorkspaceFormat.date(range.from)!
        to = NativeHealthWorkspaceFormat.date(range.to)!
        readMessage = nil
    }
    private func beginQuickEntry() {
        guard !busy else { return }
        if let selected = QuickEntryMetric(rawValue: metric) { entryMetric = selected }
        else { choosingEntryMetric = true }
    }
    private func invalidateComparison() {
        comparisonGeneration = UUID(); comparison = nil; comparisonMessage = nil; comparing = false
    }
    private func refresh() async {
        guard !recordsPresented else { return }
        await load()
        await loadCurrentGoals()
    }
    private func refreshAll() async {
        async let health: Void = refresh()
        async let apple: Void = loadAppleActivity()
        _ = await (health, apple)
    }
    private func load() async {
        guard !busy else { return }
        let generation = UUID()
        readGeneration = generation; busy = true; readMessage = nil; invalidateComparison()
        defer { if readGeneration == generation { busy = false } }
        do {
            let range = try NativeHealthWorkspaceRange(from: from, to: to)
            let result = try await api.json(path: NativeHealthWorkspaceFormat.path("health", query: range.query), token: token)
            guard !Task.isCancelled, readGeneration == generation,
                  NativeActionDates.day(from) == range.from, NativeActionDates.day(to) == range.to else { return }
            let accepted = try NativeHealthTrendSnapshot(response: result, range: range)
            snapshot = accepted
            if !recordsPresented { needsRecordsRefresh = false }
        } catch {
            if readGeneration == generation, !Task.isCancelled {
                readMessage = error.localizedDescription
                needsRecordsRefresh = false
            }
        }
    }

    private func currentPoints(_ key: String) -> [NativeWorkspaceHealthPoint] {
        let keyTopic = NativeHealthTrendTopic.forMetric(key)
        if keyTopic == .heart || keyTopic == .oxygen { return currentAppleSnapshot?.points(for: key) ?? [] }
        return hasCurrentRange ? snapshot?.points(metric: key) ?? [] : []
    }

    private func point(_ key: String, on day: String) -> NativeWorkspaceHealthPoint? {
        currentPoints(key).first { $0.day == day }
    }

    private func appleDay(_ day: String) -> NativeAppleActivityDay? {
        currentAppleSnapshot?.vitals.first { $0.day == day }
    }

    private var appleAvailabilityText: String {
        if currentAppleSnapshot != nil { return "暂无已同步记录" }
        if let issue = currentAppleIssue { return issue.canRetry ? "暂时无法读取" : "当前服务尚未支持" }
        return "正在读取…"
    }

    private var legacyAvailabilityText: String {
        if hasCurrentRange { return "暂无记录" }
        return readMessage == nil ? "正在读取…" : "暂时无法读取"
    }

    @MainActor private func loadAppleActivity() async {
        guard let range = requestedRange else { return }
        let generation = UUID()
        appleReadGeneration = generation
        if currentAppleIssue?.range == range { appleReadIssue = nil }
        do {
            let result = try await api.appleActivity(token: token, range: range)
            guard !Task.isCancelled, appleReadGeneration == generation, requestedRange == range else { return }
            appleSnapshot = result
        } catch {
            guard !Task.isCancelled, appleReadGeneration == generation, requestedRange == range else { return }
            if case NativeAPIError.server(let status, _, _, _) = error, status == 404 {
                appleReadIssue = AppleReadIssue(range: range, message: "当前服务版本尚未提供苹果健康心率、血氧和训练记录。", canRetry: false)
            } else {
                appleReadIssue = AppleReadIssue(range: range, message: error.localizedDescription, canRetry: true)
            }
        }
    }
    private func loadCurrentGoals() async {
        guard !Task.isCancelled else { return }
        let generation = UUID(); goalGeneration = generation
        do {
            let result = try await api.goals(token: token)
            guard !Task.isCancelled, goalGeneration == generation else { return }
            goalSettings = result; goalMessage = nil
        } catch {
            if goalGeneration == generation, !Task.isCancelled { goalSettings = nil; goalMessage = "目标参考暂时无法读取。" }
        }
    }
    private func comparePreviousPeriod() async {
        guard !busy, !comparing, hasCurrentRange, let range = loadedRange else { return }
        let requestedMetric = metric, generation = UUID()
        let currentPoints = points
        comparisonGeneration = generation; comparing = true; comparisonMessage = nil
        defer { if comparisonGeneration == generation { comparing = false } }
        do {
            let previous = try NativeHealthPeriodComparison.previousRange(for: range)
            let response = try await api.json(path: NativeHealthWorkspaceFormat.path("health", query: previous.query), token: token)
            guard !Task.isCancelled, comparisonGeneration == generation, metric == requestedMetric, loadedRange == range else { return }
            let accepted = try NativeHealthTrendSnapshot(response: response, range: previous)
            comparison = NativeHealthPeriodComparisonSnapshot(metric: requestedMetric, currentRange: range, previousRange: previous,
                current: NativeHealthPeriodStatistics(points: currentPoints, range: range),
                previous: NativeHealthPeriodStatistics(points: accepted.points(metric: requestedMetric), range: previous))
        } catch {
            if comparisonGeneration == generation, !Task.isCancelled { comparisonMessage = error.localizedDescription }
        }
    }
    private func export(_ range: NativeHealthWorkspaceRange) async {
        guard !busy, !preparingExport else { return }
        preparingExport = true; actionMessage = nil
        defer { preparingExport = false }
        do {
            let result = try await api.json(path: NativeHealthWorkspaceFormat.path("health/export", query: range.query), token: token)
            guard !Task.isCancelled else { return }
            exportDocument = NativeHealthJSONDocument(data: try result.encodedData())
            exportFilename = "jiashu-health-" + range.from + "_" + range.to
            exporting = true
        } catch { if !Task.isCancelled { actionMessage = error.localizedDescription } }
    }
}


struct NativeHealthDateRangeEditor: View {
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
            }.nativeGeometricPage().navigationTitle("查看哪段时间")
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
