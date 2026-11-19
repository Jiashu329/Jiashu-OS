import SwiftUI
import PhotosUI
import UIKit
import ImageIO
import Combine

enum NativeRecipeSource: String, Decodable {
    case xiaohongshu, xiachufang, own

    var title: String {
        switch self {
        case .xiaohongshu: "小红书"
        case .xiachufang: "下厨房"
        case .own: "自制菜"
        }
    }

    static func link(_ input: String) -> URL? {
        supportedLink(in: input)?.url
    }

    static func sharedText(in input: String) -> NativeRecipeSharedText? {
        guard let match = supportedLink(in: input), platform(for: match.url) == .xiaohongshu else { return nil }
        return NativeRecipeSharedText(copy: String(input[..<match.start]))
    }

    private static func supportedLink(in input: String) -> (url: URL, start: String.Index)? {
        guard input.utf16.count <= 8192,
              let regex = try? NSRegularExpression(pattern: #"(?<![A-Za-z0-9_+.:/=-])https?://[^\s<>\"'“”‘’《》〈〉【】（）。，、；：！？]+"#,
                                                   options: .caseInsensitive) else { return nil }
        for match in regex.matches(in: input, range: NSRange(input.startIndex..., in: input)) {
            guard let range = Range(match.range, in: input) else { continue }
            var text = String(input[range])
            while let last = text.last, ".!?,;:)]}".contains(last) { text.removeLast() }
            guard text.utf16.count <= 2048, !text.contains("\\"), var parts = URLComponents(string: text) else { continue }
            parts.scheme = "https"
            if let url = parts.url, platform(for: url) != nil { return (url, range.lowerBound) }
        }
        return nil
    }

    static func platform(for url: URL) -> Self? {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              url.port == nil, let host = url.host?.lowercased() else { return nil }
        let pattern: String
        let source: Self
        switch host {
        case "xiaohongshu.com", "www.xiaohongshu.com", "m.xiaohongshu.com":
            pattern = #"^/(?:explore|discovery/item|user/profile/[a-f0-9]{24})/[a-f0-9]{24}/?$"#
            source = .xiaohongshu
        case "rednote.com", "www.rednote.com":
            pattern = #"^/(?:(?:en|zh)/)?(?:explore|discovery/item)/[a-f0-9]{24}/?$"#
            source = .xiaohongshu
        case "xhslink.com", "www.xhslink.com", "xhslink.cn", "www.xhslink.cn":
            pattern = #"^/(?:[aom]/)?[a-z0-9]{4,64}/?$"#
            source = .xiaohongshu
        case "xiachufang.com", "www.xiachufang.com", "m.xiachufang.com", "mip.xiachufang.com":
            pattern = #"^/recipe/[1-9][0-9]{0,15}/?$"#
            source = .xiachufang
        default:
            return nil
        }
        return url.path.range(of: pattern, options: [.regularExpression, .caseInsensitive]) == nil ? nil : source
    }
}

/// Keeps the user's pasted share copy separate from verified ingredient and step fields.
struct NativeRecipeSharedText: Equatable {
    let title: String
    let excerpt: String?

    init?(copy: String) {
        let cleaned = copy.replacingOccurrences(
            of: #"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]"#,
            with: "", options: .regularExpression)
        let lines = cleaned.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard let first = lines.first, !first.contains("://"),
              first.range(of: #"发布了(?:一篇|一条)小红书笔记|复制(?:这段话|本条信息)|^(?:打开|去)[【\[]?小红书|^小红书分享[：:]?$"#,
                          options: .regularExpression) == nil else { return nil }
        let marker = first.range(of: #"(?:准备材料|食材|用料|做法|步骤)\s*[：:]"#, options: .regularExpression)
        let name = String(first[..<(marker?.lowerBound ?? first.endIndex)])
            .replacingOccurrences(of: "\t", with: " ").trimmingCharacters(in: .whitespaces)
        guard name.rangeOfCharacter(from: .letters) != nil else { return nil }
        title = recipeTextPrefix(name, limit: 100)
        let initial = marker.map { [String(first[$0.lowerBound...])] } ?? []
        let details = (initial + Array(lines.dropFirst())).joined(separator: "\n")
        excerpt = details.isEmpty ? nil : recipeTextPrefix(details, limit: 960)
    }
}

private struct NativeRecipe: Decodable, Identifiable {
    let id: String
    let title: String
    let source: NativeRecipeSource
    let sourceUrl: String?
    let sourceTitle: String?
    let sourceAuthor: String?
    let note: String
    let ingredients: String?
    let steps: String?
    let servings: String?
    let cookingCount: Int
    let coverCookingId: String?
    let revision: Int
    let archivedAt: String?
    let cookings: [NativeRecipeCooking]?

    var originalURL: URL? {
        guard let sourceUrl, let url = URL(string: sourceUrl), NativeRecipeSource.platform(for: url) == source else { return nil }
        return url
    }
    var detailsMissing: Bool {
        source != .own && (ingredients ?? "").isEmpty && (steps ?? "").isEmpty
    }
}

private struct NativeRecipeCooking: Decodable, Identifiable {
    let id: String
    let note: String
    let hasPhoto: Bool
    let revision: Int
    let createdAt: String

    var date: String {
        guard let value = NativeDates.parse(createdAt) else { return String(createdAt.prefix(10)) }
        return NativeActionDates.day(value)
    }
}

private struct NativeRecipePage: Decodable {
    let recipes: [NativeRecipe]
    let nextOffset: Int?
}

private struct NativeRecipeEnvelope: Decodable {
    let recipe: NativeRecipe
}

private struct NativeRecipePreviewEnvelope: Decodable {
    struct Preview: Decodable {
        let title: String?
        let ingredients: [String]?
        let steps: [String]?
        let author: String?
    }
    let preview: Preview?
}

@MainActor
private final class NativeRecipesContext: ObservableObject {
    static let path = "health/nutrition/recipes"
    struct Change {
        let id = UUID()
        let recipe: NativeRecipe
        let foundExisting: Bool
    }

