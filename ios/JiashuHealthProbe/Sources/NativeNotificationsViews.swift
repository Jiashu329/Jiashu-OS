import Foundation
import SwiftUI

enum NativeNotificationContract {
    static let categories = ["invitations", "collaboration", "sync", "balances"]
    static let labels = ["invitations": "家庭邀请", "collaboration": "协作变更", "sync": "同步结果", "balances": "余额核对"]
    static let defaults = Dictionary(uniqueKeysWithValues: categories.map { ($0, true) })
    static func actionTitle(_ category: String) -> String {
        ["invitations": "查看邀请", "collaboration": "查看变更", "sync": "查看同步中心", "balances": "核对余额"][category] ?? "查看事项"
    }
    static func icon(_ category: String) -> String {
        ["invitations": "person.crop.circle.badge.plus", "collaboration": "person.2", "sync": "arrow.triangle.2.circlepath", "balances": "checkmark.seal"][category] ?? "bell"
    }

    static func validID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 512
            && value.range(of: "^[A-Za-z0-9:._-]+$", options: .regularExpression) != nil
    }

    static func settings(_ value: NativeJSON) throws -> (categories: [String: Bool], revision: Int) {
        guard let revision = value["revision"].intValue, (0..<9_007_199_254_740_991).contains(revision),
              Set(value["categories"].objectValue.keys) == Set(categories),
              categories.allSatisfy({ value["categories"][$0].boolValue != nil }) else { throw NativeAPIError.invalidResponse }
        return (Dictionary(uniqueKeysWithValues: categories.map { ($0, value["categories"][$0].boolValue!) }), revision)
    }

    static func feed(_ value: NativeJSON) throws -> NativeJSON {
        guard case .array(let items) = value["items"], let total = value["total"].intValue, (0...100).contains(total),
              let unreadCount = value["unreadCount"].intValue, (0...100).contains(unreadCount),
              let offset = value["offset"].intValue, (0...1000).contains(offset),
              let limit = value["limit"].intValue, (1...50).contains(limit), items.count <= limit,
              value["hasMore"].boolValue != nil, value["truncated"].boolValue != nil,
              case .array(let unread) = value["unreadIds"], unread.count == unreadCount,
              unread.allSatisfy({ $0.stringValue.map(validID) == true }),
              Set(unread.compactMap(\.stringValue)).count == unread.count,
              case .array(let unavailable) = value["unavailable"],
              unavailable.allSatisfy({ $0.stringValue.map { categories.contains($0) } == true }) else { throw NativeAPIError.invalidResponse }
        _ = try settings(value["settings"])
        var itemIDs = Set<String>()
        for item in items {
            guard let id = item["id"].stringValue, validID(id), itemIDs.insert(id).inserted,
                  let category = item["category"].stringValue, categories.contains(category),
                  item["title"].stringValue != nil, item["summary"].stringValue != nil, item["href"].stringValue != nil,
                  item["createdAt"].stringValue.flatMap(NativeDates.parse) != nil,
                  item["readAt"].isNull || item["readAt"].stringValue.flatMap(NativeDates.parse) != nil else { throw NativeAPIError.invalidResponse }
        }
        return value
    }

    /// Server links become native destinations; credentials never enter a URL.
    static func destination(_ href: String) -> String? {
        guard href == href.trimmingCharacters(in: .whitespacesAndNewlines),
              !href.contains("\\"), !href.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              !href.hasPrefix("//"), let url = URL(string: href, relativeTo: NativeAPI.websiteURL)?.absoluteURL,
              url.scheme == NativeAPI.websiteURL.scheme, url.host == NativeAPI.websiteURL.host,
              url.port == NativeAPI.websiteURL.port, url.user == nil, url.password == nil, url.fragment == nil,
              ["/finance", "/finance/activity", "/finance/balances", "/sync"].contains(url.path),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.percentEncodedPath == url.path else { return nil }
        return parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
    }
}

struct NativeNotificationPending: Codable, Equatable {
    let ownerID: String
    let body: NativeJSON
    var isSettings: Bool { body["action"].stringValue == "settings" }
    var label: String { isSettings ? "保存提醒设置" : "将固定的 \(body["ids"].arrayValue.count) 条消息标为已读" }

    static func read(owner: String, ids: [String]) throws -> Self {
        guard !owner.isEmpty, (1...100).contains(ids.count), ids.allSatisfy(NativeNotificationContract.validID),
              Set(ids).count == ids.count else { throw NativeAPIError.invalidRequest }
        return Self(ownerID: owner, body: .object(["action": .string("read"), "ids": .array(ids.map(NativeJSON.string))]))
    }

