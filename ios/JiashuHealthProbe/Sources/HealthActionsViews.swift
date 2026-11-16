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
    @State private var pending: NativePendingEntry?
    @State private var isSaving = false
    @State private var hasLoaded = false
    @State private var message: String?

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
                ? NativePendingEntry.nutrition(name: foodName, meal: meal, portion: portion, calories: value, note: note, date: date)
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
struct HealthWeeklyReviewView: View {
    let api: NativeAPI
    let token: String
    let userID: String

    @State private var previousWeek = false
    @State private var review: NativeWeeklyDetails?
    @State private var loading = false
    @State private var reviewError: String?
    @State private var actionLoaded = false
    @State private var actionRevision = 0
    @State private var actionText = ""
    @State private var actionStatus: NativeWeeklyActionStatus = .planned
    @State private var feedback = ""
    @State private var savingAction = false
    @State private var actionMessage: String?
    @State private var actionError: String?
    @State private var pendingAction: WeeklyActionDraft?
    @State private var confirmReload = false

    private struct WeeklyActionDraft {
        let text: String
        let status: NativeWeeklyActionStatus
        let feedback: String
        let revision: Int
    }
    private var actionWeek: String { NativeActionDates.day(NativeActionDates.monday(Date())) }
    private var selectedWeek: String {
        let monday = NativeActionDates.monday(Date())
        let day = previousWeek ? NativeActionDates.calendar.date(byAdding: .day, value: -7, to: monday)! : monday
        return NativeActionDates.day(day)
    }

    var body: some View {
        List {
            Section {
                Picker("回顾周", selection: $previousWeek) {
                    Text("本周").tag(false)
                    Text("上周").tag(true)
                }.pickerStyle(.segmented)
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
            Section("本周的一项行动 · " + actionWeek) {
                if !actionLoaded {
                    ProgressView("正在读取行动…")
                } else {
                    TextField("这周想做的一件具体小事", text: $actionText, axis: .vertical).lineLimit(2...4)
                        .disabled(pendingAction != nil)
                    Picker("执行状态", selection: $actionStatus) {
                        ForEach(NativeWeeklyActionStatus.allCases) { Text($0.title).tag($0) }
                    }.disabled(pendingAction != nil)
                    TextField("执行后的反馈（可选）", text: $feedback, axis: .vertical).lineLimit(2...5)
                        .disabled(pendingAction != nil)
                    Button(pendingAction == nil ? "保存行动" : "继续核对原保存") { Task { await saveAction() } }
                        .disabled(savingAction || (pendingAction == nil && actionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
                if savingAction { ProgressView("正在核对…") }
                if let actionMessage { Text(actionMessage).foregroundStyle(.green) }
                if let actionError { Text(actionError).foregroundStyle(.red) }
                Button("读取服务器最新行动") { confirmReload = true }.disabled(savingAction)
            }
            .disabled(savingAction)
            .onChange(of: actionText) { _, _ in actionMessage = nil }
            Section {
                Text("记录日均只使用有记录的日期，缺失记录不会补成0；两期覆盖不同的日期时，日均不能直接代表改善或下降。行动始终保存到上方标明的本周。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("健康周回顾")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: selectedWeek) { await loadReview() }
        .task { if !actionLoaded { await loadAction() } }
        .refreshable { await loadReview() }
        .confirmationDialog("读取最新行动会替换本页尚未保存的填写。", isPresented: $confirmReload, titleVisibility: .visible) {
            Button("读取并替换填写") { Task { await loadAction() } }
        }
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

    private func loadAction() async {
        actionError = nil
        actionMessage = nil
        do {
            let action = try await api.weeklyAction(token: token, week: actionWeek)
            guard !Task.isCancelled else { return }
            actionText = action?.text ?? ""
            actionStatus = action?.status ?? .planned
            feedback = action?.feedback ?? ""
            actionRevision = action?.revision ?? 0
            pendingAction = nil
            actionLoaded = true
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func saveAction() async {
        guard !savingAction else { return }
        let draft = pendingAction ?? WeeklyActionDraft(text: actionText, status: actionStatus, feedback: feedback, revision: actionRevision)
        pendingAction = draft
        savingAction = true
        actionError = nil
        actionMessage = nil
        defer { savingAction = false }
        do {
            let action = try await api.saveWeeklyAction(token: token, week: actionWeek, text: draft.text,
                status: draft.status, feedback: draft.feedback, expectedRevision: draft.revision)
            guard !Task.isCancelled else { return }
            actionRevision = action?.revision ?? actionRevision
            actionText = action?.text ?? draft.text
            actionStatus = action?.status ?? draft.status
            feedback = action?.feedback ?? draft.feedback
            pendingAction = nil
            actionMessage = "本周行动已保存。"
        } catch {
            actionError = error.localizedDescription + " 原填写已保留；重试核对同一次保存。"
        }
    }
}