    @Published private var writeError: String?
    @Published private(set) var change: Change?
    private static let submissions = NativePendingSubmissions<NativeNutritionCommand>()
    private let submission: NativePendingSubmission<NativeNutritionCommand>
    private var submissionObservation: AnyCancellable?
    private let api: NativeAPI
    private let token: String
    private let images = NSCache<NSString, UIImage>()

    init(api: NativeAPI, token: String, userID: String) {
        self.api = api
        self.token = token
        let storage = NativeWorkspacePersistence(userID: userID, scope: "recipe-pending-submission")
        submission = Self.submissions.forOwner(userID) {
            NativePendingSubmission(load: { try storage.load(NativeNutritionCommand.self) },
                                    save: { try storage.save($0) }, clear: { try storage.clear() })
        }
        submissionObservation = submission.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        images.totalCostLimit = 12 * 1024 * 1024
    }

    var pending: NativeNutritionCommand? { submission.pending }
    var busy: Bool { submission.busy }
    var error: String? { submission.storageError?.localizedDescription ?? writeError }

    func restorePending() { submission.restore() }

    func clearError() {
        if pending == nil { writeError = nil }
    }

    func page(source: String, cooked: Bool, search: String, offset: Int) async throws -> NativeRecipePage {
        var query = [
            URLQueryItem(name: "source", value: source),
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "limit", value: "20"),
        ]
        if cooked { query.append(URLQueryItem(name: "cooked", value: "1")) }
        if !search.isEmpty { query.append(URLQueryItem(name: "q", value: search)) }
        return try await read(listPath(query))
    }

    func recipe(_ id: String) async throws -> NativeRecipe {
        let envelope: NativeRecipeEnvelope = try await read(try recipePath(id))
        guard envelope.recipe.id == id, envelope.recipe.cookings != nil else { throw NativeAPIError.invalidResponse }
        return envelope.recipe
    }

    private func existingRecipe(sourceURL: String) async throws -> NativeRecipe {
        let path = try listPath([URLQueryItem(name: "sourceUrl", value: sourceURL)])
        let envelope: NativeRecipeEnvelope = try await read(path)
        guard envelope.recipe.originalURL != nil, envelope.recipe.cookings != nil,
              envelope.recipe.archivedAt == nil else { throw NativeAPIError.invalidResponse }
        return envelope.recipe
    }

    func preview(url: URL) async throws -> NativeRecipePreviewEnvelope.Preview? {
        let data = try NativeJSON.object(["sourceUrl": .string(url.absoluteString)]).encodedData()
        let envelope: NativeRecipePreviewEnvelope = try await api.request(path: Self.path + "/preview",
            method: "POST", token: token, body: data, reportWorkspaceFailure: true)
        return envelope.preview
    }

    func photo(recipeID: String, cookingID: String, revision: String) async throws -> UIImage {
        let path = try cookingPath(recipeID: recipeID, cookingID: cookingID) + "/photo"
        let cacheKey = (path + "@" + revision) as NSString
        if let cached = images.object(forKey: cacheKey) { return cached }
        struct ImageEnvelope: Decodable { let photoDataUrl: String }
        let envelope: ImageEnvelope = try await read(path)
        let data = try NativeRecipePhoto.decode(envelope.photoDataUrl)
        guard let image = UIImage(data: data) else { throw NativeAPIError.invalidResponse }
        let pixelCost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? data.count
        images.setObject(image, forKey: cacheKey, cost: pixelCost)
        return image
    }

    func recipePath(_ id: String) throws -> String {
        Self.path + "/" + (try identifier(id))
    }

    func cookingPath(recipeID: String, cookingID: String) throws -> String {
        try recipePath(recipeID) + "/cookings/" + identifier(cookingID)
    }

    func retry() async -> NativeRecipe? {
        restorePending()
        guard let pending else { return nil }
        return await write(pending, retrying: true)
    }

    func write(_ command: NativeNutritionCommand, retrying: Bool = false) async -> NativeRecipe? {
        guard !busy else { return nil }
        writeError = nil
        do {
            let outcome: Change? = try await submission.attempt(command, retrying: retrying) {
                do {
                    let response: NativeRecipeEnvelope = try await self.api.request(path: command.path,
                        method: command.method, token: self.token, body: command.body.encodedData(),
                        headers: ["Idempotency-Key": command.requestID], reportWorkspaceFailure: true)
                    let path = command.path.split(separator: "/")
                    let expectedID = path.count > 3 ? String(path[3]) : command.requestID
                    guard response.recipe.id == expectedID, response.recipe.cookings != nil else {
                        throw NativeAPIError.invalidResponse
                    }
                    return .success(Change(recipe: response.recipe, foundExisting: false))
                } catch let failure as NativeAPIError {
                    switch failure {
                    case .server(409, "RECIPE_ALREADY_SAVED", _, _)
                        where command.path == Self.path && command.method == "POST":
                        guard let url = command.body["sourceUrl"].stringValue else { return .failure(failure) }
                        do {
                            let existing = try await self.existingRecipe(sourceURL: url)
                            return .success(Change(recipe: existing, foundExisting: true))
                        } catch { return .failure(error) }
                    case .invalidRequest:
                        return .failure(failure)
                    case .server(let status, _, _, _) where [400, 404, 409, 413, 415, 422].contains(status):
                        return .failure(failure)
                    default:
                        throw failure
                    }
                }
            }
            if let outcome {
                images.removeAllObjects()
                change = outcome
            }
            return outcome?.recipe
        } catch is CancellationError {
            return nil
        } catch {
            writeError = error.localizedDescription
            return nil
        }
    }

