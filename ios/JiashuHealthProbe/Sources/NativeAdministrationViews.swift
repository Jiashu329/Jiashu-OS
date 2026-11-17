import Foundation
import Security
import SwiftUI

enum NativeProviderKind: String, CaseIterable, Identifiable, Sendable {
    case ai, media
    var id: String { rawValue }
    var title: String { self == .ai ? "AI 服务" : "影视封面服务" }
    var path: String { self == .ai ? "ai/settings" : "media/tmdb/settings" }
}

struct NativeAdministrationInputError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum NativeAdministrationContract {
    static func email(_ input: String) throws -> String {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        guard value.utf8.count <= 254, parts.count == 2, !parts[0].isEmpty,
              parts[1].contains("."), !value.contains(where: { $0.isWhitespace || $0.isNewline }) else {
            throw NativeAdministrationInputError(message: "请填写有效的登录邮箱。")
        }
        return value
    }
    static func password(_ value: String) throws {
        guard (12...256).contains(value.unicodeScalars.count), value.utf8.count <= 1024,
              !value.unicodeScalars.contains(where: { $0.value == 0 || $0.value == 10 || $0.value == 13 }) else {
            throw NativeAdministrationInputError(message: "密码需为12–256个字符，不能包含换行。")
        }
    }
    static func providerSave(kind: NativeProviderKind, revision: Int, secret: String, model: String, region: String) throws -> NativeJSON {
        guard revision >= 0 else { throw NativeAdministrationInputError(message: "请先读取当前设置版本。") }
        let key = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard key.utf8.count <= 4096, key.utf8.allSatisfy({ (33...126).contains($0) }) else {
            throw NativeAdministrationInputError(message: "服务密钥需为不超过4096个字符的有效密钥。")
        }
        var fields: [String: NativeJSON] = ["expectedRevision": .integer(revision)]
        if !key.isEmpty { fields[kind == .ai ? "apiKey" : "token"] = .string(key) }
        if kind == .ai {
            let name = model.trimmingCharacters(in: .whitespacesAndNewlines)
            guard name.utf16.count <= 100, name.range(of: "^MiniMax-[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) != nil,
                  ["cn", "global"].contains(region) else {
                throw NativeAdministrationInputError(message: "请填写以 MiniMax- 开头的模型名称，并选择服务区域。")
            }
            fields["model"] = .string(name); fields["region"] = .string(region)
        }
        return .object(fields)
    }
    static func providerTest(kind: NativeProviderKind, revision: Int) -> NativeJSON {
        var fields: [String: NativeJSON] = ["expectedRevision": .integer(revision)]
        if kind == .ai { fields["consent"] = .bool(true) }
        return .object(fields)
    }
    static func createUser(email: String, password: String) throws -> NativeJSON {
        try self.password(password)
        return .object(["email": .string(try self.email(email)), "password": .string(password)])
    }
    static func editUser(_ user: NativeJSON, email: String, password: String, active: Bool) throws -> NativeJSON {
        guard let revision = user["revision"].intValue, revision >= 1 else { throw NativeAdministrationInputError(message: "请先读取最新用户资料。") }
        if user["isAdmin"].boolValue == true && !active { throw NativeAdministrationInputError(message: "管理员账号不能停用。") }
        var fields: [String: NativeJSON] = ["expectedRevision": .integer(revision), "email": .string(try self.email(email)), "status": .string(active ? "active" : "disabled")]
        if !password.isEmpty { try self.password(password); fields["password"] = .string(password) }
        return .object(fields)
    }
}

struct NativeAdministrationPending: Codable, Equatable {
    let ownerID: String
    let scope: String
    let id: String
    let path: String
    let method: String
    let body: NativeJSON
    let label: String
    init(ownerID: String, scope: String, path: String, method: String, body: NativeJSON, label: String, id: UUID = UUID()) {
        self.ownerID = ownerID; self.scope = scope; self.id = id.uuidString.lowercased()
        self.path = path; self.method = method; self.body = body; self.label = label
    }
}

/// Sensitive drafts are frozen before sending, isolated by server, owner and
/// feature, and protected by device-only Keychain rather than browser storage.
struct NativeAdministrationPendingStore {
    let ownerID: String
    let scope: String
    var service = "asia.treefund.jiashu.native-administration.v1"
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "https://www.treefund.asia|" + ownerID + "|" + scope,
         kSecAttrSynchronizable as String: false]
    }
    func load() throws -> NativeAdministrationPending? {
        var search = query; search[kSecReturnData as String] = true; search[kSecMatchLimit as String] = kSecMatchLimitOne
        var raw: CFTypeRef?; let status = SecItemCopyMatching(search as CFDictionary, &raw)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = raw as? Data else { throw NativeAdministrationInputError(message: "无法读取待确认设置，请解锁手机后重试。") }
        let value = try JSONDecoder().decode(NativeAdministrationPending.self, from: data)
        guard value.ownerID == ownerID, value.scope == scope else { throw NativeAdministrationInputError(message: "待确认设置不属于当前账户。") }
        return value
    }
    func save(_ value: NativeAdministrationPending) throws {
        guard value.ownerID == ownerID, value.scope == scope else { throw NativeAdministrationInputError(message: "此操作不属于当前账户。") }
        let fields: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, fields as CFDictionary)
        if status == errSecItemNotFound { var item = query; fields.forEach { item[$0.key] = $0.value }; status = SecItemAdd(item as CFDictionary, nil) }
        guard status == errSecSuccess else { throw NativeAdministrationInputError(message: "无法安全保留原操作，本次未发送。") }
    }
    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeAdministrationInputError(message: "无法清理已确认的本机操作，请稍后重试。") }
    }
}

