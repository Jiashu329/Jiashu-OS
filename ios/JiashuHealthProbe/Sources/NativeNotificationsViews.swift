import Foundation
import SwiftUI

enum NativeNotificationContract {
    static let categories = ["invitations", "collaboration", "sync", "balances"]
    static let labels = ["invitations": "家庭邀请", "collaboration": "协作变更", "sync": "同步结果", "balances": "余额核对"]
    static let defaults = Dictionary(uniqueKeysWithValues: categories.map { ($0, true) })

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
    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID
        _model = StateObject(wrappedValue: NativeNotificationsModel(api: api, token: token, userID: userID))
    }

    var body: some View {
        List {
            Section {
                Picker("消息范围", selection: Binding(get: { model.unreadOnly }, set: { value in Task { await model.filter(unread: value) } })) {
                    Text("全部").tag(false); Text("未读").tag(true)
                }.pickerStyle(.segmented).disabled(model.blocked)
                if !model.feed.isNull {
                    LabeledContent("近期未读", value: String(model.feed["unreadCount"].intValue ?? 0))
                    Button("将当前全部未读标为已读") { Task { await model.markAllVisibleUnread() } }
                        .disabled(model.blocked || model.feed["unreadIds"].arrayValue.isEmpty)
                }
                Button("刷新消息") { Task { await model.load() } }.disabled(model.busy || model.pending != nil)
            }
            if model.loading { Section { ProgressView("读取消息…") } }
            if let pending = model.pending {
                Section("待确认的原操作") {
                    Text(pending.label)
                    Text("原请求已按当前账号加密保存在本机；继续核对不会包含后来到达的新消息。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("继续确认原操作") { Task { await model.retry() } }.disabled(model.busy)
                }
            }
            if let message = model.message { Section { Text(message).foregroundStyle(.secondary).textSelection(.enabled) } }
            if !model.ready {
                Section { Button("重新读取本机待确认操作") { Task { await model.activate(token: token, userID: userID) } } }
            }
            if !model.feed.isNull {
                if !model.feed["unavailable"].arrayValue.isEmpty {
                    Section("部分消息暂不可用") {
                        Text(model.feed["unavailable"].arrayValue.compactMap { NativeNotificationContract.labels[$0.stringValue ?? ""] }.joined(separator: "、"))
                        Text("已显示其他可读取消息；暂不可用不代表没有提醒。").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("消息") {
                    if model.feed["items"].arrayValue.isEmpty { Text("当前范围暂无可见消息。").foregroundStyle(.secondary) }
                    ForEach(Array(model.feed["items"].arrayValue.enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(NativeNotificationContract.labels[item["category"].stringValue ?? ""] ?? "消息").font(.caption).foregroundStyle(.secondary)
                                Spacer(); Text(item["readAt"].isNull ? "未读" : "已读").font(.caption).foregroundStyle(item["readAt"].isNull ? Color.indigo : Color.secondary)
                            }
                            Text(item["title"].stringValue ?? "").font(.headline)
                            Text(item["summary"].stringValue ?? "")
                            Text(NativeWorkspaceFormat.timestamp(item["createdAt"].stringValue)).font(.caption).foregroundStyle(.secondary)
                            if let href = item["href"].stringValue.flatMap(NativeNotificationContract.destination) {
                                NavigationLink("查看相关事项") { NativeWorkspaceDestinationView(api: api, token: token, userID: userID, href: href) }
                                    .disabled(model.busy)
                            }
                            if item["readAt"].isNull, let id = item["id"].stringValue {
                                Button("标为已读") { Task { await model.markRead(ids: [id]) } }.disabled(model.blocked)
                            }
                        }.padding(.vertical, 5)
                    }
                }
                Section {
                    HStack {
                        Button("上一页") { Task { await model.page(max(0, model.offset - 20)) } }.disabled(model.blocked || model.offset == 0)
                        Spacer(); Text("第 \(model.offset / 20 + 1) 页").font(.caption)
                        Spacer(); Button("下一页") { Task { await model.page(model.offset + 20) } }.disabled(model.blocked || model.feed["hasMore"].boolValue != true)
                    }
                    Text("近期最多100条可见提醒；完整修改记录请在对应家庭账本的协作动态查看。")
                        .font(.footnote).foregroundStyle(.secondary)
                    if model.feed["truncated"].boolValue == true { Text("部分较早动态未列入当前消息。").font(.caption).foregroundStyle(.secondary) }
                }
            }
            Section("提醒开关") {
                ForEach(NativeNotificationContract.categories, id: \.self) { category in
                    Toggle(NativeNotificationContract.labels[category] ?? category, isOn: Binding(
                        get: { model.preferences[category] ?? true }, set: { model.setCategory(category, enabled: $0) }))
                        .disabled(model.blocked || model.settingsRevision == nil)
                }
                Button("保存提醒设置") { Task { await model.saveSettings() } }
                    .disabled(model.blocked || model.settingsRevision == nil || model.settingsConflict)
                if model.settingsConflict {
                    Button("保留填写并读取最新版本") { Task { await model.load(rebaseSettings: true) } }.disabled(model.loading || model.busy)
                    Text("读取后对照服务器当前开关，再明确保存自己的选择。").font(.footnote).foregroundStyle(.secondary)
                }
                if model.settingsConflict || model.feed["settings"]["revision"].intValue != model.settingsRevision {
                    ForEach(NativeNotificationContract.categories, id: \.self) { category in
                        LabeledContent("服务器 · " + (NativeNotificationContract.labels[category] ?? category),
                                       value: model.feed["settings"]["categories"][category].boolValue == true ? "开启" : "关闭")
                    }
                }
                Text("只控制站内消息，设置与已读状态跨设备保存；不会发送邮件或浏览器推送。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("消息中心").navigationBarTitleDisplayMode(.inline)
        .task(id: userID + token) { await model.activate(token: token, userID: userID) }
        .refreshable { if model.pending == nil { await model.load() } }
        .onDisappear { model.invalidate() }
    }
}
