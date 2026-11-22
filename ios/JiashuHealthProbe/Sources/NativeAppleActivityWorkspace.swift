import SwiftUI
import Charts
import HealthKit

struct NativeAppleActivityResponse: Decodable {
    let from: String
    let to: String
    let vitals: [NativeAppleActivityDay]
    let workouts: [NativeAppleActivityWorkout]
}

extension NativeAPI {
    func appleActivity(token: String, range: NativeHealthWorkspaceRange) async throws -> NativeAppleActivityResponse {
        let path = NativeHealthWorkspaceFormat.path("health/apple-activity", query: range.query)
        let response: NativeAppleActivityResponse = try await request(path: path, token: token, reportWorkspaceFailure: true)
        guard response.from == range.from, response.to == range.to else { throw NativeAPIError.invalidResponse }
        return response
    }
}

struct NativeAppleActivityWorkspace: View {
    private enum Mode: String, CaseIterable {
        case vitals = "心率与血氧"
        case workouts = "训练记录"
    }

    private struct ReadContext: Equatable {
        let dateRange: String?
        let lastSync: String?
    }

    let api: NativeAPI
    let token: String

    @EnvironmentObject private var appModel: NativeAppModel
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var mode: Mode = .vitals
    @State private var from: Date
    @State private var to: Date
    @State private var editingDates = false
    @State private var snapshot: NativeAppleActivityResponse?
    @State private var loading = false
    @State private var error: String?
    @State private var requestID = UUID()

    init(api: NativeAPI, token: String, initialRange: NativeHealthWorkspaceRange? = nil) {
        self.api = api
        self.token = token
        let end = initialRange.flatMap { NativeHealthWorkspaceFormat.date($0.to) } ?? Date()
        let start = initialRange.flatMap { NativeHealthWorkspaceFormat.date($0.from) }
            ?? NativeActionDates.calendar.date(byAdding: .day, value: -29, to: end) ?? end
        _from = State(initialValue: start)
        _to = State(initialValue: end)
    }

    private var range: NativeHealthWorkspaceRange? {
        try? NativeHealthWorkspaceRange(from: from, to: to)
    }

    var body: some View {
        List {
            Section {
                if typeSize.isAccessibilitySize {
                    modePicker
                } else {
                    modePicker.pickerStyle(.segmented)
                }
                Button { editingDates = true } label: {
                    Label(range?.label ?? "选择日期", systemImage: "calendar")
                }
                .accessibilityLabel("日期范围，" + (range?.label ?? "选择日期"))
            }
            if let error {
                Section {
                    NativeInlineNotice(error, tone: .error)
                    Button("重试") { Task { await load() } }
                }
            }
            if let snapshot, let range, snapshot.from == range.from, snapshot.to == range.to {
                switch mode {
                case .vitals:
                    NativeAppleActivityVitals(days: snapshot.vitals, range: range)
                case .workouts:
                    workoutSection(snapshot.workouts)
                }
            } else if loading || error == nil {
                Section { ProgressView("正在读取记录…") }
            }
        }
        .nativeGeometricPage()
        .navigationTitle("心率、血氧与训练")
        .navigationBarTitleDisplayMode(.inline)
        .environment(\.timeZone, NativeActionDates.timeZone)
        .task(id: ReadContext(dateRange: range?.label, lastSync: appModel.appleActivityLastSync)) { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $editingDates) {
            NativeHealthDateRangeEditor(from: from, to: to) { start, end in
                let previousRange = range
                from = start
                to = end
                if range != previousRange { error = nil }
            }
        }
    }

    private var modePicker: some View {
        Picker("记录类型", selection: $mode) {
            ForEach(Mode.allCases, id: \.self) { item in Text(item.rawValue).tag(item) }
        }
    }

    private func workoutSection(_ workouts: [NativeAppleActivityWorkout]) -> some View {
        Section("训练记录") {
            if workouts.isEmpty {
                NativeFeatureEmpty(title: "这段时间暂无训练记录",
                                   detail: "请在「应用 → 同步中心」检查授权并补充同步。",
                                   icon: "figure.run")
            } else {
                ForEach(workouts.sorted { $0.startDate > $1.startDate }) { workout in
                    NativeAppleActivityWorkoutRow(workout: workout)
                }
            }
        }
    }

