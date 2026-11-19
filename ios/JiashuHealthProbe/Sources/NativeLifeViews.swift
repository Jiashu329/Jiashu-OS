import SwiftUI
import UniformTypeIdentifiers
import UIKit

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
    func updateCredential(token: String, userID: String) {
        guard self.userID == userID else { deactivate(); return }
        self.token = token
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

/// Layout decisions are local to the shelf and never start another API read.
enum NativeLifeShelfMetrics {
    static let spacing: CGFloat = 14
    static let portraitRatio: CGFloat = 3.0 / 4.0

    static func columnCount(availableWidth: CGFloat, titlePointSize: CGFloat,
                            prefersTwoColumns: Bool, titles: [String]) -> Int {
        guard availableWidth.isFinite, availableWidth >= 96 * 3 + spacing * 2,
              !prefersTwoColumns else { return 2 }
        let width = (availableWidth - spacing * 2) / 3
        let font = UIFont.systemFont(ofSize: max(1, titlePointSize), weight: .medium)
        let titlesFit = titles.allSatisfy { title in
            let bounds = (title as NSString).boundingRect(
                with: CGSize(width: width, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: font], context: nil)
            return ceil(bounds.height) <= ceil(font.lineHeight * 2)
        }
        return titlesFit ? 3 : 2
    }

    static func artworkSize(width: CGFloat, domain: String) -> CGSize {
        let safeWidth = width.isFinite ? max(0, width) : 0
        return CGSize(width: safeWidth, height: domain == "music" ? safeWidth : safeWidth / portraitRatio)
    }

    static func markingDate(_ value: String?) -> String {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "日期未知" }
        if value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil {
            return String(value.suffix(5)).replacingOccurrences(of: "-", with: "/")
        }
        return value
    }
}

