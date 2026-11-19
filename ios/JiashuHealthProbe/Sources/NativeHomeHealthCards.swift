import SwiftUI

/// A read-only homepage projection. Missing observations remain missing, and
/// the seven-day window belongs to the response that supplied the observations.
struct NativeHomeHealthSnapshot {
    let today: String
    let windowEnd: String
    let hasSource: Bool
    let metrics: [String: NativeHomeMetric]
    let sleepDeepHours: Double?

    init(overview: NativeOverview?, health: NativeHealthResponse?, now: Date = Date(), healthUpdatedAt: Date? = nil) {
        let today = NativeActionDates.day(now)
        self.today = today
        let ready = overview?.health.status == "ready"
        hasSource = ready || health != nil
        let end: String
        if ready, let day = overview?.today, NativeHomeHealthData.validDay(day), day <= today {
            end = day
        } else {
            end = healthUpdatedAt.map { NativeActionDates.day(min($0, now)) } ?? today
        }
        windowEnd = end
        var result: [String: NativeHomeMetric] = [:]
        for key in NativeHomeHealthData.metricKeys {
            let raw: NativeHomeMetric?
            if ready {
                raw = overview?.health.metrics.first { $0.metric == key }
            } else if let summary = health?.summary.metrics[key] {
                raw = NativeHomeHealthData.homeMetric(summary)
            } else {
                raw = nil
            }
            result[key] = NativeHomeHealthData.sanitized(raw, key: key, end: end, today: today)
        }
        metrics = result
        let sleep = result["sleep"]!
        sleepDeepHours = NativeHomeHealthData.deepSleep(sleep: sleep, health: health)
    }

    func metric(_ key: String) -> NativeHomeMetric { metrics[key]! }
}

enum NativeHomeHealthData {
    static let metricKeys = ["steps", "active_energy", "sleep"]

    static func validDay(_ value: String) -> Bool {
        guard let date = NativeChartDates.parse(value) else { return false }
        return NativeActionDates.day(date) == value
    }

    static func validValue(_ value: Double, key: String) -> Bool {
        guard value.isFinite else { return false }
        switch key {
        case "sleep": return (0...24).contains(value)
        default: return value >= 0
        }
    }

    static func homeMetric(_ summary: NativeMetricSummary) -> NativeHomeMetric {
        let points = summary.points.sorted { $0.day < $1.day }
        let latest = points.last
        return NativeHomeMetric(metric: summary.metric, label: summary.label, value: latest?.value,
                                unit: summary.unit, day: latest?.day, freshness: "current",
                                points: points.map { NativeDayPoint(day: $0.day, value: $0.value) },
                                average7: nil, observedDays7: 0)
    }

    static func sanitized(_ raw: NativeHomeMetric?, key: String, end: String, today: String) -> NativeHomeMetric {
        let allowedDays = Set(recentDays(ending: end))
        var daily: [String: Double] = [:]
        for point in raw?.points ?? [] where allowedDays.contains(point.day) && validValue(point.value, key: key) {
            daily[point.day] = point.value
        }
        let points = daily.keys.sorted().map { NativeDayPoint(day: $0, value: daily[$0]!) }
        let validLatest: Bool
        if let value = raw?.value, let day = raw?.day {
            validLatest = validValue(value, key: key) && validDay(day) && day <= today
        } else { validLatest = false }
        let average: Double? = points.isEmpty ? nil : points.reduce(0) { $0 + $1.value } / Double(points.count)
        return NativeHomeMetric(metric: key, label: raw?.label ?? key,
                                value: validLatest ? raw?.value : nil, unit: raw?.unit ?? "",
                                day: validLatest ? raw?.day : nil, freshness: raw?.freshness ?? "missing",
                                points: points, average7: average, observedDays7: points.count)
    }

    static func recentDays(ending end: String) -> [String] {
        guard let date = NativeChartDates.parse(end), validDay(end) else { return [] }
        return (-6...0).compactMap { offset in
            NativeActionDates.calendar.date(byAdding: .day, value: offset, to: date).map(NativeActionDates.day)
        }
    }

    static func deepSleep(sleep: NativeHomeMetric, health: NativeHealthResponse?) -> Double? {
        guard let day = sleep.day, let total = sleep.value,
              let point = health?.summary.metrics["sleep"]?.points.last(where: { $0.day == day }),
              point.value.isFinite, abs(point.value - total) < 0.001,
              let stages = point.sleepStages else { return nil }
        let durations = [stages.unspecified, stages.core, stages.deep, stages.rem, stages.awake, stages.inBed]
        guard durations.allSatisfy({ $0.isFinite && (0...24).contains($0) }) else { return nil }
        let asleep = stages.unspecified + stages.core + stages.deep + stages.rem
        guard abs(asleep - total) <= 1.0 / 60.0 else { return nil }
        return stages.deep
    }

    static func number(_ value: Double?, decimals: Int = 0) -> String {
        guard let value, value.isFinite else { return "—" }
        return value.formatted(.number.precision(.fractionLength(decimals)))
    }

    static func duration(_ value: Double?) -> String {
        guard let value, validValue(value, key: "sleep") else { return "—" }
        let minutes = Int((value * 60).rounded())
        return "\(minutes / 60)时\(minutes % 60)分"
    }