@MainActor
final class NativeAdministrationContext: ObservableObject {
    @Published var data: NativeJSON = .null
    @Published var pending: NativeAdministrationPending?
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?
    @Published var ready = false
    @Published var locked = false
    let api: NativeAPI; let token: String; let userID: String; let scope: String; let path: String
    private var valid = true
    private var epoch = UUID()
    private var store: NativeAdministrationPendingStore { NativeAdministrationPendingStore(ownerID: userID, scope: scope) }
    init(api: NativeAPI, token: String, userID: String, scope: String, path: String) {
        self.api = api; self.token = token; self.userID = userID; self.scope = scope; self.path = path
        do { pending = try store.load() } catch { self.error = error.localizedDescription; locked = true }
    }
    var canMutate: Bool { ready && !locked && !busy && pending == nil }
    func activate() { valid = true; epoch = UUID() }
    func deactivate() { valid = false; epoch = UUID(); data = .null; ready = false; busy = false }
    func load() async {
        guard valid, !busy else { return }; let generation = epoch
        busy = true; error = nil
        defer { if epoch == generation { busy = false } }
        do {
            let savedPending = try store.load()
            let result = try await api.json(path: path, token: token)
            guard valid, epoch == generation else { return }
            data = result; pending = savedPending; ready = true; locked = false
        } catch {
            guard valid, epoch == generation else { return }; self.error = error.localizedDescription
            if case NativeAPIError.server(let status, _, _, _) = error, status == 401 || status == 403 { locked = true; ready = false; data = .null }
        }
    }
    func begin(path: String, method: String, body: NativeJSON, label: String) async {
        guard canMutate else { return }
        let command = NativeAdministrationPending(ownerID: userID, scope: scope, path: path, method: method, body: body, label: label)
        do { try store.save(command); pending = command; await resume() }
        catch { self.error = error.localizedDescription }
    }
    func resume() async {
        guard valid, !busy, !locked, let command = pending, command.ownerID == userID, command.scope == scope else { return }
        let generation = epoch; busy = true; error = nil; notice = nil
        defer { if epoch == generation { busy = false } }
        do {
            let result = try await api.json(path: command.path, method: command.method, token: token, body: command.body, headers: ["Idempotency-Key": command.id])
            guard valid, epoch == generation else { return }
            try store.clear(); pending = nil
            if result["reauthRequired"].boolValue == true {
                locked = true; ready = false; data = .null
                notice = "当前账号的登录资料已更新。请返回账户页重新登录，原有业务数据保留。"
                return
            }
            notice = result["message"].stringValue ?? "操作已确认保存。"
            do {
                let current = try await api.json(path: path, token: token)
                guard valid, epoch == generation else { return }; data = current; ready = true
            } catch { if valid, epoch == generation { self.error = "操作已保存，最新资料暂未读取成功，请刷新。" } }
        } catch {
            guard valid, epoch == generation else { return }
            if case NativeAPIError.server(let status, _, _, _) = error, [400, 413, 415, 422].contains(status) {
                do { try store.clear(); pending = nil; self.error = error.localizedDescription }
                catch { self.error = error.localizedDescription }
                return
            }
            self.error = error.localizedDescription + " 原操作保留在本机，请核对后继续确认。"
            if case NativeAPIError.server(let status, _, _, _) = error, status == 401 || status == 403 { locked = true; ready = false; data = .null }
        }
    }
    func discard() {
        guard !busy else { return }
        do { try store.clear(); pending = nil; notice = "已移除本机待确认操作；服务器可能已完成的修改不会被撤销。" }
        catch { self.error = error.localizedDescription }
    }
}

