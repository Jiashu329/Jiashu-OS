import SwiftUI

@MainActor
struct HealthQuickEntryView: View {
    let api: NativeAPI
    let token: String
    let userID: String
    let onSaved: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var isNutrition = false
    @State private var metric: QuickEntryMetric = .weight
    @State private var date = Date()
    @State private var time = Date()
    @State private var value = ""
    @State private var note = ""
    @State private var foodName = ""
    @State private var meal: QuickEntryMeal = .lunch
    @State private var portion = ""
    @State private var carbs = ""
    @State private var protein = ""
    @State private var fat = ""
    @State private var pending: NativePendingEntry?
    @State private var isSaving = false
    @State private var hasLoaded = false
    @State private var message: String?
    @StateObject private var drafts: NativeQuickEntryDraftRecovery
    @State private var initialDraft: NativeQuickEntryDraft?
    private enum EntryField: Hashable { case value, note, name, portion, carbs, protein, fat }
    @FocusState private var entryFocus: EntryField?

    init(api: NativeAPI, token: String, userID: String, defaultIsNutrition: Bool = false, initialMetric: QuickEntryMetric = .weight,
         initialDate: Date = Date(), onSaved: @escaping () async -> Void) {
        self.api = api
        self.token = token
        self.userID = userID
        self.onSaved = onSaved
        _isNutrition = State(initialValue: defaultIsNutrition)
        _metric = State(initialValue: initialMetric)
        _date = State(initialValue: initialDate)
        _drafts = StateObject(wrappedValue: NativeQuickEntryDraftRecovery(userID: userID))
    }