    private func read<Response: Decodable>(_ path: String) async throws -> Response {
        try await api.request(path: path, token: token, reportWorkspaceFailure: true)
    }

    private func listPath(_ query: [URLQueryItem]) throws -> String {
        var parts = URLComponents()
        parts.path = Self.path
        parts.queryItems = query
        parts.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let path = parts.string else { throw NativeAPIError.invalidRequest }
        return path
    }

    private func identifier(_ raw: String) throws -> String {
        guard UUID(uuidString: raw) != nil else { throw NativeAPIError.invalidResponse }
        return raw
    }
}

@MainActor
struct NativeRecipesRoot: View {
    private enum Filter: String, CaseIterable, Identifiable {
        case saved = "收藏", cooked = "我做的"
        var id: Self { self }
    }

    private struct Query: Equatable {
        let filter: Filter
        let search: String
        let mutation: UUID?
    }

    @StateObject private var context: NativeRecipesContext
    @State private var filter: Filter = .saved
    @State private var search = ""
    @State private var editor: NativeRecipeEditorMode?
    @State private var existingRecipe: NativeRecipe?
    @State private var showingExisting = false
    @State private var recipes: [NativeRecipe] = []
    @State private var nextOffset: Int?
    @State private var loadedQuery: Query?
    @State private var loading = false
    @State private var readError: String?
    @State private var readID = UUID()

    init(api: NativeAPI, token: String, userID: String) {
        _context = StateObject(wrappedValue: NativeRecipesContext(api: api, token: token, userID: userID))
    }

    private var query: Query {
        Query(filter: filter, search: recipeTextPrefix(search.trimmingCharacters(in: .whitespacesAndNewlines), limit: 100),
              mutation: context.change?.id)
    }

    var body: some View {
        List {
            Section {
                Picker("菜谱分类", selection: $filter) {
                    ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
            }
            pendingSection
            results
        }
        .nativeGeometricPage()
        .navigationTitle("我的菜谱")
        .searchable(text: $search, prompt: "搜索菜名或食材")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("保存菜谱链接", systemImage: "link") { open(.link) }
                    Button("上传自制菜", systemImage: "camera") { open(.own) }
                } label: {
                    Image(systemName: "plus").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("添加菜谱")
                .disabled(context.busy || context.pending != nil)
            }
        }
        .task(id: query) {
            context.restorePending()
            let requested = query
            if !requested.search.isEmpty {
                do { try await Task.sleep(for: .milliseconds(250)) }
                catch { return }
            }
            await load(requested)
        }
        .refreshable { await load(query) }
        .navigationDestination(isPresented: $showingExisting) {
            if let existingRecipe { NativeRecipeDetail(context: context, initial: existingRecipe) }
        }
        .onChange(of: showingExisting) { _, showing in
            if !showing { existingRecipe = nil }
        }
        .sheet(item: $editor, onDismiss: { showingExisting = existingRecipe != nil }) { mode in
            NavigationStack {
                NativeRecipeEditor(context: context, mode: mode) { saved in
                    select(saved)
                }
            }
        }
    }

    @ViewBuilder private var pendingSection: some View {
        if let pending = context.pending {
            Section("保存待确认") {
                Text(pending.title)
                Button("继续核对原操作") {
                    Task {
                        if let saved = await context.retry(), saved.archivedAt == nil {
                            select(saved)
                            showingExisting = existingRecipe != nil
                        }
                    }
                }
                .disabled(context.busy)
            }
        }
        NativeFeatureFeedback(busy: context.busy, error: context.error)
    }

    @ViewBuilder private var results: some View {
        if let readError {
            Section {
                NativeInlineNotice(readError, tone: .error)
                Button("重试") { Task { await load(query) } }.disabled(loading)
            }
        }
        if loadedQuery?.filter == query.filter, loadedQuery?.search == query.search {
            if recipes.isEmpty && !loading && readError == nil {
                Section {
                    NativeFeatureEmpty(title: emptyTitle, detail: emptyDetail, icon: "book.closed")
                    if query.search.isEmpty {
                        Button(filter == .saved ? "保存菜谱链接" : "上传自制菜") {
                            open(filter == .saved ? .link : .own)
                        }
                        .disabled(context.pending != nil || context.busy)
                    }
                }
            } else {
                ForEach(recipes) { recipe in
                    NavigationLink {
                        NativeRecipeDetail(context: context, initial: recipe)
                    } label: {
                        NativeRecipeRow(context: context, recipe: recipe)
                    }
                }
                if let nextOffset {
                    Button("载入更多菜谱") { Task { await load(query, offset: nextOffset) } }
                        .disabled(loading || loadedQuery != query)
                }
            }
        }
        if loading { ProgressView("读取菜谱…") }
    }

    private var emptyTitle: String {
        if !query.search.isEmpty { return "没有符合的菜谱" }
        return filter == .saved ? "还没有收藏" : "还没有做过的菜"
    }

    private var emptyDetail: String {
        if !query.search.isEmpty { return "试试其他菜名或食材。" }
        return filter == .saved ? "保存小红书或下厨房链接。" : "上传自己做的菜，或为收藏菜谱添加一次做菜记录。"
    }

    private func open(_ mode: NativeRecipeEditorMode) {
        context.clearError()
        editor = mode
    }

    private func select(_ recipe: NativeRecipe) {
        filter = recipe.source == .own ? .cooked : .saved
        search = ""
        if context.change?.foundExisting == true { existingRecipe = recipe }
    }

    private func load(_ requested: Query, offset: Int = 0) async {
        guard requested == query, offset == 0 || !loading else { return }
        let id = UUID()
        readID = id
        loading = true
        readError = nil
        defer { if readID == id { loading = false } }

        do {
            let result = try await context.page(source: requested.filter == .saved ? "linked" : "all",
                                                cooked: requested.filter == .cooked, search: requested.search, offset: offset)
            guard readID == id, requested == query, !Task.isCancelled else { return }
            if offset == 0 {
                recipes = result.recipes
            } else {
                let previouslyLoaded = Set(recipes.map(\.id))
                recipes.append(contentsOf: result.recipes.filter { !previouslyLoaded.contains($0.id) })
            }
            loadedQuery = requested
            nextOffset = result.nextOffset.flatMap { $0 > offset ? $0 : nil }
        } catch {
            if readID == id, requested == query, !Task.isCancelled { readError = error.localizedDescription }
        }
    }
}