@MainActor
private struct NativeAdministrationStatus: View {
    @ObservedObject var model: NativeAdministrationContext
    @State private var discard = false
    @State private var retryTest = false
    var body: some View {
        NativeFeatureFeedback(busy: model.busy, error: model.error)
        if let notice = model.notice { Section { Text(notice).foregroundStyle(.secondary) } }
        if let pending = model.pending {
            Section("待确认的原操作") {
                Label(pending.label, systemImage: "clock.arrow.circlepath")
                Text("内容和提交标识已安全保存在本机。请先核对服务器现状，再继续原操作；版本冲突不会覆盖新设置。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("继续确认原操作") {
                    if pending.path.hasSuffix("/test") { retryTest = true } else { Task { await model.resume() } }
                }.disabled(model.busy || model.locked)
                Button("移除本机待确认操作", role: .destructive) { discard = true }.disabled(model.busy)
            }
            .confirmationDialog("移除本机待确认操作？", isPresented: $discard, titleVisibility: .visible) {
                Button("移除本机记录", role: .destructive) { model.discard() }
            } message: { Text("这不会撤销服务器可能已经完成的修改。请先读取最新状态。") }
            .confirmationDialog("重新测试服务连接？", isPresented: $retryTest, titleVisibility: .visible) {
                Button("确认再次测试") { Task { await model.resume() } }
            } message: { Text("测试会再次发送请求，可能消耗服务调用额度。") }
        }
    }
}