    var body: some View {
        NavigationStack {
            entryForm
                .disabled(isSaving)
                .environment(\.timeZone, NativeActionDates.timeZone)
                .nativeGeometricPage().navigationTitle(isNutrition ? "记饮食":"记" + metric.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("关闭") { close() }.disabled(isSaving)
                    }
                    ToolbarItemGroup(placement:.keyboard) {
                        Spacer()
                        Button("完成输入") { entryFocus = nil }
                    }
                }
                .scrollDismissesKeyboard(.interactively)
                .interactiveDismissDisabled(shouldPreventDismissal)
                .task { loadPending() }
                .onChange(of: currentDraft) { _, draft in persistDraftChange(draft) }
        }
    }

    private var shouldPreventDismissal: Bool {
        isSaving || (pending == nil && (!drafts.canWrite || currentDraft != initialDraft))
    }
    private var canSave: Bool { !isSaving && hasLoaded && drafts.canWrite }
    private var healthEntryExplanation: String {
        metric.isSample ? "保存为一次人工测量，时间按北京时间。" : "保存为所选日期的人工汇总值；人工补录会保留修改依据。"
    }
    private var entryForm: some View {
        Form {
            if pending != nil {
                pendingSection
            } else {
                recoverySection
                entryFields.disabled(!drafts.canWrite)
            }
            if isSaving { Section { ProgressView("正在核对保存结果…") } }
            messageSection
        }
    }

    @ViewBuilder
    private var pendingSection: some View {
        if let pending {
            Section("保存待确认") {
                Label(pending.label, systemImage: "clock.arrow.circlepath")
                Text("还未收到保存确认，填写已保留。继续确认不会重复创建记录。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("继续确认") { Task { await submit(pending) } }.disabled(isSaving)
            }
        }
    }

    @ViewBuilder
    private var recoverySection: some View {
        if let saved = drafts.recovery {
            Section("发现未完成的填写") {
                Text(recoveryDescription(saved)).font(.footnote).foregroundStyle(.secondary)
                Button("恢复填写") { restoreDraft() }
                Button("丢弃旧草稿", role: .destructive) { discardDraft() }
            }
        }
    }

    @ViewBuilder
    private var entryFields: some View {
        selectionSection
        if isNutrition { nutritionFields } else { healthFields }
        Section("备注（可选）") {
            TextField("记录说明", text: $note, axis: .vertical).lineLimit(2...4).focused($entryFocus,equals:.note)
        }
        Section {
            Button("保存记录") { entryFocus = nil; Task { await prepareAndSubmit() } }.buttonStyle(.borderedProminent).disabled(!canSave)
        }
    }

    private var selectionSection: some View {
        Section {
            Picker("记录类型", selection: $isNutrition) {
                Text("健康数据").tag(false)
                Text("饮食").tag(true)
            }.pickerStyle(.segmented)
            DatePicker("记录日期", selection: $date, in: ...Date(), displayedComponents: .date)
        }
    }

    @ViewBuilder
    private var nutritionFields: some View {
        Section("这次吃了什么") {
            TextField("食物名称", text: $foodName).focused($entryFocus,equals:.name)
            Picker("餐次", selection: $meal) {
                ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0) }
            }
            TextField("份量，例如一碗、200克", text: $portion).focused($entryFocus,equals:.portion)
            TextField("热量（千卡，未知时留空）", text: $value).keyboardType(.decimalPad).focused($entryFocus,equals:.value)
            TextField("碳水化合物（克，未知时留空）", text: $carbs).keyboardType(.decimalPad).focused($entryFocus,equals:.carbs)
            TextField("蛋白质（克，未知时留空）", text: $protein).keyboardType(.decimalPad).focused($entryFocus,equals:.protein)
            TextField("脂肪（克，未知时留空）", text: $fat).keyboardType(.decimalPad).focused($entryFocus,equals:.fat)
        }
        Section {
            Text("未知热量保持未知；填写0表示已确认这份食物的热量为0。此处记录本人核对的值，不自动估算。")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var healthFields: some View {
        Section("健康记录") {
            Picker("指标", selection: $metric) {
                ForEach(QuickEntryMetric.allCases) { Text($0.title).tag($0) }
            }
            HStack {
                TextField("数值", text: $value).keyboardType(.decimalPad).focused($entryFocus,equals:.value)
                Text(metric.unit).foregroundStyle(.secondary)
            }
            if metric.isSample {
                DatePicker("测量时间", selection: $time, displayedComponents: .hourAndMinute)
            }
        }
        Section {
            Text(healthEntryExplanation).font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var messageSection: some View {
        if let message {
            Section {
                Text(message).foregroundStyle(.red).textSelection(.enabled)
                if !hasLoaded { Button("重新读取原操作") { loadPending() } }
                else if pending == nil && !drafts.hasLoaded {
                    Button("重新读取草稿") { reloadDraft() }
                }
            }
        }
    }

    private func recoveryDescription(_ draft: NativeQuickEntryDraft) -> String {
        let kind: String = draft.isNutrition ? "饮食" : "健康"
        return "此前的" + kind + "填写已加密保存在本机。你可以恢复或丢弃；不会自动保存为记录。"
    }
    private func discardDraft() {
        do { try drafts.discard(); message = nil }
        catch { message = error.localizedDescription }
    }
    private func reloadDraft() {
        do { try drafts.read(); message = nil }
        catch { message = error.localizedDescription }
    }
    private func persistDraftChange(_ draft: NativeQuickEntryDraft) {
        guard hasLoaded, pending == nil, drafts.canWrite else { return }
        do { try drafts.save(draft) }
        catch { message = error.localizedDescription }
    }

    private func loadPending() {
        guard !hasLoaded else { return }
        do {
            pending = try NativePendingEntryStore(userID: userID).load()
            if pending == nil { try drafts.read() }
            initialDraft = currentDraft
            hasLoaded = true
        } catch { message = error.localizedDescription }
    }

    private var currentDraft: NativeQuickEntryDraft {
        NativeQuickEntryDraft(isNutrition: isNutrition, metric: metric.rawValue, date: date, time: time,
            value: value, note: note, foodName: foodName, meal: meal.rawValue, portion: portion,
            carbs: carbs, protein: protein, fat: fat)
    }

    private func restoreDraft() {
        do {
            let saved = try drafts.restore()
            isNutrition = saved.isNutrition; metric = QuickEntryMetric(rawValue: saved.metric)!
            date = saved.date; time = saved.time; value = saved.value; note = saved.note
            foodName = saved.foodName; meal = QuickEntryMeal(rawValue: saved.meal)!
            portion = saved.portion; carbs = saved.carbs; protein = saved.protein; fat = saved.fat
            message = nil
        } catch { message = error.localizedDescription }
    }

    private func close() {
        if pending != nil || !hasLoaded || drafts.recovery != nil { dismiss(); return }
        do {
            guard drafts.canWrite else { throw NativeWorkspacePersistenceError.unavailable }
            if currentDraft != initialDraft { try drafts.save(currentDraft) }
            dismiss()
        } catch { message = error.localizedDescription }
    }

    private func prepareAndSubmit() async {
        message = nil
        do {
            guard drafts.canWrite else { throw NativeWorkspacePersistenceError.unavailable }
            let entry = try currentDraft.operation()
            try NativePendingEntryStore(userID: userID).save(entry)
            pending = entry
            try drafts.clearAfterPendingStored()
            await submit(entry)
        } catch { message = error.localizedDescription }
    }

    private func submit(_ entry: NativePendingEntry) async {
        guard !isSaving else { return }
        isSaving = true
        message = nil
        defer { isSaving = false }
        do {
            // A loaded immutable pending operation always takes precedence over
            // ordinary drafts; never leave a stale compose draft after success.
            try drafts.clearAfterPendingStored()
            _ = try await api.saveQuickEntry(token: token, entry: entry)
            // Clear only after an acknowledged response; if Keychain clearing
            // fails the original request remains safe to replay next time.
            try NativePendingEntryStore(userID: userID).clear()
            pending = nil
            await onSaved()
            dismiss()
        } catch let error as NativeAPIError {
            // These responses are definitive validation rejections, not an
            // uncertain write. Let the user correct their original fields.
            if case .server(let status, _, _, _) = error,
               [400, 404, 409, 413, 415, 422].contains(status) {
                do {
                    try NativePendingEntryStore(userID: userID).clear(); pending = nil
                    try drafts.read()
                }
                catch { message = error.localizedDescription; return }
                message = error.localizedDescription
            } else {
                message = error.localizedDescription + " 原操作已保留，请稍后继续核对。"
            }
        } catch {
            message = error.localizedDescription + " 原操作已保留，请稍后继续核对。"
        }
    }
}

@MainActor
struct NativeNutritionDayView: View {
    let api: NativeAPI
    let token: String
    let userID: String
    let onSaved: () async -> Void

    @State private var date = Date()
    @State private var records: NativeNutritionDay?
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var showingEntry = false

    private var selectedDay: String { NativeActionDates.day(date) }

    var body: some View {
        List {
            Section {
                DatePicker("记录日期", selection: $date, in: ...Date(), displayedComponents: .date)
            }
            if loading { Section { ProgressView("正在读取饮食…") } }
            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                    Button("重新读取") { Task { await load() } }
                }
            }
            if let records {
                Section("当天记录 · " + records.date) {
                    LabeledContent("食物记录", value: "\(records.summary.entryCount)项")
                    LabeledContent("已知热量小计", value: amount(records.summary.knownCalories, unit: "千卡"))
                    Text("热量已知\(records.summary.knownCount)项，未知\(records.summary.unknownCount)项。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(records.dayStatus.complete ? "已确认全天记录完整" : "尚未确认全天记全")
                        .font(.footnote).foregroundStyle(.secondary)
                    nutrientRow("碳水化合物", key: "carbs", in: records)
                    nutrientRow("蛋白质", key: "protein", in: records)
                    nutrientRow("脂肪", key: "fat", in: records)
                }
                ForEach(QuickEntryMeal.allCases) { meal in
                    Section(meal.title) {
                        let entries = records.entries.filter { $0.meal == meal.rawValue && !$0.deleted }
                        if entries.isEmpty {
                            Text(records.dayStatus.meals[meal.rawValue] == "skipped" ? "已标记未进食" : "尚无食物记录")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(entries) { entry in
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    Text(entry.name).fontWeight(.medium)
                                    Spacer()
                                    Text(amount(entry.calories, unit: "千卡"))
                                }
                                if !entry.portion.isEmpty { Text(entry.portion).font(.footnote).foregroundStyle(.secondary) }
                                Text("碳水 " + amount(entry.carbs, unit: "克") + " · 蛋白质 " + amount(entry.protein, unit: "克") + " · 脂肪 " + amount(entry.fat, unit: "克"))
                                    .font(.caption).foregroundStyle(.secondary)
                                if !entry.note.isEmpty { Text(entry.note).font(.footnote).foregroundStyle(.secondary) }
                            }.padding(.vertical, 3)
                        }
                    }
                }
                Section {
                    Text("以上只汇总已记录且已知的营养值。部分记录和未知值不能代表全天真实摄入。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .nativeGeometricPage().navigationTitle("饮食记录")
        .navigationBarTitleDisplayMode(.inline)
        .environment(\.timeZone, NativeActionDates.timeZone)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("记饮食", systemImage: "plus") { showingEntry = true }
            }
        }
        .task(id: selectedDay) { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showingEntry) {
            HealthQuickEntryView(api: api, token: token, userID: userID, defaultIsNutrition: true, initialDate: date) {
                await load()
                await onSaved()
            }
        }
    }

    private func amount(_ value: String?, unit: String) -> String {
        guard let value else { return "未知" }
        return value + " " + unit
    }
    private func nutrientRow(_ title: String, key: String, in records: NativeNutritionDay) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            LabeledContent(title + "已知小计", value: amount(records.summary.nutrients[key]?.total, unit: "克"))
            if let nutrient = records.summary.nutrients[key] {
                Text("已知\(nutrient.knownCount)项 · 未知\(nutrient.unknownCount)项")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private func load() async {
        let day = selectedDay
        loading = true
        records = nil
        errorMessage = nil
        do {
            let result = try await api.nutritionDay(token: token, date: day)
            guard !Task.isCancelled, selectedDay == day else { return }
            guard result.date == day else { throw NativeAPIError.invalidResponse }
            records = result
        } catch {
            guard !Task.isCancelled, selectedDay == day else { return }
            errorMessage = error.localizedDescription
        }
        if selectedDay == day { loading = false }
    }
}

enum NativeWeeklySuggestionDraft {
    static func applying(_ text: String,to original: NativeWeeklyActionCommand) throws -> NativeWeeklyActionCommand {
        let proposal = text.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !proposal.isEmpty,proposal.utf16.count <= 200,
              !proposal.unicodeScalars.contains(where:{ $0.value < 32 || $0.value == 127 }) else {
            throw NativeActionInputError.invalid("这条建议暂时无法填入，请自行填写一项200字以内的行动。")
        }
        return .init(weekStart:original.weekStart,text:proposal,status:original.status,feedback:original.feedback,expectedRevision:original.expectedRevision)
    }
    static func needsReplacementConfirmation(current: String,proposal: String) -> Bool {
        let old = current.trimmingCharacters(in:.whitespacesAndNewlines)
        return !old.isEmpty && old != proposal.trimmingCharacters(in:.whitespacesAndNewlines)
    }
}

@MainActor
struct HealthWeeklyReviewView: View {
    let api: NativeAPI
    let token: String
    let userID: String
    private enum ReviewPeriod: String { case current, previous, custom }

    @Environment(\.scenePhase) private var scenePhase
    @State private var calendarNow = Date()
    @State private var period: ReviewPeriod = .current
    @State private var historicalDate = Date()
    @State private var review: NativeWeeklyDetails?
    @State private var loading = false
    @State private var reviewError: String?
    @State private var actionLoaded = false
    @State private var loadingAction = false
    @State private var actionWeek = NativeActionDates.day(NativeActionDates.monday(Date()))
    @State private var actionRevision = 0
    @State private var actionText = ""
    @State private var actionStatus: NativeWeeklyActionStatus = .planned
    @State private var feedback = ""
    @State private var savingAction = false
    @State private var actionMessage: String?
    @State private var actionError: String?
    @State private var pendingAction: NativeWeeklyActionCommand?
    @State private var confirmReload = false
    @State private var reloadWeek: String?
    @State private var recovery: NativeWeeklyActionRecovery?
    @State private var storageChecked = false
    @State private var storageReady = false
    @State private var baseline: NativeWeeklyActionCommand?
    @State private var actionConflict = false
    @State private var latestAction: NativeWeeklyActionEntry?
    @State private var latestChecked = false
    @State private var confirmAdoptLatest = false
    @State private var confirmDiscardRecovery = false
    @State private var confirmSuggestion = false
    @State private var suggestedText: String?
    private enum ActionField: Hashable { case text, feedback }
    @FocusState private var actionFocus: ActionField?

    init(api: NativeAPI, token: String, userID: String, initialWeek: String? = nil, initialActionWeek: String? = nil) {
        self.api = api; self.token = token; self.userID = userID
        let now = Date(), monday = NativeActionDates.monday(now)
        let current = NativeActionDates.day(monday)
        let previous = NativeActionDates.day(NativeActionDates.calendar.date(byAdding:.day,value:-7,to:monday)!)
        let selected = NativeWeeklyReviewWeek.initial(initialWeek,now:now)
        _actionWeek = State(initialValue: initialActionWeek.map { NativeWeeklyReviewWeek.initial($0, now: now) } ?? selected)
        _period = State(initialValue:selected == current ? .current:selected == previous ? .previous:.custom)
        _historicalDate = State(initialValue:NativeWeeklyReviewWeek.date(selected) ?? monday)
    }

    private var persistence: NativeWorkspacePersistence { .init(userID:userID,scope:"weekly-health-action") }
    private var command: NativeWeeklyActionCommand {
        .init(weekStart:actionWeek,text:actionText,status:actionStatus,feedback:feedback,expectedRevision:actionRevision)
    }

    private var currentCalendarWeek: String { NativeActionDates.day(NativeActionDates.monday(calendarNow)) }
    private var selectedWeek: String {
        let monday = NativeActionDates.monday(calendarNow)
        let day = period == .custom ? NativeActionDates.monday(historicalDate) : period == .previous ? NativeActionDates.calendar.date(byAdding: .day, value: -7, to: monday)! : monday
        return NativeActionDates.day(day)
    }

    var body: some View {
        List {
            weekSection
            focusSection
            if let review, let activity = review.appleActivity {
                NativeAppleActivityWeeklySections(api: api, token: token, userID: userID,
                                                 activity: activity, isCurrent: review.isCurrent)
            }
            recoverySection
            actionSection
            evidenceSection
        }
        .nativeGeometricPage().navigationTitle("每周复盘")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItemGroup(placement:.keyboard) { Spacer(); Button("完成输入") { actionFocus = nil } }
        }
        .task(id:selectedWeek) { await loadReview() }
        .task { await initializeAction() }
        .onDisappear { persistUnfinishedAction() }
        .refreshable { await loadReview() }
        .onReceive(Timer.publish(every:60,on:.main,in:.common).autoconnect()) { calendarNow = $0 }
        .onChange(of:scenePhase) { _,phase in if phase == .active { calendarNow = Date() } }
        .confirmationDialog("替换当前行动填写？",isPresented:$confirmReload,titleVisibility:.visible) {
            Button("读取并替换填写",role:.destructive) { let week = reloadWeek ?? actionWeek; Task { await loadAction(week:week) } }
            Button("保留当前填写",role:.cancel) { }
        } message: { Text("将读取所选行动周。未保存的填写会被替换；已发出的保存不会被撤销。") }
        .confirmationDialog("放弃本机恢复内容？",isPresented:$confirmDiscardRecovery,titleVisibility:.visible) {
            Button("仅放弃本机内容",role:.destructive) { Task { await discardRecovery() } }
            Button("取消",role:.cancel) { }
        } message: { Text("不会删除已保存的行动。随后会读取服务器内容。") }
        .confirmationDialog("采用核对后的版本？",isPresented:$confirmAdoptLatest,titleVisibility:.visible) {
            Button("保留填写并继续编辑") { adoptLatestAction() }
            Button("取消",role:.cancel) { }
        } message: { Text("当前文字和反馈保留，下次保存会使用刚核对的版本。") }
        .confirmationDialog("用建议替换当前行动文字？",isPresented:$confirmSuggestion,titleVisibility:.visible) {
            Button("替换文字，保留状态与反馈") { applySuggestion() }
            Button("保留原文字",role:.cancel) { suggestedText = nil }
        } message: { Text("只填入草稿，不会自动保存，也不会更改行动周。") }
    }
    private var weekSection: some View {
        Section {
            Picker("正在回顾",selection:$period) {
                Text("本周").tag(ReviewPeriod.current)
                Text("上周").tag(ReviewPeriod.previous)
                Text("历史周").tag(ReviewPeriod.custom)
            }.pickerStyle(.segmented)
            if period == .custom {
                DatePicker("选择一周",selection:$historicalDate,in:...Date(),displayedComponents:.date)
                    .environment(\.timeZone,NativeActionDates.timeZone)
            }
            LabeledContent("回顾周",value:selectedWeek)
        }
    }
    @ViewBuilder private var focusSection: some View {
        if loading { Section { ProgressView("读取这一周…") } }
        if let reviewError { Section { Text(reviewError).foregroundStyle(.red); Button("重试读取") { Task { await loadReview() } } } }
        if let review {
            Section("这周值得关注") {
                if let focus = review.focus {
                    Text(focus.headline).font(.title3.bold())
                    Text(focus.summary)
                } else { Text(review.isCurrent ? "本周还在进行中，先看看已有记录。":"看看这一周的记录，再选一件接下来要做的事。") }
            }
        }
    }
    @ViewBuilder private var recoverySection: some View {
        if let recovery {
            Section(recovery.submitted ? "保存待确认":"有未完成的行动填写") {
                Text(recovery.command.weekStart)
                Text(recovery.command.text.isEmpty ? "行动还没写完。":recovery.command.text)
                Text(recovery.submitted ? "填写已保留。恢复后由你继续确认，不会自动重发。":"恢复后继续填写，不会自动保存。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("恢复填写") { restoreRecovery() }
                Button("放弃本机填写",role:.destructive) { confirmDiscardRecovery = true }
            }
        }
    }
    private var actionSection: some View {
        Section("选一件接下来要做的事") {
            LabeledContent("行动执行周",value:actionWeek)
            Menu("更换行动周") {
                Button("本周 · " + currentCalendarWeek) { requestActionWeek(currentCalendarWeek) }
                Button("回顾周 · " + selectedWeek) { requestActionWeek(selectedWeek) }
                if let next = nextReviewWeek { Button("回顾后的下一周 · " + next) { requestActionWeek(next) } }
            }.disabled(!storageReady || recovery != nil)
            if recovery != nil { Text("先恢复或放弃上面的填写。") }
            else if !storageReady { Button("重新读取本机填写") { Task { await initializeAction() } } }
            else if !actionLoaded && loadingAction { ProgressView("读取行动…") }
            else if !actionLoaded { Button("重试读取行动") { Task { await loadAction() } } }
            else if actionLoaded { actionFields }
            if savingAction { ProgressView("正在保存…") }
            if let actionMessage { Text(actionMessage).font(.footnote).foregroundStyle(.green) }
            if let actionError { Text(actionError).font(.footnote).foregroundStyle(.red) }
            if actionLoaded { actionRecoveryTools }
        }
        .disabled(savingAction || loadingAction)
        .onChange(of:actionText) { _,_ in actionMessage = nil; persistUnfinishedAction() }
        .onChange(of:actionStatus) { _,_ in persistUnfinishedAction() }
        .onChange(of:feedback) { _,_ in persistUnfinishedAction() }
    }
    @ViewBuilder private var actionFields: some View {
        if let suggestion = review?.focus?.suggestedAction {
            VStack(alignment:.leading,spacing:6) {
                Text("可选建议").font(.caption).foregroundStyle(.secondary)
                Text(suggestion.text).font(.subheadline)
                Button("填入行动草稿") { proposeSuggestion(suggestion.text) }
                    .disabled(pendingAction != nil || actionConflict || !storageReady)
            }
        }
        TextField("想做的一件具体小事",text:$actionText,axis:.vertical).lineLimit(2...4)
            .focused($actionFocus,equals:.text).disabled(pendingAction != nil)
        Picker("执行情况",selection:$actionStatus) {
            ForEach(NativeWeeklyActionStatus.allCases) { Text($0.title).tag($0) }
        }.disabled(pendingAction != nil)
        TextField("做完后的反馈（可选）",text:$feedback,axis:.vertical).lineLimit(2...5)
            .focused($actionFocus,equals:.feedback).disabled(pendingAction != nil)
        Button(pendingAction == nil ? "保存行动":"继续确认") { actionFocus = nil; Task { await saveAction() } }
            .buttonStyle(.borderedProminent)
            .disabled(!storageReady || actionConflict || (pendingAction == nil && actionText.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty))
        if pendingAction != nil { Text("保存结果还未确认，原填写已保留。继续确认不会重复创建行动。").font(.footnote).foregroundStyle(.secondary) }
    }
    @ViewBuilder private var actionRecoveryTools: some View {
        if actionConflict || pendingAction != nil {
            Button("查看最新保存结果，保留填写") { Task { await checkLatestAction() } }
            latestActionComparison
        } else {
            DisclosureGroup("读取与保存详情") {
                Button("核对最新保存结果") { Task { await checkLatestAction() } }
                Button("重新载入行动填写") { requestActionWeek(actionWeek) }
                latestActionComparison
            }
        }
    }
    @ViewBuilder private var latestActionComparison: some View {
        if latestChecked {
            DisclosureGroup("已保存的行动") {
                Text(latestAction?.text ?? "还没有保存行动。")
                if let latestAction { Text(latestAction.status.title); Text(latestAction.feedback) }
            }
            if actionConflict { Button("核对后保留我的填写继续编辑") { confirmAdoptLatest = true } }
        }
    }
    @ViewBuilder private var evidenceSection: some View {
        if let review {
            Section {
                DisclosureGroup("查看记录与判断依据") {
                    if let focus = review.focus {
                        Text(focus.coverageNote).font(.footnote).foregroundStyle(.secondary)
                        let points = [focus.primary].compactMap { $0 } + focus.secondary
                        ForEach(points) { point in
                            VStack(alignment:.leading,spacing:5) {
                                Text(point.title).font(.headline)
                                Text(point.evidence)
                                Text(point.interpretation).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    ForEach(review.metrics) { metric in metricEvidenceRow(metric) }
                    Text("日均只用有记录的日期。缺失不补0，覆盖不同不能直接解释为改善或下降。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }
    private func metricEvidenceRow(_ metric: NativeWeeklyDetails.Metric) -> some View {
        let current: String = formatted(metric.currentAverage,unit:metric.unit)
        let previous: String = formatted(metric.previousAverage,unit:metric.unit)
        let comparison: String = "前期 \(previous) · 本期有记录\(metric.currentRecordedDays)天，前期\(metric.previousRecordedDays)天"
        return VStack(alignment:.leading,spacing:5) {
            LabeledContent(metric.label,value:current)
            Text(comparison).font(.caption).foregroundStyle(.secondary)
        }
    }
    private var nextReviewWeek: String? {
        guard let start = NativeWeeklyReviewWeek.date(selectedWeek),let date = NativeActionDates.calendar.date(byAdding:.day,value:7,to:start) else { return nil }
        return NativeActionDates.day(date)
    }
    private func requestActionWeek(_ week: String) {
        guard !loadingAction,!savingAction,storageReady,recovery == nil else { return }
        if pendingAction != nil || (actionLoaded && command != baseline) { reloadWeek = week; confirmReload = true }
        else { Task { await loadAction(week:week) } }
    }
    private func proposeSuggestion(_ text: String) {
        guard pendingAction == nil,!actionConflict,actionLoaded,storageReady else { return }
        suggestedText = text
        if NativeWeeklySuggestionDraft.needsReplacementConfirmation(current:actionText,proposal:text) { confirmSuggestion = true }
        else { applySuggestion() }
    }
    private func applySuggestion() {
        guard let proposed = suggestedText,pendingAction == nil,!actionConflict else { return }
        do {
            let updated = try NativeWeeklySuggestionDraft.applying(proposed,to:command)
            actionText = updated.text; suggestedText = nil
            persistUnfinishedAction()
        } catch { actionError = error.localizedDescription }
    }

    private func formatted(_ value: Double?, unit: String) -> String {
        guard let value else { return "暂无记录" }
        return value.formatted(.number.precision(.fractionLength(0...2))) + " " + unit
    }

    private func loadReview() async {
        let week = selectedWeek
        loading = true
        reviewError = nil
        review = nil
        do {
            let result = try await api.weeklyDetails(token: token, week: week)
            guard selectedWeek == week, !Task.isCancelled else { return }
            review = result
        } catch {
            guard selectedWeek == week, !Task.isCancelled else { return }
            reviewError = error.localizedDescription
        }
        if selectedWeek == week { loading = false }
    }

    private func loadAction(week: String? = nil) async {
        guard !loadingAction, !savingAction else { return }
        let requestedWeek = week ?? actionWeek
        guard NativeWeeklyReviewWeek.isMonday(requestedWeek),storageReady else { return }
        loadingAction = true
        defer { loadingAction = false }
        actionError = nil
        actionMessage = nil
        do {
            let action = try await api.weeklyAction(token: token, week: requestedWeek)
            guard !Task.isCancelled else { return }
            guard action == nil || action?.weekStart == requestedWeek else { throw NativeAPIError.invalidResponse }
            try persistence.clear()
            actionWeek = requestedWeek
            actionText = action?.text ?? ""
            actionStatus = action?.status ?? .planned
            feedback = action?.feedback ?? ""
            actionRevision = action?.revision ?? 0
            pendingAction = nil
            recovery = nil
            baseline = command
            actionConflict = false
            latestAction = nil
            latestChecked = false
            actionLoaded = true
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func initializeAction() async {
        guard !storageChecked else { return }
        storageChecked = true
        do {
            if let saved = try persistence.load(NativeWeeklyActionRecovery.self) {
                recovery = try saved.validated(ownerID:userID)
            }
            storageReady = true
            if recovery == nil { await loadAction() }
        } catch {
            storageChecked = false; storageReady = false
            actionError = error.localizedDescription
        }
    }

    private func restoreRecovery() {
        guard let recovery,storageReady else { return }
        do {
            let saved = try recovery.validated(ownerID:userID)
            let original = saved.command
            actionWeek = original.weekStart; actionRevision = original.expectedRevision
            actionText = original.text; actionStatus = original.status; feedback = original.feedback
            baseline = saved.baseline; pendingAction = saved.submitted ? original:nil
            actionLoaded = true; actionConflict = false; latestChecked = false; latestAction = nil
            self.recovery = nil
            actionMessage = saved.submitted ? "已恢复上次保存，请点击“继续确认”。":"已恢复填写，尚未保存。"
        } catch { actionError = error.localizedDescription }
    }

    private func discardRecovery() async {
        do {
            try persistence.clear(); recovery = nil
            await loadAction(week:actionWeek)
        } catch { actionError = error.localizedDescription }
    }

    private func persistUnfinishedAction() {
        guard storageReady,recovery == nil,actionLoaded,pendingAction == nil,!loadingAction,!savingAction else { return }
        do {
            if command != baseline {
                try persistence.save(NativeWeeklyActionRecovery(ownerID:userID,command:command,baseline:baseline,submitted:false))
            } else { try persistence.clear() }
        } catch { actionError = error.localizedDescription + " 当前填写仍在本页，请重试后再离开。" }
    }

    private func checkLatestAction() async {
        guard !loadingAction,!savingAction,actionLoaded,recovery == nil else { return }
        let originalWeek = actionWeek
        loadingAction = true; actionError = nil
        defer { loadingAction = false }
        do {
            let latest = try await api.weeklyAction(token:token,week:originalWeek)
            guard !Task.isCancelled,actionWeek == originalWeek else { return }
            guard latest == nil || latest?.weekStart == originalWeek else { throw NativeAPIError.invalidResponse }
            if let pendingAction,pendingAction.matchesSaved(latest),let latest {
                try acknowledgeAction(pendingAction,entry:latest,reconciled:true)
                return
            }
            latestAction = latest; latestChecked = true
            actionConflict = (latest?.revision ?? 0) != actionRevision
            actionMessage = actionConflict ? "另一处修改过行动。请核对已保存内容，再选择继续编辑。":"当前填写与已保存内容没有冲突。"
        } catch { actionError = error.localizedDescription }
    }

    private func adoptLatestAction() {
        guard latestChecked,!savingAction,!loadingAction else { return }
        do {
            let revision = latestAction?.revision ?? 0
            let updated = NativeWeeklyActionCommand(weekStart:actionWeek,text:actionText,status:actionStatus,feedback:feedback,expectedRevision:revision)
            let updatedBaseline = NativeWeeklyActionCommand(weekStart:actionWeek,text:latestAction?.text ?? "",status:latestAction?.status ?? .planned,feedback:latestAction?.feedback ?? "",expectedRevision:revision)
            try persistence.save(NativeWeeklyActionRecovery(ownerID:userID,command:updated,baseline:updatedBaseline,submitted:false))
            actionRevision = revision; baseline = updatedBaseline; pendingAction = nil; actionConflict = false
            latestChecked = false; latestAction = nil
            actionMessage = "已保留你的填写，可继续编辑后保存。"
        } catch { actionError = error.localizedDescription }
    }

    private func acknowledgeAction(_ original: NativeWeeklyActionCommand,entry: NativeWeeklyActionEntry,reconciled: Bool) throws {
        guard original.matchesSaved(entry) else { throw NativeAPIError.invalidResponse }
        try persistence.clear()
        actionWeek = original.weekStart; actionRevision = entry.revision
        actionText = entry.text; actionStatus = entry.status; feedback = entry.feedback
        baseline = command; pendingAction = nil; recovery = nil; actionConflict = false
        latestChecked = false; latestAction = nil
        actionMessage = reconciled ? "上次的行动已保存，没有重复创建。":"\(original.weekStart)这周的行动已保存。"
    }

    private func saveAction() async {
        guard !savingAction,!loadingAction,storageReady,actionLoaded,recovery == nil,!actionConflict else { return }
        let isRecovery = pendingAction != nil
        let draft = pendingAction ?? NativeWeeklyActionCommand(weekStart: actionWeek, text: actionText,
            status: actionStatus, feedback: feedback, expectedRevision: actionRevision)
        savingAction = true
        actionError = nil
        actionMessage = nil
        defer { savingAction = false }
        do {
            _ = try draft.encodedBody()
            try persistence.save(NativeWeeklyActionRecovery(ownerID:userID,command:draft,baseline:baseline,submitted:true))
            pendingAction = draft
            if isRecovery {
                let latest = try await api.weeklyAction(token:token,week:draft.weekStart)
                guard !Task.isCancelled else { return }
                guard latest == nil || latest?.weekStart == draft.weekStart else { throw NativeAPIError.invalidResponse }
                if draft.matchesSaved(latest),let latest {
                    try acknowledgeAction(draft,entry:latest,reconciled:true)
                    return
                }
                guard (latest?.revision ?? 0) == draft.expectedRevision else {
                    latestAction = latest; latestChecked = true; actionConflict = true
                    actionError = "另一处修改过这周的行动，尚未重复保存。请先核对已保存内容。"
                    return
                }
            }
            let action = try await api.saveWeeklyAction(token: token, command: draft)
            guard !Task.isCancelled else { return }
            guard let action else { throw NativeAPIError.invalidResponse }
            try acknowledgeAction(draft,entry:action,reconciled:false)
        } catch {
            if case NativeAPIError.server(let status,_,_,_) = error {
                if status == 409 { actionConflict = true }
                if [400,403,404,413,415,422].contains(status),pendingAction != nil {
                    do {
                        try persistence.save(NativeWeeklyActionRecovery(ownerID:userID,command:draft,baseline:baseline,submitted:false))
                        pendingAction = nil
                    } catch { actionError = error.localizedDescription; return }
                }
            }
            actionError = error.localizedDescription + (pendingAction == nil ? " 原填写已保留，请核对后再保存。":" 原请求已保留；请继续核对或检查服务器最新版本。")
        }
    }
}

private struct NativeAppleActivityWeeklySections: View {
    let api: NativeAPI
    let token: String
    let userID: String
    let activity: NativeAppleActivityWeekly
    let isCurrent: Bool

    private var currentRange: NativeHealthWorkspaceRange? { activity.current?.reviewRange() }
    private var previousRange: NativeHealthWorkspaceRange? {
        guard let currentRange, let previous = activity.previous?.reviewRange(), previous.days == currentRange.days else { return nil }
        return previous
    }
    private var todayRange: NativeHealthWorkspaceRange? {
        guard isCurrent, let today = activity.today?.reviewRange(), today.days == 1 else { return nil }
        return today
    }
    private var baseline: String { isCurrent ? "上周同期" : "前一周同期" }

    var body: some View {
        if activity.status == "ready" {
            workoutSection
            heartSection
            oxygenSection
        } else {
            Section {
                NativeInlineNotice("暂时无法读取心率、血氧与训练记录。", tone: .attention)
            }
        }
    }

    private var workoutSection: some View {
        Section("活动与训练") {
            if let currentRange {
                if let previousRange {
                    Text((isCurrent ? "已结束日期 " : "回顾日期 ") + currentRange.label + "\n" + baseline + " " + previousRange.label)
                        .font(.caption).foregroundStyle(.secondary)
                }
                comparison("训练次数", workoutCount(activity.current?.workouts), workoutCount(activity.previous?.workouts))
                comparison("实际总时长", activity.current?.workouts?.durationLabel, activity.previous?.workouts?.durationLabel)
                trendLink("查看训练记录", topic: .activity, metric: "workouts", range: currentRange)
            } else if isCurrent {
                Text("本周还没有已结束的日期。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if let todayRange {
                trendLink("今天的训练", topic: .activity, metric: "workouts", range: todayRange) {
                    let count = workoutCount(activity.today?.workouts)
                    let detail = [count, activity.today?.workouts?.durationLabel].compactMap { $0 }.joined(separator: " · ")
                    LabeledContent("今天", value: detail.isEmpty ? "暂无已同步训练" : detail)
                }
            }
        }
    }

    private var heartSection: some View {
        Section("心率") {
            if let currentRange {
                comparison("日均心率有记录", coverage(activity.current?.heartRate?.days, range: currentRange),
                           coverage(activity.previous?.heartRate?.days, range: previousRange))
                comparison("静息心率有记录", coverage(activity.current?.restingHeartRate?.days, range: currentRange),
                           coverage(activity.previous?.restingHeartRate?.days, range: previousRange))
                trendLink("查看心率趋势", topic: .heart, metric: "heart_rate", range: currentRange)
            }
            if let todayRange {
                let readings = [heartValue(activity.today?.heartRate, label: "日均"),
                                heartValue(activity.today?.restingHeartRate, label: "静息")].compactMap { $0 }
                trendLink("今天的心率", topic: .heart, metric: "heart_rate", range: todayRange) {
                    LabeledContent("今天", value: readings.isEmpty ? "暂无记录" : readings.joined(separator: " · "))
                }
            }
        }
    }

    private var oxygenSection: some View {
        Section("血氧") {
            if let currentRange {
                comparison("有记录天数", coverage(activity.current?.oxygenSaturation?.days, range: currentRange),
                           coverage(activity.previous?.oxygenSaturation?.days, range: previousRange))
                comparison("采样次数", sampleCount(activity.current?.oxygenSaturation?.samples),
                           sampleCount(activity.previous?.oxygenSaturation?.samples))
                trendLink("查看血氧趋势", topic: .oxygen, metric: "oxygen_saturation", range: currentRange)
            }
            if let todayRange {
                trendLink("今天的血氧", topic: .oxygen, metric: "oxygen_saturation", range: todayRange) {
                    LabeledContent("今天", value: sampleCount(activity.today?.oxygenSaturation?.samples).map { $0 + "采样" } ?? "暂无采样")
                }
            }
        }
    }

    private func comparison(_ title: String, _ value: String?, _ previous: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent(title, value: value ?? "暂无记录")
            Text(baseline + " " + (previous ?? "暂无记录")).font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func coverage(_ count: Int?, range: NativeHealthWorkspaceRange?) -> String? {
        guard let range else { return nil }
        let recorded = count ?? 0
        guard (0...range.days).contains(recorded) else { return nil }
        return "\(recorded)/\(range.days) 天"
    }

    private func workoutCount(_ summary: NativeAppleActivityWorkoutSummary?) -> String? {
        sampleCount(summary?.count)
    }

    private func sampleCount(_ count: Int?) -> String? {
        guard let count, count > 0 else { return nil }
        return "\(count) 次"
    }

    private func heartValue(_ rate: NativeAppleActivityWeekly.Period.HeartRate?, label: String) -> String? {
        guard let rate, rate.days == 1, rate.average > 0, rate.average <= 500 else { return nil }
        return label + " " + rate.average.formatted(.number.precision(.fractionLength(0...1))) + " 次/分"
    }

    private func trendLink(_ title: String, topic: NativeHealthTrendTopic, metric: String,
                           range: NativeHealthWorkspaceRange) -> some View {
        trendLink(title, topic: topic, metric: metric, range: range) { Text(title) }
    }

    private func trendLink<LabelContent: View>(_ title: String, topic: NativeHealthTrendTopic, metric: String,
        range: NativeHealthWorkspaceRange, @ViewBuilder label: () -> LabelContent) -> some View {
        NavigationLink {
            NativeHealthRangeWorkspace(api: api, token: token, userID: userID, initialMetric: metric,
                initialFrom: range.from, initialTo: range.to, initialTopic: topic, initialDay: range.to)
        } label: { label() }
            .accessibilityHint(title)
    }
}