@MainActor
private struct NativeRecipeRow: View {
    let context: NativeRecipesContext
    let recipe: NativeRecipe

    var body: some View {
        HStack(spacing: 12) {
            NativeRecipeThumbnail(context: context, recipe: recipe)
            VStack(alignment: .leading, spacing: 5) {
                Text(recipe.title).font(.headline).foregroundStyle(NativePalette.ink)
                Text(recipe.source.title + (recipe.cookingCount > 0 ? " · 做过 \(recipe.cookingCount) 次" : ""))
                    .font(.caption).foregroundStyle(NativePalette.muted)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

@MainActor
private struct NativeRecipeThumbnail: View {
    let context: NativeRecipesContext
    let recipe: NativeRecipe
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(NativePalette.soft)
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: recipe.source == .own ? "fork.knife" : "book.closed")
                    .foregroundStyle(NativePalette.accent)
            }
        }
        .frame(width: 54, height: 54)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityHidden(true)
        .task(id: recipe.id + ":\(recipe.revision):" + (recipe.coverCookingId ?? "")) {
            image = nil
            guard let cookingID = recipe.coverCookingId else { return }
            let result = try? await context.photo(recipeID: recipe.id, cookingID: cookingID, revision: "recipe:\(recipe.revision)")
            if !Task.isCancelled { image = result }
        }
    }
}

@MainActor
private struct NativeRecipeDetail: View {
    @ObservedObject var context: NativeRecipesContext
    @State private var recipe: NativeRecipe
    @State private var loading = false
    @State private var readError: String?
    @State private var editing = false
    @State private var cookingEditor: NativeRecipeCookingEdit?
    @State private var confirmingDelete = false
    @Environment(\.dismiss) private var dismiss

    init(context: NativeRecipesContext, initial: NativeRecipe) {
        self.context = context
        _recipe = State(initialValue: initial)
    }

    var body: some View {
        List {
            if let readError {
                Section {
                    NativeInlineNotice(readError, tone: .error)
                    Button("重新读取菜谱") { Task { await load() } }.disabled(loading)
                }
            }
            if loading { ProgressView("读取菜谱…") }
            if let pending = context.pending {
                Section("保存待确认") {
                    Text(pending.title)
                    Button("继续核对原操作") { Task { await context.retry() } }.disabled(context.busy)
                }
            }
            NativeFeatureFeedback(busy: context.busy, error: context.error)
            Section("菜谱") {
                LabeledContent("来源", value: recipe.source.title)
                if let author = recipe.sourceAuthor, !author.isEmpty { LabeledContent("作者", value: author) }
                if let title = recipe.sourceTitle, !title.isEmpty, title != recipe.title {
                    LabeledContent("原文标题", value: title)
                }
                if let url = recipe.originalURL {
                    Link(destination: url) { Label("打开原文", systemImage: "arrow.up.right.square") }
                }
                if recipe.detailsMissing && recipe.cookings != nil {
                    NativeInlineNotice("原链接已保存。可打开原文，或手动补充食材和做法。")
                }
                if let servings = recipe.servings, !servings.isEmpty { LabeledContent("份量", value: servings) }
            }
            textSection("食材与用量", recipe.ingredients)
            textSection("做法", recipe.steps)
            textSection("备注", recipe.note)
            Section("我做过的") {
                ForEach(recipe.cookings ?? []) { cooking in
                    Button {
                        context.clearError()
                        cookingEditor = NativeRecipeCookingEdit(cooking: cooking)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            if cooking.hasPhoto {
                                NativeRecipeCookingPhoto(context: context, recipeID: recipe.id, cooking: cooking)
                            }
                            Label(cooking.date, systemImage: "calendar")
                            if !cooking.note.isEmpty {
                                Text(cooking.note).font(.subheadline).foregroundStyle(NativePalette.muted)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(!canEdit)
                    .accessibilityHint("查看或编辑做菜记录")
                }
                Button("添加做菜记录", systemImage: "camera") {
                    context.clearError()
                    cookingEditor = NativeRecipeCookingEdit(cooking: nil)
                }
                .disabled(!canEdit)
            }
        }
        .nativeGeometricPage()
        .navigationTitle(recipe.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu("更多", systemImage: "ellipsis.circle") {
                    Button("编辑菜谱", systemImage: "pencil") { context.clearError(); editing = true }
                    Button("删除菜谱", systemImage: "trash", role: .destructive) { confirmingDelete = true }
                }
                .disabled(!canEdit)
            }
        }
        .task {
            context.restorePending()
            await load()
        }
        .refreshable { await load() }
        .onChange(of: context.change?.id) { _, _ in
            guard let saved = context.change?.recipe, saved.id == recipe.id else { return }
            recipe = saved
            if saved.archivedAt != nil { dismiss() }
        }
        .sheet(isPresented: $editing) {
            NavigationStack { NativeRecipeEditor(context: context, mode: .edit(recipe)) { recipe = $0 } }
        }
        .sheet(item: $cookingEditor) { editor in
            NavigationStack {
                NativeRecipeCookingEditor(context: context, recipeID: recipe.id, cooking: editor.cooking) { recipe = $0 }
            }
        }
        .confirmationDialog("删除这份菜谱？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("删除菜谱", role: .destructive) { Task { await deleteRecipe() } }
        } message: {
            Text("这份菜谱会从收藏和我做的列表移除。")
        }
    }

    private var canEdit: Bool { recipe.cookings != nil && !loading && !context.busy && context.pending == nil }

    @ViewBuilder private func textSection(_ title: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            Section(title) { Text(value).textSelection(.enabled) }
        }
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        readError = nil
        let startingChange = context.change?.id
        defer { loading = false }
        do {
            let fetched = try await context.recipe(recipe.id)
            if !Task.isCancelled, context.change?.id == startingChange { recipe = fetched }
        } catch {
            if !Task.isCancelled { readError = error.localizedDescription }
        }
    }

