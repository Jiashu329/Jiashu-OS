import SwiftUI

/// A read-only homepage projection. Missing observations remain missing, and
/// the seven-day window belongs to the response that supplied the observations.
struct NativeHomeHealthSnapshot {
    let today: String
    let windowEnd: String
    let hasSource: Bool
    let metrics: [String: NativeHomeMetric]
    let sleepDeepHours: Double?
    let weightTrend: NativeHomeWeightTrend

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
            } else if key != "body_fat", let summary = health?.summary.metrics[key] {
                raw = NativeHomeHealthData.homeMetric(summary)
            } else {
                // Body fat is supplied by the server's exact source/time pairing.
                // Independent latest weight and lean-mass values are never paired here.
                raw = nil
            }
            result[key] = NativeHomeHealthData.sanitized(raw, key: key, end: end, today: today)
        }
        metrics = result
        let sleep = result["sleep"]!
        sleepDeepHours = NativeHomeHealthData.deepSleep(sleep: sleep, health: health)
        weightTrend = NativeHomeWeightTrend(points: result["weight"]!.points, end: end)
    }

    func metric(_ key: String) -> NativeHomeMetric { metrics[key]! }
}

enum NativeHomeHealthData {
    static let metricKeys = ["steps", "active_energy", "sleep", "weight", "lean_body_mass", "body_fat"]

    static func validDay(_ value: String) -> Bool {
        guard let date = NativeChartDates.parse(value) else { return false }
        return NativeActionDates.day(date) == value
    }

