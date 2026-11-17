import SwiftUI

struct NativeSettingsWorkspaceRoot: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @State private var identity: NativeJSON = .null
    @State private var error: String?
    var body: some View {
        List {
            if let error { Section { NativeInlineNotice(error, tone: .error); Button("重试") { Task { await load() } } } }
            Section("账号") {
                if identity.isNull && error == nil { ProgressView() }
                else if !identity.isNull {
                    LabeledContent("邮箱", value: identity["email"].stringValue ?? "—")
                    LabeledContent("权限", value: identity["isOwner"].boolValue == true ? "站点管理员" : "成员")
                }
            }
            if identity["isOwner"].boolValue == true {
                Section("站点管理") {
                    NavigationLink { NativeProviderSettingsView(api: api, token: token, userID: userID, kind: .ai) } label: { Label("AI 服务", systemImage: "sparkles") }
                    NavigationLink { NativeProviderSettingsView(api: api, token: token, userID: userID, kind: .media) } label: { Label("影视资料服务", systemImage: "photo") }
                    NavigationLink { NativeUsersManagementView(api: api, token: token, userID: userID) } label: { Label("登录用户", systemImage: "person.badge.key") }
                    NavigationLink { NativeAccessManagementView(api: api, token: token, userID: userID) } label: { Label("站点访问名单", systemImage: "person.2.badge.gearshape") }
                }
            }
        }.nativeGeometricPage().navigationTitle("账号与服务").task { await load() }.refreshable { await load() }
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
        else if path == "/health/sync" || path == "/health/import-history" { self = .sync }
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
    @EnvironmentObject private var appModel: NativeAppModel
    let api: NativeAPI
    let token: String
    let userID: String
    let href: String
    var body: some View {
        Group {
            switch NativeWorkspaceLink(href) {
            case .finance(let path): NativeFinanceRoot(api: api, token: token, userID: userID, initialPath: path, embedded: true)
            case .health: healthDestination
            case .nutrition: NativeNutritionRoot(api: api, token: token, userID: userID, initialCompose: query("compose") == "1")
            case .review: HealthWeeklyReviewView(api: api, token: token, userID: userID, initialWeek: query("week"))
            case .life: NativeLifeRoot(api: api, token: token, userID: userID)
            case .settings: NativeSettingsWorkspaceRoot(api: api, token: token, userID: userID)
            case .notifications: NativeNotificationsView(api: api, token: token, userID: userID)
            case .backup: NativeBackupView(api: api, token: token, userID: userID)
            case .sync: NativeSyncCenter(model: appModel)
            case nil: ContentUnavailableView("暂无对应入口", systemImage: "link", description: Text("请从 App 的健康、财务、书影音或设置入口查看当前资料。"))
            }
        }
    }
    private func query(_ key: String) -> String? {
        let items = URLComponents(string: href)?.queryItems?.filter { $0.name == key } ?? []
        return items.count == 1 ? items[0].value : nil
    }
    @ViewBuilder private var healthDestination: some View {
        switch URL(string: href, relativeTo: NativeAPI.websiteURL)?.path {
        case "/health/records": NativeHealthRecordsWorkspace(api: api, token: token, userID: userID, initialMetric: query("metric"), compose: query("compose") == "1")
        case "/health/goals": NativeHealthGoalsWorkspace(api: api, token: token, userID: userID)
        case "/health/weight-plan": NativeWeightPlanWorkspace(api: api, token: token, userID: userID)
        case "/health/assistant": NativeHealthAssistantWorkspace(api: api, token: token, userID: userID)
        default: NativeHealthRangeWorkspace(api: api, token: token, userID: userID, initialMetric: query("metric"))
        }
    }
}