struct NativeLifeRoot: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @StateObject private var store: NativeLifeStore
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .subheadline) private var shelfTitleSize: CGFloat = 14
    @FocusState private var searchFocused: Bool
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
    private var hasBrowseCriteria: Bool {
        store.filters.kind != "all" || !store.filters.query.isEmpty || !store.filters.activeChips.isEmpty
    }
    private var browseChips: [(key: String, title: String)] {
        var values = store.filters.activeChips.filter { $0.key != "sort" }
        if store.filters.kind == "screen" { values.insert(("kind", "待分类影视"), at: 0) }
        return values
    }
    private var searchText: Binding<String> {
        Binding(get: { store.filters.query }, set: { value in
            let wasEmpty = store.filters.query.isEmpty
            store.filters.query = value
            if value.isEmpty && !wasEmpty { selected.removeAll(); Task { await store.load() } }
        })
    }
    var body: some View {
        GeometryReader { geometry in
          ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                searchBar
                categoryBar
                browseControls
                if !browseChips.isEmpty { filterChips }
                if let pending = contentPending {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("保存结果待确认", systemImage: "clock.arrow.circlepath").font(.headline)
                        Text(pending.label).font(.subheadline).foregroundStyle(NativePalette.muted)
                        Button("继续确认") { Task { await store.retryPending() } }.disabled(store.busy)
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .nativeGeometricCard(fill: NativePalette.peach, corner: 22, compactCorner: 8)
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
                        Label(hasBrowseCriteria ? "没有找到作品" : "收藏从这里开始", systemImage: "books.vertical")
                    } description: { Text(hasBrowseCriteria ? "试试调整筛选条件。" : "导入看过、读过和听过的作品。") } actions: {
                        if !hasBrowseCriteria { Button("导入收藏") { importVisible = true } }
                        else { Button("清除筛选") { store.filters = NativeLifeFilters(); Task { await store.load() } } }
                    }
                } else if listLayout || typeSize.isAccessibilitySize {
                    LazyVStack(spacing: 0) {
                        ForEach(store.items) { item in
                            HStack(spacing: 12) {
                                if organizing && item.domain == "screen" { selectionButton(item) }
                                NavigationLink { NativeLifeDetail(store: store, initial: item) } label: { NativeLifeRow(store: store, item: item) }.buttonStyle(NativePressStyle())
                            }.padding(.vertical, 10)
                            Divider()
                        }
                    }
                } else {
                    shelf(availableWidth: max(0, geometry.size.width - 36))
                }
                if store.response["hasMore"].boolValue == true { Button { Task { await store.load(more: true) } } label: { if store.loading { ProgressView() } else { Text("加载更多") } }.frame(maxWidth: .infinity).padding(.vertical, 8).disabled(store.loading) }
                if store.completing { HStack { ProgressView(); Text("正在更新作品资料").font(.subheadline); Spacer(); Button("暂停") { store.pause() } } }
            }.padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 20)
          }
          .scrollDismissesKeyboard(.interactively)
        }
        .nativeGeometricPage()
        .navigationTitle("书影音")
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
                }.padding().background(NativePalette.surface)
            }
        }
        .refreshable { await store.load() }
        .sheet(isPresented: $filtersVisible) { NavigationStack { NativeLifeFilterSheet(store: store) } }
        .sheet(isPresented: $importVisible, onDismiss: { Task { await store.load() } }) { NavigationStack { NativeLifeImportForm(store: store) } }
        .sheet(isPresented: $resetVisible) { NavigationStack { NativeLifeResetView(store: store) } }
        .task(id: userID) { store.activate(token: token, userID: userID); await store.load() }
        .onChange(of: token) { _, value in store.updateCredential(token: value, userID: userID) }
        .onDisappear { store.pause() }
    }
    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(NativePalette.muted).accessibilityHidden(true)
            TextField("作品、创作者或标签", text: searchText)
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                .focused($searchFocused)
                .onSubmit { searchFocused = false; selected.removeAll(); Task { await store.load() } }
                .accessibilityLabel("搜索作品、创作者或标签")
            if !store.filters.query.isEmpty {
                Button { searchText.wrappedValue = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(NativePalette.muted).frame(minWidth: 44, minHeight: 44)
                }.buttonStyle(.plain).accessibilityLabel("清除搜索")
            }
        }.font(.subheadline).padding(.leading, 12).padding(.trailing, store.filters.query.isEmpty ? 12 : 0)
            .frame(minHeight: 46)
            .nativeGeometricCard(fill: NativePalette.surface, corner: 15, compactCorner: 6, compactAt: .bottomTrailing)
    }
    private var browseControls: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { collectionCount; Spacer(minLength: 8); sortMenu; filterButton }
            VStack(alignment: .leading, spacing: 0) {
                collectionCount
                sortMenu
                filterButton
            }
        }.font(.caption).foregroundStyle(NativePalette.muted)
    }
    private var collectionCount: some View {
        Text("\(store.total) 部收藏").monospacedDigit().fixedSize(horizontal: true, vertical: false)
    }
    private var sortMenu: some View {
        Menu {
            Picker("排序", selection: Binding(get: { store.filters.sort }, set: { value in
                guard value != store.filters.sort else { return }
                store.filters.sort = value; selected.removeAll(); Task { await store.load() }
            })) {
                Text("标记日期从近到远").tag("date-desc")
                Text("标记日期从远到近").tag("date-asc")
                Text("个人评分从高到低").tag("rating-desc")
                Text("个人评分从低到高").tag("rating-asc")
            }
        } label: {
            Label(sortLabel, systemImage: "arrow.up.arrow.down").frame(minHeight: 44).fixedSize()
        }.foregroundStyle(NativePalette.accent).accessibilityLabel("排序：" + sortLabel)
    }
    private var sortLabel: String {
        ["date-desc": "最近标记", "date-asc": "最早标记", "rating-desc": "评分优先", "rating-asc": "评分从低到高"][store.filters.sort] ?? "排序"
    }
    private var filterButton: some View {
        Button { selected.removeAll(); searchFocused = false; filtersVisible = true } label: {
            Label(browseChips.isEmpty ? "筛选" : "筛选 · \(browseChips.count)", systemImage: "slider.horizontal.3")
                .frame(minHeight: 44).fixedSize()
        }.foregroundStyle(NativePalette.accent)
    }
    private func shelf(availableWidth: CGFloat) -> some View {
        let count = NativeLifeShelfMetrics.columnCount(availableWidth: availableWidth, titlePointSize: shelfTitleSize,
                                                       prefersTwoColumns: typeSize >= .xxLarge, titles: store.items.map(\.title))
        let width = max(0, (availableWidth - NativeLifeShelfMetrics.spacing * CGFloat(count - 1)) / CGFloat(count))
        let columns = Array(repeating: GridItem(.flexible(minimum: 0), spacing: NativeLifeShelfMetrics.spacing, alignment: .topLeading), count: count)
        return LazyVGrid(columns: columns, alignment: .leading, spacing: 22) {
            ForEach(store.items) { item in
                NavigationLink { NativeLifeDetail(store: store, initial: item) } label: {
                    NativeLifePoster(store: store, item: item, width: width, titlePointSize: shelfTitleSize)
                }.buttonStyle(NativePressStyle())
                    .overlay(alignment: .topTrailing) {
                        if organizing && item.domain == "screen" {
                            selectionButton(item).background(NativePalette.surface, in: Circle()).padding(4)
                        }
                    }
            }
        }
    }
    private var categoryBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(NativeLifeContract.kinds.filter { $0 != "screen" }, id: \.self) { kind in
                    Button { store.filters.kind = kind; selected.removeAll(); Task { await store.load() } } label: {
                        Text(kind == "all" ? "全部" : kind == "series" ? "剧集" : NativeLifeContract.kindLabels[kind] ?? kind)
                            .font(.subheadline.weight(store.filters.kind == kind ? .medium : .regular))
                            .padding(.horizontal, 13).frame(minHeight: 44)
                            .nativeGeometricCard(fill: store.filters.kind == kind ? NativePalette.accent : .clear, corner: 16, compactCorner: 6, compactAt: .bottomTrailing)
                            .foregroundStyle(store.filters.kind == kind ? NativePalette.onAccent : NativePalette.muted)
                    }.buttonStyle(NativePressStyle()).accessibilityAddTraits(store.filters.kind == kind ? .isSelected : [])
                }
            }
        }
    }
    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(browseChips, id: \.key) { chip in
                    Button { if chip.key == "kind" { store.filters.kind = "all" } else { store.filters.removeChip(chip.key) }; selected.removeAll(); Task { await store.load() } } label: { HStack(spacing: 6) { Text(chip.title); Image(systemName: "xmark").font(.caption2) }.font(.caption).padding(.horizontal, 10).frame(minHeight: 44).nativeGeometricCard(fill: NativePalette.soft, corner: 14, compactCorner: 5) }
                        .buttonStyle(NativePressStyle()).accessibilityLabel("移除筛选：" + chip.title)
                }
            }
        }
    }
    private func selectionButton(_ item: NativeLifeItem) -> some View {
        Button { if !selected.insert(item.id).inserted { selected.remove(item.id) } } label: { Image(systemName: selected.contains(item.id) ? "checkmark.circle.fill" : "circle").font(.title2).foregroundStyle(selected.contains(item.id) ? NativePalette.accent : NativePalette.muted).frame(minWidth: 44, minHeight: 44) }
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
    let width: CGFloat
    let titlePointSize: CGFloat
    private var artwork: CGSize { NativeLifeShelfMetrics.artworkSize(width: width, domain: item.domain) }
    private var titleHeight: CGFloat { ceil(UIFont.systemFont(ofSize: titlePointSize, weight: .medium).lineHeight * 2) }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            NativeLifeCover(api: store.api, token: store.token, item: item, contentMode: .fit)
                .frame(width: artwork.width, height: artwork.height)
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: item.domain == "book" ? 6 : 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: item.domain == "music" ? 6 : 20, style: .continuous))
                // The mask belongs to the real cover. The extra album space is
                // above it, so all titles and ratings share the same baseline.
                .frame(width: width, height: width / NativeLifeShelfMetrics.portraitRatio, alignment: .bottom)
                .accessibilityHidden(true)
            Text(item.title).font(.system(size: titlePointSize, weight: .medium)).foregroundStyle(NativePalette.ink)
                .lineLimit(2).frame(maxWidth: .infinity, minHeight: titleHeight, alignment: .topLeading)
            HStack(spacing: 1) {
                if let rating = item.raw["rating"].intValue { ForEach(0..<5, id: \.self) { index in Image(systemName: index < rating ? "star.fill" : "star").font(.caption2).foregroundStyle(NativePalette.accent) } }
                else { Text("未评分").font(.caption2).foregroundStyle(NativePalette.muted) }
            }.frame(minHeight: max(15, titlePointSize * 1.1), alignment: .leading)
                .accessibilityLabel(item.raw["rating"].intValue.map { "我的评分\($0)星" } ?? "未评分")
            Text(NativeLifeShelfMetrics.markingDate(item.raw["markedDate"].stringValue)).font(.caption2).foregroundStyle(NativePalette.muted)
                .accessibilityLabel(item.raw["markedDate"].stringValue.map { "标记日期：" + $0 } ?? "标记日期未知")
        }.frame(width: width, alignment: .topLeading).accessibilityElement(children: .combine)
    }
}

