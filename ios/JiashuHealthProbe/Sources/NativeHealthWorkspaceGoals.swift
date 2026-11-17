import SwiftUI

enum NativeHealthGoalRequest {
    static let keys = ["steps","sleep","active_energy"]
    static func body(fields: [String:String], effectiveFrom: Date, revision: Int, now: Date = Date()) throws -> NativeJSON {
        guard revision >= 0,NativeActionDates.day(effectiveFrom) >= "1970-01-01",NativeActionDates.day(effectiveFrom) <= NativeActionDates.day(now) else {
            throw NativeHealthWorkspaceError.invalid("请核对目标版本和不晚于今天的生效日期。")
        }
        var targets: [String:NativeJSON] = [:]
        for key in keys {
            let text = (fields[key] ?? "").trimmingCharacters(in:.whitespacesAndNewlines)
            if text.isEmpty { targets[key] = .null; continue }
            let maximum: Double = key == "steps" ? 200_000:key == "sleep" ? 24:20_000
            guard text.range(of:#"^\d+(?:\.\d+)?$"#,options:.regularExpression) != nil,let value = Double(text),value.isFinite,value > 0,value <= maximum,key != "steps" || value.rounded() == value else {
                throw NativeHealthWorkspaceError.invalid("请填写有效的" + NativeHealthWorkspaceFormat.metric(key) + "目标；取消目标请留空。")
            }
            targets[key] = .number(value)
        }
        return .object(["targets":.object(targets),"expectedRevision":.number(Double(revision)),"effectiveFrom":.string(NativeActionDates.day(effectiveFrom))])
    }
    static func matchesSaved(_ operation: NativeHealthWorkspaceMutation, response: NativeJSON) -> Bool {
        guard let revision = operation.body["expectedRevision"].intValue else { return false }
        return response["revision"].intValue == revision + 1 && response["targets"] == operation.body["targets"] && response["effectiveFrom"] == operation.body["effectiveFrom"]
    }
}

