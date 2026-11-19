import SwiftUI
import PhotosUI
import UIKit
import ImageIO
import Charts

@MainActor
struct NativeNutritionRoot: View {
    private let initialCompose: Bool
    private let quickSuggestions: Bool
    private let onMutation: (() async -> Void)?
    @StateObject private var context: NativeNutritionContext
    @State private var date: Date
    @State private var meal: String
    @State private var includeDeleted = false
    @State private var data: NativeJSON = .null
    @State private var goals: NativeJSON?
    @State private var goalDay: String?
    @State private var activity: Double?
    @State private var activityDay: String?
    @State private var expandedMeals: Set<QuickEntryMeal> = []
    @State private var expansionDay: String?
    @State private var loading = false
    @State private var readError: String?
    @State private var composing = false
    @State private var openedInitialCompose = false
    @State private var readID = UUID()
    @State private var supplementalReads: Task<Void, Never>?

    private struct ReadKey: Equatable {
        let day: String
        let today: String
        let includeDeleted: Bool
        let mutation: Int
    }

    init(api: NativeAPI, token: String, userID: String, initialCompose: Bool = false,
         initialDate: Date = Date(), initialMeal: String? = nil, quickSuggestions: Bool = false,
         onMutation: (() async -> Void)? = nil) {
        self.initialCompose = initialCompose
        self.quickSuggestions = quickSuggestions
        self.onMutation = onMutation
        _date = State(initialValue: initialDate)
        _meal = State(initialValue: initialMeal ?? NativeNutritionEntrySelection.suggestedMeal())
        _context = StateObject(wrappedValue: NativeNutritionContext(api: api, token: token, userID: userID))
    }

