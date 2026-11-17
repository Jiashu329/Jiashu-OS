import SwiftUI
import UniformTypeIdentifiers

enum NativeHealthFileImport {
    static func decode(_ data: Data) throws -> NativeJSON {
        guard !data.isEmpty, data.count <= 512 * 1024 else { throw NativeHealthWorkspaceError.invalid("请选择不超过512 KB的健康 JSON 文件。") }
        let payload = try JSONDecoder().decode(NativeJSON.self,from:data)
        guard payload["version"].intValue == 1, payload["source"].stringValue == "apple-health-shortcuts",
              payload["timezone"].stringValue == "Asia/Shanghai", payload["exportedAt"].stringValue.flatMap(NativeDates.parse) != nil,
              case .array(let rows) = payload["measurements"], rows.count <= 1000 else {
            throw NativeHealthWorkspaceError.invalid("文件不符合本站健康同步格式。请使用本站健康 JSON 导出文件；记录将由服务器进一步校验。")
        }
        return payload
    }
    static func operation(payload: NativeJSON, preview: NativeJSON, confirmSources: Bool) throws -> NativeHealthWorkspaceMutation {
        guard let token = preview["token"].stringValue, !token.isEmpty,
              let sourceChanges = preview["sourceChanges"].intValue,
              sourceChanges == 0 || confirmSources else { throw NativeHealthWorkspaceError.invalid("请先完成服务器预览，并明确核对来源变化。") }
        var headers = ["X-Import-Preview":token]
        if confirmSources { headers["X-Confirm-Source-Changes"] = "true" }
        return NativeHealthWorkspaceMutation(path:"health/import",method:"POST",body:payload,headers:headers,label:"导入已预览的健康文件")
    }
}

