import SwiftUI

/// Compare recorded intake with the user's reference targets for this date.
/// Opening it retains the nutrition workspace's own entry and recovery flow.
@MainActor
struct NativeHomeNutritionCard: View {
    @ObservedObject var model: NativeAppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .largeTitle) private var calorieSize: CGFloat = 31
    @State private var nutrition: NativeNutritionDay?
    @State private var scope: Scope?
    @State private var requestID = UUID()
    @State private var loading = false
    @State private var readError: String?

    private struct Scope: Equatable {
        let owner: String
        let day: String
    }

    private struct RefreshKey: Equatable {
        let owner: String?
        let day: String
        let overview: String?
    }

    var body: some View {
        // Also advance the selected day when the home screen stays open overnight.
        TimelineView(.periodic(from: .now, by: 60)) { timeline in
            let day = NativeActionDates.day(timeline.date)
            card(date: timeline.date, day: day)
                .task(id: RefreshKey(owner: model.session?.user.id, day: day, overview: model.overview?.asOf)) {
                    await load(day: day)
                }
        }
    }

    @ViewBuilder private func card(date: Date, day: String) -> some View {
        if let session = model.session {
            let current = scope == Scope(owner: session.user.id, day: day)
            let data = current ? nutrition : nil
            VStack(alignment: .leading, spacing: 13) {
                NavigationLink {
                    NativeNutritionRoot(api: model.api, token: session.accessToken,
                                        userID: session.user.id, initialDate: date)
                } label: {
                    VStack(alignment: .leading, spacing: 13) {
                        heading(data)
                        if let data {
                            totals(data, targets: targets(for: day))
                        } else {
                            placeholder(isLoading: !current || loading)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(NativePressStyle())
                .accessibilityHint("查看当天饮食记录与营养详情")

                if current, let readError {
                    retryMessage(readError, hasPreviousData: data != nil, day: day)
                }
            }
            .padding(18)
            .nativeGeometricCard(fill: NativePalette.surface, corner: 28, compactCorner: 10, compactAt: .topLeading)
        }
    }

    private func heading(_ data: NativeNutritionDay?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("饮食").font(.headline).foregroundStyle(NativePalette.ink)
            Image(systemName: "arrow.up.right").font(.caption.weight(.medium))
                .foregroundStyle(NativePalette.muted).accessibilityHidden(true)
            Spacer(minLength: 4)
            if let data {
                Text(dayStatus(data)).font(.caption).foregroundStyle(NativePalette.muted)
                    .multilineTextAlignment(.trailing)
            }
        }
    }

    private func targets(for day: String) -> NativeJSON? {
        guard let overview = model.overview, overview.today == day,
              let nutrition = overview.nutrition, nutrition["status"].stringValue == "ready",
              nutrition["date"].stringValue == day,
              case .object = nutrition["targets"] else { return nil }
        return nutrition["targets"]
    }

    private func totals(_ data: NativeNutritionDay, targets: NativeJSON?) -> some View {
        let nutrients = [
            NativeHomeNutrient("能量", unit: "千卡", total: data.summary.knownCalories,
                               knownCount: data.summary.knownCount, unknownCount: data.summary.unknownCount,
                               target: targets?["calories"].stringValue),
            macro("碳水", key: "carbs", data: data, targets: targets),
            macro("蛋白质", key: "protein", data: data, targets: targets),
            macro("脂肪", key: "fat", data: data, targets: targets),
        ]

        return VStack(alignment: .leading, spacing: 10) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(nutrients) { nutrient in nutrientCell(nutrient) }
                }
            } else {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible())],
                          alignment: .leading, spacing: 13) {
                    ForEach(nutrients) { nutrient in nutrientCell(nutrient) }
                }
            }
            if nutrients.contains(where: \.isPartial) {
                Text("≥ 为已知小计").font(.caption2).foregroundStyle(NativePalette.muted)
            }
            if let targets, !targets.objectValue.isEmpty, nutrients.allSatisfy({ $0.target == nil }) {
                Text("未设每日目标").font(.caption2).foregroundStyle(NativePalette.muted)
            }
        }
    }

    private func macro(_ title: String, key: String, data: NativeNutritionDay, targets: NativeJSON?) -> NativeHomeNutrient {
        let value = data.summary.nutrients[key]
        return NativeHomeNutrient(title, unit: "g", total: value?.total, knownCount: value?.knownCount ?? 0,
                                  unknownCount: value?.unknownCount ?? data.summary.entryCount,
                                  target: targets?[key].stringValue)
    }

    private func nutrientCell(_ nutrient: NativeHomeNutrient) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(nutrient.title).font(.subheadline.weight(.medium)).foregroundStyle(NativePalette.muted)
            Text(nutrient.quantity).font(.callout.weight(.semibold)).monospacedDigit()
                .foregroundStyle(NativePalette.ink).fixedSize(horizontal: false, vertical: true)
            if let fraction = nutrient.fraction {
                ProgressView(value: fraction)
                    .progressViewStyle(.linear).tint(NativePalette.accent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(nutrient.title)
        .accessibilityValue(nutrient.accessibilityValue)
    }

    private func placeholder(isLoading: Bool) -> some View {
        HStack(spacing: 10) {
            Text("—").font(.system(size: calorieSize, weight: .semibold, design: .rounded))
                .foregroundStyle(NativePalette.ink)
            if isLoading { ProgressView().accessibilityLabel("正在读取饮食") }
            Text(isLoading ? "正在读取" : "暂未读取到记录")
                .font(.caption).foregroundStyle(NativePalette.muted)
        }
    }

    private func retryMessage(_ message: String, hasPreviousData: Bool, day: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(hasPreviousData ? "更新失败，显示上次读取的记录。" : "饮食记录暂时无法读取。")
                .font(.caption).foregroundStyle(NativePalette.muted)
            DisclosureGroup("详情") {
                Text(message).font(.caption).foregroundStyle(NativePalette.muted)
            }.font(.caption).tint(NativePalette.muted)
            Button("重试", systemImage: "arrow.clockwise") {
                Task { await load(day: day) }
            }
            .font(.subheadline).foregroundStyle(NativePalette.accent)
            .buttonStyle(NativePressStyle()).disabled(loading)
        }
    }

    private func dayStatus(_ data: NativeNutritionDay) -> String {
        if data.dayStatus.complete { return "已记完" }
        return data.summary.entryCount > 0 ? "记录中" : "未记录"
    }

    private func load(day: String) async {
        let identifier = UUID()
        requestID = identifier
        guard let session = model.session else {
            scope = nil; nutrition = nil; readError = nil; loading = false
            return
        }
        let selected = Scope(owner: session.user.id, day: day)
        if scope != selected { nutrition = nil; readError = nil; scope = selected }
        loading = true
        defer { if requestID == identifier { loading = false } }
        do {
            let result = try await model.api.nutritionDay(token: session.accessToken, date: day)
            guard accepts(identifier, scope: selected) else { return }
            guard result.date == day else { throw NativeAPIError.invalidResponse }
            nutrition = result
            readError = nil
        } catch {
            guard accepts(identifier, scope: selected), !(error is CancellationError) else { return }
            readError = error.localizedDescription
        }
    }

    private func accepts(_ identifier: UUID, scope selected: Scope) -> Bool {
        !Task.isCancelled && requestID == identifier && scope == selected
            && model.session?.user.id == selected.owner && NativeActionDates.day(Date()) == selected.day
    }
}