private struct NativeLifeFilterSheet: View {
    @ObservedObject var store: NativeLifeStore
    @Environment(\.dismiss) private var dismiss
    @State private var filters: NativeLifeFilters
    init(store: NativeLifeStore) {
        self.store = store
        _filters = State(initialValue: store.filters)
    }
    var body: some View {
        Form {
            Picker("分类", selection: $filters.kind) { ForEach(NativeLifeContract.kinds, id: \.self) { kind in Text(NativeLifeContract.kindLabels[kind] ?? kind).tag(kind) } }
            Picker("来源", selection: $filters.profile) { Text("全部已保存来源").tag("all"); Text("当前绑定主页").tag("current") }
            Picker("我的评分", selection: $filters.rating) { Text("全部评分").tag(""); Text("未评分").tag("unrated"); ForEach(1...5, id: \.self) { Text("\($0) 星").tag(String($0)) } }
            Picker("豆瓣标记年份", selection: $filters.year) { Text("全部年份").tag(""); ForEach(store.response["years"].arrayValue.compactMap(\.intValue), id: \.self) { Text(String($0)).tag(String($0)) } }
            Picker("排序", selection: $filters.sort) { Text("标记日期从近到远").tag("date-desc"); Text("标记日期从远到近").tag("date-asc"); Text("个人评分从高到低").tag("rating-desc"); Text("个人评分从低到高").tag("rating-asc") }
            Picker("展示范围", selection: $filters.hidden) { Text("未隐藏").tag("visible"); Text("已隐藏").tag("hidden"); Text("全部").tag("all") }
            Picker("标签", selection: $filters.tag) { Text("全部标签").tag(""); ForEach(store.response["tags"].arrayValue.compactMap(\.stringValue), id: \.self) { Text($0).tag($0) } }
            Toggle("只看资料待补全", isOn: $filters.missing)
            Text("标记日期未知的作品不会归入某一年。").font(.caption).foregroundStyle(.secondary)
            Button("清除筛选") { filters = NativeLifeFilters() }
        }
        .navigationTitle("筛选与排序")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("查看收藏") { store.filters = filters; dismiss(); Task { await store.load() } } } }
    }
}

