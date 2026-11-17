import Foundation
import SwiftUI
import UIKit

enum NativeSyncConnectionRules {
    static func validatedLabel(_ value: String) throws -> String {
        let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !result.isEmpty, result.utf16.count <= 40,
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
            throw NativeActionInputError.invalid("连接名称需为1–40个字符，不包含换行或控制字符。")
        }
        return result
    }

    /// These responses prove creation did not succeed. A lost, cancelled or
    /// malformed response does not permit silently issuing another creation.
    static func definitiveCreationRejection(_ error: Error) -> Bool {
        guard case NativeAPIError.server(let status, _, _, _) = error else { return false }
        return [400, 404, 413, 415, 422].contains(status)
    }
}

struct NativeSyncPendingCreation: Codable, Equatable {
    let ownerID: String
    let label: String
    let startedAt: String
}

struct NativeSyncConnectionRecord: Codable, Equatable, Identifiable {
    let deviceId: String
    let label: String
    let createdAt: String
    let lastUsedAt: String?
    let revokedAt: String?
    var id: String { deviceId }
}

private struct NativeSyncOneTimeCredential {
    let deviceID: String
    let deviceToken: String
}

@MainActor
final class NativeSyncConnectionsModel: ObservableObject {
    @Published private(set) var devices: [NativeSyncConnectionRecord] = []
    @Published private(set) var configuration: NativeJSON = .null
    @Published private(set) var channel: NativeHealthChannel?
    @Published private(set) var pendingCreation: NativeSyncPendingCreation?
    @Published private(set) var pendingRevocation: NativeSyncConnectionRecord?
    @Published private(set) var busy = false
    @Published private(set) var storageReady = false
    @Published private(set) var reviewedPendingCreation = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var message: String?
    @Published private(set) var templateURL: URL?
    @Published private(set) var secretVisible = false
    @Published private(set) var secret: String?
    private var credential: NativeSyncOneTimeCredential?
    private let api: NativeAPI
    private var token: String
    private var userID: String
    private var generation = UUID()
    private var templateDirectory: URL?

    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID
    }

    private var creationStore: NativeWorkspacePersistence {
        NativeWorkspacePersistence(userID: userID, scope: "sync-connection-pending-creation")
    }
    private var revocationStore: NativeWorkspacePersistence {
        NativeWorkspacePersistence(userID: userID, scope: "sync-connection-pending-revocation")
    }
    var canCreate: Bool { storageReady && !busy && pendingCreation == nil && pendingRevocation == nil && credential == nil }
    var hasOneTimeCredential: Bool { credential != nil }

    func activate(token: String, userID: String) async {
        if self.userID != userID || self.token != token {
            generation = UUID(); self.token = token; self.userID = userID
            devices = []; configuration = .null; channel = nil; busy = false
            pendingCreation = nil; pendingRevocation = nil; storageReady = false
            errorMessage = nil; message = nil; reviewedPendingCreation = false
            hideCredential(); removeTemplate()
        }
        do {
            pendingCreation = try creationStore.load(NativeSyncPendingCreation.self)
            if let pendingCreation, pendingCreation.ownerID != userID { throw NativeAPIError.invalidResponse }
            pendingRevocation = try revocationStore.load(NativeSyncConnectionRecord.self)
            storageReady = true
        } catch { errorMessage = error.localizedDescription; storageReady = false }
        await refresh()
    }

    func refresh(reviewCreation: Bool = false) async {
        guard !busy else { return }
        let epoch = generation
        busy = true; errorMessage = nil
        defer { if generation == epoch { busy = false } }
        let success = await fetchSnapshot(epoch: epoch)
        if generation == epoch, success, reviewCreation, pendingCreation != nil { reviewedPendingCreation = true }
    }

    @discardableResult
    private func fetchSnapshot(epoch: UUID) async -> Bool {
        let accessToken = token
        async let list = api.json(path: "sync/devices", token: accessToken)
        async let config = api.json(path: "sync/config", token: accessToken)
        async let policy = api.channel(token: accessToken)
        var success = false
        do {
            struct Envelope: Decodable { let devices: [NativeSyncConnectionRecord] }
            let response = try await list
            let rows = try JSONDecoder().decode(Envelope.self, from: response.encodedData()).devices
            guard generation == epoch, !Task.isCancelled else { return false }
            guard rows.allSatisfy({ UUID(uuidString: $0.deviceId) != nil && !$0.label.isEmpty }) else {
                throw NativeAPIError.invalidResponse
            }
            devices = rows
            success = true
            if let pendingRevocation, !rows.contains(where: { $0.deviceId == pendingRevocation.deviceId }) {
                try revocationStore.clear()
                self.pendingRevocation = nil
                message = "已核对连接列表，原撤销操作已完成。"
            }
        } catch {
            if generation == epoch, !Task.isCancelled { errorMessage = error.localizedDescription }
        }
        do {
            let value = try await config
            if generation == epoch, !Task.isCancelled { configuration = value }
        } catch {
            if generation == epoch, !Task.isCancelled { configuration = .null }
        }
        do {
            let value = try await policy
            if generation == epoch, !Task.isCancelled { channel = value }
        } catch {
            if generation == epoch, !Task.isCancelled { channel = nil }
        }
        return success
    }

    func create(label: String) async {
        guard canCreate else { return }
        let epoch = generation
        busy = true; errorMessage = nil; message = nil
        defer { if generation == epoch { busy = false } }
        do {
            let label = try NativeSyncConnectionRules.validatedLabel(label)
            let pending = NativeSyncPendingCreation(ownerID: userID, label: label,
                                                   startedAt: NativeHealthCalendar.timestamp(Date()))
            try creationStore.save(pending)
            pendingCreation = pending; reviewedPendingCreation = false
            let response: NativeJSON
            do {
                response = try await api.json(path: "sync/devices", method: "POST", token: token,
                                              body: .object(["label": .string(label)]))
            } catch {
                guard generation == epoch else { return }
                if NativeSyncConnectionRules.definitiveCreationRejection(error) {
                    try creationStore.clear(); pendingCreation = nil
                }
                throw error
            }
            guard generation == epoch, !Task.isCancelled else { return }
            guard let deviceID = response["deviceId"].stringValue, UUID(uuidString: deviceID) != nil,
                  let deviceToken = response["deviceToken"].stringValue,
                  NativeHealthDeviceCredential(deviceToken: deviceToken).isValid else { throw NativeAPIError.invalidResponse }
            credential = NativeSyncOneTimeCredential(deviceID: deviceID, deviceToken: deviceToken)
            secret = nil; secretVisible = false
            try creationStore.clear(); pendingCreation = nil
            message = "连接已创建。密钥只在本次页面中提供，请按需显示并妥善保存。"
            await fetchSnapshot(epoch: epoch)
        } catch {
            guard generation == epoch, !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
            if pendingCreation != nil { message = "创建结果尚未完整核对。不会自动创建第二个连接，请先读取连接列表。" }
        }
    }

    func finishCreationReview() {
        guard !busy, reviewedPendingCreation else { return }
        do {
            try creationStore.clear(); pendingCreation = nil; reviewedPendingCreation = false
            message = "已结束原创建核对；如需新连接，请再次明确创建。"
        } catch { errorMessage = error.localizedDescription }
    }

    func revoke(_ device: NativeSyncConnectionRecord) async {
        guard !busy, storageReady else { return }
        guard pendingRevocation == nil || pendingRevocation?.deviceId == device.deviceId else { return }
        let epoch = generation
        busy = true; errorMessage = nil; message = nil
        defer { if generation == epoch { busy = false } }
        do {
            try revocationStore.save(device); pendingRevocation = device
            let response = try await api.json(path: "sync/devices/" + NativeWorkspaceFormat.pathComponent(device.deviceId),
                                              method: "DELETE", token: token)
            guard generation == epoch, !Task.isCancelled else { return }
            guard response["ok"].boolValue == true else { throw NativeAPIError.invalidResponse }
            try revocationStore.clear(); pendingRevocation = nil
            if credential?.deviceID == device.deviceId { hideCredential() }
            message = "连接已撤销，已有健康记录继续保留。"
            await fetchSnapshot(epoch: epoch)
        } catch {
            guard generation == epoch, !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
            message = "撤销结果尚未确认。可读取列表核对，或继续同一条撤销请求。"
        }
    }

    func revealCredential() {
        guard let credential else { return }
        secret = credential.deviceToken; secretVisible = true
    }
    func copyCredential() {
        guard let secret, secretVisible else { return }
        UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: secret]],
                                     options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(60)])
        message = "密钥已复制到本机剪贴板，60秒后过期。"
    }
    func hideCredential() { credential = nil; secret = nil; secretVisible = false }

    /// Leaving this surface invalidates every outstanding publication, including
    /// a successful creation whose one-time secret arrives after suspension.
    /// Frozen request summaries remain encrypted for reconciliation on return.
    func suspend() {
        generation = UUID()
        busy = false; storageReady = false; reviewedPendingCreation = false
        devices = []; configuration = .null; channel = nil
        pendingCreation = nil; pendingRevocation = nil
        errorMessage = nil; message = nil
        hideCredential()
        removeTemplate()
    }

    func downloadTemplate() async {
        guard !busy else { return }
        let epoch = generation
        busy = true; errorMessage = nil
        defer { if generation == epoch { busy = false } }
        do {
            let download = try await api.download(path: "sync/template", token: token)
            guard generation == epoch, !Task.isCancelled else { return }
            let contents = try JSONDecoder().decode(NativeJSON.self, from: download.data)
            guard download.mimeType == "application/json", contents["version"].intValue == 1,
                  contents["source"].stringValue == "apple-health-shortcuts",
                  contents["timezone"].stringValue == "Asia/Shanghai",
                  Set(contents.objectValue.keys) == Set(["version", "source", "timezone", "exportedAt", "measurements"]),
                  case .array(let rows) = contents["measurements"], rows.isEmpty else { throw NativeAPIError.invalidResponse }
            removeTemplate()
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("jiashu-sync-template-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            let file = directory.appendingPathComponent("jiashu-health-sync-template.json")
            try download.data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            templateDirectory = directory; templateURL = file
        } catch {
            if generation == epoch, !Task.isCancelled { errorMessage = error.localizedDescription }
        }
    }

    private func removeTemplate() {
        if let templateDirectory { try? FileManager.default.removeItem(at: templateDirectory) }
        templateDirectory = nil; templateURL = nil
    }
}