struct NativeHealthGoalsWorkspace: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @State private var settings: NativeJSON = .null
    @State private var progress: NativeJSON = .null
    @State private var fields: [String:String] = [:]
    @State private var effective = Date()
    @State private var pending: NativeHealthWorkspaceMutation?
    @State private var busy = false
    @State private var loaded = false
    @State private var formRevision = 0
    @State private var draftReady = false
    @State private var conflict = false
    @State private var confirming = false
    @State private var message: String?
    private var store: NativeHealthWorkspaceMutationStore { .init(userID:userID,scope:"goals") }
    private var draftStore: NativeWorkspacePersistence { .init(userID:userID,scope:"health-goals-form") }
    private var draftSignature: String { NativeHealthGoalRequest.keys.map { fields[$0] ?? "" }.joined(separator:"|") + NativeActionDates.day(effective) }
    var body: some View {
        List {
            if let pending {
                Section("待确认的原目标") {
                    Text(pending.label)
                    Button("继续核对原目标") { Task { await submit(pending,recovering:true) } }.disabled(busy)
                }
            }
            Section("本人每日目标") {
                ForEach(NativeHealthGoalRequest.keys,id:\.self) { key in
                    TextField(NativeHealthWorkspaceFormat.metric(key) + "（" + NativeHealthWorkspaceFormat.unit(key) + "，取消目标留空）",text:Binding(get:{ fields[key] ?? "" },set:{ fields[key] = $0 })).keyboardType(.decimalPad)
                }
                DatePicker("生效日期",selection:$effective,in:...Date(),displayedComponents:.date)
                Text("每一天按当日生效版本评价；修改目标不会把此前的日历重新套用今天的目标。")
                    .font(.footnote).foregroundStyle(.secondary)
                if conflict { Text("版本已变化。保留填写，先读取最新目标再核对保存。") }
                Button("核对并保存目标") { confirming = true }.disabled(!loaded || !draftReady || busy || pending != nil || conflict)
                Button("读取最新目标，保留填写") { Task { await load(populate:false) } }.disabled(busy || pending != nil)
                Button("载入已存目标到表单") { Task { await load(populate:true) } }.disabled(busy || pending != nil)
            }.disabled(busy || pending != nil)
            Section("近30天达成日历") {
                Button("刷新达成与覆盖") { Task { await loadProgress() } }.disabled(busy)
                ForEach(Array(progress["metrics"].arrayValue.enumerated()),id:\.offset) { _,metric in
                    DisclosureGroup((metric["label"].stringValue ?? "") + " · 达成 " + NativeHealthWorkspaceFormat.text(metric["achievedDays"]) + " / 有记录 " + NativeHealthWorkspaceFormat.text(metric["recordedDays"]) + " 天") {
                        ForEach(Array(metric["days"].arrayValue.enumerated()),id:\.offset) { _,day in
                            VStack(alignment:.leading,spacing:3) {
                                LabeledContent(day["day"].stringValue ?? "",value:status(day["status"].stringValue))
                                Text("记录 " + NativeHealthWorkspaceFormat.text(day["value"]) + " · 当日目标 " + NativeHealthWorkspaceFormat.text(day["target"]))
                                    .font(.caption)
                                Text("目标生效：" + (day["targetEffectiveFrom"].stringValue ?? "未设置")).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Text("缺失、未设置、今日进行中与真实零值分别保留；不把缺失日期当作未达成。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("目标生效历史") {
                ForEach(Array(settings["history"].arrayValue.reversed().enumerated()),id:\.offset) { _,version in
                    DisclosureGroup(version["effectiveFrom"].stringValue == "1970-01-01" ? "兼容基线（实际生效日期未知）":(version["effectiveFrom"].stringValue ?? "未知日期")) {
                        ForEach(NativeHealthGoalRequest.keys,id:\.self) { key in
                            LabeledContent(NativeHealthWorkspaceFormat.metric(key),value:NativeHealthWorkspaceFormat.text(version["targets"][key]) + " " + NativeHealthWorkspaceFormat.unit(key))
                        }
                        LabeledContent("版本",value:NativeHealthWorkspaceFormat.text(version["revision"]))
                    }
                }
            }
            if busy { ProgressView("正在核对目标…") }
            NativeHealthWorkspaceMessage(message:message)
        }.navigationTitle("健康目标与历史")
            .environment(\.timeZone,NativeActionDates.timeZone)
            .task {
                do {
                    pending = try store.load(); let draft = try draftStore.load(NativeHealthWorkspaceFormDraft.self)
                    await load(populate:pending == nil && draft == nil); await loadProgress()
                    if let draft {
                        fields = draft.fields; effective = draft.dates["effective"] ?? effective
                        formRevision = draft.snapshot["revision"].intValue ?? 0; conflict = true
                        message = "已恢复本机目标填写。请读取最新目标版本，再核对保存。"
                    }
                    draftReady = true
                } catch { message = error.localizedDescription }
            }
            .onChange(of:draftSignature) { _,_ in saveDraft() }
            .onDisappear { saveDraft() }
            .confirmationDialog("保存这些每日目标？",isPresented:$confirming,titleVisibility:.visible) {
                Button("确认保存") { Task { await prepare() } }
                Button("取消",role:.cancel) { }
            } message: { Text("目标从 " + NativeActionDates.day(effective) + " 生效。留空的指标将取消目标，不改写原始健康记录。") }
    }
    private func status(_ key: String?) -> String { ["unset":"未设置目标","missing":"缺少记录","in-progress":"今日进行中","achieved":"已达成","missed":"未达成"][key ?? ""] ?? "未知" }
    private func load(populate: Bool) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            settings = try await api.json(path:"health/goals",token:token); loaded = true; conflict = false
            formRevision = settings["revision"].intValue ?? 0
            if populate {
                fields = Dictionary(uniqueKeysWithValues:NativeHealthGoalRequest.keys.map { key in (key,settings["targets"][key].doubleValue.map { String($0) } ?? "") })
                effective = Date()
            }
        } catch { message = error.localizedDescription }
    }
    private func loadProgress() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { progress = try await api.json(path:"health/goals/progress",token:token) } catch { message = error.localizedDescription }
    }
    private func prepare() async {
        do {
            let body = try NativeHealthGoalRequest.body(fields:fields,effectiveFrom:effective,revision:formRevision)
            let operation = NativeHealthWorkspaceMutation(path:"health/goals",method:"PUT",body:body,label:"每日目标 · " + NativeActionDates.day(effective))
            try store.save(operation); pending = operation; await submit(operation,recovering:false)
        } catch { message = error.localizedDescription }
    }
    private func saveDraft() {
        guard draftReady,pending == nil else { return }
        let edited = NativeHealthGoalRequest.keys.contains { Double(fields[$0] ?? "") != settings["targets"][$0].doubleValue } || NativeActionDates.day(effective) != NativeActionDates.day(Date())
        do {
            if edited { try draftStore.save(NativeHealthWorkspaceFormDraft(fields:fields,dates:["effective":effective],snapshot:.object(["revision":.number(Double(formRevision))]))) }
            else { try draftStore.clear() }
        } catch { message = error.localizedDescription }
    }
    private func submit(_ operation: NativeHealthWorkspaceMutation,recovering: Bool) async {
        guard !busy else { return }; busy = true; message = nil
        do {
            let result: NativeJSON
            if recovering {
                let current = try await api.json(path:"health/goals",token:token)
                if NativeHealthGoalRequest.matchesSaved(operation,response:current) { result = current }
                else { result = try await operation.send(api:api,token:token) }
            } else { result = try await operation.send(api:api,token:token) }
            guard result["revision"].intValue != nil else { throw NativeAPIError.invalidResponse }
            try store.clear(); try draftStore.clear(); pending = nil; settings = result; formRevision = result["revision"].intValue ?? formRevision; busy = false; await loadProgress(); message = "目标已核对保存。"
        } catch {
            message = error.localizedDescription
            if NativeHealthWorkspaceFormat.definiteRejection(error) {
                do { try store.clear(); pending = nil; conflict = true } catch { message = error.localizedDescription }
            } else { message = (message ?? "") + " 原目标仍待确认，请继续核对原请求。" }
        }
        busy = false
    }
}