@MainActor
struct NativeProviderSettingsView: View {
    let kind: NativeProviderKind
    @StateObject private var model: NativeAdministrationContext
    @State private var secret = ""
    @State private var modelName = "MiniMax-M3"
    @State private var region = "cn"
    @State private var remove = false
    @State private var test = false
    @State private var initialized = false
    init(api: NativeAPI, token: String, userID: String, kind: NativeProviderKind) {
        self.kind = kind
        _model = StateObject(wrappedValue: NativeAdministrationContext(api: api, token: token, userID: userID, scope: "provider." + kind.rawValue, path: kind.path))
    }
    private var settings: NativeJSON { model.data["settings"] }
    private var revision: Int { settings["revision"].intValue ?? 0 }
    private var canManage: Bool { model.data["canManage"].boolValue == true }
    var body: some View {
        Form {
            Section("当前配置") {
                LabeledContent("服务状态", value: settings["configured"].boolValue == true ? "已配置" : "尚未配置")
                LabeledContent("最近连接测试", value: settings["lastTestStatus"].stringValue == "success" ? "成功" : settings["lastTestStatus"].stringValue == "failed" ? "失败" : "尚未测试")
                if let message = model.data["message"].stringValue { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }
            if canManage {
                Section("服务设置") {
                    if kind == .ai {
                        TextField("模型，例如 MiniMax-M3", text: $modelName).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Picker("区域", selection: $region) { Text("中国区").tag("cn"); Text("国际区").tag("global") }
                    }
                    SecureField(kind == .ai ? "MiniMax API 密钥" : "TMDB API Read Access Token", text: $secret)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("留空保留当前密钥。已保存的密钥不会回显；修改只影响后续请求。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("保存配置") { Task { await save() } }
                        .disabled(!model.canMutate || model.data["storageReady"].boolValue == false)
                }.disabled(model.busy || model.pending != nil || model.locked)
                Section {
                    Button("测试连接") { test = true }.disabled(!model.canMutate || settings["configured"].boolValue != true)
                    Button("删除服务密钥", role: .destructive) { remove = true }.disabled(!model.canMutate || settings["configured"].boolValue != true)
                }
            } else if model.ready { Section { Text("此服务由管理员统一配置。个人健康、饮食和财务数据继续各自隔离。") } }
            NativeAdministrationStatus(model: model)
        }
        .navigationTitle(kind.title)
        .toolbar { Button("刷新") { Task { await model.load() } }.disabled(model.busy) }
        .confirmationDialog("测试服务连接？", isPresented: $test, titleVisibility: .visible) {
            Button("确认测试") { Task { await model.begin(path: kind.path + "/test", method: "POST", body: NativeAdministrationContract.providerTest(kind: kind, revision: revision), label: "测试" + kind.title) } }
        } message: { Text(kind == .ai ? "将发送固定测试文本，可能消耗 API 调用额度，不发送个人健康记录。" : "将向 TMDB 发送一次连接测试请求。") }
        .confirmationDialog("删除已保存的服务密钥？", isPresented: $remove, titleVisibility: .visible) {
            Button("确认删除", role: .destructive) { Task { await model.begin(path: kind.path, method: "DELETE", body: .object(["expectedRevision": .integer(revision)]), label: "删除" + kind.title + "密钥") } }
        } message: { Text("删除后全站成员的后续相关请求将停止使用该密钥。") }
        .task {
            model.activate(); await model.load()
            if !initialized, model.ready { modelName = settings["model"].stringValue ?? "MiniMax-M3"; region = settings["region"].stringValue ?? "cn"; initialized = true }
        }
        .onDisappear { secret = ""; model.deactivate() }
    }
    private func save() async {
        do {
            let body = try NativeAdministrationContract.providerSave(kind: kind, revision: revision, secret: secret, model: modelName, region: region)
            secret = ""
            await model.begin(path: kind.path, method: "PUT", body: body, label: "保存" + kind.title + "配置")
        } catch { model.error = error.localizedDescription }
    }
}

@MainActor
struct NativeAccessManagementView: View {
    @StateObject private var model: NativeAdministrationContext
    @State private var email = ""
    @State private var selected: NativeJSON?
    @State private var confirm = false
    init(api: NativeAPI, token: String, userID: String) {
        _model = StateObject(wrappedValue: NativeAdministrationContext(api: api, token: token, userID: userID, scope: "access", path: "access"))
    }
    var body: some View {
        Form {
            if model.ready {
                Section("允许访问的成员") {
                    ForEach(Array(model.data["grants"].arrayValue.enumerated()), id: \.offset) { _, grant in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(grant["email"].stringValue ?? "成员")
                            Text(grant["status"].stringValue == "active" ? "已启用" : "已停用").font(.caption).foregroundStyle(.secondary)
                            Button(grant["status"].stringValue == "active" ? "停用访问" : "恢复访问", role: grant["status"].stringValue == "active" ? .destructive : nil) { selected = grant; confirm = true }
                                .disabled(!model.canMutate)
                        }
                    }
                    if model.data["grants"].arrayValue.isEmpty { Text("尚未添加成员。") }
                }
                Section("添加允许访问的邮箱") {
                    TextField("登录邮箱", text: $email).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("添加成员") { Task { await invite() } }.disabled(!model.canMutate || email.isEmpty)
                    Text("网站不会发送邮件。请自行将网站链接提供给已获准的成员。")
                        .font(.footnote).foregroundStyle(.secondary)
                }.disabled(model.busy || model.pending != nil || model.locked)
            }
            NativeAdministrationStatus(model: model)
        }
        .navigationTitle("使用名单")
        .toolbar { Button("刷新") { Task { await model.load() } }.disabled(model.busy) }
        .confirmationDialog("修改此成员的访问权限？", isPresented: $confirm, titleVisibility: .visible) {
            Button("确认修改", role: selected?["status"].stringValue == "active" ? .destructive : nil) { Task { await changeStatus() } }
        } message: { Text("停用会拒绝后续访问，已保存的业务数据仍会保留。") }
        .task { model.activate(); await model.load() }
        .onDisappear { model.deactivate() }
    }
    private func invite() async {
        do {
            let body: NativeJSON = .object(["email": .string(try NativeAdministrationContract.email(email))])
            await model.begin(path: "access", method: "POST", body: body, label: "添加允许访问的成员")
            if model.pending == nil { email = "" }
        } catch { model.error = error.localizedDescription }
    }
    private func changeStatus() async {
        guard let selected, let id = selected["id"].stringValue, let revision = selected["revision"].intValue else { return }
        let body: NativeJSON = .object(["status": .string(selected["status"].stringValue == "active" ? "revoked" : "active"), "expectedRevision": .integer(revision)])
        await model.begin(path: "access/" + NativeWorkspaceFormat.pathComponent(id), method: "PATCH", body: body, label: "修改成员访问权限")
    }
}

@MainActor
struct NativeUsersManagementView: View {
    @StateObject private var model: NativeAdministrationContext
    @State private var email = ""
    @State private var password = ""
    @State private var editing: NativeJSON?
    @State private var showEditor = false
    init(api: NativeAPI, token: String, userID: String) {
        _model = StateObject(wrappedValue: NativeAdministrationContext(api: api, token: token, userID: userID, scope: "users", path: "admin/users"))
    }
    var body: some View {
        Form {
            if model.ready {
                Section("网站账号") {
                    ForEach(Array(model.data["users"].arrayValue.enumerated()), id: \.offset) { _, user in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(user["email"].stringValue ?? "用户")
                            Text((user["isAdmin"].boolValue == true ? "管理员 · " : "") + (user["status"].stringValue == "active" ? "已启用" : "已停用"))
                                .font(.caption).foregroundStyle(.secondary)
                            Button("编辑账号") { editing = user; showEditor = true }.disabled(!model.canMutate)
                        }
                    }
                }
                Section("添加账号") {
                    TextField("邮箱", text: $email).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("初始密码（12–256个字符）", text: $password).textContentType(.newPassword)
                    Button("创建账号") { Task { await create() } }.disabled(!model.canMutate || email.isEmpty || password.isEmpty)
                    Text("请通过你信任的方式将初始密码告知本人。修改邮箱、密码或停用账号会使该账号的旧登录失效。")
                        .font(.footnote).foregroundStyle(.secondary)
                }.disabled(model.busy || model.pending != nil || model.locked)
            }
            NativeAdministrationStatus(model: model)
        }
        .navigationTitle("用户管理")
        .toolbar { Button("刷新") { Task { await model.load() } }.disabled(model.busy) }
        .sheet(isPresented: $showEditor) {
            if let editing { NativeUserEditor(user: editing) { body in
                guard let id = editing["id"].stringValue else { return }
                await model.begin(path: "admin/users/" + NativeWorkspaceFormat.pathComponent(id), method: "PATCH", body: body, label: "更新用户登录资料")
                showEditor = false
            } }
        }
        .task { model.activate(); await model.load() }
        .onDisappear { password = ""; model.deactivate() }
    }
    private func create() async {
        do {
            let body = try NativeAdministrationContract.createUser(email: email, password: password)
            password = ""
            await model.begin(path: "admin/users", method: "POST", body: body, label: "创建网站账号")
            if model.pending == nil { email = "" }
        } catch { model.error = error.localizedDescription }
    }
}

