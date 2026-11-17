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
        if !busy {
            do {
                let restored = try pendingStorage.load(NativeLifePending.self)
                if let restored, restored.owner != userID { throw NativeAPIError.invalidResponse }
                pending = restored
            } catch { self.error = error.localizedDescription }
        }
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
    @Environment(\.dynamicTypeSize) private var typeSize
    @AppStorage("jiashu.life.listLayout") private var listLayout = false
    @State private var filtersVisible = false
    @State private var importVisible = false
    @State private var resetVisible = false
    @State private var organizing = false
    @State private var selected = Set<String>()
    @State private var bulkKind = "movie"
    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID
        _store = StateObject(wrappedValue: NativeLifeStore(api: api, token: token, userID: userID))
    }
    private var contentPending: NativeLifePending? {
        guard let pending = store.pending, !["life/douban/sync", "life/douban/connection"].contains(pending.path) else { return nil }
        return pending
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                categoryBar
                if !store.filters.activeChips.isEmpty { filterChips }
                HStack {
                    Text("\(store.total) 部收藏").font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                    Button { filtersVisible = true } label: { Label("筛选", systemImage: "line.3.horizontal.decrease.circle") }
                        .font(.subheadline)
                }
                if let pending = contentPending {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("保存结果待确认", systemImage: "clock.arrow.circlepath").font(.headline)
                        Text(pending.label).font(.subheadline).foregroundStyle(.secondary)
                        Button("继续确认") { Task { await store.retryPending() } }.disabled(store.busy)
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                }
                if let error = store.error {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(error, systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(.red)
                        Button("重试读取") { Task { await store.load() } }
                    }
                }
                if store.loading && store.items.isEmpty { ProgressView().frame(maxWidth: .infinity).padding(40) }
                else if store.items.isEmpty {
                    ContentUnavailableView {
                        Label(store.filters.activeChips.isEmpty && store.filters.query.isEmpty ? "收藏从这里开始" : "没有找到作品", systemImage: "books.vertical")
                    } description: { Text(store.filters.activeChips.isEmpty ? "导入看过、读过和听过的作品。" : "试试调整筛选条件。") } actions: {
                        if store.filters.activeChips.isEmpty { Button("导入收藏") { importVisible = true } }
                        else { Button("清除筛选") { store.filters = NativeLifeFilters(); Task { await store.load() } } }
                    }
                } else if listLayout || typeSize.isAccessibilitySize {
                    LazyVStack(spacing: 0) {
                        ForEach(store.items) { item in
                            HStack(spacing: 12) {
                                if organizing && item.domain == "screen" { selectionButton(item) }
                                NavigationLink { NativeLifeDetail(store: store, initial: item) } label: { NativeLifeRow(store: store, item: item) }.buttonStyle(.plain)
                            }.padding(.vertical, 10)
                            Divider()
                        }
                    }
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 136, maximum: 240), spacing: 16)], alignment: .leading, spacing: 24) {
                        ForEach(store.items) { item in
                            NavigationLink { NativeLifeDetail(store: store, initial: item) } label: { NativeLifePoster(store: store, item: item) }
                                .buttonStyle(.plain)
                                .overlay(alignment: .topTrailing) {
                                    if organizing && item.domain == "screen" { selectionButton(item).padding(8).background(.regularMaterial, in: Circle()).padding(5) }
                                }
                        }
                    }
                }
                if store.response["hasMore"].boolValue == true { Button { Task { await store.load(more: true) } } label: { if store.loading { ProgressView() } else { Text("加载更多") } }.frame(maxWidth: .infinity).padding(.vertical, 8).disabled(store.loading) }
                if store.completing { HStack { ProgressView(); Text("正在更新作品资料").font(.subheadline); Spacer(); Button("暂停") { store.pause() } } }
            }.padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("书影音")
        .searchable(text: $store.filters.query, prompt: "搜索作品、创作者或标签")
        .onSubmit(of: .search) { selected.removeAll(); Task { await store.load() } }
        .onChange(of: store.filters.query) { _, value in if value.isEmpty { Task { await store.load() } } }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("导入收藏", systemImage: "square.and.arrow.down") { importVisible = true }
                    Button(organizing ? "结束整理" : "整理收藏", systemImage: "checkmark.circle") { organizing.toggle(); selected.removeAll() }
                    Button(listLayout ? "封面网格" : "列表显示", systemImage: listLayout ? "square.grid.2x2" : "list.bullet") { listLayout.toggle() }
                    Divider()
                    Menu("作品资料", systemImage: "info.circle") {
                        Button("补全当前作品资料") { store.completePage(full: false) }
                        Button("重新读取当前作品资料") { store.completePage(full: true) }
                        Button("更新 IMDb 评分") { refreshRatings() }.disabled(!store.items.contains { $0.domain == "screen" && $0.raw["details"]["imdbId"].stringValue != nil })
                    }.disabled(store.busy || store.pending != nil || store.completing)
                    Divider()
                    Button("清空收藏", systemImage: "trash", role: .destructive) { resetVisible = true }
                } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("收藏工具")
            }
        }
        .safeAreaInset(edge: .bottom) {
            if organizing {
                VStack(spacing: 10) {
                    HStack { Text("已选 \(selected.count) 部影视").font(.subheadline); Spacer(); Button("完成") { organizing = false; selected.removeAll() } }
                    if !selected.isEmpty {
                        HStack {
                            Picker("分类", selection: $bulkKind) { Text("电影").tag("movie"); Text("电视剧").tag("series") }.pickerStyle(.segmented)
                            Button("分类") { bulkClassify() }.buttonStyle(.borderedProminent).disabled(store.busy || store.pending != nil || selected.count > 24)
                        }
                    }
                }.padding().background(.regularMaterial)
            }
        }
        .refreshable { await store.load() }
        .sheet(isPresented: $filtersVisible) { NavigationStack { NativeLifeFilterSheet(store: store) } }
        .sheet(isPresented: $importVisible, onDismiss: { Task { await store.load() } }) { NavigationStack { NativeLifeImportForm(store: store) } }
        .sheet(isPresented: $resetVisible) { NavigationStack { NativeLifeResetView(store: store) } }
        .task(id: userID + ":" + token) { store.activate(token: token, userID: userID); await store.load() }
        .onDisappear { store.pause() }
    }
    private var categoryBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(NativeLifeContract.kinds, id: \.self) { kind in
                    Button { store.filters.kind = kind; selected.removeAll(); Task { await store.load() } } label: {
                        Text(NativeLifeContract.kindLabels[kind] ?? kind).font(.subheadline.weight(store.filters.kind == kind ? .semibold : .regular))
                            .padding(.horizontal, 15).padding(.vertical, 10)
                            .background(store.filters.kind == kind ? Color.indigo : Color(.secondarySystemGroupedBackground), in: Capsule())
                            .foregroundStyle(store.filters.kind == kind ? Color.white : Color.primary)
                    }.buttonStyle(.plain).accessibilityAddTraits(store.filters.kind == kind ? .isSelected : [])
                }
            }
        }
    }
    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.filters.activeChips, id: \.key) { chip in
                    Button { store.filters.removeChip(chip.key); Task { await store.load() } } label: { HStack(spacing: 6) { Text(chip.title); Image(systemName: "xmark").font(.caption2) }.font(.caption).padding(.horizontal, 10).padding(.vertical, 8).background(.indigo.opacity(0.08), in: Capsule()) }
                        .buttonStyle(.plain).accessibilityLabel("移除筛选：" + chip.title)
                }
            }
        }
    }
    private func selectionButton(_ item: NativeLifeItem) -> some View {
        Button { if !selected.insert(item.id).inserted { selected.remove(item.id) } } label: { Image(systemName: selected.contains(item.id) ? "checkmark.circle.fill" : "circle").font(.title2).foregroundStyle(selected.contains(item.id) ? Color.indigo : Color.secondary).frame(minWidth: 44, minHeight: 44) }
            .buttonStyle(.borderless).accessibilityLabel((selected.contains(item.id) ? "取消选择" : "选择") + item.title)
    }
    private func bulkClassify() {
        let values = store.items.filter { selected.contains($0.id) }.map { item -> NativeJSON in var key = item.key; key["expectedUpdatedAt"] = .string(item.updatedAt); return .object(key) }
        let body = NativeJSON.object(["action": .string("classify"), "kind": .string(bulkKind), "expectedDataEpoch": .number(Double(store.epoch)), "items": .array(values)])
        Task { if await store.mutate(label: "整理影视分类", path: "life/douban/library", body: body) { selected.removeAll() } }
    }
    private func refreshRatings() { let body = NativeLifeContract.ratingsBody(items: store.items, epoch: store.epoch); Task { await store.mutate(label: "更新作品评分", path: "life/douban/imdb-ratings", body: body) } }
}

