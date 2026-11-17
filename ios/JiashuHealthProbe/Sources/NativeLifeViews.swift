import SwiftUI
import UniformTypeIdentifiers

struct NativeLifePending: Codable {
    let owner: String
    let label: String
    let path: String
    let method: String
    let body: NativeJSON
}

@MainActor
final class NativeLifeStore: ObservableObject {
    let api: NativeAPI
    let userID: String
    private(set) var token: String
    @Published var filters = NativeLifeFilters()
    @Published var items: [NativeLifeItem] = []
    @Published private(set) var detailItems: [String: NativeLifeItem] = [:]
    @Published var response: NativeJSON = .null
    @Published var busy = false
    @Published var loading = false
    @Published var error: String?
    @Published var notice: String?
    @Published var pending: NativeLifePending?
    @Published var syncing = false
    @Published var completing = false
    @Published var lastMutation: NativeJSON = .null
    private var active = true
    private var loadID = UUID()
    private var syncTask: Task<Void, Never>?
    private var pendingStorage: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: userID, scope: "life-pending") }
    var epoch: Int { response["dataEpoch"].intValue ?? 0 }
    var connection: NativeJSON { response["connection"] }
    var run: NativeJSON { response["lastRun"] }
    var total: Int { response["total"].intValue ?? 0 }

    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID
        do { if let restored = try pendingStorage.load(NativeLifePending.self), restored.owner == userID { pending = restored } }
        catch { self.error = error.localizedDescription }
    }
    func activate(token: String, userID: String) {
        guard self.userID == userID else { deactivate(); return }
        self.token = token; active = true
    }
    func deactivate() {
        active = false; loadID = UUID(); syncTask?.cancel(); syncTask = nil; syncing = false; completing = false
        items = []; detailItems = [:]; response = .null; pending = nil; notice = nil; error = nil
    }
    func fail(_ error: Error) { if active { self.error = error.localizedDescription } }
    func load(more: Bool = false) async {
        guard active else { return }
        let identity = UUID(); loadID = identity; loading = true
        let offset = more ? items.count : 0, path = filters.path(offset: offset)
        do {
            let result = try await api.json(path: path, token: token)
            guard active, loadID == identity, !Task.isCancelled else { return }
            if result["dataEpoch"].intValue != response["dataEpoch"].intValue { detailItems = [:] }
            response = result
            let incoming = result["items"].arrayValue.map { NativeLifeItem(raw: $0) }
            for item in incoming { detailItems[item.id] = item }
            if more { let existing = Set(items.map(\.id)); items += incoming.filter { !existing.contains($0.id) } }
            else { items = incoming }
            error = nil
        } catch { if loadID == identity { fail(error) } }
        if loadID == identity { loading = false }
    }
    func merge(_ item: NativeJSON) {
        guard !item.objectValue.isEmpty else { return }
        let value = NativeLifeItem(raw: item)
        detailItems[value.id] = value
        if let index = items.firstIndex(where: { $0.id == value.id }) { items[index] = value }
    }
    func accept(_ result: NativeJSON, path: String) {
        lastMutation = result
        merge(result["item"])
        for item in result["items"].arrayValue { merge(item) }
        var fields = response.objectValue
        if !result["connection"].objectValue.isEmpty { fields["connection"] = result["connection"] }
        if !result["run"].objectValue.isEmpty { fields["lastRun"] = result["run"] }
        if let epoch = result["dataEpoch"].intValue { fields["dataEpoch"] = .number(Double(epoch)) }
        response = .object(fields)
        if let message = result["metadata"]["message"].stringValue ?? result["tmdb"]["message"].stringValue { notice = message }
        else if !result["receipt"].objectValue.isEmpty { notice = "操作已确认保存。" }
        else { notice = "已完成。" }
    }
    @discardableResult
    func mutate(label: String, path: String, method: String = "POST", body: NativeJSON) async -> Bool {
        guard active, !busy, pending == nil else { return false }
        let operation = NativeLifePending(owner: userID, label: label, path: path, method: method, body: body)
        do { try pendingStorage.save(operation) } catch { fail(error); return false }
        pending = operation
        return await submit(operation)
    }
    @discardableResult
    func submit(_ operation: NativeLifePending) async -> Bool {
        guard active, operation.owner == userID, !busy else { return false }
        busy = true; error = nil
        do {
            let result: NativeJSON
            let encoded = try operation.body.encodedData()
            if operation.path.hasSuffix("/import") && encoded.count > 512 * 1024 {
                result = try await api.upload(path: operation.path, method: operation.method, token: token, data: encoded)
            } else { result = try await api.json(path: operation.path, method: operation.method, token: token, body: operation.body) }
            guard active, !Task.isCancelled else { busy = false; return false }
            try pendingStorage.clear(); pending = nil; busy = false; accept(result, path: operation.path)
            if !operation.path.hasSuffix("/sync") { await load() }
            return true
        } catch {
            guard active else { busy = false; return false }
            busy = false
            // Re-read before repeating a CAS-only write: successful writes can lose
            // their response. Never turn a changed revision into another mutation.
            if operation.path.hasSuffix("/library") || operation.path.hasSuffix("/cover-selection") || operation.path.hasSuffix("/connection") {
                if await reconcile(operation) { try? pendingStorage.clear(); pending = nil; notice = "已核对原操作保存成功。"; return true }
            }
            if case NativeAPIError.server(let status, _, _, _) = error, (400..<500).contains(status), status != 408, status != 429 {
                try? pendingStorage.clear(); pending = nil
            }
            self.error = error.localizedDescription
            return false
        }
    }
    func reconcile(_ operation: NativeLifePending) async -> Bool {
        guard active, operation.owner == userID else { return false }
        if operation.path.hasSuffix("/connection") {
            guard let result = try? await api.json(path: "life/douban?limit=1", token: token), active else { return false }
            let requested = operation.body["profile"].stringValue
            let desired = requested.flatMap { try? NativeLifeContract.profileID($0) }
            guard result["connection"]["profileId"].stringValue == desired,
                  (result["connection"]["revision"].intValue ?? -1) >= (operation.body["expectedRevision"].intValue ?? 0) else { return false }
            var fields = response.objectValue; fields["connection"] = result["connection"]; response = .object(fields); return true
        }
        let subject = operation.body["subjectId"].stringValue ?? ""
        guard !subject.isEmpty else { return false }
        var parts = URLComponents(); parts.path = "life/douban"; parts.queryItems = [URLQueryItem(name: "q", value: subject), URLQueryItem(name: "hidden", value: "all"), URLQueryItem(name: "limit", value: "50")]
        // Title search does not include the numeric identifier. Use the selected
        // item's title, then check the complete owner/profile/domain/id key.
        if let item = items.first(where: { $0.subjectID == subject && $0.profile == operation.body["profileId"].stringValue }) { parts.queryItems?[0].value = item.title }
        guard let path = parts.string, let result = try? await api.json(path: path, token: token), active,
              result["dataEpoch"].intValue == operation.body["expectedDataEpoch"].intValue,
              let raw = result["items"].arrayValue.first(where: { $0["profileId"].stringValue == operation.body["profileId"].stringValue && $0["domain"].stringValue == operation.body["domain"].stringValue && $0["subjectId"].stringValue == subject }) else { return false }
        let matched: Bool
        if operation.path.hasSuffix("/library") {
            matched = raw["local"]["note"] == operation.body["note"] && raw["local"]["tags"] == operation.body["tags"] && raw["local"]["hidden"] == operation.body["hidden"]
        } else { matched = raw["cover"]["mode"] == operation.body["mode"] && (operation.body["mode"].stringValue != "url" || raw["cover"]["url"] == operation.body["url"]) }
        if matched { merge(raw) }; return matched
    }
    func retryPending() async { guard let pending, pending.owner == userID else { return }; _ = await submit(pending) }
    func startSync() {
        guard !syncing, !busy, pending == nil, active else { return }
        syncing = true
        syncTask = Task { [weak self] in
            guard let self else { return }
            if self.run["status"].stringValue != "running" {
                let body = NativeJSON.object(["expectedConnectionRevision": self.connection["revision"]])
                guard await self.mutate(label: "开始公开同步", path: "life/douban/sync", body: body) else { self.syncing = false; return }
            }
            for _ in 0..<20 {
                guard self.active, self.syncing, !Task.isCancelled, self.run["status"].stringValue == "running" else { break }
                do { try await Task.sleep(nanoseconds: 1_500_000_000) } catch { break }
                guard self.syncing, !Task.isCancelled else { break }
                let body = NativeJSON.object(["expectedConnectionRevision": self.connection["revision"], "runId": self.run["id"], "expectedRunRevision": self.run["revision"]])
                if !(await self.mutate(label: "推进公开同步", path: "life/douban/sync", body: body)) { break }
            }
            self.syncing = false
            if self.active { await self.load() }
        }
    }
    func pause() { syncing = false; completing = false; syncTask?.cancel(); syncTask = nil }
    func completePage(full: Bool) {
        guard !busy, pending == nil, !syncing, !completing else { return }
        let queue = items; completing = true
        syncTask = Task { [weak self] in
            guard let self else { return }
            for original in queue {
                guard self.active, self.completing, !Task.isCancelled else { break }
                let current = self.items.first(where: { $0.id == original.id }) ?? original
                let checkAt = current.raw["sync"]["detailsCheckedAt"].stringValue.flatMap(NativeDates.parse)
                if !full, let checkAt, Date().timeIntervalSince(checkAt) < 7 * 86400 { continue }
                guard await self.mutate(label: "补全作品资料", path: "life/douban/metadata", body: NativeLifeContract.metadataBody(item: current, epoch: self.epoch, includeCheck: true)) else { break }
                do { try await Task.sleep(nanoseconds: 1_500_000_000) } catch { break }
            }
            self.completing = false
        }
    }
}

