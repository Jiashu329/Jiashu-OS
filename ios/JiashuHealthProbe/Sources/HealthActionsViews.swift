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

    init(api: NativeAPI, token: String, userID: String, defaultIsNutrition: Bool = false, initialMetric: QuickEntryMetric = .weight,
         initialDate: Date = Date(), onSaved: @escaping () async -> Void) {
        self.api = api
        self.token = token
        self.userID = userID
        self.onSaved = onSaved
        _isNutrition = State(initialValue: defaultIsNutrition)
        _metric = State(initialValue: initialMetric)
        _date = State(initialValue: initialDate)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let pending {
                    Section("待确认的原操作") {
                        Label(pending.label, systemImage: "clock.arrow.circlepath")
                        Text("这次提交的内容和标识已安全保存在本机。继续核对会重试同一次保存；你也可以关闭页面后再回来处理。")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("继续核对并保存") { Task { await submit(pending) } }
                            .disabled(isSaving)
                    }
                } else {
                    Section {
                        Picker("记录类型", selection: $isNutrition) {
                            Text("健康数据").tag(false)
                            Text("饮食").tag(true)
                        }.pickerStyle(.segmented)
                        DatePicker("记录日期", selection: $date, in: ...Date(), displayedComponents: .date)
                    }
                    if isNutrition {
                        Section("这次吃了什么") {
                            TextField("食物名称", text: $foodName)
                            Picker("餐次", selection: $meal) {
                                ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0) }
                            }
                            TextField("份量，例如一碗、200克", text: $portion)
                            TextField("热量（千卡，未知时留空）", text: $value).keyboardType(.decimalPad)
                            TextField("碳水化合物（克，未知时留空）", text: $carbs).keyboardType(.decimalPad)
                            TextField("蛋白质（克，未知时留空）", text: $protein).keyboardType(.decimalPad)
                            TextField("脂肪（克，未知时留空）", text: $fat).keyboardType(.decimalPad)
                        }
                        Section {
                            Text("未知热量保持未知；填写0表示已确认这份食物的热量为0。此处记录本人核对的值，不自动估算。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    } else {
                        Section("健康记录") {
                            Picker("指标", selection: $metric) {
                                ForEach(QuickEntryMetric.allCases) { Text($0.title).tag($0) }
                            }
                            HStack {
                                TextField("数值", text: $value).keyboardType(.decimalPad)
                                Text(metric.unit).foregroundStyle(.secondary)
                            }
                            if metric.isSample {
                                DatePicker("测量时间", selection: $time, displayedComponents: .hourAndMinute)
                            }
                        }
                        Section {
                            Text(metric.isSample ? "保存为一次人工测量，时间按北京时间。" : "保存为所选日期的人工汇总值；人工补录会保留修改依据。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    Section("备注（可选）") {
                        TextField("记录说明", text: $note, axis: .vertical).lineLimit(2...4)
                    }
                    Section {
                        Button("确认保存") { Task { await prepareAndSubmit() } }
                            .disabled(isSaving || !hasLoaded)
                    }
                }
                if isSaving { Section { ProgressView("正在核对保存结果…") } }
                if let message {
                    Section {
                        Text(message).foregroundStyle(.red).textSelection(.enabled)
                        if !hasLoaded { Button("重新读取原操作") { loadPending() } }
                    }
                }
            }
            .disabled(isSaving)
            .environment(\.timeZone, NativeActionDates.timeZone)
            .navigationTitle("快速记录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(isSaving) }
            }
            .interactiveDismissDisabled(isSaving)
            .task { loadPending() }
        }
    }

    private func loadPending() {
        guard !hasLoaded else { return }
        do {
            pending = try NativePendingEntryStore(userID: userID).load()
            hasLoaded = true
        } catch { message = error.localizedDescription }
    }

    private func prepareAndSubmit() async {
        message = nil
        do {
            let entry = try isNutrition
                ? NativePendingEntry.nutrition(name: foodName, meal: meal, portion: portion, calories: value,
                    note: note, date: date, carbs: carbs, protein: protein, fat: fat)
                : NativePendingEntry.health(metric: metric, value: value, date: date, time: time, reason: note)
            try NativePendingEntryStore(userID: userID).save(entry)
            pending = entry
            await submit(entry)
        } catch { message = error.localizedDescription }
    }

    private func submit(_ entry: NativePendingEntry) async {
        guard !isSaving else { return }
        isSaving = true
        message = nil
        defer { isSaving = false }
        do {
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
                do { try NativePendingEntryStore(userID: userID).clear(); pending = nil }
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
        .navigationTitle("饮食记录")
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

    init(api: NativeAPI, token: String, userID: String, initialWeek: String? = nil) {
        self.api = api; self.token = token; self.userID = userID
        let now = Date(), monday = NativeActionDates.monday(now)
        let current = NativeActionDates.day(monday)
        let previous = NativeActionDates.day(NativeActionDates.calendar.date(byAdding:.day,value:-7,to:monday)!)
        let selected = NativeWeeklyReviewWeek.initial(initialWeek,now:now)
        _actionWeek = State(initialValue:selected)
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
            Section {
                Picker("回顾周", selection: $period) {
                    Text("本周").tag(ReviewPeriod.current)
                    Text("上周").tag(ReviewPeriod.previous)
                    Text("历史周").tag(ReviewPeriod.custom)
                }.pickerStyle(.segmented)
                if period == .custom {
                    DatePicker("选择历史周内的日期",selection:$historicalDate,in:...Date(),displayedComponents:.date)
                        .environment(\.timeZone,NativeActionDates.timeZone)
                    Text("回顾周从 " + selectedWeek + "（周一）开始。").font(.caption).foregroundStyle(.secondary)
                }
            }
            if loading { Section { ProgressView("正在读取回顾…") } }
            if let reviewError {
                Section {
                    Text(reviewError).foregroundStyle(.red)
                    Button("重新读取回顾") { Task { await loadReview() } }
                }
            }
            if let review {
                Section(review.weekStart + " 至 " + review.cutoffDay) {
                    if let focus = review.focus {
                        Text(focus.headline).font(.headline)
                        Text(focus.summary)
                        Text(focus.coverageNote).font(.footnote).foregroundStyle(.secondary)
                    } else {
                        Text(review.isCurrent ? "本周仍在进行中，以下为已有记录。" : "以下为这周的实际记录。")
                    }
                }
                Section("指标记录日均") {
                    ForEach(review.metrics) { metric in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(metric.label)
                                Spacer()
                                Text(formatted(metric.currentAverage, unit: metric.unit))
                                    .fontWeight(.semibold)
                            }
                            Text("本期有记录\(metric.currentRecordedDays)天 · 前期\(metric.previousRecordedDays)天")
                                .font(.caption).foregroundStyle(.secondary)
                            Text("前期记录日均：" + formatted(metric.previousAverage, unit: metric.unit))
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 3)
                    }
                }
                if let focus = review.focus {
                    let points = [focus.primary].compactMap { $0 } + focus.secondary
                    if !points.isEmpty {
                        Section("本周重点") {
                            ForEach(points) { point in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(point.title).font(.headline)
                                    Text(point.evidence)
                                    Text(point.interpretation).font(.footnote).foregroundStyle(.secondary)
                                }.padding(.vertical, 3)
                            }
                        }
                    }
                }
            }
            if let recovery {
                Section(recovery.submitted ? "发现待确认的原保存":"发现未提交的本机填写") {
                    Text(recovery.command.weekStart + " · " + (recovery.command.text.isEmpty ? "尚未填写行动":recovery.command.text))
                    Text(recovery.submitted ? "恢复只重新展示原请求，不自动提交；继续核对会保留原周与原版本。放弃只清理本机，不会撤销服务器可能已经保存的内容。":"恢复后保留原加载周与版本，不会用今天的周日期替换，也不会自动保存。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("恢复原填写") { restoreRecovery() }
                    Button("放弃本机恢复内容",role:.destructive) { confirmDiscardRecovery = true }
                }
            }
            Section("所选周的一项行动 · " + actionWeek) {
                if actionWeek != currentCalendarWeek {
                    Text("当前填写属于\(actionWeek)，保存和重试都会保留原周，不会随日历自动改到本周。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("载入本周行动 · " + currentCalendarWeek) {
                        reloadWeek = currentCalendarWeek
                        confirmReload = true
                    }
                    .disabled(!storageReady || recovery != nil)
                }
                if recovery != nil {
                    Text("请先选择恢复或放弃本机内容。")
                } else if !storageReady {
                    Button("重新读取本机恢复内容") { Task { await initializeAction() } }
                } else if !actionLoaded && loadingAction {
                    ProgressView("正在读取行动…")
                } else if actionLoaded {
                    TextField("这周想做的一件具体小事", text: $actionText, axis: .vertical).lineLimit(2...4)
                        .disabled(pendingAction != nil)
                    Picker("执行状态", selection: $actionStatus) {
                        ForEach(NativeWeeklyActionStatus.allCases) { Text($0.title).tag($0) }
                    }.disabled(pendingAction != nil)
                    TextField("执行后的反馈（可选）", text: $feedback, axis: .vertical).lineLimit(2...5)
                        .disabled(pendingAction != nil)
                    Button(pendingAction == nil ? "保存行动" : "继续核对原保存") { Task { await saveAction() } }
                        .disabled(savingAction || !storageReady || actionConflict || (pendingAction == nil && actionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                    if pendingAction != nil { Text("原提交已安全保存。字段保持固定；继续核对会先读取服务器版本，避免重复创建新版本。").font(.footnote).foregroundStyle(.secondary) }
                    Button("核对服务器最新版本，保留填写") { Task { await checkLatestAction() } }
                    if latestChecked {
                        DisclosureGroup("已核对的服务器内容 · 版本 \(latestAction?.revision ?? 0)") {
                            Text(latestAction?.text ?? "当前没有已保存行动。")
                            if let latestAction { Text(latestAction.status.title); Text(latestAction.feedback) }
                        }
                        if actionConflict {
                            Button("核对后采用最新版本，保留填写") { confirmAdoptLatest = true }
                        }
                    }
                }
                if savingAction { ProgressView("正在核对…") }
                if let actionMessage { Text(actionMessage).foregroundStyle(.green) }
                if let actionError { Text(actionError).foregroundStyle(.red) }
                Button("读取回顾周的最新行动 · " + selectedWeek) {
                    reloadWeek = selectedWeek
                    confirmReload = true
                }
                .disabled(!storageReady || recovery != nil)
            }
            .disabled(savingAction || loadingAction)
            .onChange(of: actionText) { _, _ in actionMessage = nil; persistUnfinishedAction() }
            .onChange(of: actionStatus) { _, _ in persistUnfinishedAction() }
            .onChange(of: feedback) { _, _ in persistUnfinishedAction() }
            Section {
                Text("记录日均只使用有记录的日期，缺失记录不会补成0；两期覆盖不同的日期时，日均不能直接代表改善或下降。行动始终保存到上方标明的所选周。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("健康周回顾")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: selectedWeek) { await loadReview() }
        .task { await initializeAction() }
        .onDisappear { persistUnfinishedAction() }
        .refreshable { await loadReview() }
        .onReceive(Timer.publish(every: 60, on: .main, in: .common).autoconnect()) { calendarNow = $0 }
        .onChange(of: scenePhase) { _, phase in if phase == .active { calendarNow = Date() } }
        .confirmationDialog("读取\(reloadWeek ?? actionWeek)的行动会替换本页尚未保存的填写。待确认的保存可能已在服务器生效；替换不会撤销它。", isPresented: $confirmReload, titleVisibility: .visible) {
            Button("读取并替换填写") {
                let week = reloadWeek ?? actionWeek
                Task { await loadAction(week: week) }
            }
        }
        .confirmationDialog("放弃本机恢复内容？",isPresented:$confirmDiscardRecovery,titleVisibility:.visible) {
            Button("仅放弃本机内容",role:.destructive) { Task { await discardRecovery() } }
        } message: { Text("不会删除服务器上的行动。待确认的保存可能已经生效，随后读取服务器内容核对。") }
        .confirmationDialog("采用已核对的服务器版本？",isPresented:$confirmAdoptLatest,titleVisibility:.visible) {
            Button("采用最新版本，保留我的填写") { adoptLatestAction() }
        } message: { Text("原请求将结束恢复；保留当前文字与反馈，以核对过的服务器版本重新编辑。下次保存仍需再次核对该版本。") }
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
            actionMessage = saved.submitted ? "原保存已恢复，尚未重新提交。请主动继续核对。":"原填写已恢复，保留原周与原版本，尚未提交。"
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
            actionMessage = actionConflict ? "服务器版本已有变化。请核对展示的最新内容，再明确采用该版本或替换填写。":"服务器仍是原加载版本；当前填写与版本未改变。"
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
            actionMessage = "已主动采用核对后的版本，填写仍保留，尚未保存。"
        } catch { actionError = error.localizedDescription }
    }

    private func acknowledgeAction(_ original: NativeWeeklyActionCommand,entry: NativeWeeklyActionEntry,reconciled: Bool) throws {
        guard original.matchesSaved(entry) else { throw NativeAPIError.invalidResponse }
        try persistence.clear()
        actionWeek = original.weekStart; actionRevision = entry.revision
        actionText = entry.text; actionStatus = entry.status; feedback = entry.feedback
        baseline = command; pendingAction = nil; recovery = nil; actionConflict = false
        latestChecked = false; latestAction = nil
        actionMessage = reconciled ? "已核对服务器内容与原保存一致，没有重复保存。":"\(original.weekStart)这周的行动已保存。"
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
                    actionError = "原周的服务器版本已变化，原请求未重发。请先核对最新内容。"
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