    private var day: String { NativeActionDates.day(date) }
    private var diary: NativeJSON { data["date"].stringValue == day ? data : .null }
    private var canRecord: Bool { context.pending == nil && !context.busy }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { timeline in
            let today = NativeActionDates.day(timeline.date)
            page(now: timeline.date, today: today)
                .task(id: ReadKey(day: day, today: today, includeDeleted: includeDeleted, mutation: context.changes)) {
                    await load(today: today)
                }
        }
        .nativeGeometricPage()
        .navigationTitle("饮食")
        .environment(\.timeZone, NativeActionDates.timeZone)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                NavigationLink { NativeNutritionGoalsView(context: context) } label: {
                    Label("目标", systemImage: "slider.horizontal.3").labelStyle(.titleOnly)
                }
                Menu {
                    Toggle("显示已删除记录", isOn: $includeDeleted)
                } label: { Image(systemName: "ellipsis.circle").accessibilityLabel("饮食选项") }
            }
        }
        .task {
            context.restorePending()
            if initialCompose, !openedInitialCompose {
                openedInitialCompose = true
                if canRecord { composing = true }
            }
        }
        .onDisappear { supplementalReads?.cancel() }
        .onChange(of: context.changes) { _, _ in
            if let onMutation { Task { await onMutation() } }
        }
        .sheet(isPresented: $composing) {
            NavigationStack {
                NativeNutritionEntryChooser(context: context, date: $date, meal: $meal,
                                            quickSuggestions: quickSuggestions) { composing = false }
            }
            .environment(\.timeZone, NativeActionDates.timeZone)
        }
    }

    private func page(now: Date, today: String) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                dateNavigation(now: now)
                NavigationLink {
                    NativeRecipesRoot(api: context.api, token: context.token, userID: context.userID)
                } label: {
                    HStack {
                        Label("我的菜谱", systemImage: "book.closed")
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).accessibilityHidden(true)
                    }
                    .font(.subheadline.weight(.semibold)).foregroundStyle(NativePalette.ink)
                    .padding(.horizontal, 14).frame(minHeight: 44)
                    .nativeGeometricCard(fill: NativePalette.surface, corner: 16, compactCorner: 7)
                }
                .buttonStyle(NativePressStyle())
                .accessibilityIdentifier("diet-my-recipes")
                pendingSection
                NativeNutritionErrorRow(text: context.error)
                if let readError {
                    VStack(alignment: .leading, spacing: 8) {
                        NativeNutritionErrorRow(text: readError)
                        Button("重试") { Task { await load(today: today) } }.disabled(loading)
                    }
                }
                if diary != .null {
                    NativeDietEnergyOverview(nutrients: diary["summary"]["nutrients"],
                                             targets: day == today && goalDay == day ? goals : nil)
                    activitySummary
                    mealJournal
                } else if loading || readError == nil {
                    ProgressView("读取饮食…").frame(maxWidth: .infinity, minHeight: 116)
                }
            }
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 14)
            .frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .refreshable { await load(today: today) }
        .safeAreaInset(edge: .bottom, spacing: 0) { actions }
    }

    private func dateNavigation(now: Date) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            DatePicker("饮食日期", selection: $date, in: ...now, displayedComponents: .date)
                .datePickerStyle(.compact).labelsHidden()
                .accessibilityIdentifier("diet-date-picker")
            NativeDietWeekStrip(date: $date, now: now)
        }
    }

    @ViewBuilder private var pendingSection: some View {
        if let pending = context.pending {
            VStack(alignment: .leading, spacing: 6) {
                Text("保存待确认").font(.headline)
                Text(pending.title).font(.subheadline).foregroundStyle(NativePalette.muted)
                Button("继续核对") { Task { await context.retry(pending) } }
                    .frame(minHeight: 44).disabled(context.busy)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(14)
            .nativeGeometricCard(corner: 18, compactCorner: 7)
        }
    }

    private var activitySummary: some View {
        let value = activityDay == day ? activity : nil
        return HStack(spacing: 8) {
            Image(systemName: "waveform.path").foregroundStyle(NativePalette.accent).accessibilityHidden(true)
            Text("活动能量")
            Spacer(minLength: 6)
            Text(value.map { $0.formatted(.number.precision(.fractionLength(0...1))) + " 千卡" } ?? "—")
                .monospacedDigit().foregroundStyle(NativePalette.muted)
        }
        .font(.subheadline).foregroundStyle(NativePalette.ink)
        .padding(.horizontal, 3).frame(minHeight: 30)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("活动能量")
        .accessibilityValue(value.map { $0.formatted(.number.precision(.fractionLength(0...1))) + " 千卡" } ?? "暂无记录")
    }

    private var mealJournal: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text("餐次").font(.headline).foregroundStyle(NativePalette.ink)
                Spacer(minLength: 8)
                NavigationLink {
                    NativeNutritionStatusView(context: context, initial: diary["dayStatus"], date: day)
                } label: {
                    HStack(spacing: 4) {
                        Text(diary["dayStatus"]["complete"].boolValue == true ? "已记完"
                             : diary["summary"]["entryCount"].intValue == 0 ? "未记录" : "记录中")
                        Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                    }
                    .font(.subheadline).foregroundStyle(NativePalette.accent).frame(minHeight: 44)
                }
                .buttonStyle(NativePressStyle())
                .accessibilityHint("查看并确认餐次状态")
            }
            ForEach(QuickEntryMeal.allCases) { selectedMeal in mealCard(selectedMeal) }
        }
    }

    private func mealCard(_ selectedMeal: QuickEntryMeal) -> some View {
        let mealKey = selectedMeal.rawValue
        let rows = diary["entries"].arrayValue.filter {
            $0["meal"].stringValue == mealKey && (includeDeleted || $0["deleted"].boolValue != true)
        }
        let expanded = expansionDay == day && expandedMeals.contains(selectedMeal)
        let total = NativeDietMealSubtotal.label(entries: rows,
            skipped: diary["dayStatus"]["meals"][mealKey].stringValue == "skipped")
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 2) {
                Button {
                    if rows.isEmpty { startRecording(selectedMeal) }
                    else if expanded { expandedMeals.remove(selectedMeal) }
                    else { expandedMeals.insert(selectedMeal) }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: mealIcon(selectedMeal)).font(.subheadline)
                            .foregroundStyle(NativePalette.accent).accessibilityHidden(true)
                        Text(selectedMeal.title).font(.subheadline.weight(.semibold))
                        Spacer(minLength: 4)
                        Text(total).font(.caption).monospacedDigit().foregroundStyle(NativePalette.muted)
                        if !rows.isEmpty {
                            Image(systemName: expanded ? "chevron.up" : "chevron.down")
                                .font(.caption2.weight(.medium)).foregroundStyle(NativePalette.accent)
                                .accessibilityHidden(true)
                        }
                    }
                    .foregroundStyle(NativePalette.ink).multilineTextAlignment(.leading)
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(NativePressStyle())
                .disabled(rows.isEmpty && !canRecord)
                .accessibilityHint(rows.isEmpty ? "添加记录" : expanded ? "收起食物明细" : "展开食物明细")
                Button { startRecording(selectedMeal) } label: {
                    Image(systemName: "plus").font(.body).foregroundStyle(NativePalette.accent)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(NativePressStyle()).disabled(!canRecord)
                .accessibilityLabel("添加" + selectedMeal.title)
            }
            if expanded {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, entry in
                    Divider()
                    NavigationLink { NativeNutritionEntryDetail(context: context, initial: entry) } label: {
                        foodRow(entry)
                    }.buttonStyle(NativePressStyle())
                }
            }
        }
        .padding(.leading, 11).padding(.trailing, 4)
        .nativeGeometricCard(corner: 18, compactCorner: 7)
    }

    private func foodRow(_ entry: NativeJSON) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry["name"].stringValue ?? "食物")
                    .strikethrough(entry["deleted"].boolValue == true)
                if let portion = entry["portion"].stringValue, !portion.isEmpty {
                    Text(portion).font(.caption).foregroundStyle(NativePalette.muted)
                }
                if entry["deleted"].boolValue == true {
                    Text("已删除").font(.caption).foregroundStyle(NativePalette.muted)
                }
            }
            Spacer(minLength: 2)
            Text(NativeNutritionFields.value(entry["calories"], unit: "千卡"))
                .font(.caption).monospacedDigit().foregroundStyle(NativePalette.muted)
        }
        .font(.subheadline).foregroundStyle(NativePalette.ink)
        .padding(.vertical, 7).padding(.trailing, 10)
        .frame(minHeight: 44).contentShape(Rectangle())
    }

    private var actions: some View {
        HStack(spacing: 8) {
            Button { startRecording() } label: {
                Label("记一餐", systemImage: "plus")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(NativePalette.onAccent)
                    .padding(.horizontal, 8).frame(maxWidth: .infinity, minHeight: 44)
                    .nativeGeometricCard(fill: NativePalette.accent, corner: 18, compactCorner: 7, compactAt: .bottomTrailing)
            }
            .buttonStyle(NativePressStyle()).disabled(!canRecord)
            NavigationLink { NativeNutritionReviewView(context: context, initialDate: date) } label: {
                Label("回顾", systemImage: "calendar")
                    .font(.subheadline.weight(.medium)).foregroundStyle(NativePalette.accent)
                    .padding(.horizontal, 12).frame(minHeight: 44)
                    .nativeGeometricCard(corner: 18, compactCorner: 7, compactAt: .topLeading)
            }.buttonStyle(NativePressStyle())
        }
        .padding(.horizontal, 16).padding(.vertical, 7)
        .frame(maxWidth: 620).frame(maxWidth: .infinity)
        .background(NativePalette.canvas)
    }

    private func startRecording(_ selected: QuickEntryMeal? = nil) {
        guard canRecord else { return }
        if let selected { meal = selected.rawValue }
        composing = true
    }

    private func mealIcon(_ selectedMeal: QuickEntryMeal) -> String {
        switch selectedMeal.rawValue {
        case "breakfast": return "cup.and.saucer"
        case "lunch": return "sun.max"
        case "dinner": return "moon"
        default: return "carrot"
        }
    }

    private func load(today: String) async {
        let selected = day, identifier = UUID(), includesDeleted = includeDeleted
        readID = identifier
        loading = true; readError = nil
        if activityDay != selected { activity = nil }
        if goalDay != selected || selected != today { goals = nil }
        defer { if readID == identifier { loading = false } }

        // The diary can finish loading or be retried even if the optional
        // goals or Health read is still waiting on the network.
        supplementalReads?.cancel()
        supplementalReads = Task {
            async let goal: Void = readGoals(date: selected, today: today, identifier: identifier)
            await readActivity(date: selected, identifier: identifier)
            await goal
        }
        do {
            let path = "health/nutrition?" + NativeWorkspaceFormat.query(["date": selected, "includeDeleted": includesDeleted ? "1" : "0"])
            let result = try await context.api.json(path: path, token: context.token)
            guard accepts(identifier, date: selected) else { return }
            guard result["date"].stringValue == selected else { throw NativeAPIError.invalidResponse }
            data = result
            if expansionDay != selected {
                let rows = result["entries"].arrayValue
                let first = QuickEntryMeal.allCases.first { meal in
                    rows.contains { $0["meal"].stringValue == meal.rawValue && $0["deleted"].boolValue != true }
                }
                expandedMeals = first.map { Set([$0]) } ?? []
                expansionDay = selected
            }
        } catch {
            if accepts(identifier, date: selected), !(error is CancellationError) { readError = error.localizedDescription }
        }
    }

    private func readGoals(date selected: String, today: String, identifier: UUID) async {
        guard selected == today else { return }
        let result = try? await context.api.json(path: "health/nutrition/goals", token: context.token)
        guard accepts(identifier, date: selected), NativeActionDates.day(Date()) == today else { return }
        goalDay = selected
        if let result, case .object = result["goals"] { goals = result["goals"] }
        else { goals = nil }
    }

    private func readActivity(date selected: String, identifier: UUID) async {
        let path = "health?" + NativeWorkspaceFormat.query(["from": selected, "to": selected])
        let result: NativeHealthResponse? = try? await context.api.request(
            path: path, token: context.token, reportWorkspaceFailure: true)
        guard accepts(identifier, date: selected) else { return }
        activityDay = selected
        activity = result.flatMap { NativeDietActivity.value(in: $0, date: selected) }
    }

    private func accepts(_ identifier: UUID, date selected: String) -> Bool {
        !Task.isCancelled && readID == identifier && day == selected
    }
}

enum NativeDietActivity {
    static func value(in response: NativeHealthResponse, date: String) -> Double? {
        guard let metric = response.summary.metrics["active_energy"], metric.unit == "kcal",
              let point = metric.points.first(where: { $0.day == date }), point.value.isFinite, point.value >= 0 else {
            return nil
        }
        return point.value
    }
}

