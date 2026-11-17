import SwiftUI

enum NativeHealthRecordRequest {
    static func operation(record: NativeJSON, action: String, value: String, reason: String) throws -> NativeHealthWorkspaceMutation {
        guard let key = record["recordKey"].stringValue, !key.isEmpty,
              let revision = record["revision"].intValue, revision >= 0,
              ["correct","hide","restore","reset"].contains(action), reason.utf16.count <= 500 else {
            throw NativeHealthWorkspaceError.invalid("请先读取完整记录，再选择操作；说明最多500字。")
        }
        var body: [String:NativeJSON] = ["action":.string(action),"expectedRevision":.number(Double(revision)),
            "expectedBaseExportedAt":record["base"]["exportedAt"],"reason":.string(reason.trimmingCharacters(in:.whitespacesAndNewlines))]
        if action == "correct" {
            let text = value.trimmingCharacters(in:.whitespacesAndNewlines)
            guard text.range(of:#"^\d+(?:\.\d+)?$"#,options:.regularExpression) != nil,
                  let number = Double(text), number.isFinite,
                  let metric = QuickEntryMetric(rawValue:record["metric"].stringValue ?? ""), metric.acceptedRange.contains(number),
                  metric != .steps || number.rounded() == number else { throw NativeHealthWorkspaceError.invalid("请核对本指标的有效数值与单位，未知不能填0。") }
            body["value"] = .number(number)
        }
        return .init(path:"health/records/" + NativeHealthWorkspaceFormat.encodedSegment(key),method:"PATCH",body:.object(body),label:actionLabel(action) + " · " + (record["day"].stringValue ?? ""))
    }
    static func actionLabel(_ action: String) -> String { ["create":"补录","correct":"更正数值","hide":"屏蔽记录","restore":"恢复显示","reset":"恢复最新同步值"][action] ?? action }
}

struct NativeHealthRecordsWorkspace: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @State private var from = NativeActionDates.calendar.date(byAdding:.day,value:-29,to:Date())!
    @State private var to = Date()
    @State private var metric = "all"
    @State private var includeDeleted = false
    @State private var records: [NativeJSON] = []
    @State private var cursor: String?
    @State private var loadedQuery = ""
    @State private var selected: NativeJSON = .null
    @State private var changes: [NativeJSON] = []
    @State private var action = "correct"
    @State private var value = ""
    @State private var reason = ""
    @State private var conflict = false
    @State private var pending: NativeHealthWorkspaceMutation?
    @State private var pendingSelection: NativeJSON = .null
    @State private var switching = false
    @State private var confirming = false
    @State private var quickEntry = false
    @State private var busy = false
    @State private var loaded = false
    @State private var draftReady = false
    @State private var message: String?
    private var store: NativeHealthWorkspaceMutationStore { .init(userID:userID,scope:"records") }
    private var draftStore: NativeWorkspacePersistence { .init(userID:userID,scope:"health-record-form") }
    private var signature: String { NativeActionDates.day(from) + NativeActionDates.day(to) + metric + String(includeDeleted) }
    private var dirty: Bool { !reason.isEmpty || (selected["recordKey"].stringValue != nil && value != (selected["effective"]["value"].doubleValue.map { String($0) } ?? "")) || action != "correct" }
    private var draftSignature: String { (selected["recordKey"].stringValue ?? "") + action + value + reason }
    var body: some View {
        List {
            Section("筛选原始健康指标") {
                DatePicker("开始",selection:$from,in:...Date(),displayedComponents:.date)
                DatePicker("结束",selection:$to,in:...Date(),displayedComponents:.date)
                Picker("指标",selection:$metric) {
                    Text("全部").tag("all")
                    ForEach(NativeHealthWorkspaceFormat.metricKeys,id:\.self) { Text(NativeHealthWorkspaceFormat.metric($0)).tag($0) }
                }
                Toggle("包含已屏蔽",isOn:$includeDeleted)
                Button("读取记录") { Task { await load(more:false) } }.disabled(busy)
                Button("补录一条健康数据") { quickEntry = true }.disabled(busy || pending != nil)
            }.disabled(busy)
            if let pending {
                Section("待确认的原修改") {
                    Text(pending.label)
                    Text("原数值、同步版本、修改版本与请求标识已安全保存；不更换请求内容。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("继续确认原操作") { Task { await submit(pending) } }.disabled(busy)
                }
            }
            Section("记录列表") {
                if loadedQuery != signature { Text("筛选已变化，请读取后查看对应记录。") }
                ForEach(Array(records.enumerated()),id:\.offset) { _,record in
                    Button {
                        if dirty { pendingSelection = record; switching = true } else { Task { await read(record,keepDraft:false) } }
                    } label: {
                        VStack(alignment:.leading,spacing:6) {
                            LabeledContent((record["day"].stringValue ?? "") + " · " + NativeHealthWorkspaceFormat.metric(record["metric"].stringValue ?? ""),value:NativeHealthWorkspaceFormat.text(record["effective"]["value"]))
                            Text(origin(record) + (record["deleted"].boolValue == true ? " · 已屏蔽":"")).font(.caption).foregroundStyle(.secondary)
                        }
                    }.disabled(busy || pending != nil || loadedQuery != signature)
                }
                if records.isEmpty && loaded { Text("当前已读取范围没有记录，缺失不表示0。") }
                if cursor != nil { Button("读取更多记录") { Task { await load(more:true) } }.disabled(busy || loadedQuery != signature) }
            }
            if selected["recordKey"].stringValue != nil { selectedSections }
            if busy { ProgressView("正在核对记录…") }
            NativeHealthWorkspaceMessage(message:message)
        }.navigationTitle("健康记录管理")
            .environment(\.timeZone,NativeActionDates.timeZone)
            .task {
                do {
                    pending = try store.load(); loaded = true
                    if let draft = try draftStore.load(NativeHealthWorkspaceFormDraft.self) {
                        selected = draft.snapshot; value = draft.fields["value"] ?? ""; reason = draft.fields["reason"] ?? ""
                        action = draft.fields["action"] ?? "correct"; conflict = true
                        message = "已恢复本机未提交的填写。请读取最新记录并核对后再保存。"
                    }
                    draftReady = true
                } catch { message = error.localizedDescription }
                await load(more:false)
            }
            .onChange(of:draftSignature) { _,_ in saveDraft() }
            .onDisappear { saveDraft() }
            .sheet(isPresented:$quickEntry) { HealthQuickEntryView(api:api,token:token,userID:userID) { await load(more:false) } }
            .confirmationDialog("确认这次健康记录修改？",isPresented:$confirming,titleVisibility:.visible) {
                Button(NativeHealthRecordRequest.actionLabel(action),role:action == "hide" ? .destructive:nil) { Task { await prepare() } }
                Button("取消",role:.cancel) { }
            } message: { Text(impactText + (action == "correct" ? " 新值：" + value:"")) }
            .confirmationDialog("放弃未保存填写并切换记录？",isPresented:$switching,titleVisibility:.visible) {
                Button("放弃填写并切换",role:.destructive) { Task { await read(pendingSelection,keepDraft:false) } }
                Button("继续填写",role:.cancel) { }
            }
    }
    @ViewBuilder private var selectedSections: some View {
        Section("已选记录 · " + (selected["day"].stringValue ?? "")) {
            LabeledContent("指标",value:NativeHealthWorkspaceFormat.metric(selected["metric"].stringValue ?? ""))
            LabeledContent("当前有效值",value:NativeHealthWorkspaceFormat.text(selected["effective"]["value"]) + " " + NativeHealthWorkspaceFormat.unit(selected["metric"].stringValue ?? ""))
            Text(origin(selected))
            Text(selected["effective"]["source"].stringValue ?? "来源未知").font(.caption)
            Text((selected["effective"]["startDate"].stringValue ?? "") + " " + (selected["effective"]["endDate"].stringValue ?? "")).font(.caption)
            LabeledContent("修改版本",value:NativeHealthWorkspaceFormat.text(selected["revision"]))
            if selected["base"]["measurement"]["value"].doubleValue != nil {
                LabeledContent("最新同步原值",value:NativeHealthWorkspaceFormat.text(selected["base"]["measurement"]["value"]))
                Text("原值来源：" + (selected["base"]["measurement"]["source"].stringValue ?? "未知")).font(.caption)
                Text("原值导出：" + (selected["base"]["exportedAt"].stringValue ?? "未知")).font(.caption)
            }
            if selected["override"]["value"].doubleValue != nil { LabeledContent("人工覆盖值",value:NativeHealthWorkspaceFormat.text(selected["override"]["value"])) }
            Button("读取最新记录，保留当前填写") { Task { await read(selected,keepDraft:true) } }.disabled(busy || pending != nil)
        }
        Section("主动修改与影响") {
            Picker("操作",selection:$action) {
                Text("更正数值").tag("correct")
                Text(selected["deleted"].boolValue == true ? "恢复显示":"屏蔽记录").tag(selected["deleted"].boolValue == true ? "restore":"hide")
                if selected["base"]["exportedAt"].stringValue != nil { Text("恢复最新同步值").tag("reset") }
            }
            if action == "correct" { TextField("核对后的值",text:$value).keyboardType(.decimalPad) }
            TextField("修改原因（可选，最多500字）",text:$reason,axis:.vertical)
            Text(impactText).font(.footnote).foregroundStyle(.secondary)
            if conflict { Text("记录或原同步值已经变化。请先读取最新记录，再核对保留的填写。") }
            Button("核对并确认修改") { confirming = true }.disabled(busy || pending != nil || conflict || !loaded || !draftReady)
        }.disabled(busy || pending != nil)
        Section("修改历史") {
            Button("读取此记录的修改历史") { Task { await loadHistory() } }.disabled(busy)
            ForEach(Array(changes.enumerated()),id:\.offset) { _,change in
                DisclosureGroup((change["createdAt"].stringValue ?? "") + " · " + NativeHealthRecordRequest.actionLabel(change["action"].stringValue ?? "")) {
                    LabeledContent("之前有效值",value:NativeHealthWorkspaceFormat.text(change["before"]["effective"]["value"]))
                    LabeledContent("之后有效值",value:NativeHealthWorkspaceFormat.text(change["after"]["effective"]["value"]))
                    Text("之前：" + (change["before"]["deleted"].boolValue == true ? "已屏蔽":"显示") + " · 之后：" + (change["after"]["deleted"].boolValue == true ? "已屏蔽":"显示"))
                    Text(change["reason"].stringValue ?? "无说明")
                    Text("修改前同步原值：" + NativeHealthWorkspaceFormat.text(change["before"]["base"]["measurement"]["value"]) + "；修改后同步原值：" + NativeHealthWorkspaceFormat.text(change["after"]["base"]["measurement"]["value"]))
                        .font(.caption)
                }
            }
        }
    }
    private var impactText: String {
        switch action {
        case "hide": return "这条记录将从健康图表、目标与回顾中排除；原值与修改历史仍保留，可恢复。"
        case "restore": return "重新计入当前有效记录；人工覆盖若存在仍优先于同步原值。"
        case "reset": return "清除人工覆盖与屏蔽状态，重新采用最新同步原值；后续同步会继续更新原值。"
        default: return "人工更正覆盖展示与回顾中的有效值；原同步值与历史保留，后续同步不会悄悄覆盖人工更正。"
        }
    }
    private func origin(_ record: NativeJSON) -> String {
        if record["manual"].boolValue == true { return "人工补录" }
        if case .object = record["override"] { return "人工覆盖 · 原同步值保留" }
        return "同步记录"
    }
    private func load(more: Bool) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            guard NativeActionDates.day(from) <= NativeActionDates.day(to),NativeActionDates.day(from) >= "1970-01-01" else { throw NativeHealthWorkspaceError.invalid("请核对起止日期。") }
            var query = [URLQueryItem(name:"from",value:NativeActionDates.day(from)),URLQueryItem(name:"to",value:NativeActionDates.day(to)),URLQueryItem(name:"metric",value:metric),URLQueryItem(name:"includeDeleted",value:includeDeleted ? "1":"0"),URLQueryItem(name:"limit",value:"100")]
            if more,let cursor { query.append(URLQueryItem(name:"cursor",value:cursor)) }
            let result = try await api.json(path:NativeHealthWorkspaceFormat.path("health/records",query:query),token:token)
            if more { records += result["records"].arrayValue } else { records = result["records"].arrayValue }
            cursor = result["nextCursor"].stringValue; loadedQuery = signature; message = nil
        } catch { message = error.localizedDescription }
    }
    private func read(_ record: NativeJSON, keepDraft: Bool) async {
        guard !busy,let key = record["recordKey"].stringValue else { return }; busy = true; defer { busy = false }
        do {
            let result = try await api.json(path:"health/records/" + NativeHealthWorkspaceFormat.encodedSegment(key),token:token)
            guard result["record"]["recordKey"].stringValue == key else { throw NativeAPIError.invalidResponse }
            selected = result["record"]; conflict = false; changes = []
            if !keepDraft { value = selected["effective"]["value"].doubleValue.map { String($0) } ?? ""; reason = ""; action = "correct" }
            message = keepDraft ? "已读取最新记录，原填写仍保留，请核对后再保存。":nil
        } catch { message = error.localizedDescription }
    }
    private func loadHistory() async {
        guard !busy,let key = selected["recordKey"].stringValue else { return }; busy = true; defer { busy = false }
        do { changes = try await api.json(path:"health/records/" + NativeHealthWorkspaceFormat.encodedSegment(key) + "/history",token:token)["history"].arrayValue }
        catch { message = error.localizedDescription }
    }
    private func prepare() async {
        do { let operation = try NativeHealthRecordRequest.operation(record:selected,action:action,value:value,reason:reason); try store.save(operation); pending = operation; await submit(operation) }
        catch { message = error.localizedDescription }
    }
    private func saveDraft() {
        guard draftReady,pending == nil else { return }
        do {
            if selected["recordKey"].stringValue != nil && dirty {
                try draftStore.save(NativeHealthWorkspaceFormDraft(fields:["value":value,"reason":reason,"action":action],dates:[:],snapshot:selected))
            } else { try draftStore.clear() }
        } catch { message = error.localizedDescription }
    }
    private func submit(_ operation: NativeHealthWorkspaceMutation) async {
        guard !busy else { return }; busy = true; message = nil
        do {
            let result = try await operation.send(api:api,token:token)
            guard result["record"]["recordKey"].stringValue != nil else { throw NativeAPIError.invalidResponse }
            try store.clear(); try draftStore.clear(); pending = nil; selected = result["record"]; value = selected["effective"]["value"].doubleValue.map { String($0) } ?? ""; reason = ""; action = "correct"; conflict = false; changes = []
            busy = false; await load(more:false); message = "修改已确认保存。"
        } catch {
            message = error.localizedDescription
            if NativeHealthWorkspaceFormat.definiteRejection(error) {
                do { try store.clear(); pending = nil; conflict = true } catch { message = error.localizedDescription }
            } else { message = (message ?? "") + " 原操作待确认，请继续核对原请求。" }
        }
        busy = false
    }
}