private struct NativeLifeRow: View {
    @ObservedObject var store: NativeLifeStore
    let item: NativeLifeItem
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            NativeLifeCover(api: store.api, token: store.token, item: item, contentMode: .fit)
                .frame(width: 68, height: NativeLifeShelfMetrics.artworkSize(width: 68, domain: item.domain).height)
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: 6, bottomLeadingRadius: 14, bottomTrailingRadius: 6, topTrailingRadius: 14)).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(NativePalette.ink).lineLimit(3)
                Text(item.kindLabel + (item.raw["markedDate"].stringValue.map { " · " + $0 } ?? "")).font(.caption).foregroundStyle(NativePalette.muted)
                if let rating = item.raw["rating"].intValue {
                    Label("\(rating) 星", systemImage: "star.fill")
                        .foregroundStyle(NativePalette.accent).accessibilityLabel("我的评分\(rating)星")
                }
                HStack { if let score = item.raw["details"]["doubanRating"].doubleValue { Text("豆瓣 \(score, specifier: "%.1f")") }; if let score = item.raw["imdb"]["rating"].doubleValue { Text("IMDb \(score, specifier: "%.1f")") } }.font(.caption2).foregroundStyle(NativePalette.muted)
                if !item.tags.isEmpty { Text(item.tags.joined(separator: " · ")).font(.caption).foregroundStyle(NativePalette.accent) }
            }
            Spacer(minLength: 0)
        }.padding(.vertical, 5)
    }
}