    static func validValue(_ value: Double, key: String) -> Bool {
        guard value.isFinite else { return false }
        switch key {
        case "weight", "lean_body_mass": return value > 0
        case "sleep": return (0...24).contains(value)
        case "body_fat": return (0...100).contains(value)
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
        let days = NativeHomeWeightTrend.days(ending: end)
        let allowedDays = Set(days)
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

struct NativeHomeWeightTrend {
    struct Slot: Identifiable {
        let day: String
        let value: Double?
        var id: String { day }
    }
    let slots: [Slot]
    var recordedDays: Int { slots.filter { $0.value != nil }.count }

    init(points: [NativeDayPoint], end: String) {
        var daily: [String: Double] = [:]
        for point in points where NativeHomeHealthData.validValue(point.value, key: "weight") {
            daily[point.day] = point.value
        }
        slots = Self.days(ending: end).map { Slot(day: $0, value: daily[$0]) }
    }

    static func days(ending end: String) -> [String] {
        guard let date = NativeChartDates.parse(end), NativeHomeHealthData.validDay(end) else { return [] }
        return (-6...0).compactMap { offset in
            NativeActionDates.calendar.date(byAdding: .day, value: offset, to: date).map(NativeActionDates.day)
        }
    }

    /// Each missing day starts a new path, including gaps between observations.
    var segments: [[Slot]] {
        var result: [[Slot]] = []
        var current: [Slot] = []
        for slot in slots {
            if slot.value != nil { current.append(slot) }
            else if !current.isEmpty { result.append(current); current = [] }
        }
        if !current.isEmpty { result.append(current) }
        return result
    }
}

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
            compositionCard(data)
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
                    Text(steps.day == data.today ? "今天步数" : "最近步数").font(.subheadline)
                    Text(NativeHomeHealthData.number(steps.value)).font(.largeTitle.weight(.semibold)).monospacedDigit()
                    HStack(spacing: 6) {
                        Text("步")
                        if steps.day != data.today { Text(NativeHomeHealthData.dateLabel(steps.day, today: data.today)) }
                    }.font(.caption)
                    if let average = steps.average7 {
                        Text("有记录日均 " + NativeHomeHealthData.number(average) + "步")
                            .font(.caption).padding(.top, 5)
                        Text(coverage(steps, data: data)).font(.caption)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(NativePressStyle()).accessibilityElement(children: .combine)
                .accessibilityHint("查看步数趋势")
            Rectangle().fill(NativePalette.onAccent.opacity(0.28)).frame(height: 1).accessibilityHidden(true)
            Button { showHealth("active_energy") } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("活动能量").font(.caption)
                    metricValue(energy.value, unit: "千卡", decimals: 0, font: .title3)
                    Text(NativeHomeHealthData.dateLabel(energy.day, today: data.today)).font(.caption)
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
                Text(sleepDate(sleep, data: data)).font(.caption).foregroundStyle(NativePalette.muted)
                VStack(alignment: .leading, spacing: 7) {
                    if let deep = data.sleepDeepHours {
                        Text("深睡 " + NativeHomeHealthData.duration(deep)).font(.subheadline)
                    } else {
                        Text("暂无睡眠分期").font(.caption).foregroundStyle(NativePalette.muted)
                    }
                    Text(coverage(sleep, data: data)).font(.caption).foregroundStyle(NativePalette.muted)
                }.padding(.top, 10)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
                .nativeGeometricCard(fill: NativePalette.peach, compactAt: .topLeading)
        }.buttonStyle(NativePressStyle()).accessibilityElement(children: .combine)
            .accessibilityHint("查看睡眠详情")
    }

    private func compositionCard(_ data: NativeHomeHealthSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("体成分").font(.headline)
                Spacer(minLength: 8)
                Text("最近记录").font(.caption).foregroundStyle(NativePalette.muted)
            }
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    compositionMetric("weight", title: "体重", unit: "kg", data: data).fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 0)
                    compositionMetric("lean_body_mass", title: "去脂体重", unit: "kg", data: data).fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 0)
                    compositionMetric("body_fat", title: "估算体脂", unit: "%", data: data).fixedSize(horizontal: true, vertical: false)
                }
                VStack(alignment: .leading, spacing: 16) {
                    compositionMetric("weight", title: "体重", unit: "kg", data: data)
                    compositionMetric("lean_body_mass", title: "去脂体重", unit: "kg", data: data)
                    compositionMetric("body_fat", title: "估算体脂", unit: "%", data: data)
                }
            }
            Divider().overlay(NativePalette.muted.opacity(0.15))
            weightTrend(data)
        }.padding(18).foregroundStyle(NativePalette.ink)
            .nativeGeometricCard(fill: NativePalette.surface)
    }

    private func compositionMetric(_ key: String, title: String, unit: String, data: NativeHomeHealthSnapshot) -> some View {
        let metric = data.metric(key)
        let hint: String = key == "body_fat" ? "由同次、同源测量配对估算，查看体脂趋势" : "查看" + title + "趋势"
        return Button { showHealth(key) } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.caption).foregroundStyle(NativePalette.muted)
                metricValue(metric.value, unit: unit, decimals: 1, font: .title3)
                Text(NativeHomeHealthData.dateLabel(metric.day, today: data.today)).font(.caption).foregroundStyle(NativePalette.muted)
            }.frame(minHeight: 44, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(NativePressStyle()).accessibilityElement(children: .combine)
            .accessibilityHint(hint)
    }

    private func weightTrend(_ data: NativeHomeHealthSnapshot) -> some View {
        let trend = data.weightTrend
        return Button { showHealth("weight") } label: {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 16) {
                    trendDescription(data).fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 0)
                    trendPlot(trend).frame(width: 110, height: 34)
                }
                VStack(alignment: .leading, spacing: 12) {
                    trendDescription(data)
                    trendPlot(trend).frame(maxWidth: .infinity).frame(height: 44)
                }
            }.contentShape(Rectangle())
        }.buttonStyle(NativePressStyle()).accessibilityElement(children: .ignore)
            .accessibilityLabel("近7日体重，" + rangeLabel(data) + "，" + trendCoverage(data))
            .accessibilityValue(trendAccessibility(trend, today: data.today))
            .accessibilityHint("查看体重趋势，未记录日期留空")
    }

    private func trendDescription(_ data: NativeHomeHealthSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("近7日体重").font(.subheadline)
            Text(trendCoverage(data)).font(.caption).foregroundStyle(NativePalette.muted)
            Text(rangeLabel(data)).font(.caption2).foregroundStyle(NativePalette.muted)
        }
    }

    @ViewBuilder private func trendPlot(_ trend: NativeHomeWeightTrend) -> some View {
        if trend.recordedDays > 0 {
            NativeHomeWeightSparkline(trend: trend).foregroundStyle(NativePalette.accent).accessibilityHidden(true)
        } else {
            Text("暂无近7日记录").font(.caption).foregroundStyle(NativePalette.muted)
                .fixedSize(horizontal: false, vertical: true).accessibilityHidden(true)
        }
    }

    private func metricValue(_ value: Double?, unit: String, decimals: Int, font: Font) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(NativeHomeHealthData.number(value, decimals: decimals)).font(font.weight(.semibold)).monospacedDigit()
            Text(unit).font(.caption)
        }
    }

    private func coverage(_ metric: NativeHomeMetric, data: NativeHomeHealthSnapshot) -> String {
        guard data.hasSource else { return "记录天数未知" }
        let prefix = data.windowEnd == data.today ? "近7日" : "截至" + NativeHomeHealthData.dateLabel(data.windowEnd, today: data.today) + "的7日"
        return prefix + " · \(metric.observedDays7)/7天有记录"
    }

    private func sleepDate(_ metric: NativeHomeMetric, data: NativeHomeHealthSnapshot) -> String {
        guard metric.day != nil else { return "暂无记录" }
        return NativeHomeHealthData.dateLabel(metric.day, today: data.today) + " · 按醒来日"
    }

    private func rangeLabel(_ data: NativeHomeHealthSnapshot) -> String {
        guard let first = data.weightTrend.slots.first else { return "日期未知" }
        return NativeHomeHealthData.dateLabel(first.day, today: data.today) + "–" + NativeHomeHealthData.dateLabel(data.windowEnd, today: data.today)
    }

    private func trendCoverage(_ data: NativeHomeHealthSnapshot) -> String {
        data.hasSource ? "\(data.weightTrend.recordedDays)/7天有记录" : "记录天数未知"
    }

    private func trendAccessibility(_ trend: NativeHomeWeightTrend, today: String) -> String {
        trend.slots.map { slot in
            let day = NativeHomeHealthData.dateLabel(slot.day, today: today)
            guard let value = slot.value else { return day + "未记录" }
            return day + "，" + NativeHomeHealthData.number(value, decimals: 1) + "千克"
        }.joined(separator: "；")
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

private struct NativeHomeWeightSparkline: View {
    let trend: NativeHomeWeightTrend

    var body: some View {
        Canvas { context, size in
            let values = trend.slots.compactMap(\.value)
            guard let minimum = values.min(), let maximum = values.max(), trend.slots.count > 1 else { return }
            let span = max(0.2, maximum - minimum)
            let middle = (minimum + maximum) / 2
            let low = middle - span * 0.65
            let high = middle + span * 0.65
            func position(_ slot: NativeHomeWeightTrend.Slot) -> CGPoint? {
                guard let index = trend.slots.firstIndex(where: { $0.day == slot.day }), let value = slot.value else { return nil }
                let x = 3 + (size.width - 6) * CGFloat(index) / CGFloat(trend.slots.count - 1)
                let y = 3 + (size.height - 6) * CGFloat((high - value) / (high - low))
                return CGPoint(x: x, y: y)
            }
            for segment in trend.segments {
                var path = Path()
                for (index, slot) in segment.enumerated() {
                    guard let point = position(slot) else { continue }
                    if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
                    let dot = CGRect(x: point.x - 2, y: point.y - 2, width: 4, height: 4)
                    context.fill(Path(ellipseIn: dot), with: .foreground)
                }
                context.stroke(path, with: .foreground, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
        }
    }
}
