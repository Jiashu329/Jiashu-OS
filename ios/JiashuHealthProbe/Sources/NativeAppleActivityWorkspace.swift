import SwiftUI
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

enum NativeHealthTrendTopic: String, CaseIterable, Identifiable {
    case activity, sleep, heart, oxygen, body

    var id: String { rawValue }

    var title: String {
        switch self {
        case .activity: return "活动与训练"
        case .sleep: return "睡眠"
        case .heart: return "心率"
        case .oxygen: return "血氧"
        case .body: return "体重与体成分"
        }
    }

    var icon: String {
        switch self {
        case .activity: return "figure.walk"
        case .sleep: return "moon"
        case .heart: return "heart.text.square"
        case .oxygen: return "drop"
        case .body: return "scalemass"
        }
    }

    var accent: Color {
        switch self {
        case .activity: return NativePalette.adaptive(0x976125, 0xFFC786)
        case .sleep: return NativePalette.adaptive(0x6251A6, 0xC9BAFF)
        case .heart: return NativePalette.adaptive(0x526EAF, 0xB6C7FF)
        case .oxygen: return NativePalette.adaptive(0x2A7189, 0x91D5EA)
        case .body: return NativePalette.adaptive(0x237467, 0x80D7BF)
        }
    }

    var metrics: [String] {
        switch self {
        case .activity: return ["steps", "active_energy"]
        case .sleep: return ["sleep"]
        case .heart: return ["heart_rate", "resting_heart_rate"]
        case .oxygen: return ["oxygen_saturation"]
        case .body: return ["weight", "lean_body_mass", "body_fat"]
        }
    }

    var defaultMetric: String { metrics[0] }

    static func forMetric(_ metric: String?) -> NativeHealthTrendTopic {
        guard let metric else { return .activity }
        return allCases.first { $0.metrics.contains(metric) } ?? .activity
    }
}

extension NativeAppleActivityResponse {
    func points(for metric: String) -> [NativeWorkspaceHealthPoint] {
        vitals.compactMap { sample -> NativeWorkspaceHealthPoint? in
            guard sample.day >= from, sample.day <= to else { return nil }
            switch metric {
            case "heart_rate":
                guard let value = sample.heartRate, value.average.isFinite else { return nil }
                let bounds: ClosedRange<Double>? = value.min.isFinite && value.max.isFinite && value.min <= value.max
                    ? value.min...value.max : nil
                return NativeWorkspaceHealthPoint(day: sample.day, value: value.average, bounds: bounds)
            case "resting_heart_rate":
                guard let value = sample.restingHeartRate, value.value.isFinite else { return nil }
                return NativeWorkspaceHealthPoint(day: sample.day, value: value.value, measuredAt: value.measuredAt)
            case "oxygen_saturation":
                guard let value = sample.oxygenSaturation, value.average.isFinite, (0...100).contains(value.average) else { return nil }
                return NativeWorkspaceHealthPoint(day: sample.day, value: value.average, measuredAt: value.measuredAt)
            default:
                return nil
            }
        }.sorted { $0.day < $1.day }
    }
}

struct NativeHealthTrendTopicCard: View {
    let topic: NativeHealthTrendTopic
    let value: String
    let note: String
    let selected: Bool
    let action: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 5) {
                if topic == .body && !typeSize.isAccessibilitySize {
                    HStack {
                        title
                        Spacer(minLength: 4)
                        readout
                    }
                } else {
                    title
                    readout
                }
                Text(note).font(.caption).foregroundStyle(NativePalette.muted).fixedSize(horizontal: false, vertical: true)
            }
            .padding(11)
            .frame(maxWidth: .infinity, minHeight: topic == .body ? 66 : 83, alignment: .leading)
            .nativeGeometricCard(fill: selected ? NativePalette.soft : NativePalette.surface, corner: 16, compactCorner: 7)
            .overlay(RoundedRectangle(cornerRadius: 15).strokeBorder(NativePalette.accent.opacity(selected ? 0.55 : 0), lineWidth: 1))
            .foregroundStyle(NativePalette.ink)
        }
        .buttonStyle(NativePressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("health-trend-topic-" + topic.rawValue)
    }

    private var title: some View {
        Label(topic.title, systemImage: topic.icon).font(.caption.weight(.semibold))
            .foregroundStyle(topic.accent).fixedSize(horizontal: false, vertical: true)
    }

    private var readout: some View {
        Text(value).font(.title3.weight(.semibold)).monospacedDigit()
            .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
    }
}