private struct NativeLifePoster: View {
    @ObservedObject var store: NativeLifeStore
    let item: NativeLifeItem
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            NativeLifeCover(api: store.api, token: store.token, item: item).aspectRatio(2.0 / 3.0, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 11)).overlay(RoundedRectangle(cornerRadius: 11).stroke(.primary.opacity(0.06), lineWidth: 1))
            Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(2).frame(minHeight: 38, alignment: .topLeading)
            HStack(spacing: 2) {
                if let rating = item.raw["rating"].intValue { ForEach(0..<5, id: \.self) { index in Image(systemName: index < rating ? "star.fill" : "star").font(.caption2).foregroundStyle(.orange) } }
                else { Text("未评分").font(.caption).foregroundStyle(.secondary) }
            }.accessibilityLabel(item.raw["rating"].intValue.map { "我的评分\($0)星" } ?? "未评分")
            Text(item.raw["markedDate"].stringValue ?? item.kindLabel).font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .topLeading).accessibilityElement(children: .combine)
    }
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
    @State private var editing = false
    @State private var artwork = false
    private var item: NativeLifeItem { store.detailItems[initial.id] ?? initial }
    var body: some View {
        Form {
            Section {
                HStack(alignment: .top, spacing: 18) {
                    NativeLifeCover(api: store.api, token: store.token, item: item).frame(width: 112, height: 168).clipShape(RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 10) {
                        Text(item.title).font(.title3.bold()).textSelection(.enabled)
                        Text(item.kindLabel).font(.subheadline).foregroundStyle(.secondary)
                        if let rating = item.raw["rating"].intValue { Text(String(repeating: "★", count: max(0, min(rating, 5)))).foregroundStyle(.orange).accessibilityLabel("我的评分\(rating)星") }
                        if let day = item.raw["markedDate"].stringValue { Text(day).font(.caption).foregroundStyle(.secondary) }
                    }
                }.padding(.vertical, 8)
            }
            if let summary = item.raw["details"]["summary"].stringValue, !summary.isEmpty {
                Section("简介") { Text(summary).font(.body).lineSpacing(5).textSelection(.enabled) }
            }
            Section("我的记录") {
                if let comment = item.raw["comment"].stringValue, !comment.isEmpty { Text(comment).textSelection(.enabled) }
                if !item.note.isEmpty { Text(item.note).lineSpacing(4).textSelection(.enabled) }
                if !item.tags.isEmpty { Text(item.tags.map { "#" + $0 }.joined(separator: "  ")).font(.subheadline).foregroundStyle(.indigo) }
                if item.hidden { Label("已隐藏", systemImage: "eye.slash").font(.caption).foregroundStyle(.secondary) }
                if item.note.isEmpty && item.tags.isEmpty && item.raw["comment"].stringValue == nil { Text("记下一点自己的感受。").foregroundStyle(.secondary) }
                Button("编辑备注与标签", systemImage: "square.and.pencil") { editing = true }
            }
            if item.raw["details"]["doubanRating"].doubleValue != nil || item.raw["imdb"]["rating"].doubleValue != nil {
                Section("来源评分") {
                    if let score = item.raw["details"]["doubanRating"].doubleValue { LabeledContent("豆瓣", value: String(format: "%.1f / 10", score)) }
                    if let score = item.raw["imdb"]["rating"].doubleValue { LabeledContent("IMDb", value: String(format: "%.1f / 10", score)) }
                }
            }
            Section {
                DisclosureGroup("全部作品资料") {
                    ForEach(NativeLifePresentation.detailFields, id: \.0) { key, label in
                        let value = NativeLifePresentation.text(item.raw["details"][key])
                        if !value.isEmpty { LabeledContent(label) { Text(value).multilineTextAlignment(.trailing).textSelection(.enabled) } }
                    }
                }
                DisclosureGroup("来源") {
                    LabeledContent("豆瓣主页", value: item.profile)
                    LabeledContent("资料来源", value: ["browser": "本人浏览器", "import": "本人导入", "collection": "公开收藏", "rss": "近期动态"][item.raw["source"].stringValue ?? ""] ?? "未知")
                    if let id = item.raw["details"]["imdbId"].stringValue { LabeledContent("IMDb", value: id) }
                    if let url = item.raw["url"].stringValue.flatMap(URL.init(string:)), ["movie.douban.com", "book.douban.com", "music.douban.com"].contains(url.host ?? "") { Link("查看豆瓣作品", destination: url) }
                }
            }
            if let error = store.error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
        }
        .navigationTitle("作品详情").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("编辑备注与标签", systemImage: "square.and.pencil") { editing = true }
                    Button("封面与分类", systemImage: "photo") { artwork = true }
                    Divider()
                    Button("补全作品资料") { let body = NativeLifeContract.metadataBody(item: item, epoch: store.epoch, includeCheck: true); Task { await store.mutate(label: "更新作品资料", path: "life/douban/metadata", body: body) } }
                    if item.domain == "screen" {
                        Button("查找 TMDB 海报") { let body = NativeLifeContract.metadataBody(item: item, epoch: store.epoch); Task { await store.mutate(label: "查找作品海报", path: "life/douban/tmdb", body: body) } }
                        Button("更新 IMDb 评分") { let body = NativeLifeContract.ratingsBody(items: [item], epoch: store.epoch); Task { await store.mutate(label: "更新作品评分", path: "life/douban/imdb-ratings", body: body) } }.disabled(item.raw["details"]["imdbId"].stringValue == nil)
                    }
                } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("作品工具").disabled(store.busy || store.pending != nil)
            }
        }
        .sheet(isPresented: $editing) { NavigationStack { NativeLifeRecordEditor(store: store, item: item) } }
        .sheet(isPresented: $artwork) { NavigationStack { NativeLifeArtworkEditor(store: store, initial: item) } }
    }
}