struct NativeLifeCover: View {
    let api: NativeAPI
    let token: String
    let item: NativeLifeItem
    var contentMode: ContentMode = .fit
    @State private var image: UIImage?
    @State private var failed = false
    @State private var retry = 0
    private var publicURL: URL? {
        if item.raw["cover"]["mode"].stringValue == "url" { return NativeLifeContract.publicImageURL(item.raw["cover"]["url"].stringValue) }
        let url = NativeLifeContract.publicImageURL(item.raw["tmdbCoverUrl"].stringValue)
        return url?.host == "image.tmdb.org" ? url : nil
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                NativePalette.soft
                if let publicURL {
                    // AsyncImage has no authenticated headers. Never pass API tokens
                    // to user-selected images or TMDB's public image host.
                    AsyncImage(url: publicURL) { phase in
                        if let image = phase.image {
                            image.resizable().aspectRatio(contentMode: contentMode)
                                .frame(width: geometry.size.width, height: geometry.size.height, alignment: .center)
                        } else if phase.error != nil { placeholder }
                        else { ProgressView() }
                    }
                } else if let image {
                    Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
                        .frame(width: geometry.size.width, height: geometry.size.height, alignment: .center)
                } else if failed { placeholder.overlay(alignment: .bottomTrailing) { Button { retry += 1 } label: { Image(systemName: "arrow.clockwise").font(.caption).foregroundStyle(NativePalette.ink).frame(width: 44, height: 44) }.buttonStyle(.plain).accessibilityLabel("重试封面") } }
                else if item.raw["coverUrl"].stringValue != nil { ProgressView() }
                else { placeholder }
            }
            // The caller's asymmetric mask is applied to these exact bounds,
            // after images, loading and fallback share one clipping rectangle.
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        }
        .task(id: item.id + ":" + item.updatedAt + ":" + String(retry)) {
            guard publicURL == nil, item.raw["coverUrl"].stringValue != nil else { return }
            image = nil; failed = false
            do {
                let data = try await api.download(path: NativeLifeContract.protectedCoverPath(item: item), token: token)
                guard !Task.isCancelled else { return }
                guard data.mimeType.hasPrefix("image/"), data.data.count <= 4 * 1024 * 1024, let loaded = UIImage(data: data.data) else { failed = true; return }
                image = loaded
            } catch { if !Task.isCancelled { failed = true } }
        }
    }
    private var placeholder: some View {
        ZStack {
            (item.domain == "book" ? NativePalette.peach : item.domain == "screen" ? NativePalette.accent : NativePalette.soft)
            GeometryReader { proxy in
                Circle().fill((item.domain == "screen" ? NativePalette.onAccent : NativePalette.accent).opacity(0.13))
                    .frame(width: max(56, proxy.size.width * 0.9), height: max(56, proxy.size.width * 0.9))
                    .position(x: proxy.size.width * 0.95, y: proxy.size.height * 0.12)
            }.accessibilityHidden(true)
            Image(systemName: item.domain == "book" ? "book.closed" : item.domain == "music" ? "opticaldisc" : "film")
                .font(.title3.weight(.light)).foregroundStyle(item.domain == "screen" ? NativePalette.onAccent : NativePalette.ink)
                .accessibilityHidden(true)
        }.clipped().accessibilityLabel("暂无封面")
    }
}

/// Resolve a recent home item against current owner-scoped records before
/// presenting the existing detail editor and its existing version checks.
struct NativeLifeDetailDestination: View {
    let api: NativeAPI
    let token: String
    let userID: String
    let item: NativeLifeItem
    @StateObject private var store: NativeLifeStore
    @State private var loaded = false