    static func dateLabel(_ day: String?, today: String) -> String {
        guard let day, let date = NativeChartDates.parse(day), validDay(day) else { return "暂无记录" }
        if day == today { return "今天" }
        let pattern = day.prefix(4) == today.prefix(4) ? "M/d" : "yyyy/M/d"
        return NativeActionDates.formatted(date, pattern: pattern)
    }
}

@MainActor
struct NativeHomeHealthCards: View {
    @ObservedObject var model: NativeAppModel
    let showHealth: (String) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    private var snapshot: NativeHomeHealthSnapshot {
        NativeHomeHealthSnapshot(overview: model.overview, health: model.health, healthUpdatedAt: model.healthUpdatedAt)
    }

    var body: some View {
        let data = snapshot
        VStack(alignment: .leading, spacing: 16) {
            primaryCards(data)
            if let notice = sourceNotice(data) {
                Text(notice).font(.caption).foregroundStyle(NativePalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }.foregroundStyle(NativePalette.ink)
    }

    private func primaryCards(_ data: NativeHomeHealthSnapshot) -> some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        return layout {
            activityCard(data)
            sleepCard(data)
        }
    }

    private func activityCard(_ data: NativeHomeHealthSnapshot) -> some View {
        let steps = data.metric("steps")
        let energy = data.metric("active_energy")
        return VStack(alignment: .leading, spacing: 12) {
            Button { showHealth("steps") } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text("步数").font(.subheadline)
                    Text(NativeHomeHealthData.number(steps.value)).font(.largeTitle.weight(.semibold)).monospacedDigit()
                        .accessibilityLabel(steps.value == nil ? "暂无步数记录" : NativeHomeHealthData.number(steps.value) + "步")
                    if steps.day != data.today {
                        Text(NativeHomeHealthData.dateLabel(steps.day, today: data.today)).font(.caption)
                    }
                    if let average = steps.average7 {
                        Text("近7日记录均值 " + NativeHomeHealthData.number(average))
                            .font(.caption).padding(.top, 5)
                        if data.windowEnd != data.today { Text(rangeLabel(data)).font(.caption) }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(NativePressStyle()).accessibilityElement(children: .combine)
                .accessibilityHint("查看步数趋势")
            Rectangle().fill(NativePalette.onAccent.opacity(0.28)).frame(height: 1).accessibilityHidden(true)
            Button { showHealth("active_energy") } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("活动能量").font(.caption)
                    metricValue(energy.value, unit: "千卡", decimals: 0, font: .title3)
                    if energy.day != data.today {
                        Text(NativeHomeHealthData.dateLabel(energy.day, today: data.today)).font(.caption)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(NativePressStyle()).accessibilityElement(children: .combine)
                .accessibilityHint("查看活动能量趋势")
        }
        .foregroundStyle(NativePalette.onAccent).padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .nativeGeometricCard(fill: NativePalette.accent, compactAt: .bottomTrailing)
    }

    private func sleepCard(_ data: NativeHomeHealthSnapshot) -> some View {
        let sleep = data.metric("sleep")
        return Button { showHealth("sleep") } label: {
            VStack(alignment: .leading, spacing: 12) {
                Text("睡眠").font(.subheadline)
                Text(NativeHomeHealthData.duration(sleep.value)).font(.title2.weight(.semibold)).monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
                if sleep.day != data.today {
                    Text(sleepDate(sleep, data: data)).font(.caption).foregroundStyle(NativePalette.muted)
                }
                VStack(alignment: .leading, spacing: 7) {
                    if let deep = data.sleepDeepHours {
                        Text("深睡 " + NativeHomeHealthData.duration(deep)).font(.subheadline)
                    } else {
                        Text("暂无睡眠分期").font(.caption).foregroundStyle(NativePalette.muted)
                    }
                }.padding(.top, 10)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
                .nativeGeometricCard(fill: NativePalette.peach, compactAt: .topLeading)
        }.buttonStyle(NativePressStyle()).accessibilityElement(children: .combine)
            .accessibilityHint("查看睡眠详情")
    }

    private func metricValue(_ value: Double?, unit: String, decimals: Int, font: Font) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(NativeHomeHealthData.number(value, decimals: decimals)).font(font.weight(.semibold)).monospacedDigit()
            Text(unit).font(.caption)
        }
    }

    private func sleepDate(_ metric: NativeHomeMetric, data: NativeHomeHealthSnapshot) -> String {
        guard metric.day != nil else { return "暂无记录" }
        return NativeHomeHealthData.dateLabel(metric.day, today: data.today) + " · 按醒来日"
    }

    private func rangeLabel(_ data: NativeHomeHealthSnapshot) -> String {
        guard let first = NativeHomeHealthData.recentDays(ending: data.windowEnd).first else { return "日期未知" }
        return NativeHomeHealthData.dateLabel(first, today: data.today) + "–" + NativeHomeHealthData.dateLabel(data.windowEnd, today: data.today)
    }

    private func sourceNotice(_ data: NativeHomeHealthSnapshot) -> String? {
        if model.overviewError != nil {
            return data.hasSource ? "概览暂未更新，显示已读取的记录" : "健康数据暂时无法读取"
        }
        if model.healthError != nil { return "部分健康详情暂未更新" }
        if !data.hasSource { return model.loading ? "健康数据读取中…" : "暂无已读取的健康记录" }
        return nil
    }
}