enum NativeDietMealSubtotal {
    static func label(entries: [NativeJSON], skipped: Bool) -> String {
        let active = entries.filter { $0["deleted"].boolValue != true }
        guard !active.isEmpty else { return skipped ? "未进食" : "未记录" }
        let amounts = active.compactMap { entry -> Decimal? in
            guard let text = entry["calories"].stringValue, !text.isEmpty,
                  let value = Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")),
                  !value.isNaN, value >= 0 else { return nil }
            return value
        }
        guard !amounts.isEmpty else { return "—" }
        let value = NSDecimalNumber(decimal: amounts.reduce(Decimal.zero, +)).stringValue
        return (amounts.count < active.count ? "≥" : "") + value + " 千卡"
    }
}

@MainActor
private struct NativeNutritionEntryChooser: View {
    @ObservedObject var context: NativeNutritionContext
    @Binding var date: Date
    @Binding var meal: String
    let quickSuggestions: Bool
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var editor: NutritionEditorPresentation?
    @State private var favorites: [NativeJSON] = []
    @State private var loadingPreviousMeal = false
    @State private var suggestionError: String?
    private var selection: NativeNutritionEntrySelection { NativeNutritionEntrySelection(date: NativeActionDates.day(date), meal: meal) }
    var body: some View {
        List {
            Section {
                DatePicker("日期", selection: $date, in: ...Date(), displayedComponents: .date)
                Picker("餐次", selection: $meal) { ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0.rawValue) } }
            }.listRowBackground(NativePalette.surface)
            if quickSuggestions { suggestions }
            Section("怎么记录这餐？") {
                NavigationLink { NativeNutritionReuseView(context: context, date: selection.date, initialMeal: meal, onDraft: adopt) } label: { Label("常吃与最近", systemImage: "heart") }
                NavigationLink { NativeNutritionRecognitionView(context: context, date: selection.date, meal: meal, usePhoto: true, onSaved: onSaved) } label: { Label("拍照记录", systemImage: "camera") }
                NavigationLink { NativeNutritionRecognitionView(context: context, date: selection.date, meal: meal, onSaved: onSaved) } label: { Label("说说吃了什么", systemImage: "text.bubble") }
                NavigationLink { NativeNutritionBatchEditor(context: context, rows: [selection.applying()], onSaved: onSaved) } label: { Label("手动填写", systemImage: "square.and.pencil") }
            }.listRowBackground(NativePalette.surface).labelStyle(NativeNutritionEntryLabelStyle()).disabled(context.busy || context.pending != nil)
            Section("更多选择") {
                NavigationLink {
                    NativeNutritionFoodsView(api: context.api, token: context.token, userID: context.userID,
                        initialDate: selection.date, initialMeal: meal, onDraft: adopt)
                } label: { Label("查找食物", systemImage: "magnifyingglass") }
                NavigationLink {
                    NativeNutritionTemplatesView(context: context, initialDate: selection.date, initialMeal: meal, onDraft: adopt)
                } label: { Label("我的食物与整餐模板", systemImage: "square.stack") }
            }.listRowBackground(NativePalette.surface).labelStyle(NativeNutritionEntryLabelStyle()).disabled(context.busy || context.pending != nil)
        }
        .nativeGeometricPage().navigationTitle("记一餐").navigationBarTitleDisplayMode(.inline)
        .environment(\.timeZone, NativeActionDates.timeZone)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        .task { if quickSuggestions { await loadFavorites() } }
        .sheet(item: $editor) { value in NavigationStack { NativeNutritionBatchEditor(context: context, rows: value.rows, onSaved: onSaved) } }
    }

    private var suggestions: some View {
        Section("快速带入") {
            ForEach(Array(favorites.enumerated()), id: \.offset) { _, item in
                if let name = item["name"].stringValue {
                    Button {
                        adoptSuggestion(item)
                    } label: { Label(name, systemImage: "heart") }
                    .accessibilityHint("将常吃食物带入可编辑的记录草稿")
                }
            }
            Button {
                Task { await adoptPreviousMeal() }
            } label: {
                Label(selection.date == NativeActionDates.day(Date()) ? "昨天同餐" : "前一天同餐",
                      systemImage: "arrow.uturn.backward")
            }
            if loadingPreviousMeal { ProgressView("读取前一天的记录…") }
            NativeNutritionErrorRow(text: suggestionError)
        }.listRowBackground(NativePalette.surface).labelStyle(NativeNutritionEntryLabelStyle())
            .disabled(context.busy || context.pending != nil || loadingPreviousMeal)
    }

    private func loadFavorites() async {
        do {
            let response = try await context.api.json(path: "health/nutrition/reuse", token: context.token)
            guard !Task.isCancelled else { return }
            favorites = Array(response["favorites"].arrayValue.prefix(3))
        } catch {
            // The full reuse screen owns its own load and retry controls.
        }
    }

    private func adoptSuggestion(_ item: NativeJSON) {
        suggestionError = nil
        do { adopt([try NativeNutritionReuseDraft.make(item, date: selection.date, meal: selection.meal)]) }
        catch { suggestionError = error.localizedDescription }
    }

    private func adoptPreviousMeal() async {
        guard !loadingPreviousMeal, let previous = NativeActionDates.calendar.date(byAdding: .day, value: -1, to: date) else { return }
        loadingPreviousMeal = true
        suggestionError = nil
        defer { loadingPreviousMeal = false }
        let target = selection
        let body: NativeJSON = .object(["action": .string("preview"), "fromDate": .string(NativeActionDates.day(previous)),
            "fromMeal": .string(target.meal), "toDate": .string(target.date), "toMeal": .string(target.meal)])
        do {
            let response = try await context.api.json(path: "health/nutrition/copy", method: "POST", token: context.token, body: body)
            guard !Task.isCancelled, selection == target, context.pending == nil else { return }
            let entries = response["preview"]["entries"].arrayValue
            guard !entries.isEmpty else { suggestionError = "前一天这个餐次没有可复制的记录。"; return }
            adopt(try entries.map { try NativeNutritionReuseDraft.make($0, date: target.date, meal: target.meal) })
        } catch {
            if !Task.isCancelled, selection == target { suggestionError = error.localizedDescription }
        }
    }

    private func adopt(_ rows: [NativeJSON]) { editor = NutritionEditorPresentation(rows: rows) }
}

private struct NativeNutritionEntryLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 14) {
            configuration.icon.font(.title3).foregroundStyle(NativePalette.accent)
                .frame(width: 44, height: 44)
                .background(NativePalette.soft, in: RoundedRectangle(cornerRadius: 15))
            configuration.title.font(.body.weight(.medium)).foregroundStyle(NativePalette.ink)
        }.padding(.vertical, 6)
    }
}

struct NutritionEditorPresentation: Identifiable {
    let id = UUID()
    let rows: [NativeJSON]
}

