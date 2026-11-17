import SwiftUI

/// The home summary is a read-only view of today's recorded, known nutrients.
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
                            totals(data)
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
                Text(mealCaption(data)).font(.caption).foregroundStyle(NativePalette.muted)
                    .multilineTextAlignment(.trailing)
            }
        }
    }

    private func totals(_ data: NativeNutritionDay) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(NativeHomeNutritionValue.display(data.summary.knownCalories,
                                                       knownCount: data.summary.knownCount))
                    .font(.system(size: calorieSize, weight: .semibold, design: .rounded))
                    .monospacedDigit().foregroundStyle(NativePalette.ink)
                Text("千卡").font(.caption).foregroundStyle(NativePalette.muted)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(calorieAccessibility(data))

            Text(coverageCaption(data)).font(.caption).foregroundStyle(NativePalette.muted)
                .fixedSize(horizontal: false, vertical: true)

            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 12) { macroValues(data) }
            } else {
                HStack(alignment: .top, spacing: 10) { macroValues(data) }
            }
        }
    }

    @ViewBuilder private func macroValues(_ data: NativeNutritionDay) -> some View {
        macro("碳水", key: "carbs", data: data)
        macro("蛋白质", key: "protein", data: data)
        macro("脂肪", key: "fat", data: data)
    }

    private func macro(_ title: String, key: String, data: NativeNutritionDay) -> some View {
        let nutrient = data.summary.nutrients[key]
        let known = nutrient?.knownCount ?? 0
        let unknown = nutrient?.unknownCount ?? data.summary.entryCount
        let value = NativeHomeNutritionValue.display(nutrient?.total, knownCount: known)
        return VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(NativePalette.muted)
            (Text(value).font(.title3.weight(.medium)) + Text(" g").font(.caption))
                .foregroundStyle(NativePalette.ink).monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
            if unknown > 0 {
                Text("\(unknown)项未知").font(.caption2).foregroundStyle(NativePalette.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title)，\(known > 0 && nutrient?.total != nil ? value + "克已知小计" : "暂无已知数值")，\(unknown)项未知")
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

    private func mealCaption(_ data: NativeNutritionDay) -> String {
        let meals = Set(data.entries.filter { !$0.deleted }.map(\.meal)).count
        return meals > 0 ? "已记录\(meals)餐" : "暂无食物记录"
    }

    private func coverageCaption(_ data: NativeNutritionDay) -> String {
        let completeness = data.dayStatus.complete ? "当天已记完" : "记录中"
        if data.summary.entryCount == 0 { return "暂无食物记录 · " + completeness }
        let unknown = data.summary.unknownCount
        let basis = data.summary.knownCount > 0 ? "已知小计" : "热量未填"
        return basis + (unknown > 0 ? " · \(unknown)项热量未知" : "") + " · " + completeness
    }

    private func calorieAccessibility(_ data: NativeNutritionDay) -> String {
        let known = data.summary.knownCount
        let value = NativeHomeNutritionValue.display(data.summary.knownCalories, knownCount: known)
        let amount = known > 0 && data.summary.knownCalories != nil ? value + "千卡已知小计" : "暂无已知热量"
        return amount + "，" + coverageCaption(data) + "。未填写的数值不计为零。"
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

/// Keep the API's exact decimal string; absence is never turned into a zero.
enum NativeHomeNutritionValue {
    static func display(_ total: String?, knownCount: Int) -> String {
        guard knownCount > 0, let total else { return "—" }
        return total.hasSuffix(".0") ? String(total.dropLast(2)) : total
    }
}