    static func settings(owner: String, categories: [String: Bool], revision: Int) throws -> Self {
        guard !owner.isEmpty, Set(categories.keys) == Set(NativeNotificationContract.categories),
              (0..<9_007_199_254_740_991).contains(revision) else { throw NativeAPIError.invalidRequest }
        return Self(ownerID: owner, body: .object(["action": .string("settings"),
            "categories": .object(categories.mapValues(NativeJSON.bool)), "expectedRevision": .integer(revision)]))
    }

    func validate(owner: String) throws {
        guard ownerID == owner else { throw NativeAPIError.invalidRequest }
        if isSettings {
            guard Set(body.objectValue.keys) == ["action", "categories", "expectedRevision"],
                  let revision = body["expectedRevision"].intValue else { throw NativeAPIError.invalidRequest }
            let settings = try NativeNotificationContract.settings(.object(["categories": body["categories"], "revision": .integer(revision)]))
            _ = try Self.settings(owner: owner, categories: settings.categories, revision: settings.revision)
        } else {
            guard body["action"].stringValue == "read", Set(body.objectValue.keys) == ["action", "ids"],
                  case .array(let ids) = body["ids"], ids.allSatisfy({ $0.stringValue != nil }) else { throw NativeAPIError.invalidRequest }
            _ = try Self.read(owner: owner, ids: ids.compactMap(\.stringValue))
        }
    }
}

@MainActor
final class NativeNotificationsModel: ObservableObject {
    @Published private(set) var feed: NativeJSON = .null
    @Published private(set) var pending: NativeNotificationPending?
    @Published private(set) var busy = false
    @Published private(set) var loading = false
    @Published private(set) var ready = false
    @Published private(set) var message: String?
    @Published private(set) var settingsConflict = false
    @Published private(set) var preferences = NativeNotificationContract.defaults
    @Published private(set) var settingsRevision: Int?
    @Published private(set) var unreadOnly = false
    @Published private(set) var offset = 0
    private let api: NativeAPI
    private var token: String
    private(set) var userID: String
    private var generation = UUID()
    private var readID = UUID()
    private var dirty = false
    private var persistence: NativeWorkspacePersistence { .init(userID: userID, scope: "notifications-pending-command") }
    var blocked: Bool { busy || pending != nil || !ready }
    var canSavePreferences: Bool { !blocked && dirty && settingsRevision != nil && !settingsConflict }

    init(api: NativeAPI, token: String, userID: String) { self.api = api; self.token = token; self.userID = userID }

    func activate(token: String, userID: String) async {
        if self.userID != userID {
            invalidate(); self.userID = userID; preferences = NativeNotificationContract.defaults
            settingsRevision = nil; dirty = false; settingsConflict = false; offset = 0; unreadOnly = false
        }
        self.token = token
        do {
            let restored = try persistence.load(NativeNotificationPending.self)
            try restored?.validate(owner: userID)
            pending = restored; ready = true
            if let restored, restored.isSettings {
                let settings = try NativeNotificationContract.settings(.object([
                    "categories": restored.body["categories"], "revision": restored.body["expectedRevision"]]))
                preferences = settings.categories; settingsRevision = settings.revision; dirty = true
            }
        } catch { message = error.localizedDescription; ready = false }
        await load()
    }
    func updateCredential(token: String, userID: String) {
        guard self.userID == userID else { invalidate(); return }
        self.token = token
    }

    func invalidate() { generation = UUID(); readID = UUID(); feed = .null; pending = nil; busy = false; loading = false; ready = false; message = nil }
    func setCategory(_ category: String, enabled: Bool) {
        guard !blocked, NativeNotificationContract.categories.contains(category) else { return }
        preferences[category] = enabled; dirty = true
    }
    func filter(unread: Bool) async { guard !blocked else { return }; unreadOnly = unread; offset = 0; await load() }
    func page(_ offset: Int) async { guard !blocked, (0...1000).contains(offset) else { return }; self.offset = offset; await load() }

    func load(rebaseSettings: Bool = false) async {
        guard !busy else { return }
        let epoch = generation, identifier = UUID(), owner = userID, credential = token
        readID = identifier; loading = true
        defer { if generation == epoch && readID == identifier { loading = false } }
        var query = ["offset": String(offset), "limit": "20"]
        if unreadOnly { query["unread"] = "1" }
        do {
            let result = try NativeNotificationContract.feed(await api.json(path: "notifications?" + NativeWorkspaceFormat.query(query), token: credential))
            guard generation == epoch, readID == identifier, userID == owner, !Task.isCancelled else { return }
            let total = result["total"].intValue!
            if offset > 0 && offset >= total { offset = max(0, (max(1, total) - 1) / 20 * 20); await load(rebaseSettings: rebaseSettings); return }
            feed = result
            let settings = try NativeNotificationContract.settings(result["settings"])
            if !dirty && pending?.isSettings != true { preferences = settings.categories; settingsRevision = settings.revision }
            if rebaseSettings && pending == nil {
                settingsRevision = settings.revision; settingsConflict = false
                message = "已读取服务器最新版本并保留填写，请对照当前设置后再次保存。"
            }
        } catch {
            guard generation == epoch, readID == identifier, userID == owner, !Task.isCancelled else { return }
            message = error.localizedDescription
        }
    }

