import SwiftUI
import UniformTypeIdentifiers

private struct NativeBackupReceipt: Codable {
    let generatedAt: String
    let format: String
    let files: Int
    let rows: Int
    var confirmedAt: String?
}

@MainActor
final class NativeBackupWorkspace: ObservableObject {
    @Published private(set) var summary: NativeBackupSummary?
    @Published private(set) var preview: NativeJSON = .null
    @Published private(set) var result: NativeJSON = .null
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var pendingRestore = false
    @Published private(set) var exports: [URL] = []
    @Published private(set) var receiptText: String?
    private let api: NativeAPI
    private let token: String
    private let userID: String
    private var backup: Data?
    private var generation = UUID()
    private var receipt: NativeBackupReceipt?
    private var persistence: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: userID, scope: "backup.restore") }
    private var receiptStore: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: userID, scope: "backup.export-receipt") }

    init(api: NativeAPI, token: String, userID: String) { self.api = api; self.token = token; self.userID = userID }
    func open() {
        generation = UUID(); busy = false
        do {
            if let receipt = try receiptStore.load(NativeBackupReceipt.self) { self.receipt = receipt; describeReceipt() }
            guard backup == nil, let data = try persistence.loadData() else { return }
            guard let raw = try NativeBackupCodec.value("backup", in: data) else { throw NativeBackupError.invalid }
            backup = raw; summary = try NativeBackupCodec.inspect(raw)
            let meta = try JSONDecoder().decode(NativeJSON.self, from: data)
            preview = meta["preview"]; pendingRestore = meta["stage"].stringValue == "restore"
        } catch { self.error = error.localizedDescription }
    }
    func close() { generation = UUID(); busy = false; clearExports() }
    func clearExports() {
        let folders = Set(exports.map { $0.deletingLastPathComponent() })
        for folder in folders { try? FileManager.default.removeItem(at: folder) }
        exports = []
    }
    func select(_ urls: [URL]) {
        guard !busy, !pendingRestore else { return }
        do {
            guard !urls.isEmpty, urls.count <= 9 else { throw NativeBackupError.invalid }
            var files: [NativeBackupFile] = []; var total = 0
            for url in urls {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                guard values.isRegularFile == true, let size = values.fileSize, size <= NativeBackupCodec.groupLimit,
                      total + size <= NativeBackupCodec.groupLimit else { throw NativeBackupError.tooLarge }
                let data = try Data(contentsOf: url); total += data.count
                files.append(NativeBackupFile(name: url.lastPathComponent, data: data))
            }
            let raw = try NativeBackupCodec.assemble(files)
            let inspected = try NativeBackupCodec.inspect(raw)
            backup = raw; summary = inspected; preview = .null; result = .null; error = nil
            try persist(stage: "selected")
        } catch { self.error = error.localizedDescription }
    }
    private func persist(stage: String) throws {
        guard let backup else { return }
        var data = Data("{\"backup\":".utf8); data.append(backup)
        data.append(Data((",\"stage\":\"" + stage + "\",\"preview\":").utf8))
        data.append(try preview.encodedData()); data.append(125)
        try persistence.saveData(data)
    }
    func discard() {
        guard !busy else { return }
        do {
            try persistence.clear(); backup = nil; summary = nil; preview = .null; result = .null
            pendingRestore = false; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func previewRestore() async {
        guard !busy, let backup else { return }
        let epoch = generation; busy = true; error = nil
        defer { if generation == epoch { busy = false } }
        do {
            let body = try NativeBackupCodec.request(action: "preview", backup: backup)
            let value = try await api.upload(path: "data/backup", token: token, data: body)
            guard generation == epoch else { return }
            preview = value; pendingRestore = false; try persist(stage: "preview")
        } catch { if generation == epoch { self.error = error.localizedDescription } }
    }
    func restore() async {
        guard !busy, let backup, preview["canRestore"].boolValue == true,
              let hash = preview["previewHash"].stringValue else { return }
        let epoch = generation; busy = true; error = nil
        defer { if generation == epoch { busy = false } }
        do {
            let body = try NativeBackupCodec.request(action: "restore", backup: backup, previewHash: hash)
            pendingRestore = true; try persist(stage: "restore")
            let value = try await api.upload(path: "data/backup", token: token, data: body)
            guard generation == epoch else { return }
            result = value; try persistence.clear(); self.backup = nil; summary = nil; preview = .null; pendingRestore = false
        } catch { if generation == epoch { self.error = error.localizedDescription } }
    }
    func export(volumes: Bool) async {
        guard !busy else { return }
        let epoch = generation; busy = true; error = nil
        defer { if generation == epoch { busy = false } }
        do {
            let response = try await api.download(path: volumes ? "data/backup?format=volumes" : "data/backup", token: token)
            guard generation == epoch else { return }
            let summary = try NativeBackupCodec.inspect(response.data)
            let files = try NativeBackupCodec.split(response.data)
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("jiashu-backup-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            var urls: [URL] = []
            do {
                for file in files {
                    let url = directory.appendingPathComponent(file.name)
                    try file.data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                    urls.append(url)
                }
            } catch { try? FileManager.default.removeItem(at: directory); throw error }
            clearExports(); exports = urls
            receipt = NativeBackupReceipt(generatedAt: NativeHealthCalendar.timestamp(Date()), format: summary.format,
                                          files: files.count, rows: summary.rows, confirmedAt: nil)
            if let receipt { try receiptStore.save(receipt) }; describeReceipt()
        } catch { if generation == epoch { self.error = error.localizedDescription } }
    }
    func confirmSaved() {
        guard var receipt, !exports.isEmpty else { return }
        do { receipt.confirmedAt = NativeHealthCalendar.timestamp(Date()); try receiptStore.save(receipt); self.receipt = receipt; describeReceipt() }
        catch { self.error = error.localizedDescription }
    }
    private func describeReceipt() {
        guard let receipt else { return }
        receiptText = "生成于 " + NativeWorkspaceFormat.timestamp(receipt.generatedAt) + "，共 \(receipt.files) 个文件、\(receipt.rows) 行。"
            + (receipt.confirmedAt == nil ? "尚未确认妥善保存。" : "本人已确认妥善保存。")
    }
}

struct NativeBackupView: View {
    private enum Mode: String { case backup, restore }
    @StateObject private var state: NativeBackupWorkspace
    @State private var mode: Mode = .backup
    @State private var choosing = false
    @State private var confirmRestore = false
    @State private var confirmDiscard = false
    @State private var confirmRepreview = false
    init(api: NativeAPI, token: String, userID: String) { _state = StateObject(wrappedValue: NativeBackupWorkspace(api: api, token: token, userID: userID)) }
    var body: some View {
        Form {
            Section {
                Picker("操作", selection: $mode) { Text("备份").tag(Mode.backup); Text("恢复").tag(Mode.restore) }.pickerStyle(.segmented)
            }
            NativeFeatureFeedback(busy: state.busy, error: state.error)
            if mode == .backup { Section("备份数据") {
                Button("备份我的数据", systemImage: "externaldrive") { Task { await state.export(volumes: true) } }
                if !state.exports.isEmpty {
                    ShareLink(items: state.exports) { Label("保存全部备份文件", systemImage: "square.and.arrow.up") }
                    Button("我已保存全部文件") { state.confirmSaved() }
                }
                if let text = state.receiptText { Text(text).font(.footnote).foregroundStyle(.secondary) }
                DisclosureGroup("格式与范围") {
                    Button("仅生成单文件") { Task { await state.export(volumes: false) } }
                    Text("完整备份含清单及全部分卷。健康、饮食、菜谱与成品照、财务和书影音记录包含在内，登录凭据与服务密钥不包含。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } }
            if mode == .restore {
            Section("恢复备份") {
                Text(state.summary == nil ? "1 · 选择文件" : state.preview.isNull ? "2 · 核对记录" : "3 · 确认恢复").font(.subheadline).foregroundStyle(.secondary)
                Button("选择备份文件") { choosing = true }.disabled(state.pendingRestore)
                if let summary = state.summary {
                    LabeledContent("备份时间", value: NativeWorkspaceFormat.timestamp(summary.exportedAt))
                    LabeledContent("记录与文件", value: "\(summary.rows) 行 · \(summary.files) 个文件")
                    if state.pendingRestore {
                        Text("上次恢复结果待确认，原文件已保留。")
                        Button("继续确认") { confirmRestore = true }
                        Button("重新核对服务器") { confirmRepreview = true }
                    } else { Button("核对恢复差异") { Task { await state.previewRestore() } } }
                    Button("重新选择", role: .destructive) { confirmDiscard = true }
                }
                DisclosureGroup("文件要求") {
                    Text("请选择单文件，或清单与全部分卷。单文件最多8 MiB／20,000行，分卷组最多16 MiB／40,000行。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if !state.preview.isNull {
                Section("恢复预览") {
                    LabeledContent("新增", value: String(state.preview["total"]["added"].intValue ?? 0))
                    LabeledContent("已存在", value: String(state.preview["total"]["skipped"].intValue ?? 0))
                    LabeledContent("冲突", value: String(state.preview["total"]["conflicts"].intValue ?? 0))
                    if state.preview["canRestore"].boolValue == true && !state.pendingRestore {
                        Button("确认恢复") { confirmRestore = true }
                    } else if state.preview["canRestore"].boolValue != true { Text("存在冲突，尚未写入。请核对后重新预览。").foregroundStyle(.orange) }
                    DisclosureGroup("查看记录明细") {
                    ForEach(Array(state.preview["tables"].arrayValue.enumerated()), id: \.offset) { _, table in
                        DisclosureGroup(table["label"].stringValue ?? "数据表") {
                            Text("新增 \(table["added"].intValue ?? 0)，已存在 \(table["skipped"].intValue ?? 0)，冲突 \(table["conflicts"].intValue ?? 0)")
                            ForEach(Array(table["conflictExamples"].arrayValue.enumerated()), id: \.offset) { _, conflict in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(conflict["reason"].stringValue ?? "已有记录内容不同").foregroundStyle(.orange)
                                    Text(conflict["record"].stringValue ?? "").font(.caption).textSelection(.enabled)
                                    ForEach(Array(conflict["differences"].arrayValue.enumerated()), id: \.offset) { _, field in
                                        NativeBackupDifference(field: field)
                                    }
                                }
                            }
                        }
                    }
                    }
                }
            }
            if !state.result.isNull {
                Section("服务器已确认") { Text("恢复新增 \(state.result["added"].intValue ?? 0) 行，跳过 \(state.result["skipped"].intValue ?? 0) 行。") }
            }
            }
        }
        .nativeGeometricPage().navigationTitle("备份与恢复").disabled(state.busy).task {
            state.open(); if state.summary != nil || state.pendingRestore { mode = .restore }
        }.onDisappear { state.close() }
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.json], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { state.select(urls) }
        }
        .confirmationDialog("恢复预览中的新增记录？", isPresented: $confirmRestore, titleVisibility: .visible) {
            Button("确认恢复") { Task { await state.restore() } }
        } message: { Text("只提交当前已预览的原始备份。服务器会再次核对最新记录和预览摘要。") }
        .confirmationDialog("放弃本机恢复内容？", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("放弃本机恢复内容", role: .destructive) { state.discard() }
        } message: { Text("这不会撤销服务器可能已完成的恢复。请先核对服务器记录。") }
        .confirmationDialog("重新读取恢复预览？", isPresented: $confirmRepreview, titleVisibility: .visible) {
            Button("重新核对服务器") { Task { await state.previewRestore() } }
        } message: { Text("原恢复可能已经完成。重新预览会显示当前已存在、新增与冲突的记录，之后需要再次明确确认。") }
    }
}

private struct NativeBackupDifference: View {
    let field: NativeJSON
    private func text(_ value: NativeJSON) -> String {
        if value.isNull { return "空" }
        return value.stringValue ?? value.doubleValue.map { String($0) } ?? value.boolValue.map { $0 ? "是" : "否" } ?? "结构化资料"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(field["label"].stringValue ?? field["field"].stringValue ?? "字段").font(.caption.bold())
            Text("当前：" + text(field["current"])).font(.caption)
            Text("备份：" + text(field["incoming"])).font(.caption)
        }.textSelection(.enabled)
    }
}
