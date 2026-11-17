import SwiftUI

struct NativeSettingsWorkspaceRoot: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @State private var identity: NativeJSON = .null
    @State private var error: String?
    var body: some View {
        List {
            if let error { Section { Text(error).foregroundStyle(.red) } }
            Section("资料与服务") {
                NavigationLink { NativeNotificationsView(api: api, token: token, userID: userID) } label: { Label("消息与提醒", systemImage: "bell") }
                NavigationLink { NativeBackupView(api: api, token: token, userID: userID) } label: { Label("完整备份与恢复", systemImage: "externaldrive") }
                NavigationLink { NativeSyncConnectionsView(api: api, token: token, userID: userID) } label: { Label("同步连接与设备", systemImage: "arrow.triangle.2.circlepath") }
                NavigationLink { NativeProviderSettingsView(api: api, token: token, userID: userID, kind: .ai) } label: { Label("AI 服务设置", systemImage: "sparkles") }
                NavigationLink { NativeProviderSettingsView(api: api, token: token, userID: userID, kind: .media) } label: { Label("影视封面服务", systemImage: "photo") }
            }
            if identity["isOwner"].boolValue == true {
                Section("管理员") {
                    NavigationLink { NativeUsersManagementView(api: api, token: token, userID: userID) } label: { Label("登录用户管理", systemImage: "person.badge.key") }
                    NavigationLink { NativeAccessManagementView(api: api, token: token, userID: userID) } label: { Label("允许访问的成员", systemImage: "person.2.badge.gearshape") }
                }
            }
            Section("当前账号") {
                LabeledContent("邮箱", value: identity["email"].stringValue ?? "正在读取…")
                LabeledContent("权限", value: identity["isOwner"].boolValue == true ? "管理员" : "成员")
                Text("每个账号的数据与本机草稿分开保存；家庭账本的访问与导出遵守原有成员权限。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }.navigationTitle("设置与数据").task { await load() }.refreshable { await load() }
    }
    @MainActor private func load() async {
        do { let value = try await api.json(path: "session", token: token); guard !Task.isCancelled else { return }; identity = value; error = nil }
        catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

enum NativeWorkspaceLink: Equatable, Sendable {
    case finance(String), health, nutrition, review, life, settings, notifications, backup, sync
    init?(_ value: String) {
        guard let url = URL(string: value, relativeTo: NativeAPI.websiteURL)?.absoluteURL,
              url.scheme == "https", url.host == NativeAPI.websiteURL.host,
              url.port == nil || url.port == 443, url.user == nil, url.password == nil, url.fragment == nil else { return nil }
        let path = url.path
        if path == "/finance" || path.hasPrefix("/finance/") { self = .finance(url.absoluteString) }
        else if path == "/health/nutrition" || path.hasPrefix("/health/nutrition/") || path.hasPrefix("/health/foods") { self = .nutrition }
        else if path == "/health/review" || path == "/health/weekly" { self = .review }
        else if path == "/health" || path.hasPrefix("/health/") { self = .health }
        else if path == "/life/douban" || path.hasPrefix("/life/douban/") { self = .life }
        else if path == "/notifications" { self = .notifications }
        else if path == "/data" || path == "/backup" { self = .backup }
        else if path == "/sync" || path.hasPrefix("/sync/") || path.hasPrefix("/connect-") { self = .sync }
        else if path == "/account" || path.hasPrefix("/settings/") { self = .settings }
        else { return nil }
    }
}

struct NativeWorkspaceDestinationView: View {
    let api: NativeAPI
    let token: String
    let userID: String
    let href: String
    var body: some View {
        Group {
            switch NativeWorkspaceLink(href) {
            case .finance(let path): NativeFinanceRoot(api: api, token: token, userID: userID, initialPath: path, embedded: true)
            case .health: NativeHealthWorkspaceRoot(api: api, token: token, userID: userID)
            case .nutrition: NativeNutritionRoot(api: api, token: token, userID: userID)
            case .review: HealthWeeklyReviewView(api: api, token: token, userID: userID)
            case .life: NativeLifeRoot(api: api, token: token, userID: userID)
            case .settings: NativeSettingsWorkspaceRoot(api: api, token: token, userID: userID)
            case .notifications: NativeNotificationsView(api: api, token: token, userID: userID)
            case .backup: NativeBackupView(api: api, token: token, userID: userID)
            case .sync: NativeHealthSyncWorkspace(api: api, token: token, userID: userID)
            case nil: ContentUnavailableView("暂无对应入口", systemImage: "link", description: Text("请从 App 的健康、财务、书影音或设置入口查看当前资料。"))
            }
        }
    }
}