private enum NativeLifePresentation {
    static let detailFields: [(String, String)] = [("alternateTitles", "别名"), ("year", "年份"), ("genres", "类型"), ("countries", "国家／地区"), ("languages", "语言"), ("directors", "导演"), ("writers", "编剧"), ("cast", "演员"), ("releaseDates", "上映／首播"), ("duration", "片长"), ("episodes", "集数"), ("seasons", "季数"), ("episodeDuration", "单集片长"), ("authors", "作者"), ("translators", "译者"), ("publisher", "出版社"), ("publicationDate", "出版日期"), ("pages", "页数"), ("isbn", "ISBN"), ("binding", "装帧"), ("price", "定价"), ("seriesTitle", "丛书"), ("artists", "表演者"), ("albumType", "专辑类型"), ("medium", "介质"), ("releaseDate", "发行日期"), ("label", "唱片公司"), ("tracks", "曲目")]
    static func text(_ value: NativeJSON) -> String {
        if let text = value.stringValue { return text }
        if let number = value.doubleValue { return number.rounded() == number ? String(format: "%.0f", number) : String(number) }
        return value.arrayValue.compactMap(\.stringValue).joined(separator: " / ")
    }
    static func status(_ value: String?) -> String {
        ["pending": "等待中", "complete": "已完成", "completed": "已完成", "running": "进行中", "partial": "部分完成", "failed": "未完成", "blocked": "访问受限", "limited": "等待继续"][value ?? ""] ?? "尚未开始"
    }
}