struct NativeNutritionTotals: View {
    let nutrients: NativeJSON
    var compact = false
    var body: some View {
        if compact {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("热量已知小计").font(.subheadline).foregroundStyle(NativePalette.muted)
                    Spacer()
                    Image(systemName: "fork.knife").foregroundStyle(NativePalette.accent)
                        .frame(width: 36, height: 36).background(NativePalette.surface.opacity(0.7), in: Circle())
                        .accessibilityHidden(true)
                }
                Text((nutrients["calories"]["knownCount"].intValue ?? 0) > 0 ? NativeNutritionFields.value(nutrients["calories"]["total"], unit: "千卡") : "—")
                    .font(.largeTitle.weight(.semibold)).monospacedDigit().foregroundStyle(NativePalette.ink)
                if let unknown = nutrients["calories"]["unknownCount"].intValue, unknown > 0 {
                    Text("另有\(unknown)项热量未知").font(.caption).foregroundStyle(NativePalette.muted)
                }
            }
            .padding(22).frame(maxWidth: .infinity, alignment: .leading).nativeGeometricCard(fill: NativePalette.soft)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
            .listRowBackground(Color.clear).listRowSeparator(.hidden)
            DisclosureGroup("营养明细") {
                detailedTotals
                Text("未知与未记录不计为0。").font(.caption).foregroundStyle(NativePalette.muted)
            }
        } else { detailedTotals }
    }
    private var detailedTotals: some View {
        ForEach(NativeNutritionFields.keys, id: \.self) { key in
            VStack(alignment: .leading, spacing: 3) {
                LabeledContent(NativeNutritionFields.title(key) + "已知小计",
                    value: NativeNutritionFields.value(nutrients[key]["total"], unit: key == "calories" ? "千卡" : "克"))
                Text("已知\(nutrients[key]["knownCount"].intValue ?? 0)项 · 未知\(nutrients[key]["unknownCount"].intValue ?? 0)项")
                    .font(.caption).foregroundStyle(NativePalette.muted)
            }
        }
    }
}

struct NativeNutritionReadOnlyFields: View {
    let row: NativeJSON
    var body: some View {
        LabeledContent("日期", value: row["date"].stringValue ?? "未知")
        LabeledContent("餐次", value: NativeNutritionFields.meal(row["meal"].stringValue))
        LabeledContent("份量", value: row["portion"].stringValue ?? "未填写")
        ForEach(NativeNutritionFields.keys, id: \.self) { key in
            VStack(alignment: .leading, spacing: 4) {
                LabeledContent(NativeNutritionFields.title(key), value: NativeNutritionFields.value(row[key], unit: key == "calories" ? "千卡" : "克"))
                Text("来源：" + NativeNutritionFields.source(row["provenance"][key]["source"].stringValue)).font(.caption).foregroundStyle(NativePalette.muted)
                if row["provenance"][key]["basis"].stringValue != nil || row["provenance"][key]["originalValue"].stringValue != nil {
                    DisclosureGroup("查看依据") {
                        if let basis = row["provenance"][key]["basis"].stringValue { Text(basis).font(.caption).foregroundStyle(NativePalette.muted) }
                        if let original = row["provenance"][key]["originalValue"].stringValue { Text("原参考值：" + original).font(.caption).foregroundStyle(NativePalette.muted) }
                    }.font(.caption)
                }
            }
        }
        if let release = row["food"]["catalogRelease"].stringValue { LabeledContent("食物库版本", value: release) }
        if let note = row["note"].stringValue, !note.isEmpty { Text(note) }
    }
}