    private func deleteRecipe() async {
        do {
            let path = try context.recipePath(recipe.id)
            let body: NativeJSON = .object(["expectedRevision": .integer(recipe.revision)])
            if await context.write(NativeNutritionCommand(path: path, method: "DELETE", title: "删除菜谱", body: body)) != nil {
                dismiss()
            }
        } catch { readError = error.localizedDescription }
    }
}

private enum NativeRecipeEditorMode: Identifiable {
    case link, own, edit(NativeRecipe)
    var id: String {
        switch self { case .link: "link"; case .own: "own"; case .edit(let recipe): recipe.id }
    }
    var title: String {
        switch self { case .link: "保存菜谱链接"; case .own: "上传自制菜"; case .edit: "编辑菜谱" }
    }
}

private struct NativeRecipeWebSource: Identifiable {
    let url: URL
    var id: URL { url }
}

private func recipeTextPrefix(_ value: String, limit: Int) -> String {
    guard value.utf16.count > limit else { return value }
    var remaining = limit
    return String(value.prefix { character in
        remaining -= String(character).utf16.count
        return remaining >= 0
    })
}

private struct NativeRecipeFields {
    var title = ""
    var ingredients = ""
    var steps = ""
    var servings = ""
    var note = ""

    init(_ recipe: NativeRecipe? = nil) {
        if let recipe {
            title = recipe.title
            ingredients = recipe.ingredients ?? ""
            steps = recipe.steps ?? ""
            servings = recipe.servings ?? ""
            note = recipe.note
        }
    }

    var body: [String: NativeJSON] {
        [
            "title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines)),
            "ingredients": .string(ingredients),
            "steps": .string(steps),
            "servings": .string(servings),
            "note": .string(note),
        ]
    }
}

@MainActor
private struct NativeRecipeEditor: View {
    @ObservedObject var context: NativeRecipesContext
    let mode: NativeRecipeEditorMode
    let onSaved: (NativeRecipe) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var fields: NativeRecipeFields
    @State private var linkText = ""
    @State private var sourcePreview: NativeRecipePreviewEnvelope.Preview?
    @State private var webSource: NativeRecipeWebSource?
    @State private var xiaohongshuNote: NativeXiaohongshuNote?
    @State private var appliedTitle: String?
    @State private var appliedNote: String?
    @State private var appliedIngredients: String?
    @State private var appliedSteps: String?
    @State private var previewMessage: String?
    @State private var readingPreview = false
    @State private var photo: NativeRecipePhotoChange = .keep
    @State private var processingPhoto = false
    @State private var cookingNote = ""
    @State private var localError: String?

    init(context: NativeRecipesContext, mode: NativeRecipeEditorMode, onSaved: @escaping (NativeRecipe) -> Void) {
        self.context = context
        self.mode = mode
        self.onSaved = onSaved
        if case .edit(let recipe) = mode { _fields = State(initialValue: NativeRecipeFields(recipe)) }
        else { _fields = State(initialValue: NativeRecipeFields()) }
    }