struct NativeHealthSyncWorkspace: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @State private var status: NativeJSON = .null
    @State private var history: NativeJSON = .null
    @State private var channel: NativeHealthChannel?
    @State private var payload: NativeJSON = .null
    @State private var preview: NativeJSON = .null
    @State private var receipt: NativeJSON = .null
    @State private var pending: NativeHealthWorkspaceMutation?
    @State private var selectedBatch: NativeJSON = .null
    @State private var fileName = ""
    @State private var reason = ""
    @State private var sourceConfirmed = false
    @State private var filePicker = false
    @State private var confirming = false
    @State private var confirmationKind = "import"
    @State private var busy = false
    @State private var loaded = false
    @State private var draftReady = false
    @State private var message: String?
    private var store: NativeHealthWorkspaceMutationStore { .init(userID:userID,scope:"sync") }
    private var draftStore: NativeWorkspacePersistence { .init(userID:userID,scope:"health-file-import-form") }
    private var fileImportAllowed: Bool { loaded && channel?.hasActiveChannel == false && pending == nil }

    var body: some View {
        List {
            channelSection
            pendingSection
            coverageSection
            importSection
            receiptSection
            attemptsSection
            batchesSection
            revertSection
            if busy { ProgressView("正在核对…") }
            NativeHealthWorkspaceMessage(message:message)
        }.navigationTitle("同步与导入")
            .task {
                do {
                    pending = try store.load()
                    if let draft = try draftStore.load(NativeHealthWorkspaceFormDraft.self) {
                        payload = draft.snapshot["payload"]; selectedBatch = draft.snapshot["batch"]
                        fileName = draft.fields["filename"] ?? ""; reason = draft.fields["reason"] ?? ""
                        preview = .null; sourceConfirmed = false
                        message = "已恢复未提交的文件或回退填写。导入前需要重新预览当前影响。"
                    }
                    loaded = true; draftReady = true
                } catch { message = error.localizedDescription }
                await load()
            }
            .onChange(of:reason) { _,_ in saveDraft() }
            .onChange(of:selectedBatch) { _,_ in saveDraft() }
            .onDisappear { saveDraft() }
            .fileImporter(isPresented:$filePicker,allowedContentTypes:[.json],allowsMultipleSelection:false) { result in
                do {
                    guard let url = try result.get().first else { throw NativeHealthWorkspaceError.invalid("未选择文件。") }
                    let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? Int.max
                    guard size <= 512 * 1024 else { throw NativeHealthWorkspaceError.invalid("文件不能超过512 KB。") }
                    payload = try NativeHealthFileImport.decode(Data(contentsOf:url)); fileName = url.lastPathComponent
                    preview = .null; sourceConfirmed = false; message = nil; saveDraft()
                } catch { message = error.localizedDescription }
            }
            .confirmationDialog(confirmationKind == "revert" ? "回退所选整批导入？":"导入这份已预览的健康记录？",isPresented:$confirming,titleVisibility:.visible) {
                Button(confirmationKind == "revert" ? "确认回退":"确认导入",role:confirmationKind == "revert" ? .destructive:nil) { Task { await prepare() } }
                Button("取消",role:.cancel) { }
            } message: { Text(confirmationKind == "revert" ? "操作会恢复此批次导入前的原始同步值，保留人工修改与操作历史。":"只提交刚才预览的原文件；原日期、来源与未知值均保留。") }
    }
    private var channelSection: some View {
            Section("当前同步通道") {
                if let channel {
                    Text(channelDescription(channel))
                    if channel.hasActiveChannel { Text("账号已选择设备通道，手动导入暂停。请从主健康页使用选定设备同步，或明确解除原通道后再导入。") }
                } else { Text("尚未读取通道状态，文件导入不可用。") }
                Button("刷新通道、覆盖与回执") { Task { await load() } }.disabled(busy)
            }
    }
    @ViewBuilder private var pendingSection: some View {
            if let pending {
                Section("待确认的原操作") {
                    Text(pending.label)
                    Text("原文件、预览标识、说明和请求标识已安全保存在本机。继续核对会发送完全相同的请求。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("继续确认原操作") { Task { await submit(pending) } }.disabled(busy)
                }
            }
    }
    private var coverageSection: some View {
            Section("逐指标覆盖与新鲜度") {
                ForEach(Array(status["metrics"].arrayValue.enumerated()),id:\.offset) { _,metric in
                    VStack(alignment:.leading,spacing:5) {
                        LabeledContent(metric["label"].stringValue ?? "指标",value:freshness(metric["freshness"].stringValue))
                        Text(coverageDescription(metric))
                            .font(.caption).foregroundStyle(.secondary)
                        if let received = metric["lastImport"]["receivedAt"].stringValue { Text("最近接收：" + received).font(.caption2) }
                    }
                }
                Text("新鲜度以实际记录日期计算，空导入或其他指标更新不会使本指标显示为最新。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
    }
    private var importSection: some View {
            Section("健康 JSON 文件导入") {
                Button("选择健康 JSON 文件") { filePicker = true }.disabled(busy || !fileImportAllowed)
                if !fileName.isEmpty { Text(fileName).font(.caption) }
                if case .object = payload {
                    LabeledContent("原导出时间",value:payload["exportedAt"].stringValue ?? "未知")
                    LabeledContent("原始记录数量",value:String(payload["measurements"].arrayValue.count))
                    Button("向服务器预览本文件影响") { Task { await previewFile() } }.disabled(busy || !fileImportAllowed)
                }
                if preview["token"].stringValue != nil {
                    previewDetails
                    if (preview["sourceChanges"].intValue ?? 0) > 0 { Toggle("已核对并同意这些来源替换",isOn:$sourceConfirmed).disabled(busy || pending != nil) }
                    Button("确认导入已预览文件") { confirmationKind = "import"; confirming = true }
                        .disabled(busy || !fileImportAllowed || ((preview["sourceChanges"].intValue ?? 0) > 0 && !sourceConfirmed))
                }
            }
    }
    @ViewBuilder private var receiptSection: some View {
            if receipt["ok"].boolValue == true {
                Section("本次操作回执") {
                    if let value = receipt["imported"].intValue { LabeledContent("实际导入",value:String(value)) }
                    if let value = receipt["skipped"].intValue { LabeledContent("跳过",value:String(value)) }
                    if let value = receipt["revertedAt"].stringValue { LabeledContent("回退时间",value:value) }
                    if let value = receipt["message"].stringValue { Text(value) }
                    if receipt["replayed"].boolValue == true { Text("已核对原操作回执，没有创建第二个批次。") }
                }
            }
    }
    private var attemptsSection: some View {
            Section("最近同步尝试") {
                ForEach(Array(history["attempts"].arrayValue.enumerated()),id:\.offset) { _,attempt in
                    DisclosureGroup(attemptTitle(attempt)) {
                        Text(attemptDevice(attempt))
                        if let guidance = attempt["guidance"].stringValue { Text(guidance) }
                        if let code = attempt["errorCode"].stringValue { Text(code).font(.caption) }
                        ForEach(Array(attempt["summary"]["metrics"].arrayValue.enumerated()),id:\.offset) { _,metric in
                            Text(attemptMetricDescription(metric))
                        }
                    }
                }
            }
    }
    private var batchesSection: some View {
            Section("导入批次与回退") {
                ForEach(Array(history["batches"].arrayValue.enumerated()),id:\.offset) { _,batch in
                    VStack(alignment:.leading,spacing:7) {
                        Text(batch["createdAt"].stringValue ?? "未知时间").font(.headline)
                        Text(batchDescription(batch))
                        if let reverted = batch["revertedAt"].stringValue {
                            Text("已回退：" + reverted).font(.caption)
                            Text(batch["revertReason"].stringValue ?? "").font(.caption)
                        } else if batch["canRevert"].boolValue == true {
                            Button("查看并填写整批回退原因",role:.destructive) { selectedBatch = batch; reason = "" }.disabled(busy || pending != nil)
                        }
                    }
                }
                Text("回退只恢复原同步数据并保留审计。有后续同步或影响人工修改时服务器会整批拒绝，需到记录管理逐条核对。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
    }
    @ViewBuilder private var revertSection: some View {
            if let id = selectedBatch["batchId"].stringValue {
                Section("核对选中批次") {
                    Text(selectedBatch["createdAt"].stringValue ?? "").font(.headline)
                    Text(selectedBatchImpact)
                    TextField("回退原因（1–500字）",text:$reason,axis:.vertical).disabled(busy || pending != nil)
                    Button("确认回退整批",role:.destructive) { confirmationKind = "revert"; confirming = true }.disabled(busy || pending != nil || reason.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || id.count != 64)
                    Button("取消选中批次") { selectedBatch = .null }.disabled(busy || pending != nil)
                }
            }
    }
    @ViewBuilder private var previewDetails: some View {
        let from: String = preview["from"].stringValue ?? "空"
        let to: String = preview["to"].stringValue ?? "空"
        let range: String = "\(from) — \(to)"
        LabeledContent("记录范围",value:range)
        ForEach(["total","added","updated","skipped","sourceChanges","manualOverrides"],id:\.self) { key in previewCountRow(key) }
        ForEach(Array(preview["examples"].arrayValue.enumerated()),id:\.offset) { _,row in previewExampleRow(row) }
    }
    private func previewCountRow(_ key: String) -> some View {
        let labels: [String:String] = ["total":"总条数","added":"新增","updated":"更新","skipped":"跳过","sourceChanges":"来源变化","manualOverrides":"人工覆盖保留"]
        let title: String = labels[key] ?? key
        let value: String = NativeHealthWorkspaceFormat.text(preview[key])
        return LabeledContent(title,value:value)
    }
    private func previewExampleRow(_ row: NativeJSON) -> some View {
        let day: String = row["day"].stringValue ?? ""
        let metric: String = NativeHealthWorkspaceFormat.metric(row["metric"].stringValue ?? "")
        let action: String = row["action"].stringValue ?? ""
        let title: String = "\(day) · \(metric) · \(action)"
        let before: String = NativeHealthWorkspaceFormat.text(row["before"])
        let after: String = NativeHealthWorkspaceFormat.text(row["after"])
        let oldSource: String = row["oldSource"].stringValue ?? "无来源"
        let newSource: String = row["newSource"].stringValue ?? "无来源"
        let sourceChange: String = "\(oldSource) → \(newSource)"
        let reason: String = row["reason"].stringValue ?? ""
        return DisclosureGroup(title) {
            LabeledContent("原值",value:before)
            LabeledContent("新值",value:after)
            Text(sourceChange)
            Text(reason).font(.caption)
            if row["manualOverride"].boolValue == true { Text("人工覆盖继续生效，页面展示值不直接改为同步原值。") }
        }
    }
    private func channelDescription(_ channel: NativeHealthChannel) -> String {
        guard channel.hasActiveChannel else { return "未选择专用 Apple 健康通道，可手动导入文件。" }
        let label: String = channel.label ?? "Apple 健康设备"
        return "已选择：\(label)"
    }
    private func coverageDescription(_ metric: NativeJSON) -> String {
        let day: String = metric["latestDay"].stringValue ?? "无"
        let week: String = NativeHealthWorkspaceFormat.text(metric["observedDays7"])
        let month: String = NativeHealthWorkspaceFormat.text(metric["observedDays30"])
        return "最近记录：\(day) · 7天覆盖 \(week) · 30天覆盖 \(month)"
    }
    private func attemptTitle(_ attempt: NativeJSON) -> String {
        let date: String = attempt["createdAt"].stringValue ?? ""
        let status: String = outcome(attempt["status"].stringValue)
        return "\(date) · \(status)"
    }
    private func attemptDevice(_ attempt: NativeJSON) -> String {
        if let label = attempt["deviceLabel"].stringValue { return label }
        return attempt["channel"].stringValue == "manual" ? "手动文件":"设备"
    }
    private func attemptMetricDescription(_ metric: NativeJSON) -> String {
        let name: String = NativeHealthWorkspaceFormat.metric(metric["metric"].stringValue ?? "")
        let received: String = NativeHealthWorkspaceFormat.text(metric["received"])
        let added: String = NativeHealthWorkspaceFormat.text(metric["added"])
        let updated: String = NativeHealthWorkspaceFormat.text(metric["updated"])
        let unchanged: String = NativeHealthWorkspaceFormat.text(metric["unchanged"])
        let older: String = NativeHealthWorkspaceFormat.text(metric["older"])
        return "\(name)：接收 \(received)，新增 \(added)，更新 \(updated)，未变 \(unchanged)，旧值跳过 \(older)"
    }
    private func batchDescription(_ batch: NativeJSON) -> String {
        let imported: String = NativeHealthWorkspaceFormat.text(batch["imported"])
        let skipped: String = NativeHealthWorkspaceFormat.text(batch["skipped"])
        return "导入 \(imported) · 跳过 \(skipped)"
    }
    private var selectedBatchImpact: String {
        let count: String = NativeHealthWorkspaceFormat.text(selectedBatch["imported"])
        return "导入 \(count) 条，回退会影响这次原始同步记录。"
    }
    private func freshness(_ value: String?) -> String { ["current":"最近有记录","stale":"记录较旧","missing":"缺少记录"][value ?? ""] ?? "未知" }
    private func outcome(_ value: String?) -> String { ["recorded":"已记录","imported":"已导入","failed":"失败","empty":"没有可用记录","replayed":"原回执","reverted":"已回退","unchanged":"无变化"][value ?? ""] ?? (value ?? "未知") }
    private func load() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            async let coverage = api.json(path:"sync/status",token:token)
            async let imports = api.json(path:"health/import",token:token)
            async let policy = api.channel(token:token)
            let result = try await (coverage,imports,policy)
            status = result.0; history = result.1; channel = result.2
        } catch { message = error.localizedDescription }
    }
    private func previewFile() async {
        guard !busy,fileImportAllowed else { return }; busy = true; message = nil; defer { busy = false }
        do { preview = try await api.json(path:"health/import/preview",method:"POST",token:token,body:payload)["preview"]; sourceConfirmed = false }
        catch { preview = .null; message = error.localizedDescription }
    }
    private func prepare() async {
        guard pending == nil,!busy else { return }
        do {
            let operation: NativeHealthWorkspaceMutation
            if confirmationKind == "revert",let id = selectedBatch["batchId"].stringValue {
                let trimmed = reason.trimmingCharacters(in:.whitespacesAndNewlines)
                guard (1...500).contains(trimmed.utf16.count),id.count == 64 else { throw NativeHealthWorkspaceError.invalid("请填写1–500字原因并核对批次。") }
                operation = .init(path:"health/import/" + id + "/revert",method:"POST",body:.object(["reason":.string(trimmed)]),label:"回退 " + (selectedBatch["createdAt"].stringValue ?? "所选批次"))
            } else {
                guard fileImportAllowed else { throw NativeHealthWorkspaceError.invalid("当前设备同步通道启用，不能通过手动文件导入。") }
                operation = try NativeHealthFileImport.operation(payload:payload,preview:preview,confirmSources:sourceConfirmed)
            }
            try store.save(operation); pending = operation; await submit(operation)
        } catch { message = error.localizedDescription }
    }
    private func saveDraft() {
        guard draftReady,pending == nil else { return }
        do {
            if payload != .null || selectedBatch != .null {
                try draftStore.save(NativeHealthWorkspaceFormDraft(fields:["filename":fileName,"reason":reason],dates:[:],snapshot:.object(["payload":payload,"batch":selectedBatch])))
            } else { try draftStore.clear() }
        } catch { message = error.localizedDescription }
    }
    private func submit(_ operation: NativeHealthWorkspaceMutation) async {
        guard !busy else { return }; busy = true; message = nil
        do {
            let result = try await operation.send(api:api,token:token)
            guard result["ok"].boolValue == true else { throw NativeAPIError.invalidResponse }
            try store.clear(); try draftStore.clear(); pending = nil; receipt = result; preview = .null; payload = .null; selectedBatch = .null
            busy = false; await load()
        } catch {
            message = error.localizedDescription
            if NativeHealthWorkspaceFormat.definiteRejection(error) {
                do { try store.clear(); pending = nil; preview = .null } catch { message = error.localizedDescription }
            } else { message = (message ?? "") + " 原操作仍待确认，请继续核对原请求。" }
        }
        busy = false
    }
}