private struct NativeLifeRecordEditor: View {
    @ObservedObject var store: NativeLifeStore
    let item: NativeLifeItem
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var tags = ""
    @State private var hidden = false
    @State private var loaded = false
    @State private var confirmClose = false
    @State private var saving = false
    private var persistence: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: store.userID, scope: "life-item-" + item.id) }
    private var dirty: Bool { note != item.note || tags != item.tags.joined(separator: ", ") || hidden != item.hidden }
    var body: some View {
        Form {
            Section { Text(item.title).font(.headline) }
            Section("备注") { TextField("记下自己的感受", text: $note, axis: .vertical).lineLimit(6...15) }.disabled(saving || store.busy || store.pending != nil)
            Section("标签") { TextField("逗号分隔，如：喜欢，重读", text: $tags) }.disabled(saving || store.busy || store.pending != nil)
            Section { Toggle("隐藏这部作品", isOn: $hidden) } footer: { Text("可以从“已隐藏”筛选中找回。") }.disabled(saving || store.busy || store.pending != nil)
            if let pending = store.pending { Section("保存结果待确认") { Text(pending.label).font(.subheadline); Button("继续确认") { retrySave() }.disabled(saving || store.busy) } }
            if let error = store.error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
        }
        .navigationTitle("编辑我的记录").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("取消") { if dirty { confirmClose = true } else { dismiss() } }.disabled(saving || store.busy || store.pending != nil) }
            ToolbarItem(placement: .confirmationAction) { Button("保存") { save() }.disabled(!dirty || saving || store.busy || store.pending != nil) }
        }
        .interactiveDismissDisabled(dirty || saving || store.busy || store.pending != nil)
        .confirmationDialog("保留这次填写？", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("保留草稿") { saveDraft(); dismiss() }
            Button("放弃填写", role: .destructive) { try? persistence.clear(); dismiss() }
            Button("继续编辑", role: .cancel) {}
        }
        .onAppear {
            guard !loaded else { return }
            note = item.note; tags = item.tags.joined(separator: ", "); hidden = item.hidden
            do { if let draft = try persistence.load(NativeLifeLocalDraft.self) { note = draft.note; tags = draft.tags; hidden = draft.hidden } } catch { store.fail(error) }
            loaded = true
        }
        .onChange(of: note) { _, _ in saveDraft() }.onChange(of: tags) { _, _ in saveDraft() }.onChange(of: hidden) { _, _ in saveDraft() }
    }
    private func saveDraft() {
        guard loaded else { return }
        do { try persistence.save(NativeLifeLocalDraft(note: note, tags: tags, hidden: hidden, kind: item.kind, coverURL: item.raw["cover"]["url"].stringValue ?? "")) } catch { store.fail(error) }
    }
    private func save() {
        guard !saving, !store.busy, store.pending == nil else { return }
        do {
            let values = tags.components(separatedBy: CharacterSet(charactersIn: ",，\n")).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            let body = try NativeLifeContract.localBody(item: item, epoch: store.epoch, note: note, tags: values, hidden: hidden)
            saving = true
            Task { defer { saving = false }; if await store.mutate(label: "保存备注与标签", path: "life/douban/library", method: "PUT", body: body) { try? persistence.clear(); dismiss() } }
        } catch { store.fail(error) }
    }
    private func retrySave() {
        guard !saving, !store.busy else { return }
        saving = true
        Task { defer { saving = false }; await store.retryPending(); if store.pending == nil && store.error == nil { try? persistence.clear(); dismiss() } }
    }
}