    var body: some View {
        Form {
            Group {
                if isLink { linkSection }
                else if previewURL != nil { Section("原文资料") { previewControls } }
                Section("菜名") {
                    TextField(isLink ? "可选，留空则用来源名称" : "输入菜名", text: $fields.title)
                        .accessibilityIdentifier("recipe-title")
                }
                if case .own = mode {
                    Section("自制菜照片") {
                        NativeRecipePhotoField(existing: nil, change: $photo, processing: $processingPhoto)
                        TextField("这次做菜的心得（可选）", text: $cookingNote, axis: .vertical)
                    }
                }
                Section("食材与做法") {
                    TextField("份量，例如 2 人份", text: $fields.servings)
                    TextField("食材与用量，每项一行", text: $fields.ingredients, axis: .vertical).lineLimit(3...8)
                    TextField("做法，每步一行", text: $fields.steps, axis: .vertical).lineLimit(3...8)
                }
                Section("备注") { TextField("可选", text: $fields.note, axis: .vertical).lineLimit(2...5) }
                if let xiaohongshuNote {
                    Section {
                        DisclosureGroup("查看小红书笔记正文") {
                            Text(xiaohongshuNote.body).textSelection(.enabled)
                        }
                    }
                }
            }
            .disabled(context.busy || context.pending != nil)
            NativeRecipeSaveFeedback(context: context, localError: localError, onSaved: finish)
        }
        .nativeGeometricPage()
        .navigationTitle(mode.title)
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(context.busy)
        .sheet(item: $webSource) { source in
            NativeXiaohongshuReader(url: source.url) { note in
                guard previewURL == source.url, !context.busy, context.pending == nil else { return }
                applyXiaohongshuNote(note)
            }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(context.busy) }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") { Task { await save() } }.disabled(!canSave)
            }
        }
    }

    private var isLink: Bool {
        if case .link = mode { return true }
        return false
    }

    private var canSave: Bool {
        guard !context.busy, context.pending == nil, !processingPhoto else { return false }
        if isLink { return previewURL != nil }
        return !fields.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var previewURL: URL? {
        switch mode {
        case .link: NativeRecipeSource.link(linkText)
        case .edit(let recipe): recipe.originalURL
        case .own: nil
        }
    }

    private var linkSection: some View {
        Section("小红书或下厨房链接") {
            TextField("粘贴链接或分享文字", text: $linkText, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("recipe-link")
                .onChange(of: linkText) { old, new in
                    if NativeRecipeSource.link(old) != NativeRecipeSource.link(new) { clearPreview() }
                    applyShareText(new)
                }
            if !linkText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               NativeRecipeSource.link(linkText) == nil {
                NativeInlineNotice("未找到可用的小红书或下厨房 HTTPS 链接。", tone: .attention)
            }
            previewControls
        }
    }

    @ViewBuilder private var previewControls: some View {
        if let url = previewURL, NativeRecipeSource.platform(for: url) == .xiaohongshu {
            Button { webSource = NativeRecipeWebSource(url: url) } label: {
                Label("读取小红书原文", systemImage: "doc.text.magnifyingglass")
            }
            .accessibilityIdentifier("recipe-read-xiaohongshu")
            Link(destination: url) { Label("打开小红书原文", systemImage: "arrow.up.right.square") }
            if let previewMessage {
                NativeInlineNotice(previewMessage)
            } else if isLink && (appliedTitle != nil || appliedNote != nil) {
                NativeInlineNotice("已带入分享文案。读取原文后可补充食材和做法。")
            }
        } else {
            Button("读取可用菜谱资料") { Task { await readPreview() } }
                .disabled(previewURL == nil || readingPreview)
            if readingPreview { ProgressView("读取原文资料…") }
            if let previewMessage { NativeInlineNotice(previewMessage) }
        }
    }

    private func readPreview() async {
        guard !readingPreview, let url = previewURL, NativeRecipeSource.platform(for: url) == .xiachufang else { return }
        readingPreview = true
        previewMessage = nil
        defer { readingPreview = false }
        do {
            let result = try await context.preview(url: url)
            guard !Task.isCancelled, !context.busy, context.pending == nil, previewURL == url else { return }
            sourcePreview = result
            if let result {
                let placeholder = NativeRecipeSource.platform(for: url).map { $0.title + "菜谱" }
                if fields.title.isEmpty || fields.title == placeholder, let title = result.title {
                    fields.title = recipeTextPrefix(title, limit: 100)
                    appliedTitle = fields.title
                }
                if fields.ingredients.isEmpty, let ingredients = result.ingredients {
                    fields.ingredients = recipeTextPrefix(ingredients.joined(separator: "\n"), limit: 3000)
                    appliedIngredients = fields.ingredients
                }
                if fields.steps.isEmpty, let steps = result.steps {
                    fields.steps = recipeTextPrefix(steps.joined(separator: "\n"), limit: 6000)
                    appliedSteps = fields.steps
                }
                previewMessage = "已填入可读取的资料，可核对或编辑后保存。"
            } else {
                previewMessage = "暂时无法读取原文资料，仍可直接保存链接。"
            }
        } catch {
            if !Task.isCancelled, !context.busy, previewURL == url {
                previewMessage = "暂时无法读取原文资料，仍可直接保存链接。"
            }
        }
    }

    private func clearPreview() {
        if let appliedTitle, fields.title == appliedTitle { fields.title = "" }
        if let appliedNote, fields.note == appliedNote { fields.note = "" }
        if let appliedIngredients, fields.ingredients == appliedIngredients { fields.ingredients = "" }
        if let appliedSteps, fields.steps == appliedSteps { fields.steps = "" }
        appliedTitle = nil
        appliedNote = nil
        appliedIngredients = nil
        appliedSteps = nil
        sourcePreview = nil
        xiaohongshuNote = nil
        previewMessage = nil
    }

    private func applyShareText(_ input: String) {
        guard xiaohongshuNote == nil, let url = NativeRecipeSource.link(input),
              NativeRecipeSource.platform(for: url) == .xiaohongshu else { return }
        let shared = NativeRecipeSource.sharedText(in: input)
        if fields.title.isEmpty || appliedTitle == fields.title {
            appliedTitle = shared?.title
            fields.title = appliedTitle ?? ""
        }
        if fields.note.isEmpty || appliedNote == fields.note {
            appliedNote = shared.flatMap(\.excerpt).map { "分享文案摘录\n" + $0 }
            fields.note = appliedNote ?? ""
        }
    }

    private func applyXiaohongshuNote(_ note: NativeXiaohongshuNote) {
        xiaohongshuNote = note
        let draft = NativeXiaohongshuRecipeDraft(noteBody: note.body)
        if let title = note.title, fields.title.isEmpty || fields.title == appliedTitle || fields.title == "小红书菜谱" {
            fields.title = recipeTextPrefix(title, limit: 100)
            appliedTitle = fields.title
        }
        if let ingredients = draft.ingredients, fields.ingredients.isEmpty || fields.ingredients == appliedIngredients {
            fields.ingredients = ingredients
            appliedIngredients = ingredients
        }
        if let steps = draft.steps, fields.steps.isEmpty || fields.steps == appliedSteps {
            fields.steps = steps
            appliedSteps = steps
        }
        if note.body.utf16.count <= 1000, fields.note.isEmpty || fields.note == appliedNote {
            fields.note = note.body
            appliedNote = note.body
        }
        previewMessage = "已读取小红书原文。可在下方核对菜谱或展开笔记正文。"
    }

    private func save() async {
        guard canSave else { return }
        var body = fields.body
        localError = nil
        do {
            let path: String
            let method: String
            switch mode {
            case .link:
                guard let url = NativeRecipeSource.link(linkText), let source = NativeRecipeSource.platform(for: url) else { return }
                if body["title"]?.stringValue?.isEmpty == true { body["title"] = .string(source.title + "菜谱") }
                body["sourceUrl"] = .string(url.absoluteString)
                if let sourceTitle = xiaohongshuNote?.title ?? sourcePreview?.title {
                    body["sourceTitle"] = .string(recipeTextPrefix(sourceTitle, limit: 200))
                }
                if let author = sourcePreview?.author { body["sourceAuthor"] = .string(author) }
                path = NativeRecipesContext.path
                method = "POST"
            case .own:
                body["cookingNote"] = .string(cookingNote)
                body["photoDataUrl"] = photo.payload
                path = NativeRecipesContext.path
                method = "POST"
            case .edit(let recipe):
                body["expectedRevision"] = .integer(recipe.revision)
                path = try context.recipePath(recipe.id)
                method = "PATCH"
            }
            if let saved = await context.write(NativeNutritionCommand(path: path, method: method, title: mode.title, body: .object(body))) {
                finish(saved)
            }
        } catch { localError = error.localizedDescription }
    }

    private func finish(_ saved: NativeRecipe) {
        onSaved(saved)
        dismiss()
    }
}

private struct NativeRecipeCookingEdit: Identifiable {
    let id = UUID()
    let cooking: NativeRecipeCooking?
}

@MainActor
private struct NativeRecipeCookingEditor: View {
    @ObservedObject var context: NativeRecipesContext
    let recipeID: String
    let cooking: NativeRecipeCooking?
    let onSaved: (NativeRecipe) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var note: String
    @State private var existingPhoto: UIImage?
    @State private var photo: NativeRecipePhotoChange = .keep
    @State private var processingPhoto = false
    @State private var photoLoading = false
    @State private var photoError: String?
    @State private var localError: String?
    @State private var confirmingDelete = false

    init(context: NativeRecipesContext, recipeID: String, cooking: NativeRecipeCooking?,
         onSaved: @escaping (NativeRecipe) -> Void) {
        self.context = context
        self.recipeID = recipeID
        self.cooking = cooking
        self.onSaved = onSaved
        _note = State(initialValue: cooking?.note ?? "")
    }

    var body: some View {
        Form {
            Section("照片") {
                if photoLoading { ProgressView("读取照片…") }
                if let photoError {
                    NativeInlineNotice(photoError, tone: .error)
                    Button("重试读取照片") { Task { await loadPhoto() } }
                }
                NativeRecipePhotoField(existing: existingPhoto, hasExisting: cooking?.hasPhoto == true,
                                       change: $photo, processing: $processingPhoto)
            }
            .disabled(context.busy || context.pending != nil)
            Section("做菜心得") { TextField("可选", text: $note, axis: .vertical).lineLimit(3...8) }
                .disabled(context.busy || context.pending != nil)
            if cooking != nil {
                Section {
                    Button("删除这次做菜记录", role: .destructive) { confirmingDelete = true }
                        .disabled(context.busy || context.pending != nil)
                }
            }
            NativeRecipeSaveFeedback(context: context, localError: localError, onSaved: finish)
        }
        .nativeGeometricPage()
        .navigationTitle(cooking == nil ? "添加做菜记录" : "编辑做菜记录")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(context.busy)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(context.busy) }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") { Task { await save() } }.disabled(!canSave)
            }
        }
        .task { await loadPhoto() }
        .confirmationDialog("删除这次做菜记录？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("删除记录", role: .destructive) { Task { await save(deleting: true) } }
        } message: { Text("这次记录中的照片也会从菜谱移除。") }
    }

    private var canSave: Bool {
        !context.busy && context.pending == nil && !processingPhoto &&
            (cooking != nil || photo != .keep || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private func loadPhoto() async {
        guard !photoLoading, let cooking, cooking.hasPhoto else { return }
        photoLoading = true
        photoError = nil
        defer { photoLoading = false }
        do {
            let image = try await context.photo(recipeID: recipeID, cookingID: cooking.id, revision: "cooking:\(cooking.revision)")
            if !Task.isCancelled { existingPhoto = image }
        } catch {
            if !Task.isCancelled { photoError = "暂时无法读取已保存照片。" }
        }
    }

    private func save(deleting: Bool = false) async {
        guard deleting ? (!context.busy && context.pending == nil) : canSave else { return }
        localError = nil
        do {
            let path: String
            let method: String
            var body: [String: NativeJSON] = [:]
            if let cooking {
                path = try context.cookingPath(recipeID: recipeID, cookingID: cooking.id)
                body["expectedRevision"] = .integer(cooking.revision)
                method = deleting ? "DELETE" : "PATCH"
            } else {
                path = try context.recipePath(recipeID) + "/cookings"
                method = "POST"
            }
            if !deleting {
                body["note"] = .string(note)
                body["photoDataUrl"] = photo.payload
            }
            let command = NativeNutritionCommand(path: path, method: method,
                                                 title: deleting ? "删除做菜记录" : "保存做菜记录", body: .object(body))
            if let saved = await context.write(command) { finish(saved) }
        } catch { localError = error.localizedDescription }
    }

    private func finish(_ saved: NativeRecipe) {
        onSaved(saved)
        dismiss()
    }
}

@MainActor
private struct NativeRecipeSaveFeedback: View {
    @ObservedObject var context: NativeRecipesContext
    let localError: String?
    let onSaved: (NativeRecipe) -> Void

    var body: some View {
        NativeFeatureFeedback(busy: context.busy, error: localError ?? context.error)
        if context.pending != nil && !context.busy {
            Section("保存待确认") {
                Button("继续核对原操作") {
                    Task { if let saved = await context.retry() { onSaved(saved) } }
                }
            }
        }
    }
}

private enum NativeRecipePhotoChange: Equatable {
    case keep, replace(Data), remove

    var payload: NativeJSON? {
        switch self {
        case .keep: nil
        case .replace(let data): .string(NativeRecipePhoto.prefix + data.base64EncodedString())
        case .remove: .null
        }
    }
}

private enum NativeRecipePhoto {
    static let prefix = "data:image/jpeg;base64,"
    private static let uploadLimit = 240 * 1024

    static func decode(_ dataURL: String) throws -> Data {
        guard dataURL.hasPrefix(prefix), dataURL.utf8.count <= 350_000,
              let data = Data(base64Encoded: String(dataURL.dropFirst(prefix.count))),
              data.count <= 256 * 1024 else { throw NativeAPIError.invalidResponse }
        return data
    }

    static func shrink(_ sanitized: Data) throws -> Data {
        if sanitized.count <= uploadLimit { return sanitized }
        guard let source = CGImageSourceCreateWithData(sanitized as CFData, nil) else {
            throw NativeActionInputError.invalid("无法读取这张照片。")
        }
        for size in [1280, 900, 640] {
            guard let pixels = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: size
            ] as CFDictionary) else { continue }
            let image = UIImage(cgImage: pixels)
            for quality in [0.82, 0.65, 0.48, 0.3] {
                if let result = image.jpegData(compressionQuality: quality), result.count <= uploadLimit { return result }
            }
        }
        throw NativeActionInputError.invalid("照片压缩后仍过大，请选择较小的图片。")
    }
}