@MainActor
struct NativeNutritionEntryDetail: View {
    @ObservedObject var context: NativeNutritionContext
    @State private var row: NativeJSON
    @State private var error: String?
    @State private var editing = false
    @State private var confirmingDelete = false
    init(context: NativeNutritionContext, initial: NativeJSON) { self.context = context; _row = State(initialValue: initial) }
    private var entryID: String { row["id"].stringValue ?? "" }
    var body: some View {
        Form {
            Section(row["name"].stringValue ?? "食物详情") {
                NativeNutritionMacroChart(row: row)
                NativeNutritionReadOnlyFields(row: row)
            }.listRowBackground(NativePalette.surface)
            Section {
                Button("编辑记录") { editing = true }
                NavigationLink("修改历史与恢复") { NativeNutritionHistoryView(context: context, entryID: entryID) }
                Button("加入常吃") { Task { await favorite() } }
                Button(row["deleted"].boolValue == true ? "恢复这条记录" : "删除这条记录", role: .destructive) { confirmingDelete = true }
            }.listRowBackground(NativePalette.surface).disabled(context.busy || context.pending != nil)
            NativeNutritionErrorRow(text: error ?? context.error)
        }
        .nativeGeometricPage().navigationTitle("食物详情").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: context.changes) { _, _ in Task { await load() } }
        .sheet(isPresented: $editing) { NavigationStack { NativeNutritionBatchEditor(context: context, rows: [row], editing: row) } }
        .confirmationDialog("确认修改这条记录的删除状态？已有修改历史继续保留。", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button(row["deleted"].boolValue == true ? "恢复记录" : "删除记录", role: .destructive) { Task { await toggleDeleted() } }
        }
    }
    private func load() async {
        do { let result = try await context.api.json(path: "health/nutrition/" + entryID, token: context.token)
            guard !Task.isCancelled else { return }; row = result["entry"]; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func favorite() async {
        _ = await context.write(NativeNutritionCommand(path: "health/nutrition/reuse", title: "将食物加入常吃",
            body: .object(["entryId": .string(entryID), "expectedRevision": row["revision"]])))
    }
    private func toggleDeleted() async {
        _ = await context.write(NativeNutritionCommand(path: "health/nutrition/" + entryID, method: "PATCH", title: "修改食物删除状态",
            body: .object(["deleted": .bool(row["deleted"].boolValue != true), "expectedRevision": row["revision"]])))
    }
}

@MainActor
struct NativeNutritionHistoryView: View {
    @ObservedObject var context: NativeNutritionContext
    let entryID: String
    @State private var history: [NativeJSON] = []
    @State private var revision: NativeJSON = .null
    @State private var target: NativeJSON?
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        List {
            if loading { ProgressView("读取修改历史…") }
            ForEach(Array(history.enumerated()), id: \.offset) { _, item in
                DisclosureGroup("版本\(item["revision"].intValue ?? 0) · " + NativeWorkspaceFormat.timestamp(item["createdAt"].stringValue)) {
                    Text(["baseline":"兼容基线", "create":"新增", "edit":"编辑", "delete":"删除", "restore":"恢复"][item["action"].stringValue ?? ""] ?? "记录变更")
                    if item["before"] != .null {
                        DisclosureGroup("修改前") { NativeNutritionReadOnlyFields(row: item["before"]) }
                    }
                    DisclosureGroup("此版本内容") { NativeNutritionReadOnlyFields(row: item["after"]) }
                    Text(item["after"]["deleted"].boolValue == true ? "此版本为已删除状态" : "此版本为正常记录")
                    Button("恢复到此版本") { target = item }.disabled(context.busy || context.pending != nil)
                }
            }
            if !loading && history.isEmpty && error == nil { Text("暂无可用修改历史。") }
            NativeNutritionErrorRow(text: error ?? context.error)
        }
        .nativeGeometricPage().navigationTitle("修改历史").task { await load() }.refreshable { await load() }
        .confirmationDialog("恢复会生成新版本，并保留此版本的日期、餐次和删除状态。", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }), titleVisibility: .visible) {
            if let target { Button("确认恢复") { Task { await restore(target) } } }
        }
    }
    private func load() async {
        loading = true; defer { loading = false }
        do {
            let current = try await context.api.json(path: "health/nutrition/" + entryID, token: context.token)
            let result = try await context.api.json(path: "health/nutrition/" + entryID + "/history", token: context.token)
            guard !Task.isCancelled else { return }; revision = current["entry"]["revision"]; history = result["history"].arrayValue; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func restore(_ target: NativeJSON) async {
        if await context.write(NativeNutritionCommand(path: "health/nutrition/" + entryID + "/restore", title: "恢复饮食历史版本",
            body: .object(["revision": target["revision"], "expectedRevision": revision]))) != nil { await load() }
    }
}

@MainActor
struct NativeNutritionBatchEditor: View {
    @ObservedObject var context: NativeNutritionContext
    @Environment(\.dismiss) private var dismiss
    @State private var drafts: [NativeNutritionDraft]
    let editing: NativeJSON?
    let onSaved: (() -> Void)?
    @State private var error: String?
    @State private var recovered: [NativeNutritionDraft]?
    @State private var originalDrafts: [NativeNutritionDraft]
    @State private var confirmClose = false
    @State private var finished = false
    @State private var persistenceReady = false
    @State private var saveDraftTask: Task<Void, Never>?
    @State private var validating = false
    @State private var expanded = Set<UUID>()
    @State private var firstIssueAnchor: String?
    init(context: NativeNutritionContext, rows: [NativeJSON], editing: NativeJSON? = nil, onSaved: (() -> Void)? = nil) {
        self.context = context; self.editing = editing; self.onSaved = onSaved
        let values = rows.map { NativeNutritionDraft($0) }
        _drafts = State(initialValue: values); _originalDrafts = State(initialValue: values)
        _expanded = State(initialValue: values.count == 1 ? Set(values.map(\.id)) : [])
    }
    private var persistence: NativeWorkspacePersistence {
        NativeWorkspacePersistence(userID: context.userID, scope: "nutrition-editor." + (editing?["id"].stringValue ?? "new"))
    }
    private var changed: Bool { drafts != originalDrafts || (editing == nil && drafts.contains { !$0.name.isEmpty }) }
    private var canSave: Bool { !context.busy && context.pending == nil && !drafts.isEmpty && persistenceReady && recovered == nil && !finished }
    var body: some View {
        ScrollViewReader { proxy in
            editorForm
                .onChange(of: firstIssueAnchor) { _, target in
                    guard let target else { return }
                    Task { await Task.yield(); withAnimation { proxy.scrollTo(target, anchor: .center) } }
                }
        }
        .nativeGeometricPage().navigationTitle(editing == nil ? "核对这餐" : "编辑食物")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭") { if changed { confirmClose = true } else { dismiss() } }.disabled(context.busy)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(context.busy ? "保存中…" : "保存") { Task { await save() } }.disabled(!canSave)
                    .fontWeight(.semibold)
            }
        }
        .interactiveDismissDisabled(context.busy || changed)
        .task { do { recovered = try persistence.load([NativeNutritionDraft].self); persistenceReady = true } catch { self.error = error.localizedDescription } }
        .onChange(of: drafts) { _, _ in
            guard persistenceReady, !finished, recovered == nil else { return }
            saveDraftTask?.cancel()
            saveDraftTask = Task { try? await Task.sleep(for: .milliseconds(350)); if !Task.isCancelled { saveDraft() } }
        }
        .onDisappear { saveDraftTask?.cancel(); if !finished && persistenceReady && changed && recovered == nil { saveDraft() } }
        .confirmationDialog("还有未保存的食物。", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("存草稿并关闭") { if saveDraft() { finished = true; dismiss() } }
            Button("放弃本页填写", role: .destructive) { do { try persistence.clear(); finished = true; dismiss() } catch { self.error = error.localizedDescription } }
        }
    }
    private var editorForm: some View {
        Form {
            recoverySection
            Section {
                Text("共\(drafts.count)项，展开食物可修改。未知营养留空，填写0表示已确认。").font(.footnote).foregroundStyle(NativePalette.muted)
            }.listRowBackground(NativePalette.surface)
            ForEach($drafts) { $draft in
                DisclosureGroup(isExpanded: Binding(get: { expanded.contains(draft.id) }, set: { selected in
                    if selected { expanded.insert(draft.id) } else { expanded.remove(draft.id) }
                })) {
                    NativeNutritionDraftFields(draft: $draft, context: context, issues: issueMessages(draft))
                } label: { NativeNutritionDraftSummary(draft: draft) }
                .id(draft.id)
            }.onDelete { if editing == nil && canSave { drafts.remove(atOffsets: $0) } }
            .disabled(context.busy || context.pending != nil || recovered != nil || !persistenceReady)
            if editing == nil && drafts.count < 30 {
                Button("再加一项", systemImage: "plus") {
                    let target = drafts.first.map { NativeNutritionEntrySelection(date: $0.date, meal: $0.meal) }
                        ?? NativeNutritionEntrySelection(date: NativeActionDates.day(Date()), meal: NativeNutritionEntrySelection.suggestedMeal())
                    let added = NativeNutritionDraft(target.applying()); drafts.append(added); expanded.insert(added.id)
                }.disabled(context.busy || context.pending != nil || recovered != nil || !persistenceReady)
            }
            NativeNutritionErrorRow(text: error ?? context.error)
            if !persistenceReady { Button("重新读取本机草稿") { Task { await loadDraft() } } }
        }
    }
    @ViewBuilder private var recoverySection: some View {
        if let recovered {
            Section("上次未完成的填写") {
                Text("\(recovered.count)项食物，恢复后仍需确认保存。").font(.footnote).foregroundStyle(NativePalette.muted)
                Button("恢复草稿") { drafts = recovered; self.recovered = nil }
                Button("丢弃旧草稿", role: .destructive) { do { try persistence.clear(); self.recovered = nil } catch { self.error = error.localizedDescription } }
            }.listRowBackground(NativePalette.surface)
        }
    }
    private func issueMessages(_ draft: NativeNutritionDraft) -> [String: String] {
        guard validating else { return [:] }
        return Dictionary(uniqueKeysWithValues: draft.validationIssues().map { ($0.field, $0.message) })
    }
    private func loadDraft() async {
        do { recovered = try persistence.load([NativeNutritionDraft].self); persistenceReady = true; error = nil }
        catch { self.error = error.localizedDescription }
    }
    @discardableResult private func saveDraft() -> Bool {
        guard persistenceReady, recovered == nil, !finished else { return false }
        do { try persistence.save(drafts); return true }
        catch { persistenceReady = false; self.error = error.localizedDescription; return false }
    }
    private func save() async {
        validating = true; error = nil
        if let first = drafts.flatMap({ $0.validationIssues() }).first {
            expanded.insert(first.rowID); firstIssueAnchor = nil
            Task { await Task.yield(); firstIssueAnchor = first.id }
            error = "请先修正标出的内容。"
            return
        }
        do {
            let rows = try drafts.map { try $0.payload() }
            let command: NativeNutritionCommand
            if let editing, let first = rows.first, let id = editing["id"].stringValue {
                var body = first.objectValue; body["expectedRevision"] = editing["revision"]
                command = NativeNutritionCommand(path: "health/nutrition/" + id, method: "PATCH", title: "编辑食物记录", body: .object(body))
            } else { command = NativeNutritionCommand(path: "health/nutrition/batch", title: "保存\(rows.count)项饮食明细", body: .object(["entries": .array(rows)])) }
            if await context.write(command) != nil { try persistence.clear(); finished = true; onSaved?(); dismiss() }
        } catch { self.error = error.localizedDescription }
    }
}