struct NativeLifeRoot: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @StateObject private var store: NativeLifeStore
    @State private var filtersVisible = false
    @State private var managementVisible = false
    @State private var selected = Set<String>()
    @State private var bulkKind = "movie"
    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID
        _store = StateObject(wrappedValue: NativeLifeStore(api: api, token: token, userID: userID))
    }
    var body: some View {
        List {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(NativeLifeContract.kinds, id: \.self) { kind in
                            Button {
                                store.filters.kind = kind; selected.removeAll(); Task { await store.load() }
                            } label: { Text((NativeLifeContract.kindLabels[kind] ?? kind) + " " + String(store.response["counts"][kind].intValue ?? 0)).font(.subheadline).padding(.horizontal, 12).padding(.vertical, 8).background(store.filters.kind == kind ? Color.indigo.opacity(0.18) : Color.secondary.opacity(0.08), in: Capsule()) }
                                .buttonStyle(.plain)
                        }
                    }
                }
                HStack {
                    Label("已保存 \(store.total) 部作品", systemImage: "books.vertical")
                    Spacer()
                    Button("筛选", systemImage: "line.3.horizontal.decrease.circle") { filtersVisible = true }.labelStyle(.iconOnly)
                }
                Text("我的完成收藏 · 个人整理仅保存在本站").font(.caption).foregroundStyle(.secondary)
            }
            if let pending = store.pending {
                Section("待确认的原操作") {
                    Text(pending.label)
                    Text("保留原提交内容与标识，重试会核对这次操作。").font(.caption).foregroundStyle(.secondary)
                    Button("重试并核对原操作") { Task { await store.retryPending() } }.disabled(store.busy)
                }
            }
            if let error = store.error { Section { Text(error).foregroundStyle(.red); Button("重新读取收藏") { Task { await store.load() } } } }
            if let notice = store.notice { Section { Text(notice).font(.footnote).foregroundStyle(.secondary) } }
            if store.loading && store.items.isEmpty { ProgressView("正在读取收藏…") }
            if !store.loading && store.items.isEmpty {
                ContentUnavailableView("暂无符合条件的收藏", systemImage: "books.vertical", description: Text("调整筛选，或从同步与导入接入本人已完成收藏。"))
            }
            Section {
                ForEach(store.items) { item in
                    HStack(alignment: .top, spacing: 12) {
                        if item.domain == "screen" {
                            Button { if !selected.insert(item.id).inserted { selected.remove(item.id) } } label: { Image(systemName: selected.contains(item.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(selected.contains(item.id) ? Color.indigo : Color.secondary) }.buttonStyle(.borderless).accessibilityLabel("选择" + item.title)
                        }
                        NavigationLink {
                            NativeLifeDetail(store: store, initial: item)
                        } label: { NativeLifeRow(store: store, item: item) }
                    }
                }
                if store.response["hasMore"].boolValue == true { Button("加载更多") { Task { await store.load(more: true) } }.disabled(store.loading) }
            } header: { Text("收藏库") }
            if !selected.isEmpty {
                Section("整理已选 \(selected.count) 部影视") {
                    Picker("归类为", selection: $bulkKind) { Text("电影").tag("movie"); Text("电视剧").tag("series") }
                    Button("确认批量分类") { bulkClassify() }.disabled(store.busy || store.pending != nil || selected.count > 24)
                    Button("取消选择") { selected.removeAll() }
                }
            }
            Section("更新当前页") {
                Button("增量补全作品资料") { store.completePage(full: false) }.disabled(store.busy || store.completing || store.pending != nil)
                Button("完整刷新当前页作品资料") { store.completePage(full: true) }.disabled(store.busy || store.completing || store.pending != nil)
                Button("更新当前页 IMDb 评分") { refreshRatings() }.disabled(store.busy || store.pending != nil || !store.items.contains(where: { $0.domain == "screen" && $0.raw["details"]["imdbId"].stringValue != nil }))
                if store.completing { Button("暂停资料补全") { store.pause() }; ProgressView("按作品逐条补全…") }
            }
        }
        .navigationTitle("书影音")
        .searchable(text: $store.filters.query, prompt: "作品、创作者、短评或标签")
        .onSubmit(of: .search) { selected.removeAll(); Task { await store.load() } }
        .onChange(of: store.filters.query) { _, value in if value.isEmpty { Task { await store.load() } } }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("同步与导入", systemImage: "arrow.triangle.2.circlepath") { managementVisible = true } } }
        .refreshable { await store.load() }
        .sheet(isPresented: $filtersVisible) { NavigationStack { NativeLifeFilterSheet(store: store) } }
        .sheet(isPresented: $managementVisible) { NavigationStack { NativeLifeManagement(store: store) } }
        .task(id: userID + ":" + token) { store.activate(token: token, userID: userID); await store.load() }
        .onDisappear { store.pause() }
    }
    private func bulkClassify() {
        let values = store.items.filter { selected.contains($0.id) }.map { item -> NativeJSON in var key = item.key; key["expectedUpdatedAt"] = .string(item.updatedAt); return .object(key) }
        let body = NativeJSON.object(["action": .string("classify"), "kind": .string(bulkKind), "expectedDataEpoch": .number(Double(store.epoch)), "items": .array(values)])
        Task { if await store.mutate(label: "批量影视分类", path: "life/douban/library", body: body) { selected.removeAll() } }
    }
    private func refreshRatings() { let body = NativeLifeContract.ratingsBody(items: store.items, epoch: store.epoch); Task { await store.mutate(label: "更新当前页评分", path: "life/douban/imdb-ratings", body: body) } }
}

