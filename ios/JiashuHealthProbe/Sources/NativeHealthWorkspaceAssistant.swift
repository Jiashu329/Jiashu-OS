import SwiftUI

struct NativeHealthAssistantTurn: Identifiable, Equatable {
    let id: UUID
    let question: String
    let answer: String
    init(question: String, answer: String) { id = UUID(); self.question = question; self.answer = answer }
}

enum NativeHealthAssistantRequest {
    static func body(question: String, range: NativeHealthWorkspaceRange, metrics: Set<String>, nutrition: Bool,
                     goals: Bool, scopeKey: String, history: [NativeHealthAssistantTurn]) throws -> NativeJSON {
        let trimmed = question.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf16.count <= 1000, !scopeKey.isEmpty,
              metrics.isSubset(of:Set(NativeHealthWorkspaceFormat.metricKeys)), !metrics.isEmpty || nutrition else {
            throw NativeHealthWorkspaceError.invalid("请填写1000字以内的问题，并选择至少一种健康指标或饮食摘要。")
        }
        var pairs = Array(history.suffix(4))
        func messages(_ turns: [NativeHealthAssistantTurn]) -> NativeJSON {
            .array(turns.flatMap { [.object(["role":.string("user"),"content":.string($0.question)]), .object(["role":.string("assistant"),"content":.string($0.answer)])] })
        }
        while !(pairs.isEmpty), try messages(pairs).encodedData().count > 32_000 { pairs.removeFirst() }
        let result: NativeJSON = .object([
            "question":.string(trimmed),"from":.string(range.from),"to":.string(range.to),
            "shareHealthData":.bool(true),"historyScope":.string(scopeKey),"history":messages(pairs),
            "scope":.object(["metrics":.array(NativeHealthWorkspaceFormat.metricKeys.filter { metrics.contains($0) }.map { .string($0) }),
                             "includeNutrition":.bool(nutrition),"includeGoals":.bool(goals)])
        ])
        guard try result.encodedData().count <= 48 * 1024 else { throw NativeHealthWorkspaceError.invalid("问题与历史超过请求限制，请开始新对话。") }
        return result
    }
}

struct NativeHealthAssistantSelection: Equatable {
    var from: Date
    var to: Date
    var metrics: Set<String>
    var nutrition: Bool
    var goals: Bool

    static func initial(metric: String? = nil, from: String? = nil, to: String? = nil, now: Date = Date()) -> Self {
        let end: Date = to.flatMap(NativeHealthWorkspaceFormat.date) ?? now
        let fallback: Date = NativeActionDates.calendar.date(byAdding:.day,value:-29,to:end)!
        let start: Date = from.flatMap(NativeHealthWorkspaceFormat.date) ?? fallback
        let selectedMetrics: Set<String>
        if let metric { selectedMetrics = NativeHealthWorkspaceFormat.metricKeys.contains(metric) ? [metric]:[] }
        else { selectedMetrics = Set(NativeHealthWorkspaceFormat.metricKeys) }
        return .init(from:start,to:end,metrics:selectedMetrics,nutrition:metric == nil,goals:false)
    }
    func range(now: Date = Date()) throws -> NativeHealthWorkspaceRange {
        guard !metrics.isEmpty || nutrition else { throw NativeHealthWorkspaceError.invalid("请选择至少一种健康指标或饮食摘要。") }
        return try NativeHealthWorkspaceRange(from:from,to:to,now:now)
    }
    var dateLabel: String { NativeActionDates.day(from) + " — " + NativeActionDates.day(to) }
    var detailLabel: String {
        var labels: [String] = NativeHealthWorkspaceFormat.metricKeys.filter { metrics.contains($0) }.map(NativeHealthWorkspaceFormat.metric)
        if nutrition { labels.append("饮食摘要") }
        if goals { labels.append("本人目标") }
        return labels.isEmpty ? "请选择支持的健康指标":labels.joined(separator:"、")
    }
    func needsNewConversation(comparedWith original: Self,hasConversation: Bool) -> Bool { self != original && hasConversation }
}