struct NativeHealthTrendDayRow: View {
    let topic: NativeHealthTrendTopic
    let title: String
    let value: String
    let note: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: topic.icon)
                .frame(width: 30, height: 30).background(topic.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
                .foregroundStyle(topic.accent).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(title).fontWeight(.semibold).fixedSize()
                        Spacer(minLength: 4)
                        Text(value).monospacedDigit().fixedSize()
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title).fontWeight(.semibold)
                        Text(value).monospacedDigit()
                    }
                }
                .font(.subheadline)
                Text(note).font(.caption).foregroundStyle(NativePalette.muted)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct NativeHealthTrendWorkouts: View {
    let title: String
    let workouts: [NativeAppleActivityWorkout]?
    let unavailableText: String
    @Binding var expandedID: String?
    @State private var showingMore = false

    private var sorted: [NativeAppleActivityWorkout] {
        (workouts ?? []).sorted { $0.startDate > $1.startDate }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            if let workouts {
                Text(Self.summary(workouts)).font(.caption).foregroundStyle(NativePalette.muted)
                let recent = sorted
                ForEach(recent.prefix(4)) { row in
                    NativeAppleActivityWorkoutRow(workout: row, expandedID: $expandedID)
                }
                if recent.count > 4 {
                    DisclosureGroup("其余 \(recent.count - 4) 条训练", isExpanded: moreBinding) {
                        ForEach(recent.dropFirst(4)) { row in
                            NativeAppleActivityWorkoutRow(workout: row, expandedID: $expandedID)
                        }
                    }.font(.subheadline)
                }
            } else {
                Text(unavailableText).font(.subheadline).foregroundStyle(NativePalette.muted)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .nativeGeometricCard(corner: 20, compactCorner: 7)
    }

    private var moreBinding: Binding<Bool> {
        Binding(get: {
            showingMore || sorted.dropFirst(4).contains { $0.id == expandedID }
        }, set: { value in
            showingMore = value
            if !value, sorted.dropFirst(4).contains(where: { $0.id == expandedID }) { expandedID = nil }
        })
    }

    static func summary(_ rows: [NativeAppleActivityWorkout]) -> String {
        guard !rows.isEmpty else { return "暂无已同步训练" }
        let duration = rows.reduce(0) { $0 + $1.durationSeconds }
        return "\(rows.count) 次训练 · " + (Self.duration(duration) ?? "时长未知")
    }

    static func duration(_ duration: Double, includeSeconds: Bool = false) -> String? {
        guard let seconds = Int(exactly: duration.rounded()), seconds >= 0 else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let remainder = seconds % 60
        return [
            hours > 0 ? "\(hours) 小时" : nil,
            minutes > 0 ? "\(minutes) 分钟" : nil,
            seconds < 60 || (includeSeconds && remainder > 0) ? "\(remainder) 秒" : nil,
        ].compactMap { $0 }.joined(separator: " ")
    }
}

private struct NativeAppleActivityWorkoutRow: View {
    let workout: NativeAppleActivityWorkout
    @Binding var expandedID: String?

    var body: some View {
        DisclosureGroup(isExpanded: Binding(get: { expandedID == workout.id }, set: { expanded in
            if expanded { expandedID = workout.id }
            else if expandedID == workout.id { expandedID = nil }
        })) {
            VStack(alignment: .leading, spacing: 5) {
                Text(timeLabel)
                if let duration = NativeHealthTrendWorkouts.duration(workout.durationSeconds, includeSeconds: true) {
                    Text("实际时长 " + duration)
                }
                if let distance = workout.distanceMeters {
                    Text("距离 " + NativeHealthWorkspaceFormat.number(distance / 1_000) + " 公里")
                }
                if let energy = workout.energyKcal {
                    Text("活动消耗 " + NativeHealthWorkspaceFormat.number(energy) + " 千卡")
                }
            }
            .font(.caption).foregroundStyle(NativePalette.muted)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "figure.run")
                    .frame(width: 28, height: 28)
                    .background(NativeHealthTrendTopic.activity.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 7))
                    .foregroundStyle(NativeHealthTrendTopic.activity.accent).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(activityLabel).font(.subheadline.weight(.semibold)).foregroundStyle(NativePalette.ink)
                    Text(startLabel).font(.caption).foregroundStyle(NativePalette.muted)
                }
                Spacer(minLength: 4)
                if let duration = NativeHealthTrendWorkouts.duration(workout.durationSeconds) {
                    Text(duration).font(.caption.weight(.medium)).foregroundStyle(NativePalette.ink)
                }
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
        }
    }

    private var startLabel: String {
        guard let start = NativeDates.parse(workout.startDate) else { return "时间未提供" }
        return NativeActionDates.formatted(start, pattern: "M月d日 · HH:mm")
    }

    private var timeLabel: String {
        guard let start = NativeDates.parse(workout.startDate), let end = NativeDates.parse(workout.endDate)
        else { return "时间未提供" }
        let endPattern = NativeActionDates.day(start) == NativeActionDates.day(end) ? "HH:mm" : "M月d日 HH:mm"
        return NativeActionDates.formatted(start, pattern: "M月d日 HH:mm") + "–"
            + NativeActionDates.formatted(end, pattern: endPattern)
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