private struct NativeLifeFilterSheet: View {
    @ObservedObject var store: NativeLifeStore
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        Form {
            Picker("来源", selection: $store.filters.profile) { Text("全部已保存来源").tag("all"); Text("当前绑定主页").tag("current") }
            Picker("我的评分", selection: $store.filters.rating) { Text("全部评分").tag(""); Text("未评分").tag("unrated"); ForEach(1...5, id: \.self) { Text("\($0) 星").tag(String($0)) } }
            Picker("豆瓣标记年份", selection: $store.filters.year) { Text("全部年份").tag(""); ForEach(store.response["years"].arrayValue.compactMap(\.intValue), id: \.self) { Text(String($0)).tag(String($0)) } }
            Picker("排序", selection: $store.filters.sort) { Text("标记日期从近到远").tag("date-desc"); Text("标记日期从远到近").tag("date-asc"); Text("个人评分从高到低").tag("rating-desc"); Text("个人评分从低到高").tag("rating-asc") }
            Picker("展示范围", selection: $store.filters.hidden) { Text("未隐藏").tag("visible"); Text("已隐藏").tag("hidden"); Text("全部").tag("all") }
            Picker("标签", selection: $store.filters.tag) { Text("全部标签").tag(""); ForEach(store.response["tags"].arrayValue.compactMap(\.stringValue), id: \.self) { Text($0).tag($0) } }
            Toggle("只看资料待补全", isOn: $store.filters.missing)
            Text("标记日期未知的作品不会归入某一年。").font(.caption).foregroundStyle(.secondary)
            Button("清除筛选") { store.filters = NativeLifeFilters() }
        }
        .navigationTitle("筛选与排序")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("查看收藏") { dismiss(); Task { await store.load() } } } }
    }
}

private struct NativeLifeRow: View {
    @ObservedObject var store: NativeLifeStore
    let item: NativeLifeItem
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            NativeLifeCover(api: store.api, token: store.token, item: item).frame(width: 68, height: 96).clipShape(RoundedRectangle(cornerRadius: 7))
            VStack(alignment: .leading, spacing: 6) {
                Text(item.title).font(.headline).lineLimit(3)
                Text(item.kindLabel + (item.raw["markedDate"].stringValue.map { " · " + $0 } ?? "")).font(.caption).foregroundStyle(.secondary)
                if let rating = item.raw["rating"].intValue { Text(String(repeating: "★", count: max(0, min(rating, 5)))).foregroundStyle(.orange) }
                HStack { if let score = item.raw["details"]["doubanRating"].doubleValue { Text("豆瓣 \(score, specifier: "%.1f")") }; if let score = item.raw["imdb"]["rating"].doubleValue { Text("IMDb \(score, specifier: "%.1f")") } }.font(.caption2).foregroundStyle(.secondary)
                if !item.tags.isEmpty { Text(item.tags.joined(separator: " · ")).font(.caption).foregroundStyle(.indigo) }
            }
            Spacer(minLength: 0)
        }.padding(.vertical, 5)
    }
}