@MainActor
private struct NativeUserEditor: View {
    let user: NativeJSON
    let save: (NativeJSON) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var email: String
    @State private var password = ""
    @State private var active: Bool
    @State private var error: String?
    @State private var busy = false
    @State private var confirm = false
    init(user: NativeJSON, save: @escaping (NativeJSON) async -> Void) {
        self.user = user; self.save = save
        _email = State(initialValue: user["email"].stringValue ?? "")
        _active = State(initialValue: user["status"].stringValue == "active")
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("账号资料") {
                    TextField("邮箱", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("新密码（留空保留）", text: $password).textContentType(.newPassword)
                    Toggle("允许登录", isOn: $active).disabled(user["isAdmin"].boolValue == true)
                    Text("修改登录资料后，此账号的旧会话会失效。修改自己的资料后需要重新登录。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .disabled(busy)
            .navigationTitle("编辑账号")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { confirm = true }.disabled(busy) }
            }
            .confirmationDialog("确认更新账号资料？", isPresented: $confirm, titleVisibility: .visible) {
                Button("确认保存", role: active ? nil : .destructive) { Task { await submit() } }
            } message: { Text("旧登录将失效；停用账号会保留其业务数据。") }
            .interactiveDismissDisabled(busy)
            .onDisappear { password = "" }
        }
    }
    private func submit() async {
        do {
            let body = try NativeAdministrationContract.editUser(user, email: email, password: password, active: active)
            password = ""; busy = true; defer { busy = false }
            await save(body)
        } catch { self.error = error.localizedDescription }
    }
}