    func markRead(ids: [String]) async {
        do { try await submit(.read(owner: userID, ids: ids)) }
        catch { message = error.localizedDescription }
    }
    func markAllVisibleUnread() async {
        // Snapshot the original IDs. Retrying readAll would also consume new arrivals.
        await markRead(ids: feed["unreadIds"].arrayValue.compactMap(\.stringValue))
    }
    func saveSettings() async {
        guard let revision = settingsRevision, !settingsConflict else { return }
        do { try await submit(.settings(owner: userID, categories: preferences, revision: revision)) }
        catch { message = error.localizedDescription }
    }
    func retry() async { guard let pending else { return }; do { try await submit(pending) } catch { message = error.localizedDescription } }

    private func submit(_ command: NativeNotificationPending) async throws {
        guard !busy, ready, pending == nil || pending == command else { return }
        try command.validate(owner: userID)
        try persistence.save(command); pending = command
        let epoch = generation, owner = userID, credential = token
        readID = UUID(); busy = true; message = nil
        do {
            let result = try await api.json(path: "notifications", method: "POST", token: credential, body: command.body)
            guard generation == epoch, userID == owner else { return }
            if command.isSettings {
                let settings = try NativeNotificationContract.settings(result["settings"])
                guard result["settings"]["categories"] == command.body["categories"] else { throw NativeAPIError.invalidResponse }
                settingsRevision = settings.revision; preferences = settings.categories; dirty = false; settingsConflict = false
            } else { guard result["ok"].boolValue == true else { throw NativeAPIError.invalidResponse } }
            try persistence.clear(); pending = nil; busy = false
            message = "操作已确认。"; await load()
        } catch {
            guard generation == epoch, userID == owner else { return }
            busy = false
            if case NativeAPIError.server(let status, _, _, _) = error, [400, 404, 409, 413, 415, 422].contains(status) {
                do { try persistence.clear(); pending = nil }
                catch { message = error.localizedDescription; return }
                if command.isSettings && status == 409 { settingsConflict = true; dirty = true }
                message = error.localizedDescription + (settingsConflict ? " 填写已保留，请先读取最新版本。" : " 请刷新消息后重新选择。")
                if !command.isSettings { await load() }
            } else { message = error.localizedDescription + " 原操作已安全保留，只会继续确认同一批消息或同一版设置。" }
        }
    }
}