private struct NativeLifeCover: View {
    let api: NativeAPI
    let token: String
    let item: NativeLifeItem
    @State private var image: UIImage?
    @State private var failed = false
    @State private var retry = 0
    private var publicURL: URL? {
        if item.raw["cover"]["mode"].stringValue == "url" { return NativeLifeContract.publicImageURL(item.raw["cover"]["url"].stringValue) }
        let url = NativeLifeContract.publicImageURL(item.raw["tmdbCoverUrl"].stringValue)
        return url?.host == "image.tmdb.org" ? url : nil
    }
    var body: some View {
        ZStack {
            Color.secondary.opacity(0.08)
            if let publicURL {
                // AsyncImage has no authenticated headers. Never pass API tokens
                // to user-selected images or TMDB's public image host.
                AsyncImage(url: publicURL) { phase in
                    if let image = phase.image { image.resizable().scaledToFit() }
                    else if phase.error != nil { Image(systemName: "photo.badge.exclamationmark").foregroundStyle(.secondary) }
                    else { ProgressView() }
                }
            } else if let image { Image(uiImage: image).resizable().scaledToFit() }
            else if failed { Button { retry += 1 } label: { Image(systemName: "arrow.clockwise").foregroundStyle(.secondary) }.buttonStyle(.plain).accessibilityLabel("重试封面") }
            else if item.raw["coverUrl"].stringValue != nil { ProgressView() }
            else { Image(systemName: "photo").foregroundStyle(.secondary) }
        }
        .task(id: item.id + ":" + item.updatedAt + ":" + String(retry)) {
            guard publicURL == nil, item.raw["coverUrl"].stringValue != nil else { return }
            image = nil; failed = false
            do {
                let data = try await api.download(path: NativeLifeContract.protectedCoverPath(item: item), token: token)
                guard !Task.isCancelled, data.mimeType.hasPrefix("image/"), data.data.count <= 4 * 1024 * 1024, let loaded = UIImage(data: data.data) else { return }
                image = loaded
            } catch { if !Task.isCancelled { failed = true } }
        }
    }
}