private struct NativeNutritionDraftSummary: View {
    let draft: NativeNutritionDraft
    private var sources: String {
        let values = NativeNutritionFields.keys.map { draft.provenance[$0]?["source"].stringValue ?? ((draft.nutrients[$0] ?? "").isEmpty ? "unknown" : "manual") }
        return Set(values).sorted().map { NativeNutritionFields.source($0) }.joined(separator: "、")
    }
    private var calories: String {
        guard let value = draft.nutrients["calories"], !value.isEmpty else { return "热量未知" }
        return value + " 千卡"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(draft.name.isEmpty ? "待填写食物" : draft.name).fontWeight(.medium)
            Text((draft.portion.isEmpty ? "份量待补充" : draft.portion) + " · " + calories).font(.subheadline)
            Text(draft.date + " · " + NativeNutritionFields.meal(draft.meal) + " · " + sources).font(.caption).foregroundStyle(NativePalette.muted)
        }.padding(.vertical, 7).foregroundStyle(NativePalette.ink)
    }
}

enum NativeNutritionPhoto {
    /// Retain only pixels and explicit orientation from a camera UIImage, then
    /// use the same transform/size/metadata sanitizer as selected photo files.
    static func jpeg(image: UIImage) throws -> Data {
        guard let pixels = image.cgImage, pixels.width > 0, pixels.height > 0,
              Double(pixels.width) * Double(pixels.height) <= 32_000_000 else {
            throw NativeActionInputError.invalid("拍摄图片过大或无法读取，请重拍或从相册选择较小图片。")
        }
        let orientation: CGImagePropertyOrientation
        switch image.imageOrientation {
        case .up: orientation = .up
        case .upMirrored: orientation = .upMirrored
        case .down: orientation = .down
        case .downMirrored: orientation = .downMirrored
        case .left: orientation = .left
        case .leftMirrored: orientation = .leftMirrored
        case .right: orientation = .right
        case .rightMirrored: orientation = .rightMirrored
        @unknown default: orientation = .up
        }
        let encoded = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(encoded as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
            throw NativeActionInputError.invalid("拍摄图片暂时无法处理，请重试。")
        }
        CGImageDestinationAddImage(destination, pixels, [kCGImagePropertyOrientation: orientation.rawValue,
            kCGImageDestinationLossyCompressionQuality: 0.95] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw NativeActionInputError.invalid("拍摄图片暂时无法处理，请重试。") }
        return try jpeg(encoded as Data)
    }