struct NativeHealthAssistantWorkspace: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @State private var selection: NativeHealthAssistantSelection
    @State private var previewSelection: NativeHealthAssistantSelection?
    @State private var preview: NativeJSON = .null
    @State private var previewRange: NativeHealthWorkspaceRange?
    @State private var turns: [NativeHealthAssistantTurn] = []
    @State private var sources: [NativeJSON] = []
    @State private var question = ""
    @State private var busy = false
    @State private var confirm = false
    @State private var editingScope = false
    @State private var confirmNewConversation = false
    @State private var message: String?
    @State private var remaining: Int?
    @State private var retryAt: Date?
    @State private var clockNow = Date()
    @FocusState private var questionFocused: Bool

    init(api: NativeAPI, token: String, userID: String, initialMetric: String? = nil,
         initialFrom: String? = nil, initialTo: String? = nil, initialQuestion: String? = nil) {
        self.api = api; self.token = token; self.userID = userID
        _selection = State(initialValue:.initial(metric:initialMetric,from:initialFrom,to:initialTo))
        _question = State(initialValue:initialQuestion ?? "")
    }
    private var ready: Bool {
        previewSelection == selection && preview["hasData"].boolValue == true && preview["configuration"]["ready"].boolValue == true && previewRange != nil
    }
    private var hasConversation: Bool { !turns.isEmpty || !question.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty }
    private var waitingForQuota: Bool { retryAt.map { $0 > clockNow } ?? false }
    var body: some View {
        List {
            scopeSection
            statusSection
            conversationSection
            previewSection
            sourcesSection
        }
        .nativeGeometricPage().navigationTitle("健康助手")
        .navigationBarTitleDisplayMode(.inline)
        .environment(\.timeZone,NativeActionDates.timeZone)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge:.bottom) { composer }
        .toolbar {
            ToolbarItem(placement:.topBarTrailing) {
                Button { if hasConversation { confirmNewConversation = true } else { newConversation() } } label: { Image(systemName:"square.and.pencil") }
                    .accessibilityLabel("开始新对话").disabled(busy)
            }
        }
        .task { await load() }
        .sheet(isPresented:$editingScope) {
            NativeHealthAssistantScopeEditor(selection:selection,hasConversation:hasConversation) { updated in
                guard updated != selection else { return }
                selection = updated; preview = .null; previewRange = nil; previewSelection = nil
                turns = []; sources = []; message = nil
                Task { await load() }
            }
        }
        .confirmationDialog("发送所选资料给 AI？",isPresented:$confirm,titleVisibility:.visible) {
            Button("确认发送") { Task { await send() } }
            Button("取消",role:.cancel) { }
        } message: { Text("将发送本次问题、所选健康摘要及后续问答给 MiniMax，可能产生模型费用。原始样本、财务、食物名称与备注不会发送。") }
        .confirmationDialog("开始新对话？",isPresented:$confirmNewConversation,titleVisibility:.visible) {
            Button("清空当前对话并重新开始",role:.destructive) { newConversation() }
            Button("保留当前对话",role:.cancel) { }
        } message: { Text("当前问答与问题草稿只在本页保留，清空后无法恢复。健康记录不受影响。") }
        .onReceive(Timer.publish(every:1,on:.main,in:.common).autoconnect()) { now in
            if retryAt != nil { clockNow = now; if let retryAt,now >= retryAt { self.retryAt = nil } }
        }
    }
    private var scopeSection: some View {
        Section {
            VStack(alignment:.leading,spacing:5) {
                Text(selection.dateLabel).font(.subheadline.weight(.semibold))
                Text(selection.detailLabel).font(.footnote).foregroundStyle(.secondary)
            }
            Button("调整日期与共享资料") { editingScope = true }.disabled(busy)
        }
    }
    @ViewBuilder private var statusSection: some View {
        if busy { Section { ProgressView(turns.isEmpty ? "正在准备资料或回答…":"正在回答…") } }
        if let message { Section { Text(message).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled) } }
        if previewRange == nil && !busy { Section { Button("重新读取资料") { Task { await load() } } } }
        if let text = preview["configuration"]["message"].stringValue { Section { Text(text).font(.footnote).foregroundStyle(.secondary) } }
    }
    private var conversationSection: some View {
        Section("对话") {
            if turns.isEmpty {
                Text("从这段记录里，选一个你想弄清楚的问题。").font(.headline)
                Button("帮我找出值得关注的变化") { question = "这段记录有哪些值得关注的变化？" }.disabled(busy)
                Text("回答会标明记录依据。这里不修改健康数据，对话离开页面后不存档。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(turns) { turn in
                VStack(alignment:.leading,spacing:12) {
                    Text(turn.question).font(.headline).textSelection(.enabled)
                    Text(turn.answer).textSelection(.enabled)
                }.padding(.vertical,8)
            }
        }
    }
    private var composer: some View {
        VStack(alignment:.leading,spacing:8) {
            HStack(alignment:.bottom,spacing:12) {
                TextField("问问这段记录",text:$question,axis:.vertical).lineLimit(1...5).focused($questionFocused)
                    .disabled(busy).padding(10).background(NativePalette.surface,in:RoundedRectangle(cornerRadius:12))
                Button("发送") { questionFocused = false; if turns.isEmpty { confirm = true } else { Task { await send() } } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || !ready || question.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || waitingForQuota)
            }
            if let retryAt,waitingForQuota {
                let seconds: Int = max(0,Int(retryAt.timeIntervalSince(clockNow).rounded(.up)))
                Text("请等待 \(seconds) 秒后主动重试。").font(.caption).foregroundStyle(.secondary)
            } else if let remaining { Text("今日剩余 \(remaining) 次 · 发送使用 MiniMax").font(.caption).foregroundStyle(.secondary) }
        }.padding(.horizontal).padding(.vertical,10).background(.bar)
    }
    @ViewBuilder private var previewSection: some View {
        if let range = previewRange {
            Section {
                DisclosureGroup("查看将分享的摘要与统计口径") {
                    Text(range.label).font(.caption)
                    LabeledContent("模型",value:preview["configuration"]["model"].stringValue ?? "未配置")
                    ForEach(Array(preview["context"]["health"].arrayValue.enumerated()),id:\.offset) { _,metric in previewMetricRow(metric) }
                    if selection.nutrition {
                        LabeledContent("饮食有记录日期",value:NativeHealthWorkspaceFormat.text(preview["context"]["nutrition"]["recordedDays"]))
                        LabeledContent("本人标记完整日期",value:NativeHealthWorkspaceFormat.text(preview["context"]["nutrition"]["completeDays"]))
                    }
                    ForEach(Array(preview["context"]["limitations"].arrayValue.enumerated()),id:\.offset) { _,item in Text(item.stringValue ?? "").font(.caption).foregroundStyle(.secondary) }
                    Text("只发送所选摘要、问题和最近最多4轮问答；不发送登录身份、财务或食物名称与备注。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
    private func previewMetricRow(_ metric: NativeJSON) -> some View {
        let label: String = metric["label"].stringValue ?? "健康指标"
        let days: String = NativeHealthWorkspaceFormat.text(metric["recordedDays"])
        let title: String = "\(label) · \(days)天有记录"
        return DisclosureGroup(title) {
            ForEach(Array(metric["points"].arrayValue.enumerated()),id:\.offset) { _,point in
                LabeledContent(point["date"].stringValue ?? "未知日期",value:NativeHealthWorkspaceFormat.text(point["value"]))
            }
        }
    }
    @ViewBuilder private var sourcesSection: some View {
        if !sources.isEmpty {
            Section {
                DisclosureGroup("查看回答依据") {
                    ForEach(Array(sources.enumerated()),id:\.offset) { _,source in sourceRow(source) }
                }
            }
        }
    }
    private func sourceRow(_ source: NativeJSON) -> some View {
        let code: String = source["id"].stringValue ?? ""
        let label: String = source["label"].stringValue ?? "来源"
        let title: String = "\(code) · \(label)"
        let from: String = source["from"].stringValue ?? ""
        let to: String = source["to"].stringValue ?? ""
        let dates: String = "\(from) — \(to)"
        return DisclosureGroup(title) {
            Text(dates)
            Text(source["sources"].arrayValue.compactMap(\.stringValue).joined(separator:"、")).font(.caption)
            Text(source["dates"].arrayValue.compactMap(\.stringValue).joined(separator:"、")).font(.caption)
        }
    }
    private func newConversation() { turns = []; sources = []; question = ""; message = nil }
    private func load() async {
        guard !busy else { return }; busy = true; message = nil; defer { busy = false }
        let requested = selection
        do {
            let range = try requested.range()
            let metricKeys: String = NativeHealthWorkspaceFormat.metricKeys.filter { requested.metrics.contains($0) }.joined(separator:",")
            let query = range.query + [URLQueryItem(name:"metrics",value:metricKeys),URLQueryItem(name:"nutrition",value:requested.nutrition ? "1":"0"),URLQueryItem(name:"goals",value:requested.goals ? "1":"0")]
            let result = try await api.json(path:NativeHealthWorkspaceFormat.path("health/assistant",query:query),token:token)
            guard requested == selection,!Task.isCancelled else { return }
            preview = result; previewRange = range; previewSelection = requested; remaining = result["usage"]["remainingToday"].intValue
            sources = result["sources"].arrayValue
        } catch { preview = .null; previewRange = nil; previewSelection = nil; message = error.localizedDescription }
    }
    private func send() async {
        guard !busy,ready,let range = previewRange,let scopeKey = preview["scopeKey"].stringValue else { return }
        let requested = selection
        busy = true; message = nil; defer { busy = false }
        do {
            let body = try NativeHealthAssistantRequest.body(question:question,range:range,metrics:requested.metrics,nutrition:requested.nutrition,goals:requested.goals,scopeKey:scopeKey,history:turns)
            let submitted = question
            let result = try await api.json(path:"health/assistant",method:"POST",token:token,body:body)
            guard !Task.isCancelled,requested == selection,let answer = result["answer"].stringValue,!answer.isEmpty,result["scopeKey"].stringValue == scopeKey else { throw NativeAPIError.invalidResponse }
            turns.append(NativeHealthAssistantTurn(question:submitted,answer:answer)); question = ""
            sources = result["sources"].arrayValue; remaining = result["usage"]["remainingToday"].intValue
        } catch {
            message = error.localizedDescription + " 问题已保留，不会自动重发。"
            if case NativeAPIError.server(let status,_,_,let retryAfter) = error,status == 429 { retryAt = Date().addingTimeInterval(retryAfter ?? 60); clockNow = Date() }
        }
    }
}

private struct NativeHealthAssistantScopeEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft: NativeHealthAssistantSelection
    let hasConversation: Bool
    let onApply: (NativeHealthAssistantSelection) -> Void
    private let original: NativeHealthAssistantSelection
    @State private var confirming = false
    @State private var message: String?
    init(selection: NativeHealthAssistantSelection,hasConversation: Bool,onApply: @escaping (NativeHealthAssistantSelection) -> Void) {
        original = selection; _draft = State(initialValue:selection); self.hasConversation = hasConversation; self.onApply = onApply
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("日期（北京时间）") {
                    DatePicker("开始",selection:$draft.from,in:...Date(),displayedComponents:.date)
                    DatePicker("结束",selection:$draft.to,in:...Date(),displayedComponents:.date)
                }
                Section("共享的摘要") {
                    ForEach(NativeHealthWorkspaceFormat.metricKeys,id:\.self) { key in
                        Toggle(NativeHealthWorkspaceFormat.metric(key),isOn:Binding(get:{ draft.metrics.contains(key) },set:{ if $0 { draft.metrics.insert(key) } else { draft.metrics.remove(key) } }))
                    }
                    Toggle("饮食营养与记录完整度",isOn:$draft.nutrition)
                    Toggle("参考本人目标",isOn:$draft.goals)
                }
                Text("这里只调整摘要，不调用 AI。问题草稿保留；使用新范围时需开始新对话。")
                    .font(.footnote).foregroundStyle(.secondary)
                if let message { Text(message).foregroundStyle(.red) }
            }
            .nativeGeometricPage().navigationTitle("资料范围").navigationBarTitleDisplayMode(.inline)
            .environment(\.timeZone,NativeActionDates.timeZone)
            .toolbar {
                ToolbarItem(placement:.cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement:.confirmationAction) { Button("使用此范围") { validateAndApply() } }
            }
            .confirmationDialog("更换范围并开始新对话？",isPresented:$confirming,titleVisibility:.visible) {
                Button("使用新范围并清空当前问答",role:.destructive) { apply() }
                Button("保留当前对话",role:.cancel) { }
            } message: { Text("当前回答只在本页保留，清空后无法恢复。尚未发送的问题会保留。") }
        }
    }
    private func validateAndApply() {
        do { _ = try draft.range(); if draft.needsNewConversation(comparedWith:original,hasConversation:hasConversation) { confirming = true } else { apply() } }
        catch { message = error.localizedDescription }
    }
    private func apply() { onApply(draft); dismiss() }
}