private struct NativeLifeDetail: View {
    @ObservedObject var store: NativeLifeStore
    let initial: NativeLifeItem
    @State private var section = "work"
    @State private var note = ""
    @State private var tags = ""
    @State private var hidden = false
    @State private var kind = "movie"
    @State private var coverURL = ""
    @State private var previewedCover: String?
    @State private var previewVisible = false
    @State private var dirty = false
    @State private var loaded = false
    @State private var confirmRestore = false
    private var draftStorage: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: store.userID, scope: "life-item-" + initial.id) }
    private var item: NativeLifeItem { store.detailItems[initial.id] ?? store.items.first(where: { $0.id == initial.id }) ?? initial }
    private var writable: Bool { !store.busy && store.pending == nil && !store.syncing && !store.completing }
    var body: some View {
        Form {
            Section {
                NativeLifeCover(api: store.api, token: store.token, item: item).frame(maxWidth: .infinity).frame(height: 240)
                Text(item.title).font(.title2.bold()).textSelection(.enabled)
                Text(item.kindLabel).foregroundStyle(.secondary)
                Picker("作品区域", selection: $section) { Text("作品资料").tag("work"); Text("我的记录").tag("mine"); Text("资料管理").tag("manage") }.pickerStyle(.segmented)
            }
            if section == "work" { workDetails }
            if section == "mine" { personalDetails }
            if section == "manage" { management }
            if let pending = store.pending { Section("待确认") { Text(pending.label); Button("核对原操作") { Task { await store.retryPending() } }.disabled(store.busy) } }
            if let error = store.error { Text(error).foregroundStyle(.red) }
            if let notice = store.notice { Text(notice).foregroundStyle(.secondary).font(.footnote) }
        }
        .navigationTitle(item.title).navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !loaded else { return }; loaded = true
            note = item.note; tags = item.tags.joined(separator: ", "); hidden = item.hidden
            kind = item.kind == "series" ? "series" : "movie"; coverURL = item.raw["cover"]["url"].stringValue ?? ""
            do {
                if let draft = try draftStorage.load(NativeLifeLocalDraft.self) {
                    note = draft.note; tags = draft.tags; hidden = draft.hidden; kind = draft.kind; coverURL = draft.coverURL
                    dirty = note != item.note || tags != item.tags.joined(separator: ", ") || hidden != item.hidden
                    store.notice = "已恢复此账号在本机未完成的整理。"
                }
            } catch { store.fail(error) }
        }
        .onChange(of: note) { _, _ in saveDraft() }
        .onChange(of: tags) { _, _ in saveDraft() }
        .onChange(of: hidden) { _, _ in saveDraft() }
        .onChange(of: kind) { _, _ in saveDraft() }
        .onChange(of: coverURL) { _, _ in saveDraft() }
        .confirmationDialog("恢复豆瓣原封面？", isPresented: $confirmRestore) { Button("确认恢复原封面") { saveCover(original: true) }; Button("取消", role: .cancel) {} } message: { Text("只修改这部作品在本站使用的封面，不影响其他资料。") }
    }
    private var workDetails: some View {
        Group {
            Section("作品评分") {
                if let rating = item.raw["details"]["doubanRating"].doubleValue { LabeledContent("豆瓣", value: String(format: "%.1f / 10", rating)) }
                if let rating = item.raw["imdb"]["rating"].doubleValue { LabeledContent("IMDb", value: String(format: "%.1f / 10", rating)); if let count = item.raw["imdb"]["ratingCount"].intValue { LabeledContent("IMDb 评分人数", value: String(count)) } }
                if item.raw["details"]["doubanRating"].doubleValue == nil && item.raw["imdb"]["rating"].doubleValue == nil { Text("尚无来源评分").foregroundStyle(.secondary) }
            }
            Section("简介") { Text(item.raw["details"]["summary"].stringValue ?? "暂无简介，可在资料管理中主动补全。").textSelection(.enabled) }
            Section("完整资料") {
                ForEach(detailFields, id: \.0) { key, label in
                    let value = display(item.raw["details"][key])
                    if !value.isEmpty { LabeledContent(label) { Text(value).multilineTextAlignment(.trailing).textSelection(.enabled) } }
                }
            }
        }
    }
    private var personalDetails: some View {
        Group {
            Section("豆瓣原始记录") {
                LabeledContent("我的评分", value: item.raw["rating"].intValue.map { String(repeating: "★", count: max(0, min($0, 5))) } ?? "未评分")
                LabeledContent("标记日期", value: item.raw["markedDate"].stringValue ?? "未知")
                Text(item.raw["comment"].stringValue ?? "没有个人短评").textSelection(.enabled)
                Text("评分、标记日期和短评来自本人导入或同步，更新这些原始内容请重新预览并导入。本站备注和标签独立保存。").font(.caption).foregroundStyle(.secondary)
            }
            Section("我的整理") {
                TextField("独立备注（最多4000字）", text: $note, axis: .vertical).lineLimit(4...12).onChange(of: note) { _, _ in dirty = true }
                TextField("标签，以逗号分隔", text: $tags).onChange(of: tags) { _, _ in dirty = true }
                Toggle("隐藏这部作品", isOn: $hidden).onChange(of: hidden) { _, _ in dirty = true }
                Text("隐藏的作品可从收藏筛选中的“已隐藏”找回，资料不会删除。").font(.caption).foregroundStyle(.secondary)
                Button("保存我的整理") { saveLocal() }.disabled(!writable)
                if dirty { Text("填写尚未保存，切换作品区域会保留当前填写。").font(.caption).foregroundStyle(.orange) }
            }
        }
    }
    private var management: some View {
        Group {
            Section("作品资料") {
                Button("补全这部作品") { metadata() }.disabled(!writable || dirty)
                if item.domain == "screen" {
                    Button("查找 TMDB 海报") { tmdb() }.disabled(!writable || dirty)
                    Button("更新 IMDb 评分") { imdb() }.disabled(!writable || dirty || item.raw["details"]["imdbId"].stringValue == nil)
                    Picker("影视分类", selection: $kind) { Text("电影").tag("movie"); Text("电视剧").tag("series") }
                    Button("确认影视分类") { classify() }.disabled(!writable || dirty)
                }
                Text("仅在点击时读取公开作品资料；遇验证、拒绝或限流会停止并保留原资料。").font(.caption).foregroundStyle(.secondary)
            }
            Section("备用封面") {
                TextField("公开HTTPS图片链接", text: $coverURL).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .onChange(of: coverURL) { _, _ in previewVisible = false; previewedCover = nil }
                Button("预览封面") { previewedCover = nil; previewVisible = NativeLifeContract.publicImageURL(coverURL) != nil; if !previewVisible { store.error = "请填写不含账户、本机地址或非标准端口的公开HTTPS图片链接。" } }
                if previewVisible, let url = NativeLifeContract.publicImageURL(coverURL) {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image { image.resizable().scaledToFit().frame(height: 200).onAppear { previewedCover = coverURL } }
                        else if phase.error != nil { Text("图片加载失败，请更换可访问的图片链接。").foregroundStyle(.red) }
                        else { ProgressView() }
                    }
                }
                Button("确认保存备用封面") { saveCover(original: false) }.disabled(!writable || dirty || previewedCover != coverURL)
                Button("恢复豆瓣原封面") { confirmRestore = true }.disabled(!writable || dirty || item.raw["cover"]["mode"].stringValue != "url")
                Text("预览会由手机直接读取填写的图片来源，不携带本站登录凭据。图片本身不上传本站。").font(.caption).foregroundStyle(.secondary)
            }
            Section("来源核对") {
                LabeledContent("来源主页", value: item.profile)
                LabeledContent("来源方式", value: ["browser": "本人浏览器同步", "import": "文件导入", "collection": "公开收藏", "rss": "近期公开动态"][item.raw["source"].stringValue ?? ""] ?? "未知")
                if let date = item.raw["observedAt"].stringValue { LabeledContent("最近观察", value: date) }
                if let imdb = item.raw["details"]["imdbId"].stringValue { LabeledContent("IMDb 编号", value: imdb) }
                if let url = item.raw["url"].stringValue.flatMap(URL.init(string:)), ["movie.douban.com", "book.douban.com", "music.douban.com"].contains(url.host ?? "") { Link("在豆瓣查看原始作品", destination: url) }
            }
        }
    }
    private var detailFields: [(String, String)] {
        [("alternateTitles", "别名"), ("year", "年份"), ("genres", "类型"), ("countries", "国家／地区"), ("languages", "语言"), ("directors", "导演"), ("writers", "编剧"), ("cast", "演员"), ("releaseDates", "上映／首播"), ("duration", "片长"), ("episodes", "集数"), ("seasons", "季数"), ("episodeDuration", "单集片长"), ("authors", "作者"), ("translators", "译者"), ("publisher", "出版社"), ("publicationDate", "出版日期"), ("pages", "页数"), ("isbn", "ISBN"), ("binding", "装帧"), ("price", "定价"), ("seriesTitle", "丛书"), ("artists", "表演者"), ("albumType", "专辑类型"), ("medium", "介质"), ("releaseDate", "发行日期"), ("label", "唱片公司"), ("tracks", "曲目")]
    }
    private func display(_ value: NativeJSON) -> String {
        if let string = value.stringValue { return string }
        if let number = value.doubleValue { return number.rounded() == number ? String(format: "%.0f", number) : String(number) }
        return value.arrayValue.compactMap(\.stringValue).joined(separator: " / ")
    }
    private func saveLocal() {
        do {
            let values = tags.components(separatedBy: CharacterSet(charactersIn: ",，\n")).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            let body = try NativeLifeContract.localBody(item: item, epoch: store.epoch, note: note, tags: values, hidden: hidden)
            Task { if await store.mutate(label: "保存个人整理", path: "life/douban/library", method: "PUT", body: body) { dirty = false; try? draftStorage.clear() } }
        } catch { store.fail(error) }
    }
    private func metadata() { let body = NativeLifeContract.metadataBody(item: item, epoch: store.epoch, includeCheck: true); Task { await store.mutate(label: "补全作品资料", path: "life/douban/metadata", body: body) } }
    private func tmdb() { let body = NativeLifeContract.metadataBody(item: item, epoch: store.epoch); Task { await store.mutate(label: "查找TMDB海报", path: "life/douban/tmdb", body: body) } }
    private func imdb() { let body = NativeLifeContract.ratingsBody(items: [item], epoch: store.epoch); Task { await store.mutate(label: "更新IMDb评分", path: "life/douban/imdb-ratings", body: body) } }
    private func classify() {
        var body = item.key; body["kind"] = .string(kind); body["expectedUpdatedAt"] = .string(item.updatedAt)
        Task { await store.mutate(label: "确认影视分类", path: "life/douban/classification", method: "PUT", body: .object(body)) }
    }
    private func saveCover(original: Bool) {
        guard original || previewedCover == coverURL else { return }
        var body = item.key; body["expectedDataEpoch"] = .number(Double(store.epoch)); body["expectedLocalRevision"] = .number(Double(item.revision)); body["mode"] = .string(original ? "original" : "url")
        if !original { body["url"] = .string(coverURL) }
        Task { await store.mutate(label: original ? "恢复原封面" : "保存备用封面", path: "life/douban/cover-selection", method: "PUT", body: .object(body)) }
    }
    private func saveDraft() {
        guard loaded else { return }
        do { try draftStorage.save(NativeLifeLocalDraft(note: note, tags: tags, hidden: hidden, kind: kind, coverURL: coverURL)) }
        catch { store.fail(error) }
    }
}