private struct NativeLifeArtworkEditor: View {
    @ObservedObject var store: NativeLifeStore
    let initial: NativeLifeItem
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "movie"
    @State private var coverURL = ""
    @State private var previewedCover: String?
    @State private var showPreview = false
    @State private var restore = false
    private var item: NativeLifeItem { store.detailItems[initial.id] ?? initial }
    var body: some View {
        Form {
            if item.domain == "screen" {
                Section("分类") {
                    Picker("作品类型", selection: $kind) { Text("电影").tag("movie"); Text("电视剧").tag("series") }.pickerStyle(.segmented)
                    Button("保存分类") { var body = item.key; body["kind"] = .string(kind); body["expectedUpdatedAt"] = .string(item.updatedAt); Task { await store.mutate(label: "更新影视分类", path: "life/douban/classification", method: "PUT", body: .object(body)) } }
                }
            }
            Section("封面") {
                TextField("公开 HTTPS 图片链接", text: $coverURL).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .onChange(of: coverURL) { _, _ in showPreview = false; previewedCover = nil }
                Button("预览图片") { showPreview = NativeLifeContract.publicImageURL(coverURL) != nil; if !showPreview { store.error = "请填写公开 HTTPS 图片链接。" } }
                if showPreview, let url = NativeLifeContract.publicImageURL(coverURL) {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image { image.resizable().scaledToFit().frame(height: 200).onAppear { previewedCover = coverURL } }
                        else if phase.error != nil { Text("图片暂时无法打开，请换一个链接。").font(.footnote).foregroundStyle(.red) }
                        else { ProgressView() }
                    }
                }
                Button("保存这张封面") { saveCover(original: false) }.disabled(previewedCover != coverURL)
                if item.raw["cover"]["mode"].stringValue == "url" { Button("恢复原封面") { restore = true } }
            }
            if let error = store.error { Text(error).font(.footnote).foregroundStyle(.red) }
            if let notice = store.notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
        }.disabled(store.busy || store.pending != nil)
        .navigationTitle("封面与分类").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        .safeAreaInset(edge: .bottom) {
            if let pending = store.pending {
                HStack { Text(pending.label).font(.footnote); Spacer(); Button("继续确认") { Task { await store.retryPending() } }.disabled(store.busy) }.padding().background(.regularMaterial)
            }
        }
        .onAppear { kind = item.kind == "series" ? "series" : "movie"; coverURL = item.raw["cover"]["url"].stringValue ?? "" }
        .confirmationDialog("恢复原封面？", isPresented: $restore) { Button("恢复") { saveCover(original: true) } }
    }
    private func saveCover(original: Bool) {
        guard original || previewedCover == coverURL else { return }
        var body = item.key; body["expectedDataEpoch"] = .number(Double(store.epoch)); body["expectedLocalRevision"] = .number(Double(item.revision)); body["mode"] = .string(original ? "original" : "url")
        if !original { body["url"] = .string(coverURL) }
        Task { await store.mutate(label: "更新作品封面", path: "life/douban/cover-selection", method: "PUT", body: .object(body)) }
    }
}