@MainActor
private struct NativeRecipePhotoField: View {
    let existing: UIImage?
    var hasExisting = false
    @Binding var change: NativeRecipePhotoChange
    @Binding var processing: Bool
    @State private var pickedPhoto: PhotosPickerItem?
    @State private var showingCamera = false
    @State private var cameraPending = false
    @State private var error: String?

    private var image: UIImage? {
        switch change {
        case .keep: existing
        case .replace(let data): UIImage(data: data)
        case .remove: nil
        }
    }

    private var hasPhoto: Bool { image != nil || (hasExisting && change == .keep) }

    var body: some View {
        if let image {
            Image(uiImage: image).resizable().scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: 235)
                .accessibilityLabel("自制菜照片预览")
        }
        PhotosPicker(selection: $pickedPhoto, matching: .images) {
            Label(hasPhoto ? "从相册更换照片" : "从相册选照片", systemImage: "photo")
        }
        .disabled(processing || cameraPending)
        .task(id: pickedPhoto) { if let item = pickedPhoto { await load(item) } }
        Button(hasPhoto ? "拍照更换" : "拍照", systemImage: "camera") { Task { await openCamera() } }
            .disabled(processing || cameraPending)
            .fullScreenCover(isPresented: $showingCamera) {
                NativeNutritionCamera(onCapture: capture, onCancel: { showingCamera = false }, onUnavailable: {
                    error = "当前设备无法使用相机，请从相册选择。"
                    showingCamera = false
                })
                .ignoresSafeArea()
            }
        if hasPhoto {
            Button("移除照片", systemImage: "trash", role: .destructive) {
                change = hasExisting ? .remove : .keep
                pickedPhoto = nil
            }.disabled(processing || cameraPending)
        }
        if processing { ProgressView("准备照片…") }
        if let error { NativeInlineNotice(error, tone: .error) }
    }

    private func load(_ item: PhotosPickerItem) async {
        processing = true
        error = nil
        defer { if pickedPhoto == item { processing = false } }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw NativeActionInputError.invalid("无法读取这张照片。")
            }
            guard !Task.isCancelled, pickedPhoto == item else { return }
            change = .replace(try NativeRecipePhoto.shrink(NativeNutritionPhoto.jpeg(data)))
        } catch {
            if !Task.isCancelled, pickedPhoto == item { self.error = error.localizedDescription }
        }
    }

    private func openCamera() async {
        guard !cameraPending, !processing else { return }
        cameraPending = true
        error = nil
        defer { cameraPending = false }
        let access = await NativeNutritionCameraAccess.requestForUserAction()
        guard !Task.isCancelled else { return }
        if access == .ready { showingCamera = true }
        else { error = access == .denied ? "相机权限未开启，可在系统设置开启或改用相册。"
                                      : "相机暂不可用，请从相册选择。" }
    }

    private func capture(_ image: UIImage) {
        do {
            change = .replace(try NativeRecipePhoto.shrink(NativeNutritionPhoto.jpeg(image: image)))
            error = nil
            pickedPhoto = nil
        } catch { self.error = error.localizedDescription }
        showingCamera = false
    }
}

@MainActor
private struct NativeRecipeCookingPhoto: View {
    let context: NativeRecipesContext
    let recipeID: String
    let cooking: NativeRecipeCooking
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 230)
                    .accessibilityLabel("做菜照片")
            } else {
                Label("做菜照片", systemImage: "photo").foregroundStyle(NativePalette.muted)
            }
        }
        .task(id: cooking.revision) {
            image = nil
            let result = try? await context.photo(recipeID: recipeID, cookingID: cooking.id, revision: "cooking:\(cooking.revision)")
            if !Task.isCancelled { image = result }
        }
    }
}
