import SwiftUI

/// Compare recorded intake with the user's reference targets for this date.
/// Opening it retains the nutrition workspace's own entry and recovery flow.
@MainActor
struct NativeHomeNutritionCard: View {
    @ObservedObject var model: NativeAppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .largeTitle) private var calorieSize: CGFloat = 34
    @State private var nutrition: NativeNutritionDay?
    @State private var scope: Scope?
    @State private var requestID = UUID()
    @State private var loading = false
    @State private var readError: String?
    @State private var observedDayScope: Scope?

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
                // Independent of overview.asOf: completing this overview read
                // may refresh the meal task, but cannot restart this one.
                .task(id: RefreshKey(owner: model.session?.user.id, day: day, overview: nil)) {
                    await refreshOverviewOnDayAdvance(day: day)
                }
                .onDisappear { observedDayScope = nil }
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
                .accessibilityIdentifier("today-nutrition-card")
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
        let energy = NativeHomeNutrient("能量", unit: "千卡", total: data.summary.knownCalories,
                                        knownCount: data.summary.knownCount, unknownCount: data.summary.unknownCount,
                                        target: targets?["calories"].stringValue)
        let macros = [(key: "carbs", title: "碳水"), (key: "protein", title: "蛋白质"), (key: "fat", title: "脂肪")]
            .map { (key: $0.key, nutrient: macro($0.title, key: $0.key, data: data, targets: targets)) }
        let nutrients = [energy] + macros.map(\.nutrient)
        let stackedMacros = VStack(alignment: .leading, spacing: 10) { macroCells(macros, horizontal: false) }

        return VStack(alignment: .leading, spacing: 10) {
            energyPanel(energy)
            if dynamicTypeSize.isAccessibilitySize {
                stackedMacros
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 10) {
                        macroCells(macros, horizontal: true)
                    }
                    stackedMacros
                }
            }
            if nutrients.contains(where: \.isPartial) {
                Text("≥ 为已知小计").font(.caption2).foregroundStyle(NativePalette.muted)
                    .accessibilityHidden(true)
            }
            if let targets, !targets.objectValue.isEmpty, nutrients.allSatisfy({ $0.target == nil }) {
                Text("未设每日目标").font(.caption2).foregroundStyle(NativePalette.muted)
            }
        }
    }

    private func energyPanel(_ energy: NativeHomeNutrient) -> some View {
        let amount = (energy.isPartial ? "≥" : "") + (energy.current ?? "—")
        return VStack(alignment: .leading, spacing: 6) {
            Text("已摄入能量").font(.caption.weight(.medium))
            if let target = energy.target {
                let goal = Text("目标 \(target) 千卡").font(.caption)
                    .accessibilityIdentifier("today-nutrition-goal")
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        energyAmount(amount)
                        Spacer(minLength: 6)
                        goal.fixedSize(horizontal: true, vertical: false)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        energyAmount(amount)
                        goal
                    }
                }
            } else {
                energyAmount(amount)
            }
            if let fraction = energy.fraction {
                progressTrack(fraction, fill: NativePalette.onAccent, track: NativePalette.onAccent.opacity(0.26))
            }
        }
        .foregroundStyle(NativePalette.onAccent)
        .padding(.horizontal, 13).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .nativeGeometricCard(fill: NativePalette.accent, corner: 19, compactCorner: 7, compactAt: .bottomTrailing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("已摄入能量")
        .accessibilityValue(energy.accessibilityValue)
        .accessibilityIdentifier("today-nutrition-energy")
    }

    private func energyAmount(_ amount: String) -> some View {
        let value = Text(amount).font(.system(size: calorieSize, weight: .semibold, design: .rounded)).monospacedDigit()
        let unit = Text("千卡").font(.caption)
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 4) { value; unit }
            VStack(alignment: .leading, spacing: 1) { value; unit }
        }
    }

    private func macro(_ title: String, key: String, data: NativeNutritionDay, targets: NativeJSON?) -> NativeHomeNutrient {
        let value = data.summary.nutrients[key]
        return NativeHomeNutrient(title, unit: "g", total: value?.total, knownCount: value?.knownCount ?? 0,
                                  unknownCount: value?.unknownCount ?? data.summary.entryCount,
                                  target: targets?[key].stringValue)
    }

    private func macroCells(_ macros: [(key: String, nutrient: NativeHomeNutrient)], horizontal: Bool) -> some View {
        ForEach(macros, id: \.key) { key, nutrient in
            macroCell(nutrient, key: key, horizontal: horizontal)
        }
    }

    private func macroCell(_ nutrient: NativeHomeNutrient, key: String, horizontal: Bool) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(nutrient.title).font(.caption).foregroundStyle(NativePalette.muted)
            Text(nutrient.quantity).font(.subheadline.weight(.semibold)).monospacedDigit()
                .foregroundStyle(NativePalette.ink).fixedSize(horizontal: horizontal, vertical: true)
            if let fraction = nutrient.fraction {
                progressTrack(fraction, fill: NativePalette.accent, track: NativePalette.soft)
            }
        }
        .frame(minWidth: horizontal ? 78 : nil, maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(nutrient.title)
        .accessibilityValue(nutrient.accessibilityValue)
        .accessibilityIdentifier("today-nutrition-" + key)
    }

    private func progressTrack(_ fraction: Double, fill: Color, track: Color) -> some View {
        GeometryReader { geometry in
            Capsule().fill(track).overlay(alignment: .leading) {
                Capsule().fill(fill).frame(width: geometry.size.width * CGFloat(fraction))
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
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

    private func refreshOverviewOnDayAdvance(day: String) async {
        guard let owner = model.session?.user.id else { observedDayScope = nil; return }
        let selected = Scope(owner: owner, day: day)
        let previous = observedDayScope
        observedDayScope = selected
        // Initial appearance and account changes retain the app's existing
        // overview refresh. Only an observed forward day transition is ours.
        guard let previous, previous.owner == owner, previous.day < day else { return }
        await Task.yield()
        do {
            // A foreground or manual refresh already in flight gets to finish;
            // never cancel it just to obtain the same new day's targets.
            while model.overviewLoading {
                guard acceptsRollover(selected) else { return }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            guard acceptsRollover(selected) else { return }
            if let current = model.overview?.today, current >= day { return }
            await model.reloadOverview(presentError: false)
        } catch is CancellationError { return }
        catch { return }
    }

    private func acceptsRollover(_ selected: Scope) -> Bool {
        !Task.isCancelled && observedDayScope == selected
            && model.session?.user.id == selected.owner
            && NativeActionDates.day(Date()) == selected.day
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
