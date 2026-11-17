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

struct NativeHealthAssistantWorkspace: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @State private var from = NativeActionDates.calendar.date(byAdding:.day,value:-29,to:Date())!
    @State private var to = Date()
    @State private var metrics = Set(NativeHealthWorkspaceFormat.metricKeys)
    @State private var nutrition = true
    @State private var goals = false
    @State private var preview: NativeJSON = .null
    @State private var previewRange: NativeHealthWorkspaceRange?
    @State private var turns: [NativeHealthAssistantTurn] = []
    @State private var sources: [NativeJSON] = []
    @State private var question = ""
    @State private var busy = false
    @State private var confirm = false
    @State private var message: String?
    @State private var remaining: Int?
    @State private var retryAt: Date?

    private var signature: String { NativeActionDates.day(from) + NativeActionDates.day(to) + metrics.sorted().joined() + String(nutrition) + String(goals) }
    private var ready: Bool { preview["hasData"].boolValue == true && preview["configuration"]["ready"].boolValue == true && previewRange != nil }
    var body: some View {
        List {
            Section("本次资料范围（北京时间）") {
                DatePicker("开始",selection:$from,in:...Date(),displayedComponents:.date)
                DatePicker("结束",selection:$to,in:...Date(),displayedComponents:.date)
                ForEach(NativeHealthWorkspaceFormat.metricKeys,id:\.self) { key in
                    Toggle(NativeHealthWorkspaceFormat.metric(key),isOn:Binding(get:{ metrics.contains(key) },set:{ if $0 { metrics.insert(key) } else { metrics.remove(key) } }))
                }
                Toggle("饮食营养与完整度摘要",isOn:$nutrition)
                Toggle("参考本人目标及启用的体重计划",isOn:$goals)
                Button("读取将分享的摘要") { Task { await load() } }.disabled(busy)
                Text("读取摘要不调用 AI。修改日期或资料范围会清空当前对话。")
                    .font(.footnote).foregroundStyle(.secondary)
            }.disabled(busy)
            if let previewRange {
                Section("发送前核对 · " + previewRange.label) {
                    LabeledContent("模型",value:preview["configuration"]["model"].stringValue ?? "未配置")
                    if let remaining { LabeledContent("今日剩余请求",value:String(remaining)) }
                    if let text = preview["configuration"]["message"].stringValue { Text(text).font(.footnote) }
                    ForEach(Array(preview["context"]["health"].arrayValue.enumerated()),id:\.offset) { _,metric in
                        DisclosureGroup((metric["label"].stringValue ?? "健康指标") + " · " + NativeHealthWorkspaceFormat.text(metric["recordedDays"]) + " 天有记录") {
                            ForEach(Array(metric["points"].arrayValue.enumerated()),id:\.offset) { _,point in
                                LabeledContent(point["date"].stringValue ?? "未知日期",value:NativeHealthWorkspaceFormat.text(point["value"]))
                            }
                        }
                    }
                    if nutrition {
                        LabeledContent("饮食有记录日期",value:NativeHealthWorkspaceFormat.text(preview["context"]["nutrition"]["recordedDays"]))
                        LabeledContent("本人标记完整日期",value:NativeHealthWorkspaceFormat.text(preview["context"]["nutrition"]["completeDays"]))
                    }
                    ForEach(Array(preview["context"]["limitations"].arrayValue.enumerated()),id:\.offset) { _,item in Text(item.stringValue ?? "").font(.caption).foregroundStyle(.secondary) }
                    Text("提交时会把本次问题、最近最多4轮问答及这里选择的摘要发送给 MiniMax。登录身份、财务记录、原始健康样本、食物名称与备注不在摘要中。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section("本次对话") {
                ForEach(turns) { turn in
                    VStack(alignment:.leading,spacing:12) {
                        Text(turn.question).font(.headline).textSelection(.enabled)
                        Text(turn.answer).textSelection(.enabled)
                    }.padding(.vertical,8)
                }
                TextField("结合记录提出问题",text:$question,axis:.vertical).lineLimit(3...8).disabled(busy)
                Button("确认资料并发送给 MiniMax") { confirm = true }
                    .disabled(busy || !ready || question.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || (retryAt.map { $0 > Date() } ?? false))
                if let retryAt, retryAt > Date() { TimelineView(.periodic(from:.now,by:1)) { context in Text("限流等待：\(max(0,Int(retryAt.timeIntervalSince(context.date).rounded(.up))))秒，请稍后主动发送。") } }
                Button("开始新对话") { turns = []; sources = []; message = nil }.disabled(busy)
                Text("对话只保留在当前页面，离开后不存档。失败请求也可能消耗额度；不会自动重发。助手不修改健康记录。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if !sources.isEmpty {
                Section("可核对的来源") {
                    ForEach(Array(sources.enumerated()),id:\.offset) { _,source in
                        DisclosureGroup((source["id"].stringValue ?? "") + " · " + (source["label"].stringValue ?? "来源")) {
                            Text((source["from"].stringValue ?? "") + " — " + (source["to"].stringValue ?? ""))
                            Text(source["sources"].arrayValue.compactMap(\.stringValue).joined(separator:"、")).font(.caption)
                            Text(source["dates"].arrayValue.compactMap(\.stringValue).joined(separator:"、")).font(.caption)
                        }
                    }
                }
            }
            if busy { ProgressView("正在读取或等待回答…") }
            NativeHealthWorkspaceMessage(message:message)
        }.navigationTitle("健康助手")
            .environment(\.timeZone,NativeActionDates.timeZone)
            .onChange(of:signature) { _,_ in preview = .null; previewRange = nil; turns = []; sources = []; message = nil }
            .task { await load() }
            .confirmationDialog("发送本次资料与问题？",isPresented:$confirm,titleVisibility:.visible) {
                Button("发送给 MiniMax") { Task { await send() } }
                Button("取消",role:.cancel) { }
            } message: { Text("将发送已预览的日期范围、所选资料、当前问题和最近问答。请求可能产生模型费用并占用今日额度。") }
    }
    private func load() async {
        guard !busy else { return }; busy = true; message = nil; defer { busy = false }
        do {
            let range = try NativeHealthWorkspaceRange(from:from,to:to)
            let query = range.query + [URLQueryItem(name:"metrics",value:NativeHealthWorkspaceFormat.metricKeys.filter { metrics.contains($0) }.joined(separator:",")),URLQueryItem(name:"nutrition",value:nutrition ? "1":"0"),URLQueryItem(name:"goals",value:goals ? "1":"0")]
            let result = try await api.json(path:NativeHealthWorkspaceFormat.path("health/assistant",query:query),token:token)
            preview = result; previewRange = range; remaining = result["usage"]["remainingToday"].intValue
            sources = result["sources"].arrayValue
        } catch { preview = .null; previewRange = nil; message = error.localizedDescription }
    }
    private func send() async {
        guard !busy, ready, let range = previewRange, let scopeKey = preview["scopeKey"].stringValue else { return }
        busy = true; message = nil; defer { busy = false }
        do {
            let body = try NativeHealthAssistantRequest.body(question:question,range:range,metrics:metrics,nutrition:nutrition,goals:goals,scopeKey:scopeKey,history:turns)
            let submitted = question
            let result = try await api.json(path:"health/assistant",method:"POST",token:token,body:body)
            guard let answer = result["answer"].stringValue, !answer.isEmpty, result["scopeKey"].stringValue == scopeKey else { throw NativeAPIError.invalidResponse }
            turns.append(NativeHealthAssistantTurn(question:submitted,answer:answer)); question = ""
            sources = result["sources"].arrayValue; remaining = result["usage"]["remainingToday"].intValue
        } catch {
            message = error.localizedDescription + " 当前问题已保留；结果不明时不要连续重复发送。"
            if case NativeAPIError.server(let status,_,_,let retryAfter) = error, status == 429 { retryAt = Date().addingTimeInterval(retryAfter ?? 60) }
        }
    }
}