struct NativeNotificationsView: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @StateObject private var model: NativeNotificationsModel
    @State private var preferencesVisible = false
    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID
        _model = StateObject(wrappedValue: NativeNotificationsModel(api: api, token: token, userID: userID))
    }
    var body: some View {
        List {
            Section {
                Picker("消息范围", selection: Binding(get: { model.unreadOnly }, set: { value in Task { await model.filter(unread: value) } })) {
                    Text("全部").tag(false); Text("未读 \(model.feed["unreadCount"].intValue ?? 0)").tag(true)
                }.pickerStyle(.segmented).disabled(model.blocked)
            }
            if let pending = model.pending {
                Section("结果待确认") {
                    Text(pending.label).font(.subheadline)
                    Button("继续确认") { Task { await model.retry() } }.disabled(model.busy)
                }
            }
            if let message = model.message, message != "操作已确认。" { Section { Text(message).font(.footnote).foregroundStyle(.secondary) } }
            if !model.ready { Section { Button("重试") { Task { await model.activate(token: token, userID: userID) } } } }
            if model.loading && model.feed.isNull { Section { ProgressView() } }
            if !model.feed.isNull {
                if !model.feed["unavailable"].arrayValue.isEmpty {
                    Section {
                        Label("部分提醒暂未读取", systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(.orange)
                        Button("重试读取") { Task { await model.load() } }.disabled(model.busy)
                    }
                }
                Section {
                    if model.feed["items"].arrayValue.isEmpty {
                        ContentUnavailableView(model.unreadOnly ? "未读消息已处理完" : "暂无消息", systemImage: "tray", description: Text("家庭邀请和待核对事项会显示在这里。"))
                    }
                    ForEach(Array(model.feed["items"].arrayValue.enumerated()), id: \.offset) { _, item in
                        notification(item)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                if item["readAt"].isNull, let id = item["id"].stringValue { Button { Task { await model.markRead(ids: [id]) } } label: { Label("已读", systemImage: "envelope.open") }.tint(NativePalette.accent).disabled(model.blocked) }
                            }
                    }
                }
                if model.offset > 0 || model.feed["hasMore"].boolValue == true {
                    Section {
                        HStack {
                            Button("上一页") { Task { await model.page(max(0, model.offset - 20)) } }.disabled(model.blocked || model.offset == 0)
                            Spacer(); Text("\(model.offset / 20 + 1)").font(.caption).foregroundStyle(.secondary)
                            Spacer(); Button("下一页") { Task { await model.page(model.offset + 20) } }.disabled(model.blocked || model.feed["hasMore"].boolValue != true)
                        }
                    }
                }
                if model.feed["truncated"].boolValue == true { Section { Text("更早的家庭变更可在账本动态中查看。").font(.footnote).foregroundStyle(.secondary) } }
            }
        }
        .nativeGeometricPage().navigationTitle("消息")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("提醒设置", systemImage: "bell.badge") { preferencesVisible = true }
                    Button("全部标为已读", systemImage: "envelope.open") { Task { await model.markAllVisibleUnread() } }.disabled(model.blocked || model.feed["unreadIds"].arrayValue.isEmpty)
                    Button("刷新", systemImage: "arrow.clockwise") { Task { await model.load() } }.disabled(model.busy || model.pending != nil)
                } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("消息选项")
            }
        }
        .sheet(isPresented: $preferencesVisible) { NavigationStack { NativeNotificationPreferencesView(model: model) } }
        .task(id: userID) { await model.activate(token: token, userID: userID) }
        .onChange(of: token) { _, value in model.updateCredential(token: value, userID: userID) }
        .refreshable { if model.pending == nil { await model.load() } }
        .onDisappear { model.invalidate() }
    }
    @ViewBuilder private func notification(_ item: NativeJSON) -> some View {
        if let href = item["href"].stringValue.flatMap(NativeNotificationContract.destination) {
            NavigationLink { NativeWorkspaceDestinationView(api: api, token: token, userID: userID, href: href) } label: { NativeNotificationRow(item: item) }.disabled(model.busy)
        } else { NativeNotificationRow(item: item) }
    }
}

private struct NativeNotificationRow: View {
    let item: NativeJSON
    private var category: String { item["category"].stringValue ?? "" }
    private var unread: Bool { item["readAt"].isNull }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: NativeNotificationContract.icon(category)).font(.title3).foregroundStyle(NativePalette.accent)
                .frame(width: 38, height: 38).background(.indigo.opacity(0.08), in: RoundedRectangle(cornerRadius: 11))
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline) {
                    Text(item["title"].stringValue ?? "").font(.subheadline.weight(unread ? .semibold : .regular)).foregroundStyle(.primary)
                    if unread { Circle().fill(.indigo).frame(width: 7, height: 7).accessibilityLabel("未读") }
                }
                Text(item["summary"].stringValue ?? "").font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                HStack {
                    Text(NativeNotificationContract.actionTitle(category)).font(.caption.weight(.medium)).foregroundStyle(NativePalette.accent)
                    Spacer()
                    Text(NativeWorkspaceFormat.timestamp(item["createdAt"].stringValue)).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }.padding(.vertical, 7).accessibilityElement(children: .combine)
    }
}

private struct NativeNotificationPreferencesView: View {
    @ObservedObject var model: NativeNotificationsModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        Form {
            Section {
                ForEach(NativeNotificationContract.categories, id: \.self) { category in
                    Toggle(NativeNotificationContract.labels[category] ?? category, isOn: Binding(get: { model.preferences[category] ?? true }, set: { model.setCategory(category, enabled: $0) })).disabled(model.blocked || model.settingsRevision == nil)
                }
            } footer: { Text("仅控制站内提醒，不发送系统推送。") }
            if model.settingsConflict {
                Section("设置已在其他设备更新") {
                    Button("保留填写并核对最新设置") { Task { await model.load(rebaseSettings: true) } }.disabled(model.loading || model.busy)
                    DisclosureGroup("服务器当前设置") {
                        ForEach(NativeNotificationContract.categories, id: \.self) { category in LabeledContent(NativeNotificationContract.labels[category] ?? category, value: model.feed["settings"]["categories"][category].boolValue == true ? "开启" : "关闭") }
                    }
                }
            }
            if let pending = model.pending { Section("结果待确认") { Text(pending.label).font(.subheadline); Button("继续确认") { Task { await model.retry() } }.disabled(model.busy) } }
            if let message = model.message { Section { Text(message == "操作已确认。" ? "已保存" : message).font(.footnote).foregroundStyle(.secondary) } }
        }
        .nativeGeometricPage().navigationTitle("提醒设置").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await model.saveSettings() } }.disabled(!model.canSavePreferences) }
        }
    }
}