struct NativeSyncConnectionsView: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @StateObject private var model: NativeSyncConnectionsModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var label = "我的快捷指令"
    @State private var selectedDevice: NativeSyncConnectionRecord?
    @State private var endingCreationReview = false

    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID
        _model = StateObject(wrappedValue: NativeSyncConnectionsModel(api: api, token: token, userID: userID))
    }

    var body: some View {
        List {
            if let pending = model.pendingCreation {
                Section("创建结果待核对") {
                    LabeledContent("原连接名称", value: pending.label)
                    LabeledContent("提交时间", value: NativeWorkspaceFormat.timestamp(pending.startedAt))
                    Text("先核对列表。若已创建但密钥未收到，请撤销该连接后再创建。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("核对创建结果") { Task { await model.refresh(reviewCreation: true) } }.disabled(model.busy)
                    Button("已核对，结束处理") { endingCreationReview = true }
                        .disabled(model.busy || !model.reviewedPendingCreation)
                }
            }
            if let pending = model.pendingRevocation {
                Section("撤销结果待核对") {
                    Text(pending.label)
                    Button("继续核对原撤销") { Task { await model.revoke(pending) } }.disabled(model.busy)
                    Button("读取列表核对是否已撤销") { Task { await model.refresh() } }.disabled(model.busy)
                }
            }
            Section("现有连接") {
                if model.devices.isEmpty, !model.busy { Text("当前未读取到有效连接。").foregroundStyle(.secondary) }
                ForEach(model.devices) { device in
                    VStack(alignment: .leading, spacing: 7) {
                        Text(device.label).font(.headline)
                        Text("创建：" + NativeWorkspaceFormat.timestamp(device.createdAt)).font(.caption).foregroundStyle(.secondary)
                        Text("最近使用：" + NativeWorkspaceFormat.timestamp(device.lastUsedAt)).font(.caption).foregroundStyle(.secondary)
                        if model.channel?.deviceId == device.deviceId {
                            Label("当前日常同步设备；撤销会使其停止上传", systemImage: "exclamationmark.triangle")
                                .font(.footnote).foregroundStyle(.orange)
                        }
                        Button("撤销此连接", role: .destructive) { selectedDevice = device }
                            .disabled(model.busy || model.pendingRevocation != nil)
                    }.padding(.vertical, 4)
                }
                Button("刷新连接列表") { Task { await model.refresh() } }.disabled(model.busy)
            }
            if model.hasOneTimeCredential {
                Section("本次连接密钥") {
                    Text("密钥仅显示一次；离开或切后台即隐藏，请先保存。")
                        .font(.footnote).foregroundStyle(.secondary)
                    if model.secretVisible, let secret = model.secret {
                        Text(secret).font(.system(.footnote, design: .monospaced)).privacySensitive()
                        Button("复制密钥（仅本机，60秒）") { model.copyCredential() }
                        ShareLink("分享本次密钥", item: secret).privacySensitive()
                    } else { Button("显示本次密钥") { model.revealCredential() } }
                    Button("已保存并隐藏密钥") { model.hideCredential() }
                }
            }
            Section("创建快捷指令连接") {
                TextField("连接名称", text: $label).disabled(!model.canCreate)
                Button("创建一个新连接") { Task { await model.create(label: label) } }.disabled(!model.canCreate)
                Text("此连接不会替换日常设备，也不授予账号读取权限。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section { DisclosureGroup("接入配置与空白模板") {
                LabeledContent("服务", value: NativeAPI.websiteURL.host ?? "Jiashu OS")
                if model.configuration["authorizationReady"].boolValue == true {
                    Text("接入配置已就绪。")
                        .font(.footnote).foregroundStyle(.secondary)
                } else { Text("接入配置尚未核对，请刷新后重试。").foregroundStyle(.secondary) }
                Button("下载空白健康同步模板") { Task { await model.downloadTemplate() } }.disabled(model.busy)
                if let template = model.templateURL { ShareLink("保存或分享空白模板", item: template) }
                Text("空白模板不含密钥或个人记录。")
                    .font(.footnote).foregroundStyle(.secondary)
            } }
            if let message = model.message { Section { Text(message).font(.footnote).foregroundStyle(.secondary) } }
            NativeFeatureFeedback(busy: model.busy, error: model.errorMessage)
        }
        .navigationTitle("其他接入方式")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: userID + "|" + token) { await model.activate(token: token, userID: userID) }
        .refreshable { await model.refresh() }
        .onDisappear { model.suspend() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { model.suspend() }
            else if phase == .active { Task { await model.activate(token: token, userID: userID) } }
        }
        .confirmationDialog("撤销后该连接将不能继续上传。已有健康记录保留；若这是日常同步设备，其自动同步也会失效。", isPresented: Binding(
            get: { selectedDevice != nil }, set: { if !$0 { selectedDevice = nil } }), titleVisibility: .visible) {
                if let selectedDevice {
                    Button("确认撤销连接", role: .destructive) { Task { await model.revoke(selectedDevice) } }
                }
            }
        .confirmationDialog("请确认已核对列表。若原连接已创建但密钥丢失，请先撤销它；结束核对不会自动创建新连接。",
                            isPresented: $endingCreationReview, titleVisibility: .visible) {
            Button("已核对并结束原请求") { model.finishCreationReview() }
        }
    }
}