struct NativeHomeNutrient: Identifiable {
    let title: String
    let unit: String
    let current: String?
    let target: String?
    let isPartial: Bool
    let fraction: Double?
    var id: String { title }

    init(_ title: String, unit: String, total: String?, knownCount: Int, unknownCount: Int, target: String?) {
        self.title = title
        self.unit = unit
        let observed = knownCount > 0 ? Self.validAmount(total) : nil
        let goal = Self.validAmount(target)
        current = observed.map(Self.display)
        self.target = goal.map(Self.display)
        isPartial = observed != nil && unknownCount > 0
        if let observed, let goal, let currentNumber = Double(observed), let targetNumber = Double(goal),
           currentNumber.isFinite, targetNumber.isFinite, targetNumber > 0 {
            fraction = min(1, currentNumber / targetNumber)
        } else {
            fraction = nil
        }
    }

    var quantity: String {
        let amount = (isPartial ? "≥" : "") + (current ?? "—")
        return amount + (target.map { " / " + $0 } ?? "") + " " + unit
    }

    var accessibilityValue: String {
        let spokenUnit = unit == "g" ? "克" : unit
        let amount = current.map { (isPartial ? "已知小计 " : "") + $0 + spokenUnit } ?? "暂无数值"
        return amount + (target.map { "，目标 " + $0 + spokenUnit } ?? "")
    }

    private static func validAmount(_ value: String?) -> String? {
        guard let value, value.range(of: #"^[0-9]+(?:\.[0-9])?$"#, options: .regularExpression) != nil else { return nil }
        return value
    }

    private static func display(_ value: String) -> String {
        value.hasSuffix(".0") ? String(value.dropLast(2)) : value
    }
}