/// The only native surface for Douban connection and public synchronization.
/// The containing app links here from 我的 → 同步中心.
struct NativeLifeSyncCenter: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @StateObject private var store: NativeLifeStore
    @State private var profile = ""
    @State private var disconnect = false
    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID
        _store = StateObject(wrappedValue: NativeLifeStore(api: api, token: token, userID: userID))
    }
    private var connected: Bool { store.connection["profileId"].stringValue != nil }
    var body: some View {
        Form {
            Section {
                LabeledContent("豆瓣", value: connected ? (store.connection["profileId"].stringValue ?? "已连接") : "未连接")
                if let date = store.run["updatedAt"].stringValue { LabeledContent("最近更新", value: NativeWorkspaceFormat.timestamp(date)) }
                if connected {
                    if store.syncing { Button("暂停同步") { store.pause() }; ProgressView() }
                    else { Button(store.run["status"].stringValue == "running" ? "继续同步" : "同步公开收藏") { store.startSync() }.disabled(store.busy || store.pending != nil) }
                } else {
                    TextField("豆瓣主页链接或 ID", text: $profile).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("连接豆瓣") { saveConnection(disconnect: false) }.disabled(profile.isEmpty || store.busy || store.pending != nil)
                }
            }
            if let pending = store.pending {
                Section("结果待确认") { Text(pending.label).font(.subheadline); Button("继续确认") { Task { await store.retryPending() } }.disabled(store.busy) }
            }
            if !store.run.objectValue.isEmpty {
                Section("同步进度") {
                    LabeledContent("状态", value: NativeLifePresentation.status(store.run["status"].stringValue))
                    HStack { Text("新增 \(store.run["added"].intValue ?? 0)"); Text("更新 \(store.run["updated"].intValue ?? 0)"); Text("未变 \(store.run["unchanged"].intValue ?? 0)") }.font(.subheadline)
                    DisclosureGroup("查看详情") {
                        ForEach(["screen", "book", "music"], id: \.self) { domain in
                            let source = store.run["sources"][domain]
                            VStack(alignment: .leading, spacing: 6) {
                                LabeledContent(domain == "screen" ? "影视" : NativeLifeContract.kindLabels[domain] ?? domain, value: NativeLifePresentation.status(source["status"].stringValue))
                                if let total = source["total"].intValue, total > 0 { ProgressView(value: Double(min(source["received"].intValue ?? 0, total)), total: Double(total)) }
                                Text("\(source["received"].intValue ?? 0) 条 · \(source["pages"].intValue ?? 0) 页").font(.caption).foregroundStyle(.secondary)
                                if let code = source["errorCode"].stringValue { Text(sourceError(code)).font(.footnote).foregroundStyle(.orange) }
                            }.padding(.vertical, 4)
                        }
                        Text(store.run["message"].stringValue ?? "").font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            if connected {
                Section {
                    DisclosureGroup("连接设置") {
                        TextField("豆瓣主页链接或 ID", text: $profile).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("保存主页") { saveConnection(disconnect: false) }.disabled(store.busy || store.pending != nil || store.syncing)
                        Button("断开连接", role: .destructive) { disconnect = true }.disabled(store.busy || store.pending != nil || store.syncing)
                    }
                }
            }
            if let error = store.error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            Section {
                DisclosureGroup("关于豆瓣同步") {
                    Text("公开同步只读取可访问的完成收藏。私密或受限内容请导入本人导出的文件；不会读取豆瓣密码或 Cookie。桌面扩展不能在 iPhone 运行。").font(.footnote).foregroundStyle(.secondary)
                    Text("每次最多推进20步，暂停后可继续。更换或断开主页会保留已有收藏。").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("豆瓣同步").navigationBarTitleDisplayMode(.inline)
        .toolbar { Button { Task { await store.load() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("刷新状态").disabled(store.busy || store.syncing) }
        .task(id: userID + ":" + token) { store.activate(token: token, userID: userID); await store.load(); profile = store.connection["profileId"].stringValue ?? "" }
        .refreshable { await store.load() }.onDisappear { store.pause() }
        .confirmationDialog("断开豆瓣连接？", isPresented: $disconnect) { Button("断开连接", role: .destructive) { saveConnection(disconnect: true) } } message: { Text("已有收藏保留。") }
    }
    private func saveConnection(disconnect: Bool) {
        do { let value: NativeJSON = disconnect ? .null : .string(try NativeLifeContract.profileID(profile)); let body = NativeJSON.object(["profile": value, "expectedRevision": store.connection["revision"]]); Task { await store.mutate(label: disconnect ? "断开豆瓣连接" : "保存豆瓣主页", path: "life/douban/connection", method: "PUT", body: body) } }
        catch { store.fail(error) }
    }
    private func sourceError(_ code: String) -> String {
        if code.contains("RATE_LIMITED") { return "请求较多，至少一分钟后再试。" }
        if code.contains("LOGIN") || code.contains("CHALLENGE") || code.contains("BLOCKED") { return "来源受限，可导入本人导出的文件。" }
        return "暂时未完成，请稍后重试。"
    }
}

private struct NativeLifeResetView: View {
    @ObservedObject var store: NativeLifeStore
    @Environment(\.dismiss) private var dismiss
    @State private var preview: NativeJSON = .null
    @State private var confirmed = false
    var body: some View {
        Form {
            Section { Text("清空此账号在本站保存的全部书影音、备注、标签与封面选择。此操作不可撤销。").foregroundStyle(.secondary) }
            Section {
                Button("查看清空范围") { Task { do { preview = try await store.api.json(path: "life/douban/reset", method: "POST", token: store.token, body: .object(["action": .string("preview")]))["preview"] } catch { store.fail(error) } } }.disabled(store.busy || store.pending != nil)
                if !preview.objectValue.isEmpty {
                    LabeledContent("全部收藏", value: String(preview["total"].intValue ?? 0))
                    DisclosureGroup("分类数量") { ForEach(NativeLifeContract.kinds.filter { $0 != "all" }, id: \.self) { kind in LabeledContent(NativeLifeContract.kindLabels[kind] ?? kind, value: String(preview["counts"][kind].intValue ?? 0)) } }
                    Button("清空全部收藏", role: .destructive) { confirmed = true }.disabled(store.busy || store.pending != nil)
                }
            }
            if let pending = store.pending { Section("结果待确认") { Text(pending.label); Button("继续确认") { Task { await store.retryPending() } }.disabled(store.busy) } }
            if let error = store.error { Text(error).font(.footnote).foregroundStyle(.red) }
        }.navigationTitle("清空收藏").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        .confirmationDialog("确认清空 \(preview["total"].intValue ?? 0) 条收藏？", isPresented: $confirmed, titleVisibility: .visible) {
            Button("确认清空", role: .destructive) { let body = NativeLifeContract.resetBody(preview: preview); Task { if await store.mutate(label: "清空收藏", path: "life/douban/reset", body: body) { dismiss() } } }
        } message: { Text("不会修改豆瓣原站或其他账号。") }
    }
}

private struct NativeLifeImportForm: View {
    @ObservedObject var store: NativeLifeStore
    @Environment(\.dismiss) private var dismiss
    @State private var profile = ""
    @State private var showFiles = false
    @State private var files: [(name: String, data: Data)] = []
    @State private var parsed: NativeLifeImportResult?
    @State private var preview: NativeJSON = .null
    @State private var confirmMissingStatus = false
    @State private var needsCompletionConfirmation = false
    @State private var confirmed = false
    @State private var reading = false
    @State private var committing = false
    @State private var previewGate = NativeLifePreviewGate()
    @State private var visible = false
    @State private var step = 0
    @State private var completedCount = 0
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
        Form {
            Section {
                HStack {
                    stepLabel("资料", index: 0); Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary); Spacer()
                    stepLabel("核对", index: 1); Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary); Spacer()
                    stepLabel("完成", index: 2)
                }.padding(.vertical, 4)
            }
            if step == 0 { sourceStep }
            if step == 1, let parsed { reviewStep(parsed) }
            if step == 2 {
                Section {
                    VStack(spacing: 14) {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 44)).foregroundStyle(.green)
                        Text("收藏已导入").font(.title3.bold())
                        Text("已核对 \(completedCount) 部作品").foregroundStyle(.secondary)
                        Button("返回收藏") { dismiss() }.buttonStyle(.borderedProminent)
                    }.frame(maxWidth: .infinity).padding(.vertical, 28)
                }
            }
            if let pending = store.pending, pending.path == "life/douban/import" {
                Section("保存结果待确认") {
                    Button("继续确认") { retryImport() }.disabled(committing || store.busy)
                }
            }
            if let error = fileError ?? store.error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
        }
        .navigationTitle("导入收藏").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(reading || committing || store.busy) } }
        .interactiveDismissDisabled(reading || committing || store.busy)
        .safeAreaInset(edge: .bottom) {
            if step < 2 {
                VStack(spacing: 8) {
                    if reading || committing || store.busy { ProgressView("正在核对…") }
                    else if step == 0 {
                        Button("预览导入") { parseAndPreview() }.buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
                            .disabled(files.isEmpty || profile.isEmpty || store.pending != nil)
                    } else if let parsed {
                        Button("确认导入 \(parsed.items.count) 部作品") { commitImport(parsed) }.buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
                            .disabled(!confirmed || store.pending != nil)
                    }
                }.padding().frame(maxWidth: .infinity).background(.regularMaterial)
            }
        }
        .onAppear {
            visible = true
            if profile.isEmpty { profile = store.connection["profileId"].stringValue ?? "" }
            guard parsed == nil, files.isEmpty else { return }
            do {
                if let draft = try draftStorage.load(NativeLifeImportDraft.self) {
                    previewProfile = draft.profile; profile = draft.profile; parsed = NativeLifeImportResult(items: draft.items, skipped: draft.skipped, duplicates: draft.duplicates); preview = draft.preview
                    if !preview.objectValue.isEmpty { step = 1 }
                }
            } catch { fileError = error.localizedDescription }
        }
        .onDisappear { visible = false; previewGate.invalidate(); reading = false }
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
    private func stepLabel(_ title: String, index: Int) -> some View {
        HStack(spacing: 6) { Image(systemName: step > index ? "checkmark.circle.fill" : "\(index + 1).circle\(step == index ? ".fill" : "")"); Text(title) }.font(.subheadline.weight(step == index ? .semibold : .regular)).foregroundStyle(step == index ? Color.indigo : Color.secondary)
    }
    private var sourceStep: some View {
        Group {
            Section("选择资料") {
                Button("从文件选择", systemImage: "doc.badge.plus") { showFiles = true }.disabled(reading || store.pending != nil)
                PasteButton(payloadType: String.self) { values in
                    guard let value = values.first else { return }
                    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    let name = text.hasPrefix("[") || text.hasPrefix("{") ? "剪贴板.json" : text.hasPrefix("---") ? "剪贴板.md" : text.hasPrefix("<") ? "剪贴板.html" : "剪贴板.csv"
                    files = [(name, Data(value.utf8))]; invalidate()
                }.disabled(reading || store.pending != nil)
                ForEach(Array(files.enumerated()), id: \.offset) { _, file in Label(file.name, systemImage: "doc.text").font(.subheadline).lineLimit(1) }
            }
            Section("资料来源") {
                TextField("豆瓣主页链接或 ID", text: $profile).textInputAutocapitalization(.never).autocorrectionDisabled().onChange(of: profile) { _, value in if value != previewProfile { invalidate() } }
                if needsCompletionConfirmation {
                    Toggle("这些条目均已完成", isOn: $confirmMissingStatus).onChange(of: confirmMissingStatus) { _, _ in invalidate() }
                    Text("文件缺少状态字段，请核对后确认。").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                DisclosureGroup("支持的文件与隐私") { Text("JSON、CSV、Markdown 或本人保存的完成收藏 HTML。每批最多500条、合计8MiB；原始文件留在手机，仅上传核对后的作品资料。").font(.footnote).foregroundStyle(.secondary) }
                DisclosureGroup("填写一部已完成作品", isExpanded: $showManual) {
                    TextField("作品名称", text: $manualTitle)
                    TextField("豆瓣作品链接", text: $manualURL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("类型", selection: $manualKind) { ForEach(NativeLifeContract.kinds.filter { $0 != "all" }, id: \.self) { Text(NativeLifeContract.kindLabels[$0] ?? $0).tag($0) } }
                    Picker("我的评分", selection: $manualRating) { Text("未评分").tag(""); ForEach(1...5, id: \.self) { Text("\($0) 星").tag(String($0)) } }
                    TextField("标记日期 YYYY-MM-DD（可留空）", text: $manualDate).keyboardType(.numbersAndPunctuation)
                    TextField("短评（可留空）", text: $manualComment, axis: .vertical).lineLimit(2...6)
                    Button("加入本次导入") { appendManual() }.disabled(store.pending != nil || reading)
                }
            }
        }.disabled(reading || committing || store.busy || store.pending != nil)
    }
    private func reviewStep(_ parsed: NativeLifeImportResult) -> some View {
        Group {
            Section("将保存到你的收藏") {
                HStack { summaryCount("新增", value: preview["added"].intValue ?? 0); Spacer(); summaryCount("更新", value: preview["updated"].intValue ?? 0); Spacer(); summaryCount("未变", value: preview["unchanged"].intValue ?? 0) }.padding(.vertical, 8)
                LabeledContent("来源主页", value: previewProfile)
                if parsed.skipped > 0 { LabeledContent("跳过未完成", value: String(parsed.skipped)) }
                if parsed.duplicates > 0 { LabeledContent("合并重复", value: String(parsed.duplicates)) }
                Toggle("已核对来源与作品", isOn: $confirmed).disabled(committing || reading || store.busy || store.pending != nil)
            }
            Section {
                DisclosureGroup("查看 \(parsed.items.count) 部作品") {
                    ForEach(Array(parsed.items.prefix(30).enumerated()), id: \.offset) { _, item in VStack(alignment: .leading, spacing: 4) { Text(item["title"].stringValue ?? ""); Text(item["markedDate"].stringValue ?? "标记日期未知").font(.caption).foregroundStyle(.secondary) } }
                    if parsed.items.count > 30 { Text("显示前30部，其余作品已一并核对。").font(.footnote).foregroundStyle(.secondary) }
                }
                Button("更换资料") { files = []; invalidate(); step = 0 }.disabled(committing || store.pending != nil || store.busy)
            }
        }
    }
    private func summaryCount(_ title: String, value: Int) -> some View { VStack(alignment: .leading, spacing: 5) { Text(String(value)).font(.title2.bold()).monospacedDigit(); Text(title).font(.caption).foregroundStyle(.secondary) } }
    private func invalidate() { previewGate.invalidate(); reading = false; parsed = nil; preview = .null; confirmed = false; step = 0; try? draftStorage.clear() }
    private func parseAndPreview() {
        guard !reading, !committing, !store.busy, store.pending == nil, visible else { return }
        let ticket = previewGate.begin(owner: store.userID, profile: profile)
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
            previewProfile = self.profile
            let body = NativeLifeContract.importBody(profile: profile, items: combined.items, epoch: store.epoch)
            Task {
                do {
                    let data = try body.encodedData()
                    let result: NativeJSON
                    if data.count > 512 * 1024 { result = try await store.api.upload(path: "life/douban/import", token: store.token, data: data) }
                    else { result = try await store.api.json(path: "life/douban/import", method: "POST", token: store.token, body: body) }
                    guard !Task.isCancelled, previewGate.accepts(ticket, owner: store.userID, profile: self.profile, visible: visible) else { return }
                    parsed = combined; preview = result["preview"]; reading = false; step = 1
                    try draftStorage.save(NativeLifeImportDraft(profile: profile, items: combined.items, preview: preview, skipped: combined.skipped, duplicates: combined.duplicates))
                } catch { if previewGate.accepts(ticket, owner: store.userID, profile: self.profile, visible: visible) { fileError = error.localizedDescription; reading = false } }
            }
        } catch { if error.localizedDescription.contains("没有完成状态") { needsCompletionConfirmation = true; fileError = nil } else { fileError = error.localizedDescription }; reading = false }
    }
    private func commitImport(_ parsed: NativeLifeImportResult) {
        guard !committing, !reading, !store.busy, store.pending == nil, confirmed, let epoch = preview["dataEpoch"].intValue, !preview["snapshotHash"].stringValue.orEmpty.isEmpty else { return }
        do {
            let profile = try NativeLifeContract.profileID(profile)
            let body = NativeLifeContract.importBody(profile: profile, items: parsed.items, epoch: epoch, preview: preview)
            committing = true
            Task {
                defer { committing = false }
                if await store.mutate(label: "导入本人完成收藏", path: "life/douban/import", body: body) {
                    completedCount = parsed.items.count; step = 2; self.parsed = nil; preview = .null; confirmed = false; files = []; fileError = nil; try? draftStorage.clear()
                }
            }
        } catch { fileError = error.localizedDescription }
    }
    private func retryImport() {
        guard !committing, !store.busy else { return }
        committing = true
        Task {
            defer { committing = false }
            await store.retryPending()
            if store.pending == nil && store.error == nil {
                completedCount = store.lastMutation["receipt"]["total"].intValue ?? parsed?.items.count ?? 0
                step = 2; try? draftStorage.clear()
            }
        }
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