    @MainActor private func load() async {
        guard let requested = range else { return }
        let id = UUID()
        requestID = id
        loading = true
        error = nil
        defer { if requestID == id { loading = false } }
        do {
            let response = try await api.appleActivity(token: token, range: requested)
            guard requestID == id, requested == range, !Task.isCancelled else { return }
            snapshot = response
        } catch {
            guard requestID == id, requested == range, !Task.isCancelled else { return }
            if case NativeAPIError.server(let status, _, _, _) = error, status == 404 {
                self.error = "当前服务端尚未提供心率、血氧和训练记录。"
            } else {
                self.error = error.localizedDescription
            }
        }
    }
}

private struct NativeAppleActivityVitalPoint: Identifiable {
    let day: String
    let date: Date
    let value: Double
    let minimum: Double
    let maximum: Double
    let detail: String
    var id: String { day }

    init(day: String, date: Date, value: Double, minimum: Double? = nil, maximum: Double? = nil, detail: String) {
        self.day = day
        self.date = date
        self.value = value
        self.minimum = minimum ?? value
        self.maximum = maximum ?? value
        self.detail = detail
    }
}

private enum NativeAppleActivityVitalMetric: String, CaseIterable {
    case heartRate = "心率"
    case restingHeartRate = "静息心率"
    case oxygenSaturation = "血氧"

    private func percentage(_ value: Double) -> String { NativeHealthWorkspaceFormat.number(value) + "%" }
    var valueLabel: String {
        switch self {
        case .heartRate: return "每日平均心率"
        case .restingHeartRate: return "每日静息心率"
        case .oxygenSaturation: return "每日最近一次血氧"
        }
    }
    var unit: String { self == .oxygenSaturation ? "%" : "次/分" }

    func valueText(_ value: Double) -> String {
        self == .oxygenSaturation ? percentage(value) : NativeHealthWorkspaceFormat.number(value) + " " + unit
    }

    func point(_ row: NativeAppleActivityDay) -> NativeAppleActivityVitalPoint? {
        guard let date = NativeHealthWorkspaceFormat.date(row.day) else { return nil }
        switch self {
        case .heartRate:
            guard let rate = row.heartRate else { return nil }
            let interval = "范围 " + NativeHealthWorkspaceFormat.number(rate.min) + "–" + valueText(rate.max)
            return .init(day: row.day, date: date, value: rate.average, minimum: rate.min, maximum: rate.max,
                         detail: interval)
        case .restingHeartRate:
            guard let rate = row.restingHeartRate else { return nil }
            return .init(day: row.day, date: date, value: rate.value,
                         detail: "记录时间 " + NativeHealthWorkspaceFormat.clock(rate.measuredAt))
        case .oxygenSaturation:
            guard let oxygen = row.oxygenSaturation else { return nil }
            let aggregate = "\(oxygen.count) 次采样 · 平均 " + percentage(oxygen.average)
                + " · 范围 " + percentage(oxygen.min) + "–" + percentage(oxygen.max)
            let timestamp = NativeHealthWorkspaceFormat.clock(oxygen.measuredAt)
            return .init(day: row.day, date: date, value: oxygen.latest, minimum: oxygen.min, maximum: oxygen.max,
                         detail: "最近 " + timestamp + " · " + aggregate)
        }
    }
}

private struct NativeAppleActivityVitals: View {
    let days: [NativeAppleActivityDay]
    let range: NativeHealthWorkspaceRange
    @State private var metric: NativeAppleActivityVitalMetric = .heartRate

    private var points: [NativeAppleActivityVitalPoint] {
        days.filter { range.from <= $0.day && $0.day <= range.to }
            .compactMap(metric.point).sorted { $0.day < $1.day }
    }