private struct NativeLifeManagement: View {
    @ObservedObject var store: NativeLifeStore
    @Environment(\.dismiss) private var dismiss
    @State private var profile = ""
    @State private var initialized = false
    @State private var resetPreview: NativeJSON = .null
    @State private var confirmReset = false
    @State private var confirmDisconnect = false
    @State private var tab = "sync"
    var body: some View {
        Form {
            Picker("操作区域", selection: $tab) { Text("同步").tag("sync"); Text("导入").tag("import"); Text("连接与数据").tag("connection") }.pickerStyle(.segmented)
            if tab == "sync" { syncControls }
            if tab == "import" { NativeLifeImportForm(store: store) }
            if tab == "connection" { connectionControls }
            if let pending = store.pending { Section("原操作待核对") { Text(pending.label); Button("重试原提交") { Task { await store.retryPending() } }.disabled(store.busy) } }
            if let error = store.error { Text(error).foregroundStyle(.red) }
            if let notice = store.notice { Text(notice).foregroundStyle(.secondary).font(.footnote) }
        }
        .navigationTitle("同步与导入").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        .onAppear { if !initialized { profile = store.connection["profileId"].stringValue ?? ""; initialized = true } }
        .confirmationDialog("清空我的全部书影音记录？", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("确认清空 \(resetPreview["total"].intValue ?? 0) 条记录", role: .destructive) { reset() }
            Button("取消", role: .cancel) {}
        } message: { Text("会删除本站此账号全部来源的书影音、作品资料、备注、标签与封面选择。保留绑定主页，不修改豆瓣原站，旧同步和导入预览将失效。") }
        .confirmationDialog("断开豆瓣主页？", isPresented: $confirmDisconnect) { Button("确认断开") { saveConnection(disconnect: true) }; Button("取消", role: .cancel) {} } message: { Text("已有收藏保留；正在处理的旧同步将停止。") }
    }
    private var syncControls: some View {
        Group {
            Section("公开记录同步") {
                if let profile = store.connection["profileId"].stringValue { LabeledContent("当前豆瓣主页", value: profile) }
                else { Text("请先在“连接与数据”保存本人豆瓣主页。").foregroundStyle(.secondary) }
                Text("从服务器读取已完成的公开收藏；私密内容、登录要求、验证或访问限制需要使用本人导出文件。不会读取豆瓣密码或Cookie。").font(.footnote).foregroundStyle(.secondary)
                if store.syncing { Button("暂停同步") { store.pause() }; ProgressView("正在推进同步…") }
                else { Button(store.run["status"].stringValue == "running" ? "继续公开同步" : "开始公开同步") { store.startSync() }.disabled(store.connection["profileId"].stringValue == nil || store.busy || store.pending != nil) }
                Button("重新读取同步状态") { Task { await store.load() } }.disabled(store.loading)
                if store.run["status"].stringValue == "running", !store.syncing { Text("每次最多推进20步；不会在打开页面或App时自动续传。").font(.caption).foregroundStyle(.secondary) }
            }
            if !store.run.objectValue.isEmpty {
                Section("最近同步进度") {
                    LabeledContent("状态", value: ["running": "进行中", "completed": "本次公开范围已完成", "partial": "部分完成", "failed": "失败"][store.run["status"].stringValue ?? ""] ?? "未知")
                    Text(store.run["message"].stringValue ?? "")
                    HStack { Text("新增 \(store.run["added"].intValue ?? 0)"); Text("更新 \(store.run["updated"].intValue ?? 0)"); Text("未变 \(store.run["unchanged"].intValue ?? 0)") }.font(.caption)
                    ForEach(["screen", "book", "music"], id: \.self) { domain in
                        let source = store.run["sources"][domain]
                        VStack(alignment: .leading, spacing: 4) {
                            Text((domain == "screen" ? "影视" : NativeLifeContract.kindLabels[domain] ?? domain) + " · " + (source["status"].stringValue ?? "待处理"))
                            if let total = source["total"].intValue, total > 0 { ProgressView(value: Double(source["received"].intValue ?? 0), total: Double(total)) }
                            Text("已接收 \(source["received"].intValue ?? 0) 条 · \(source["pages"].intValue ?? 0) 页").font(.caption).foregroundStyle(.secondary)
                            if let error = source["errorCode"].stringValue { Text(sourceError(error)).font(.caption).foregroundStyle(.orange) }
                        }
                    }
                    Text("公开读取完成不保证私密历史全量。未读到的条目不会作为删除处理。").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("本人浏览器资料") {
                Text("豆瓣本机同步扩展需要桌面Chrome或Edge，iPhone不能运行该扩展。你可在本人浏览器登录豆瓣并导出文件，再在“导入”中从文件或剪贴板解析、预览及确认保存。").font(.footnote)
                Button("选择导入资料") { tab = "import" }
            }
        }
    }
    private var connectionControls: some View {
        Group {
            Section("豆瓣来源主页") {
                TextField("主页链接或主页ID", text: $profile).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("保存连接") { saveConnection(disconnect: false) }.disabled(store.busy || store.pending != nil || store.syncing)
                Button("断开连接") { confirmDisconnect = true }.disabled(store.busy || store.pending != nil || store.connection["profileId"].stringValue == nil || store.syncing)
                Text("保存只更新来源归属，不会自动联网或删除已有收藏。声明主页不代表本站已验证豆瓣账号所有权。").font(.caption).foregroundStyle(.secondary)
            }
            Section("清空全部书影音") {
                Text("范围包含当前本站账号全部已保存来源，不受收藏筛选影响。此操作不可撤销，请先保存完整业务备份。").font(.footnote).foregroundStyle(.secondary)
                Button("查看清空范围") { previewReset() }.disabled(store.busy || store.pending != nil || store.syncing)
                if !resetPreview.objectValue.isEmpty {
                    LabeledContent("全部记录", value: String(resetPreview["total"].intValue ?? 0))
                    ForEach(NativeLifeContract.kinds.filter { $0 != "all" }, id: \.self) { kind in LabeledContent(NativeLifeContract.kindLabels[kind] ?? kind, value: String(resetPreview["counts"][kind].intValue ?? 0)) }
                    Button("核对后清空全部书影音记录", role: .destructive) { confirmReset = true }.disabled(store.busy || store.pending != nil || store.syncing)
                }
            }
        }
    }
    private func saveConnection(disconnect: Bool) {
        do {
            let value: NativeJSON = disconnect ? .null : .string(try NativeLifeContract.profileID(profile))
            let body = NativeJSON.object(["profile": value, "expectedRevision": store.connection["revision"]])
            Task { await store.mutate(label: disconnect ? "断开豆瓣连接" : "保存豆瓣连接", path: "life/douban/connection", method: "PUT", body: body) }
        } catch { store.fail(error) }
    }
    private func previewReset() {
        Task {
            do { resetPreview = try await store.api.json(path: "life/douban/reset", method: "POST", token: store.token, body: .object(["action": .string("preview")]))["preview"] }
            catch { store.fail(error) }
        }
    }
    private func reset() { let body = NativeLifeContract.resetBody(preview: resetPreview); Task { if await store.mutate(label: "清空全部书影音", path: "life/douban/reset", body: body) { resetPreview = .null } } }
    private func sourceError(_ code: String) -> String {
        if code.contains("RATE_LIMITED") { return "豆瓣暂时限制频率，请至少一分钟后手动重试。" }
        if code.contains("LOGIN") { return "此来源要求登录，请使用本人导出资料导入。" }
        if code.contains("CHALLENGE") || code.contains("BLOCKED") { return "豆瓣要求验证或拒绝读取，可使用本人导出文件。" }
        if code.contains("TIMEOUT") || code.contains("NETWORK") { return "来源连接超时或网络失败，已保存的记录保留。" }
        return "本来源未完整完成，请稍后继续或导入本人文件。"
    }
}

private struct NativeLifeImportForm: View {
    @ObservedObject var store: NativeLifeStore
    @State private var profile = ""
    @State private var showFiles = false
    @State private var files: [(name: String, data: Data)] = []
    @State private var parsed: NativeLifeImportResult?
    @State private var preview: NativeJSON = .null
    @State private var confirmMissingStatus = false
    @State private var confirmed = false
    @State private var reading = false
    @State private var showManual = false
    @State private var manualTitle = ""
    @State private var manualURL = ""
    @State private var manualKind = "book"
    @State private var manualRating = ""
    @State private var manualDate = ""
    @State private var manualComment = ""
    @State private var fileError: String?
    @State private var previewProfile = ""
    private var draftStorage: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: store.userID, scope: "life-import-draft") }
    var body: some View {
        Group {
            Section("导入本人已完成收藏") {
                TextField("这批资料的豆瓣主页ID或链接", text: $profile).textInputAutocapitalization(.never).autocorrectionDisabled().onChange(of: profile) { _, value in if value != previewProfile { invalidate() } }
                Text("支持UTF-8 JSON、CSV、Obsidian Markdown与本人保存的豆瓣完成收藏HTML。解析在手机完成，原始文件、文件名和额外元数据不会发送给本站、豆瓣或AI。").font(.footnote).foregroundStyle(.secondary)
                Button("从文件选择资料", systemImage: "doc.badge.plus") { showFiles = true }.disabled(reading || store.pending != nil)
                PasteButton(payloadType: String.self) { values in
                    guard let value = values.first else { return }
                    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    let name = trimmed.hasPrefix("[") || trimmed.hasPrefix("{") ? "剪贴板.json" : trimmed.hasPrefix("---") ? "剪贴板.md" : trimmed.hasPrefix("<") ? "剪贴板.html" : "剪贴板.csv"
                    files = [(name, Data(value.utf8))]; invalidate()
                }.disabled(reading || store.pending != nil)
                ForEach(Array(files.enumerated()), id: \.offset) { _, file in HStack { Image(systemName: "doc.text"); Text(file.name).lineLimit(1); Spacer(); Text(ByteCountFormatter.string(fromByteCount: Int64(file.data.count), countStyle: .file)).font(.caption).foregroundStyle(.secondary) } }
                Toggle("已核对：没有状态字段的条目均已完成", isOn: $confirmMissingStatus).onChange(of: confirmMissingStatus) { _, _ in invalidate() }
                Text("已注明想看、在看、想读、在读等未完成状态的记录仍会跳过，不能用此确认改为完成。").font(.caption).foregroundStyle(.secondary)
                Button("本机解析并预览导入") { parseAndPreview() }.disabled(reading || files.isEmpty || profile.isEmpty || store.pending != nil || store.busy)
                if reading { ProgressView("正在核对导入资料…") }
                if let error = fileError { Text(error).foregroundStyle(.red) }
            }
            if let parsed {
                Section("已解析的资料") {
                    LabeledContent("有效条目", value: String(parsed.items.count))
                    LabeledContent("跳过未完成状态", value: String(parsed.skipped))
                    LabeledContent("合并相同重复项", value: String(parsed.duplicates))
                    ForEach(Array(parsed.items.prefix(30).enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item["title"].stringValue ?? "")
                            Text((NativeLifeContract.kindLabels[item["kind"].stringValue ?? ""] ?? "") + " · " + (item["markedDate"].stringValue ?? "标记日期未知")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if parsed.items.count > 30 { Text("以上展示前30条，其余条目一并纳入预览核对。").font(.caption).foregroundStyle(.secondary) }
                }
            }
            if !preview.objectValue.isEmpty, let parsed {
                Section("本站核对结果（尚未保存）") {
                    LabeledContent("新增", value: String(preview["added"].intValue ?? 0))
                    LabeledContent("更新", value: String(preview["updated"].intValue ?? 0))
                    LabeledContent("未变化", value: String(preview["unchanged"].intValue ?? 0))
                    Toggle("确认来源、条目与更新范围正确", isOn: $confirmed)
                    Button("确认导入 \(parsed.items.count) 条收藏") { commitImport(parsed) }.disabled(!confirmed || store.busy || store.pending != nil || reading)
                    Text("更新不会覆盖本站独立备注、标签、隐藏和人工封面。预览后收藏发生变化时需重新核对。").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("手动整理导入条目") {
                DisclosureGroup("填写一部已完成作品", isExpanded: $showManual) {
                    TextField("作品名称", text: $manualTitle)
                    TextField("豆瓣作品链接", text: $manualURL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("作品类型", selection: $manualKind) { ForEach(NativeLifeContract.kinds.filter { $0 != "all" }, id: \.self) { Text(NativeLifeContract.kindLabels[$0] ?? $0).tag($0) } }
                    Picker("我的评分", selection: $manualRating) { Text("未评分").tag(""); ForEach(1...5, id: \.self) { Text("\($0) 星").tag(String($0)) } }
                    TextField("标记日期 YYYY-MM-DD（可留空）", text: $manualDate).keyboardType(.numbersAndPunctuation)
                    TextField("个人短评（可留空）", text: $manualComment, axis: .vertical).lineLimit(2...6)
                    Button("将此作品加入本次导入") { appendManual() }.disabled(store.pending != nil || reading)
                    Text("同样先预览再确认。这里填写的是本人已完成收藏，不会反向修改豆瓣原站。").font(.caption).foregroundStyle(.secondary)
                }
            }
            if !files.isEmpty || parsed != nil { Section { Button("清空本次导入资料", role: .destructive) { files = []; invalidate(); fileError = nil }.disabled(store.pending != nil || reading) } }
        }
        .onAppear {
            if profile.isEmpty { profile = store.connection["profileId"].stringValue ?? "" }
            guard parsed == nil, files.isEmpty else { return }
            do {
                if let draft = try draftStorage.load(NativeLifeImportDraft.self) {
                    previewProfile = draft.profile; profile = draft.profile; parsed = NativeLifeImportResult(items: draft.items, skipped: draft.skipped, duplicates: draft.duplicates); preview = draft.preview
                    store.notice = "已恢复本机导入预览，请再次核对后确认。"
                }
            } catch { fileError = error.localizedDescription }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.json, .commaSeparatedText, .plainText, .html, .text, .data], allowsMultipleSelection: true) { result in
            do {
                let urls = try result.get()
                guard urls.count <= 100 else { throw NativeLifeError.invalid("每次最多选择100个文本文件。") }
                var chosen: [(String, Data)] = [], total = 0
                for url in urls {
                    let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= 8 * 1024 * 1024 else { throw NativeLifeError.invalid("单文件超过8MiB，请分批导入。") }
                    let data = try Data(contentsOf: url); total += data.count
                    guard total <= 8 * 1024 * 1024 else { throw NativeLifeError.invalid("一次文件合计不能超过8MiB。") }
                    chosen.append((url.lastPathComponent, data))
                }
                files = chosen; invalidate(); fileError = nil
            } catch { fileError = error.localizedDescription }
        }
    }
    private func invalidate() { parsed = nil; preview = .null; confirmed = false; try? draftStorage.clear() }
    private func parseAndPreview() {
        reading = true; fileError = nil; preview = .null; confirmed = false
        do {
            let profile = try NativeLifeContract.profileID(profile)
            var combined = NativeLifeImportResult(items: []), seen: [String: Data] = [:]
            for file in files {
                let batch = try NativeLifeImportParser.parse(data: file.data, filename: file.name, profile: profile, confirmMissingStatus: confirmMissingStatus)
                combined.skipped += batch.skipped; combined.duplicates += batch.duplicates
                for item in batch.items {
                    let key = (item["domain"].stringValue ?? "") + ":" + (item["subjectId"].stringValue ?? "")
                    let value = try NativeLifeImportParser.canonical(item)
                    if let old = seen[key] { guard old == value else { throw NativeLifeError.invalid("不同文件包含同一作品的冲突资料，请先保留正确的一份。") }; combined.duplicates += 1 }
                    else { seen[key] = value; combined.items.append(item) }
                }
            }
            guard combined.items.count <= 500, !combined.items.isEmpty else { throw NativeLifeError.invalid("每批需为1–500条完成收藏。") }
            parsed = combined
            previewProfile = self.profile
            let body = NativeLifeContract.importBody(profile: profile, items: combined.items, epoch: store.epoch)
            Task {
                do {
                    let data = try body.encodedData()
                    let result: NativeJSON
                    if data.count > 512 * 1024 { result = try await store.api.upload(path: "life/douban/import", token: store.token, data: data) }
                    else { result = try await store.api.json(path: "life/douban/import", method: "POST", token: store.token, body: body) }
                    guard !Task.isCancelled else { reading = false; return }
                    preview = result["preview"]; reading = false
                    try draftStorage.save(NativeLifeImportDraft(profile: profile, items: combined.items, preview: preview, skipped: combined.skipped, duplicates: combined.duplicates))
                } catch { fileError = error.localizedDescription; reading = false }
            }
        } catch { fileError = error.localizedDescription; reading = false }
    }
    private func commitImport(_ parsed: NativeLifeImportResult) {
        guard confirmed, let epoch = preview["dataEpoch"].intValue, !preview["snapshotHash"].stringValue.orEmpty.isEmpty else { return }
        do {
            let profile = try NativeLifeContract.profileID(profile)
            let body = NativeLifeContract.importBody(profile: profile, items: parsed.items, epoch: epoch, preview: preview)
            Task {
                if await store.mutate(label: "导入本人完成收藏", path: "life/douban/import", body: body) {
                    self.parsed = nil; preview = .null; confirmed = false; files = []; fileError = nil; try? draftStorage.clear()
                }
            }
        } catch { fileError = error.localizedDescription }
    }
    private func appendManual() {
        let row = NativeJSON.object(["title": .string(manualTitle), "url": .string(manualURL), "type": .string(manualKind), "state": .string("collect"), "myRating": .string(manualRating), "collectionDate": .string(manualDate), "myComment": .string(manualComment)])
        do {
            _ = try NativeLifeImportParser.normalize(row, explicit: false)
            files.append(("手动作品-\(files.count + 1).json", try NativeJSON.array([row]).encodedData()))
            invalidate(); manualTitle = ""; manualURL = ""; manualRating = ""; manualDate = ""; manualComment = ""; fileError = nil
        } catch { fileError = error.localizedDescription }
    }
}

private extension Optional where Wrapped == String { var orEmpty: String { self ?? "" } }