    init(api: NativeAPI, token: String, userID: String, item: NativeLifeItem) {
        self.api = api; self.token = token; self.userID = userID; self.item = item
        _store = StateObject(wrappedValue: NativeLifeStore(api: api, token: token, userID: userID))
    }
    var body: some View {
        Group {
            if loaded, let current = store.detailItems[item.id] {
                NativeLifeDetail(store: store, initial: current)
            } else if !loaded || store.loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView {
                    Label(store.error == nil ? "这部作品已变化" : "暂未读取作品", systemImage: "books.vertical")
                } description: {
                    EmptyView()
                } actions: {
                    Button("重试") { Task { await loadRecord() } }
                    NavigationLink("查看收藏") { NativeLifeRoot(api: api, token: token, userID: userID) }
                }
            }
        }
        .nativeGeometricPage().navigationTitle("作品详情").navigationBarTitleDisplayMode(.inline)
        .task(id: userID) { await loadRecord() }
        .onChange(of: token) { _, value in store.updateCredential(token: value, userID: userID) }
        .onDisappear { store.pause() }
    }
    @MainActor private func loadRecord() async {
        loaded = false; store.activate(token: token, userID: userID)
        var query = ""
        for character in item.title {
            let next = query + String(character)
            if next.utf16.count > 100 { break }
            query = next
        }
        store.filters.query = query; store.filters.hidden = "all"
        await store.load()
        guard !Task.isCancelled, store.userID == userID else { return }
        loaded = true
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
                    NativeLifeCover(api: store.api, token: store.token, item: item).frame(width: 112, height: item.domain == "music" ? 112 : 168).clipShape(RoundedRectangle(cornerRadius: 10))
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
/// The containing app links here from 应用 → 同步中心.
struct NativeLifeSyncCenter: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @StateObject private var store: NativeLifeStore
    @State private var profile = ""
    @State private var profileInitialized = false
    @State private var disconnect = false
    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID
        _store = StateObject(wrappedValue: NativeLifeStore(api: api, token: token, userID: userID))
    }
    private var connected: Bool { store.connection["profileId"].stringValue != nil }
    private var profileBinding: Binding<String> {
        Binding(get: { profile }, set: { value in profile = value; profileInitialized = true })
    }
    var body: some View {
        Form {
            Section {
                LabeledContent("豆瓣", value: connected ? (store.connection["profileId"].stringValue ?? "已连接") : "未连接")
                if let date = store.run["updatedAt"].stringValue { LabeledContent("最近更新", value: NativeWorkspaceFormat.timestamp(date)) }
                if connected {
                    if store.syncing { Button("暂停同步") { store.pause() }; ProgressView() }
                    else { Button(store.run["status"].stringValue == "running" ? "继续同步" : "同步公开收藏") { store.startSync() }.disabled(store.busy || store.pending != nil) }
                } else {
                    TextField("豆瓣主页链接或 ID", text: profileBinding).textInputAutocapitalization(.never).autocorrectionDisabled()
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
                        TextField("豆瓣主页链接或 ID", text: profileBinding).textInputAutocapitalization(.never).autocorrectionDisabled()
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
        .task(id: userID) {
            store.activate(token: token, userID: userID); await store.load()
            if !Task.isCancelled, !profileInitialized, store.connection["revision"].intValue != nil {
                profile = store.connection["profileId"].stringValue ?? ""; profileInitialized = true
            }
        }
        .onChange(of: token) { _, value in store.updateCredential(token: value, userID: userID) }
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
                files = chosen; confirmMissingStatus = false; invalidate(); fileError = nil
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
                    files = [(name, Data(value.utf8))]; confirmMissingStatus = false; invalidate()
                }.disabled(reading || store.pending != nil)
                ForEach(Array(files.enumerated()), id: \.offset) { _, file in Label(file.name, systemImage: "doc.text").font(.subheadline).lineLimit(1) }
            }
            Section("资料来源") {
                TextField("豆瓣主页链接或 ID", text: $profile).textInputAutocapitalization(.never).autocorrectionDisabled().onChange(of: profile) { _, value in
                    if value != previewProfile { confirmMissingStatus = false; invalidate() }
                }
                Toggle("我已核对未注明状态的条目均已完成", isOn: $confirmMissingStatus).onChange(of: confirmMissingStatus) { _, _ in invalidate() }
                Text("默认跳过未注明状态的条目。想看、在看等记录和未知状态仍会跳过。").font(.footnote).foregroundStyle(.secondary)
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
                if parsed.skipped > 0 { LabeledContent("跳过的条目", value: String(parsed.skipped)) }
                if parsed.duplicates > 0 { LabeledContent("合并重复", value: String(parsed.duplicates)) }
                Toggle("已核对来源与作品", isOn: $confirmed).disabled(committing || reading || store.busy || store.pending != nil)
            }
            Section {
                DisclosureGroup("查看 \(parsed.items.count) 部作品") {
                    ForEach(Array(parsed.items.prefix(30).enumerated()), id: \.offset) { _, item in VStack(alignment: .leading, spacing: 4) { Text(item["title"].stringValue ?? ""); Text(item["markedDate"].stringValue ?? "标记日期未知").font(.caption).foregroundStyle(.secondary) } }
                    if parsed.items.count > 30 { Text("显示前30部，其余作品已一并核对。").font(.footnote).foregroundStyle(.secondary) }
                }
                Button("更换资料") { files = []; confirmMissingStatus = false; invalidate() }.disabled(committing || store.pending != nil || store.busy)
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
            let combined = try NativeLifeImportParser.parse(files: files, profile: profile, confirmMissingStatus: confirmMissingStatus)
            guard !combined.items.isEmpty else { throw NativeLifeError.invalid("没有可导入的已完成记录。请核对收藏状态和所属类型。") }
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
        } catch { fileError = error.localizedDescription; reading = false }
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