    var body: some View {
        Section {
            Picker("指标", selection: $metric) {
                ForEach(NativeAppleActivityVitalMetric.allCases, id: \.self) { item in Text(item.rawValue).tag(item) }
            }
            let points = self.points
            if points.isEmpty {
                NativeFeatureEmpty(title: "这段时间暂无" + metric.rawValue + "记录",
                                   detail: "请在「应用 → 同步中心」检查授权并补充同步。",
                                   icon: "heart.text.square")
            } else {
                Text(metric.valueLabel).font(.headline)
                chart(points)
            }
        }
        if !points.isEmpty {
            Section("每日记录") {
                ForEach(points.reversed()) { point in
                    VStack(alignment: .leading, spacing: 5) {
                        LabeledContent(point.day, value: metric.valueText(point.value))
                        Text(point.detail).font(.caption).foregroundStyle(NativePalette.muted)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func chart(_ points: [NativeAppleActivityVitalPoint]) -> some View {
        Chart(points) { point in
            if point.minimum < point.maximum {
                RuleMark(x: .value("日期", point.date),
                         yStart: .value("最低", point.minimum), yEnd: .value("最高", point.maximum))
                    .foregroundStyle(NativePalette.accent.opacity(0.45))
                    .lineStyle(StrokeStyle(lineWidth: 2))
            }
            PointMark(x: .value("日期", point.date), y: .value(metric.valueLabel, point.value))
                .foregroundStyle(NativePalette.accent)
        }
        .chartXScale(domain: NativeHealthChartCalendar.domain(range))
        .chartYScale(domain: yDomain(points))
        .chartYAxis { AxisMarks(position: .leading) }
        .chartXAxis {
            AxisMarks(values: NativeHealthChartCalendar.ticks(range)) { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let date = value.as(Date.self) { Text(NativeActionDates.formatted(date, pattern: "M/d")) }
                }
            }
        }
        .chartYAxisLabel(metric.unit)
        .frame(height: 160)
        .accessibilityLabel(metric.valueLabel)
    }

    private func yDomain(_ points: [NativeAppleActivityVitalPoint]) -> ClosedRange<Double> {
        let low = points.map(\.minimum).min() ?? 0
        let high = points.map(\.maximum).max() ?? low
        let padding = max(1, (high - low) * 0.08)
        if metric == .oxygenSaturation {
            return max(0, low - padding)...min(100, high + padding)
        }
        return max(0, low - padding)...(high + padding)
    }
}

private struct NativeAppleActivityWorkoutRow: View {
    let workout: NativeAppleActivityWorkout

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(activityLabel).font(.headline)
            Text(timeLabel).font(.subheadline).foregroundStyle(NativePalette.muted)
            Text(details.joined(separator: " · ")).font(.subheadline)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private var timeLabel: String {
        guard let start = NativeDates.parse(workout.startDate), let end = NativeDates.parse(workout.endDate)
        else { return "时间未提供" }
        let endPattern = NativeActionDates.day(start) == NativeActionDates.day(end) ? "HH:mm" : "yyyy-MM-dd HH:mm"
        return NativeActionDates.formatted(start, pattern: "yyyy-MM-dd HH:mm") + "–"
            + NativeActionDates.formatted(end, pattern: endPattern)
    }

    private var details: [String] {
        [duration,
         workout.distanceMeters.map { NativeHealthWorkspaceFormat.number($0 / 1000) + " 公里" },
         workout.energyKcal.map { NativeHealthWorkspaceFormat.number($0) + " 千卡" }]
            .compactMap { $0 }
    }

    private var duration: String? {
        guard let seconds = Int(exactly: workout.durationSeconds.rounded()), seconds >= 0 else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        if hours > 0 { return "\(hours) 小时 \(minutes) 分钟" }
        if minutes > 0 { return "\(minutes) 分钟 \(seconds % 60) 秒" }
        return "\(seconds) 秒"
    }

    private var activityLabel: String {
        switch HKWorkoutActivityType(rawValue: workout.activityType) {
        case .badminton: return "羽毛球"
        case .basketball: return "篮球"
        case .boxing: return "拳击"
        case .climbing: return "攀岩"
        case .coreTraining: return "核心训练"
        case .cycling: return "骑行"
        case .elliptical: return "椭圆机"
        case .functionalStrengthTraining: return "功能性力量训练"
        case .highIntensityIntervalTraining: return "高强度间歇训练"
        case .hiking: return "徒步"
        case .jumpRope: return "跳绳"
        case .mixedCardio: return "混合有氧"
        case .pilates: return "普拉提"
        case .rowing: return "划船"
        case .running: return "跑步"
        case .soccer: return "足球"
        case .stairClimbing: return "爬楼梯"
        case .swimming: return "游泳"
        case .tableTennis: return "乒乓球"
        case .taiChi: return "太极"
        case .tennis: return "网球"
        case .traditionalStrengthTraining: return "传统力量训练"
        case .walking: return "步行"
        case .yoga: return "瑜伽"
        case .other: return "其他训练"
        default: return "训练（类型 \(workout.activityType)）"
        }
    }
}