    static func jpeg(_ original: Data) throws -> Data {
        guard original.count <= 20 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(original as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0, width.doubleValue * height.doubleValue <= 32_000_000,
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1600, kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else { throw NativeActionInputError.invalid("照片无法读取或超过20MiB／3200万像素，请选择较小的餐食图片。") }
        let image = UIImage(cgImage: thumbnail)
        for quality in [0.85, 0.7, 0.5, 0.3] {
            if let data = image.jpegData(compressionQuality: quality), data.count <= 2 * 1024 * 1024 { return data }
        }
        throw NativeActionInputError.invalid("图片压缩后仍超过2MiB，请选择较小图片。")
    }
}

@MainActor
struct NativeNutritionRecognitionView: View {
    @ObservedObject var context: NativeNutritionContext
    @State private var date: Date
    @State private var meal = "lunch"
    @State private var usePhoto = false
    @State private var text = ""
    @State private var photo: PhotosPickerItem?
    @State private var jpeg: Data?
    @State private var photoLoading = false
    @State private var recognizing = false
    @State private var error: String?
    @State private var result: NativeJSON = .null
    @State private var editor: NutritionEditorPresentation?
    @State private var photoID = UUID()
    @State private var recovered: RecognitionDraft?
    @State private var persistenceReady = false
    @State private var restoringSignature: String?
    @Environment(\.openURL) private var openURL
    @State private var cameraAuthorizing = false
    @State private var showingCamera = false
    @State private var cameraID: UUID?
    @State private var pageEpoch = UUID()
    @State private var visible = false
    @State private var cameraAccess: NativeNutritionCameraAccess?
    private struct RecognitionDraft: Codable {
        let date: String; let meal: String; let text: String; let usePhoto: Bool; let result: NativeJSON
    }
    private var persistence: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: context.userID, scope: "nutrition-recognition") }
    private var inputSignature: String { [NativeActionDates.day(date), meal, text, String(usePhoto)].joined(separator: "|") }
    private let onSaved: (() -> Void)?
    init(context: NativeNutritionContext, date: String, meal: String = NativeNutritionEntrySelection.suggestedMeal(),
         usePhoto: Bool = false, onSaved: (() -> Void)? = nil) {
        self.context = context; self.onSaved = onSaved
        _date = State(initialValue: NativeChartDates.parse(date) ?? Date()); _meal = State(initialValue: meal)
        _usePhoto = State(initialValue: usePhoto)
    }
    var body: some View {
        Form {
            if let recovered {
                Section("本机未完成识别草稿") {
                    Text("\(recovered.date) · " + NativeNutritionFields.meal(recovered.meal) + "。照片不在恢复内容中。")
                    Button("恢复描述和明细") {
                        restoringSignature = [recovered.date, recovered.meal, recovered.text, String(recovered.usePhoto)].joined(separator: "|")
                        date = NativeChartDates.parse(recovered.date) ?? date; meal = recovered.meal; text = recovered.text
                        usePhoto = recovered.usePhoto; result = recovered.result; self.recovered = nil
                    }
                    Button("删除本机草稿", role: .destructive) { do { try persistence.clear(); self.recovered = nil } catch { self.error = error.localizedDescription } }
                }.listRowBackground(NativePalette.surface)
            }
            Section {
                Picker("录入方式", selection: $usePhoto) { Text("一句话").tag(false); Text("照片").tag(true) }.pickerStyle(.segmented)
                DatePicker("记录日期", selection: $date, in: ...Date(), displayedComponents: .date)
                Picker("餐次", selection: $meal) { ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0.rawValue) } }
                if usePhoto {
                    let pickerTitle = jpeg == nil ? "从相册选择食物照片" : "更换照片"
                    PhotosPicker(selection: $photo, matching: .images) { Label(pickerTitle, systemImage: "photo") }
                        .disabled(cameraAuthorizing || photoLoading)
                    Button(cameraAuthorizing ? "正在核对相机权限…" : "拍一张餐食照片", systemImage: "camera") {
                        Task { await openCamera() }
                    }.disabled(cameraAuthorizing || photoLoading || context.pending != nil)
                    if cameraAccess == .denied {
                        Text("相机权限未开启。可以从相册选择照片，或在系统设置中允许相机。")
                            .font(.footnote).foregroundStyle(NativePalette.muted)
                        Button("打开相机权限设置") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }
                    } else if cameraAccess == .restricted {
                        Text("相机访问受系统限制，可以从相册选择食物照片。")
                            .font(.footnote).foregroundStyle(NativePalette.muted)
                    } else if cameraAccess == .unavailable {
                        Text("此设备当前没有可用相机。模拟器可通过相册选择测试图片。")
                            .font(.footnote).foregroundStyle(NativePalette.muted)
                    }
                    if photoLoading { ProgressView("正在本机处理图片…") }
                    if let jpeg, let image = UIImage(data: jpeg) {
                        Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 220)
                        Text("图片已在本机压缩，确认识别后上传。")
                            .font(.footnote).foregroundStyle(NativePalette.muted)
                    }
                    TextField("实际吃了多少、配料等补充说明", text: $text, axis: .vertical).lineLimit(3...6)
                } else {
                    TextField("例如：午餐吃了一碗米饭和两个鸡蛋", text: $text, axis: .vertical).lineLimit(4...8)
                }
            }.listRowBackground(NativePalette.surface).disabled(recognizing)
            Section {
                DisclosureGroup("识别会使用哪些资料？") {
                    Text(usePhoto ? "确认识别后，图片、说明、日期和餐次会发送至已配置的AI服务。图片不会保存在饮食记录中。" : "确认识别后，描述、日期和餐次会发送至已配置的AI服务。输入文字不会自动识别。")
                        .font(.footnote).foregroundStyle(NativePalette.muted)
                }
                Button(recognizing ? "识别中…" : "识别这餐") { Task { await recognize() } }
                    .disabled(recognizing || photoLoading || cameraAuthorizing || showingCamera || context.pending != nil || (usePhoto ? jpeg == nil : text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                if recognizing { ProgressView() }
                NativeNutritionErrorRow(text: error)
            }.listRowBackground(NativePalette.surface)
            if result != .null {
                Section("识别结果，尚未保存") {
                    ForEach(Array(result["warnings"].arrayValue.enumerated()), id: \.offset) { _, warning in Text(warning.stringValue ?? "").font(.footnote).foregroundStyle(.orange) }
                    ForEach(Array(result["drafts"].arrayValue.enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item["name"].stringValue ?? "待核对食物").font(.headline)
                            Text(item["portion"].stringValue ?? "份量待核对").font(.footnote)
                            Text("热量：" + NativeNutritionFields.value(item["calories"], unit: "千卡")).font(.footnote)
                            ForEach(Array(item["warnings"].arrayValue.enumerated()), id: \.offset) { _, warning in Text(warning.stringValue ?? "").font(.caption).foregroundStyle(.orange) }
                        }
                    }
                    if !result["drafts"].arrayValue.isEmpty {
                        Button("核对后保存") {
                            let selection = NativeNutritionEntrySelection(date: NativeActionDates.day(date), meal: meal)
                            editor = NutritionEditorPresentation(rows: result["drafts"].arrayValue.map { selection.applying(to: $0) })
                        }
                    } else { Text("没有生成可核对的食物，请补充说明或手动记录。") }
                }.listRowBackground(NativePalette.surface)
            }
        }
        .nativeGeometricPage().navigationTitle("识别饮食").navigationBarTitleDisplayMode(.inline)
        .environment(\.timeZone, NativeActionDates.timeZone)
        .onChange(of: inputSignature) { _, value in
            if restoringSignature == value { restoringSignature = nil } else { result = .null }
            if recovered == nil { saveDraft() }
        }
        .onChange(of: result) { _, _ in if recovered == nil { saveDraft() } }
        .task { do { recovered = try persistence.load(RecognitionDraft.self); persistenceReady = true } catch { self.error = error.localizedDescription } }
        .onAppear { visible = true; if !showingCamera { pageEpoch = UUID() } }
        .onDisappear {
            if !showingCamera { visible = false; pageEpoch = UUID(); cameraID = nil; cameraAuthorizing = false }
            saveDraft()
        }
        .onChange(of: photo) { _, item in Task { await loadPhoto(item) } }
        .fullScreenCover(isPresented: $showingCamera, onDismiss: { cameraID = nil }) {
            if let identifier = cameraID {
                NativeNutritionCamera(onCapture: { image in acceptCameraImage(image, identifier: identifier) },
                    onCancel: { closeCamera(identifier: identifier) },
                    onUnavailable: { cameraAccess = .unavailable; closeCamera(identifier: identifier) })
                    .ignoresSafeArea()
            }
        }
        .sheet(item: $editor) { presentation in
            NavigationStack {
                NativeNutritionBatchEditor(context: context, rows: presentation.rows, onSaved: {
                    text = ""; photo = nil; jpeg = nil; result = .null
                    try? persistence.clear()
                    onSaved?()
                })
            }
        }
    }
    private func openCamera() async {
        guard visible, usePhoto, !cameraAuthorizing, !recognizing, context.pending == nil else { return }
        let epoch = pageEpoch
        cameraAuthorizing = true
        defer { if pageEpoch == epoch { cameraAuthorizing = false } }
        let access = await NativeNutritionCameraAccess.requestForUserAction()
        guard visible, pageEpoch == epoch, usePhoto, context.pending == nil, !Task.isCancelled else { return }
        cameraAccess = access
        guard access == .ready else { return }
        cameraID = UUID(); showingCamera = true
    }
    private func closeCamera(identifier: UUID) {
        guard cameraID == identifier else { return }
        cameraID = nil; showingCamera = false
    }
    private func acceptCameraImage(_ image: UIImage, identifier: UUID) {
        guard showingCamera, cameraID == identifier else { return }
        do {
            let prepared = try NativeNutritionPhoto.jpeg(image: image)
            guard cameraID == identifier else { return }
            photoID = UUID(); jpeg = prepared; result = .null; error = nil
        } catch { self.error = error.localizedDescription }
        closeCamera(identifier: identifier)
    }
    private func saveDraft() {
        guard persistenceReady, !text.isEmpty || result != .null else { return }
        do { try persistence.save(RecognitionDraft(date: NativeActionDates.day(date), meal: meal, text: text, usePhoto: usePhoto, result: result)) }
        catch { self.error = error.localizedDescription }
    }
    private func loadPhoto(_ item: PhotosPickerItem?) async {
        let identifier = UUID(); photoID = identifier; photoLoading = true; error = nil; jpeg = nil; result = .null
        defer { if photoID == identifier { photoLoading = false } }
        guard let item else { return }
        do {
            guard let raw = try await item.loadTransferable(type: Data.self), photoID == identifier, !Task.isCancelled else { return }
            let prepared = try NativeNutritionPhoto.jpeg(raw)
            guard photoID == identifier, !Task.isCancelled else { return }; jpeg = prepared
        } catch { if photoID == identifier && !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func recognize() async {
        guard !recognizing else { return }
        recognizing = true; error = nil; result = .null
        defer { recognizing = false }
        do {
            var body: [String: NativeJSON] = ["date": .string(NativeActionDates.day(date)), "meal": .string(meal), "text": .string(text)]
            if usePhoto {
                guard let jpeg else { throw NativeActionInputError.invalid("请先选择食物照片。") }
                body["image"] = .object(["dataUrl": .string("data:image/jpeg;base64," + jpeg.base64EncodedString())])
            }
            let response = try await context.api.json(path: usePhoto ? "health/nutrition/photo" : "health/nutrition/parse", method: "POST", token: context.token, body: .object(body))
            guard !Task.isCancelled else { return }; result = response
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

struct NativeNutritionDraftFields: View {
    @Binding var draft: NativeNutritionDraft
    var context: NativeNutritionContext? = nil
    var issues: [String: String] = [:]
    @State private var pickingFood = false
    @State private var foodError: String?
    var body: some View {
        TextField("食物名称", text: Binding(get: { draft.name }, set: { draft.changeIdentity(name: $0) })).id(anchor("name"))
        fieldIssue("name")
        TextField("食用份量", text: Binding(get: { draft.portion }, set: { draft.changeIdentity(portion: $0) })).id(anchor("portion"))
        fieldIssue("portion")
        DatePicker("记录日期", selection: Binding(get: { NativeChartDates.parse(draft.date) ?? Date() }, set: { draft.date = NativeActionDates.day($0) }), in: ...Date(), displayedComponents: .date)
            .environment(\.timeZone, NativeActionDates.timeZone).id(anchor("date"))
        fieldIssue("date")
        Picker("餐次", selection: $draft.meal) { ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0.rawValue) } }.id(anchor("meal"))
        fieldIssue("meal")
        ForEach(NativeNutritionFields.keys, id: \.self) { key in
            VStack(alignment: .leading, spacing: 5) {
                TextField(NativeNutritionFields.title(key) + (key == "calories" ? "（千卡，未知留空）" : "（克，未知留空）"),
                    text: Binding(get: { draft.nutrients[key] ?? "" }, set: { draft.setNutrient(key, text: $0) })).keyboardType(.decimalPad).id(anchor(key))
                fieldIssue(key)
                Text("来源：" + NativeNutritionFields.source(draft.provenance[key]?["source"].stringValue)).font(.caption).foregroundStyle(NativePalette.muted)
                if let basis = draft.provenance[key]?["basis"].stringValue {
                    DisclosureGroup("查看参考依据") { Text(basis).font(.caption).foregroundStyle(NativePalette.muted) }.font(.caption)
                }
                Menu("核对来源") {
                    ForEach(["manual", "label", "unknown"], id: \.self) { source in
                        Button(NativeNutritionFields.source(source)) {
                            var origin = draft.provenance[key]?.objectValue ?? [:]; origin["source"] = .string(source)
                            draft.provenance[key] = .object(origin)
                            if source == "unknown" { draft.nutrients[key] = "" }
                        }
                    }
                }.font(.caption)
            }
        }
        if draft.food != .null {
            Text("已关联食物库版本：" + (draft.food["catalogRelease"].stringValue ?? "原始版本")).font(.caption).foregroundStyle(NativePalette.muted)
        }
        if context != nil {
            Button(draft.food == .null ? "从食物库核对食物与份量" : "重新选择食物库与份量") { pickingFood = true }
                .sheet(isPresented: $pickingFood) {
                    if let context {
                        NavigationStack {
                            NativeNutritionFoodsView(api: context.api, token: context.token, userID: context.userID, initialQuery: draft.name, initialDate: draft.date, initialMeal: draft.meal) { rows in
                                guard rows.count == 1, let row = rows.first else { foodError = "整餐模板包含多项，请从饮食首页使用整餐模板。"; pickingFood = false; return }
                                let selected = NativeNutritionDraft(row, date: draft.date, meal: draft.meal)
                                draft.date = selected.date; draft.meal = selected.meal
                                draft.name = selected.name; draft.portion = selected.portion; draft.note = selected.note
                                draft.nutrients = selected.nutrients; draft.provenance = selected.provenance
                                draft.food = selected.food; draft.original = selected.original; draft.warnings = selected.warnings
                                pickingFood = false
                            }
                        }
                    }
                }
        }
        if !draft.original["candidates"].arrayValue.isEmpty {
            DisclosureGroup("识别给出的候选，需核对规格") {
                ForEach(Array(draft.original["candidates"].arrayValue.enumerated()), id: \.offset) { _, food in
                    Text((food["name"].stringValue ?? "候选食物") + " · " + (food["serving"]["label"].stringValue ?? food["reference"]["label"].stringValue ?? "请查看规格"))
                        .font(.footnote).foregroundStyle(NativePalette.muted)
                }
            }
        }
        NativeNutritionErrorRow(text: foodError)
        ForEach(draft.warnings, id: \.self) { Text($0).font(.footnote).foregroundStyle(.orange) }
        TextField("备注", text: $draft.note, axis: .vertical).lineLimit(2...5).id(anchor("note"))
        fieldIssue("note")
    }
    private func anchor(_ field: String) -> String { draft.id.uuidString + ":" + field }
    @ViewBuilder private func fieldIssue(_ field: String) -> some View {
        if let message = issues[field] { Text(message).font(.caption).foregroundStyle(.red) }
    }

}

struct NativeNutritionMacroChart: View {
    let row: NativeJSON
    private var values: [(key: String, value: Double)]? {
        var result: [(key: String, value: Double)] = []
        for key in ["carbs", "protein", "fat"] {
            guard let text = row[key].stringValue, let grams = Double(text), grams.isFinite, grams >= 0 else { return nil }
            result.append((key: key, value: grams * (key == "fat" ? 9 : 4)))
        }
        return result
    }
    var body: some View {
        if let values {
            if values.reduce(0, { $0 + $1.value }) > 0 {
                Chart(Array(values.enumerated()), id: \.offset) { _, item in
                    SectorMark(angle: .value("供能参考", item.value), innerRadius: .ratio(0.64))
                        .foregroundStyle(by: .value("营养素", NativeNutritionFields.title(item.key)))
                }.chartForegroundStyleScale(domain: ["carbs", "protein", "fat"].map(NativeNutritionFields.title),
                                            range: [NativePalette.accent, NativePalette.peach, NativePalette.muted])
                    .frame(height: 170)
                Text("按碳水和蛋白质每克4千卡、脂肪每克9千卡估算供能构成，不替代记录热量。")
                    .font(.caption).foregroundStyle(NativePalette.muted)
            } else { Text("三项营养素均为已确认的0克。").font(.footnote).foregroundStyle(NativePalette.muted) }
        } else { Text("三项营养素尚未填写完整，暂不绘制供能比例。").font(.footnote).foregroundStyle(NativePalette.muted) }
    }
}

@MainActor
struct NativeNutritionStatusView: View {
    @ObservedObject var context: NativeNutritionContext
    let date: String
    @State private var status: NativeJSON
    @State private var error: String?
    init(context: NativeNutritionContext, initial: NativeJSON, date: String) {
        self.context = context; self.date = date; _status = State(initialValue: initial)
    }
    var body: some View {
        Form {
            Section(date) {
                ForEach(QuickEntryMeal.allCases) { meal in
                    Picker(meal.title, selection: Binding(get: { status["meals"][meal.rawValue].stringValue ?? "unrecorded" }, set: { setMeal(meal.rawValue, $0) })) {
                        Text("尚未记录").tag("unrecorded"); Text("已记录").tag("recorded"); Text("未进食").tag("skipped")
                    }
                }
                Toggle("当天已记完", isOn: Binding(get: { status["complete"].boolValue == true }, set: { var value = status.objectValue; value["complete"] = .bool($0); status = .object(value) }))
            }.listRowBackground(NativePalette.surface)
            Text("三次正餐需有记录或明确标记未进食。此标记只表示记录覆盖，不保证实际摄入或营养值准确。").font(.footnote).foregroundStyle(NativePalette.muted)
            NativeNutritionErrorRow(text: error ?? context.error)
            Button("保存餐次状态") { Task { await save() } }.disabled(context.busy || context.pending != nil)
            Button("重新读取状态") { Task { await load() } }
        }.nativeGeometricPage().navigationTitle("记录完整度").task { await load() }
    }
    private func setMeal(_ meal: String, _ selection: String) {
        var value = status.objectValue, meals = status["meals"].objectValue; meals[meal] = .string(selection); value["meals"] = .object(meals); status = .object(value)
    }
    private func load() async {
        do { let result = try await context.api.json(path: "health/nutrition/status?date=" + date, token: context.token)
            guard !Task.isCancelled else { return }; status = result["dayStatus"]; error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func save() async {
        let body: NativeJSON = .object(["date": .string(date), "complete": status["complete"], "meals": status["meals"], "expectedRevision": status["revision"]])
        if let result = await context.write(NativeNutritionCommand(path: "health/nutrition/status", method: "PATCH", title: "更新餐次完整度", body: body)) { status = result["dayStatus"] }
    }
}
