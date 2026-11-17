import SwiftUI
import PhotosUI
import UIKit
import ImageIO
import Charts

@MainActor
struct NativeNutritionRoot: View {
    private let initialCompose: Bool
    @StateObject private var context: NativeNutritionContext
    @State private var date = Date()
    @State private var includeDeleted = false
    @State private var data: NativeJSON = .null
    @State private var loading = false
    @State private var readError: String?
    @State private var editor: NutritionEditorPresentation?
    @State private var readID = UUID()
    init(api: NativeAPI, token: String, userID: String, initialCompose: Bool = false) {
        self.initialCompose = initialCompose
        _context = StateObject(wrappedValue: NativeNutritionContext(api: api, token: token, userID: userID))
    }
    private var day: String { NativeActionDates.day(date) }
    var body: some View {
        List {
            if let pending = context.pending {
                Section("待确认的原操作") {
                    Text(pending.title)
                    Text("原内容和提交标识已在此设备加密保存。继续核对不会创建第二次操作。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("继续核对") { Task { await context.retry(); await load() } }.disabled(context.busy)
                }
            }
            NativeNutritionErrorRow(text: context.error)
            Section {
                DatePicker("饮食日期", selection: $date, in: ...Date(), displayedComponents: .date)
                Button("手动记录食物", systemImage: "plus.circle") {
                    editor = NutritionEditorPresentation(rows: [.object(["date": .string(day), "meal": .string("lunch")])])
                }.disabled(context.pending != nil || context.busy)
                NavigationLink("一句话或照片识别") { NativeNutritionRecognitionView(context: context, date: day) }
                NavigationLink("食物库与份量换算") {
                    NativeNutritionFoodsView(api: context.api, token: context.token, userID: context.userID) { rows in editor = NutritionEditorPresentation(rows: rows) }
                }
                NavigationLink("常吃、最近与复制餐次") { NativeNutritionReuseView(context: context, date: day) { editor = NutritionEditorPresentation(rows: $0) } }
                NavigationLink("自建食物、食谱与整餐模板") { NativeNutritionTemplatesView(context: context) { editor = NutritionEditorPresentation(rows: $0) } }
            }
            if loading { Section { ProgressView("正在读取当天饮食…") } }
            if let readError { Section { NativeNutritionErrorRow(text: readError); Button("重新读取") { Task { await load() } } } }
            if data != .null {
                Section("当天已记录") {
                    NativeNutritionTotals(nutrients: data["summary"]["nutrients"])
                    Text(data["dayStatus"]["complete"].boolValue == true ? "本人已标记当天记完" : "尚未标记全天记完")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text("小计只包含已填写项目，未知值及未记录食物不计为0。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(QuickEntryMeal.allCases) { meal in
                    Section(meal.title) {
                        let rows = data["entries"].arrayValue.filter { $0["meal"].stringValue == meal.rawValue }
                        if rows.isEmpty { Text(data["dayStatus"]["meals"][meal.rawValue].stringValue == "skipped" ? "已标记未进食" : "暂无记录").foregroundStyle(.secondary) }
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                            NavigationLink {
                                NativeNutritionEntryDetail(context: context, initial: row)
                            } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(row["name"].stringValue ?? "食物").strikethrough(row["deleted"].boolValue == true)
                                    Text((row["portion"].stringValue ?? "") + " · " + NativeNutritionFields.value(row["calories"], unit: "千卡"))
                                        .font(.footnote).foregroundStyle(.secondary)
                                    if row["deleted"].boolValue == true { Text("已删除").font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                        }
                    }
                }
                Section {
                    NavigationLink("餐次状态与当天记完") { NativeNutritionStatusView(context: context, initial: data["dayStatus"], date: day) }
                    Toggle("显示删除记录", isOn: $includeDeleted)
                }
            }
            Section("回顾与目标") {
                NavigationLink("7天／30天饮食回顾") { NativeNutritionReviewView(context: context, initialDate: date) }
                NavigationLink("每日营养目标与需求测算") { NativeNutritionGoalsView(context: context) }
            }
        }
        .navigationTitle("饮食")
        .environment(\.timeZone, NativeActionDates.timeZone)
        .task {
            context.restorePending()
            if initialCompose, context.pending == nil {
                editor = NutritionEditorPresentation(rows: [.object(["date": .string(day), "meal": .string("lunch")])])
            }
        }
        .task(id: day + String(includeDeleted)) { await load() }
        .onChange(of: context.changes) { _, _ in Task { await load() } }
        .refreshable { await load() }
        .sheet(item: $editor) { presentation in
            NavigationStack { NativeNutritionBatchEditor(context: context, rows: presentation.rows) }
        }
    }
    private func load() async {
        let selected = day, identifier = UUID(); readID = identifier
        loading = true; readError = nil; data = .null
        do {
            let result = try await context.api.json(path: "health/nutrition?" + NativeWorkspaceFormat.query(["date": selected, "includeDeleted": includeDeleted ? "1" : "0"]), token: context.token)
            guard !Task.isCancelled, readID == identifier, day == selected else { return }
            guard result["date"].stringValue == selected else { throw NativeAPIError.invalidResponse }
            data = result
        } catch { if !Task.isCancelled && readID == identifier { readError = error.localizedDescription } }
        if readID == identifier { loading = false }
    }
}

struct NutritionEditorPresentation: Identifiable {
    let id = UUID()
    let rows: [NativeJSON]
}

struct NativeNutritionTotals: View {
    let nutrients: NativeJSON
    var body: some View {
        ForEach(NativeNutritionFields.keys, id: \.self) { key in
            VStack(alignment: .leading, spacing: 3) {
                LabeledContent(NativeNutritionFields.title(key) + "已知小计",
                    value: NativeNutritionFields.value(nutrients[key]["total"], unit: key == "calories" ? "千卡" : "克"))
                Text("已知\(nutrients[key]["knownCount"].intValue ?? 0)项 · 未知\(nutrients[key]["unknownCount"].intValue ?? 0)项")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct NativeNutritionReadOnlyFields: View {
    let row: NativeJSON
    var body: some View {
        LabeledContent("日期", value: row["date"].stringValue ?? "未知")
        LabeledContent("餐次", value: NativeNutritionFields.meal(row["meal"].stringValue))
        LabeledContent("份量", value: row["portion"].stringValue ?? "未填写")
        ForEach(NativeNutritionFields.keys, id: \.self) { key in
            VStack(alignment: .leading, spacing: 4) {
                LabeledContent(NativeNutritionFields.title(key), value: NativeNutritionFields.value(row[key], unit: key == "calories" ? "千卡" : "克"))
                Text("来源：" + NativeNutritionFields.source(row["provenance"][key]["source"].stringValue)).font(.caption).foregroundStyle(.secondary)
                if let basis = row["provenance"][key]["basis"].stringValue, !basis.isEmpty { Text(basis).font(.caption).foregroundStyle(.secondary) }
                if let original = row["provenance"][key]["originalValue"].stringValue { Text("原参考值：" + original).font(.caption).foregroundStyle(.secondary) }
            }
        }
        if let release = row["food"]["catalogRelease"].stringValue { LabeledContent("食物库版本", value: release) }
        if let note = row["note"].stringValue, !note.isEmpty { Text(note) }
    }
}

@MainActor
struct NativeNutritionEntryDetail: View {
    @ObservedObject var context: NativeNutritionContext
    @State private var row: NativeJSON
    @State private var error: String?
    @State private var editing = false
    @State private var confirmingDelete = false
    init(context: NativeNutritionContext, initial: NativeJSON) { self.context = context; _row = State(initialValue: initial) }
    private var entryID: String { row["id"].stringValue ?? "" }
    var body: some View {
        Form {
            Section(row["name"].stringValue ?? "食物详情") {
                NativeNutritionMacroChart(row: row)
                NativeNutritionReadOnlyFields(row: row)
            }
            Section {
                Button("编辑记录") { editing = true }
                NavigationLink("修改历史与恢复") { NativeNutritionHistoryView(context: context, entryID: entryID) }
                Button("加入常吃") { Task { await favorite() } }
                Button(row["deleted"].boolValue == true ? "恢复这条记录" : "删除这条记录", role: .destructive) { confirmingDelete = true }
            }.disabled(context.busy || context.pending != nil)
            NativeNutritionErrorRow(text: error ?? context.error)
        }
        .navigationTitle("食物详情").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: context.changes) { _, _ in Task { await load() } }
        .sheet(isPresented: $editing) { NavigationStack { NativeNutritionBatchEditor(context: context, rows: [row], editing: row) } }
        .confirmationDialog("确认修改这条记录的删除状态？已有修改历史继续保留。", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button(row["deleted"].boolValue == true ? "恢复记录" : "删除记录", role: .destructive) { Task { await toggleDeleted() } }
        }
    }
    private func load() async {
        do { let result = try await context.api.json(path: "health/nutrition/" + entryID, token: context.token)
            guard !Task.isCancelled else { return }; row = result["entry"]; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func favorite() async {
        _ = await context.write(NativeNutritionCommand(path: "health/nutrition/reuse", title: "将食物加入常吃",
            body: .object(["entryId": .string(entryID), "expectedRevision": row["revision"]])))
    }
    private func toggleDeleted() async {
        _ = await context.write(NativeNutritionCommand(path: "health/nutrition/" + entryID, method: "PATCH", title: "修改食物删除状态",
            body: .object(["deleted": .bool(row["deleted"].boolValue != true), "expectedRevision": row["revision"]])))
    }
}

@MainActor
struct NativeNutritionHistoryView: View {
    @ObservedObject var context: NativeNutritionContext
    let entryID: String
    @State private var history: [NativeJSON] = []
    @State private var revision: NativeJSON = .null
    @State private var target: NativeJSON?
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        List {
            if loading { ProgressView("读取修改历史…") }
            ForEach(Array(history.enumerated()), id: \.offset) { _, item in
                DisclosureGroup("版本\(item["revision"].intValue ?? 0) · " + NativeWorkspaceFormat.timestamp(item["createdAt"].stringValue)) {
                    Text(["baseline":"兼容基线", "create":"新增", "edit":"编辑", "delete":"删除", "restore":"恢复"][item["action"].stringValue ?? ""] ?? "记录变更")
                    if item["before"] != .null {
                        DisclosureGroup("修改前") { NativeNutritionReadOnlyFields(row: item["before"]) }
                    }
                    DisclosureGroup("此版本内容") { NativeNutritionReadOnlyFields(row: item["after"]) }
                    Text(item["after"]["deleted"].boolValue == true ? "此版本为已删除状态" : "此版本为正常记录")
                    Button("恢复到此版本") { target = item }.disabled(context.busy || context.pending != nil)
                }
            }
            if !loading && history.isEmpty && error == nil { Text("暂无可用修改历史。") }
            NativeNutritionErrorRow(text: error ?? context.error)
        }
        .navigationTitle("修改历史").task { await load() }.refreshable { await load() }
        .confirmationDialog("恢复会生成新版本，并保留此版本的日期、餐次和删除状态。", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }), titleVisibility: .visible) {
            if let target { Button("确认恢复") { Task { await restore(target) } } }
        }
    }
    private func load() async {
        loading = true; defer { loading = false }
        do {
            let current = try await context.api.json(path: "health/nutrition/" + entryID, token: context.token)
            let result = try await context.api.json(path: "health/nutrition/" + entryID + "/history", token: context.token)
            guard !Task.isCancelled else { return }; revision = current["entry"]["revision"]; history = result["history"].arrayValue; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func restore(_ target: NativeJSON) async {
        if await context.write(NativeNutritionCommand(path: "health/nutrition/" + entryID + "/restore", title: "恢复饮食历史版本",
            body: .object(["revision": target["revision"], "expectedRevision": revision]))) != nil { await load() }
    }
}

@MainActor
struct NativeNutritionBatchEditor: View {
    @ObservedObject var context: NativeNutritionContext
    @Environment(\.dismiss) private var dismiss
    @State private var drafts: [NativeNutritionDraft]
    let editing: NativeJSON?
    let onSaved: (() -> Void)?
    @State private var error: String?
    @State private var recovered: [NativeNutritionDraft]?
    @State private var originalDrafts: [NativeNutritionDraft]
    @State private var confirmClose = false
    @State private var finished = false
    @State private var persistenceReady = false
    @State private var saveDraftTask: Task<Void, Never>?
    init(context: NativeNutritionContext, rows: [NativeJSON], editing: NativeJSON? = nil, onSaved: (() -> Void)? = nil) {
        self.context = context; self.editing = editing; self.onSaved = onSaved
        let values = rows.map { NativeNutritionDraft($0) }
        _drafts = State(initialValue: values); _originalDrafts = State(initialValue: values)
    }
    private var persistence: NativeWorkspacePersistence {
        NativeWorkspacePersistence(userID: context.userID, scope: "nutrition-editor." + (editing?["id"].stringValue ?? "new"))
    }
    private var changed: Bool { drafts != originalDrafts || (editing == nil && drafts.contains { !$0.name.isEmpty }) }
    var body: some View {
        Form {
            if let recovered {
                Section("本机未完成草稿") {
                    Text("\(recovered.count)项食物；恢复只填回表单，不调用AI或保存记录。")
                    Button("恢复本机草稿") { drafts = recovered; self.recovered = nil }
                    Button("删除本机草稿", role: .destructive) { do { try persistence.clear(); self.recovered = nil } catch { self.error = error.localizedDescription } }
                }
            }
            Section {
                Text(editing == nil ? "核对每项内容后一次保存。识别、模板和食物库选择都不会自动记账。" : "保存使用当前记录版本；发生冲突时保留填写，请重新核对服务器记录。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach($drafts) { $draft in
                DisclosureGroup(draft.name.isEmpty ? "待填写食物" : draft.name) {
                    NativeNutritionDraftFields(draft: $draft, context: context)
                }
            }.onDelete { if editing == nil { drafts.remove(atOffsets: $0) } }
            if editing == nil && drafts.count < 30 { Button("再加一项") { drafts.append(NativeNutritionDraft()) } }
            NativeNutritionErrorRow(text: error ?? context.error)
            Button(context.busy ? "正在确认…" : "确认保存\(drafts.count)项") { Task { await save() } }
                .disabled(context.busy || context.pending != nil || drafts.isEmpty)
        }
        .navigationTitle(editing == nil ? "核对饮食明细" : "编辑食物")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { if changed { confirmClose = true } else { dismiss() } }.disabled(context.busy) } }
        .interactiveDismissDisabled(context.busy || changed)
        .task { do { recovered = try persistence.load([NativeNutritionDraft].self); persistenceReady = true } catch { self.error = error.localizedDescription } }
        .onChange(of: drafts) { _, _ in
            guard persistenceReady, !finished, recovered == nil else { return }
            saveDraftTask?.cancel()
            saveDraftTask = Task { try? await Task.sleep(for: .milliseconds(350)); if !Task.isCancelled { saveDraft() } }
        }
        .onDisappear { saveDraftTask?.cancel(); if !finished && persistenceReady && changed { saveDraft() } }
        .confirmationDialog("还有未完成的饮食明细。", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("保存本机草稿并关闭") { if saveDraft() { finished = true; dismiss() } }
            Button("放弃本页填写", role: .destructive) { do { try persistence.clear(); finished = true; dismiss() } catch { self.error = error.localizedDescription } }
        }
    }
    @discardableResult private func saveDraft() -> Bool {
        do { try persistence.save(drafts); return true }
        catch { self.error = error.localizedDescription; return false }
    }
    private func save() async {
        do {
            let rows = try drafts.map { try $0.payload() }
            let command: NativeNutritionCommand
            if let editing, let first = rows.first, let id = editing["id"].stringValue {
                var body = first.objectValue; body["expectedRevision"] = editing["revision"]
                command = NativeNutritionCommand(path: "health/nutrition/" + id, method: "PATCH", title: "编辑食物记录", body: .object(body))
            } else { command = NativeNutritionCommand(path: "health/nutrition/batch", title: "保存\(rows.count)项饮食明细", body: .object(["entries": .array(rows)])) }
            if await context.write(command) != nil { try persistence.clear(); finished = true; onSaved?(); dismiss() }
        } catch { self.error = error.localizedDescription }
    }
}

enum NativeNutritionPhoto {
    /// Retain only pixels and explicit orientation from a camera UIImage, then
    /// use the same transform/size/metadata sanitizer as selected photo files.
    static func jpeg(image: UIImage) throws -> Data {
        guard let pixels = image.cgImage, pixels.width > 0, pixels.height > 0,
              Double(pixels.width) * Double(pixels.height) <= 32_000_000 else {
            throw NativeActionInputError.invalid("拍摄图片过大或无法读取，请重拍或从相册选择较小图片。")
        }
        let orientation: CGImagePropertyOrientation
        switch image.imageOrientation {
        case .up: orientation = .up
        case .upMirrored: orientation = .upMirrored
        case .down: orientation = .down
        case .downMirrored: orientation = .downMirrored
        case .left: orientation = .left
        case .leftMirrored: orientation = .leftMirrored
        case .right: orientation = .right
        case .rightMirrored: orientation = .rightMirrored
        @unknown default: orientation = .up
        }
        let encoded = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(encoded as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
            throw NativeActionInputError.invalid("拍摄图片暂时无法处理，请重试。")
        }
        CGImageDestinationAddImage(destination, pixels, [kCGImagePropertyOrientation: orientation.rawValue,
            kCGImageDestinationLossyCompressionQuality: 0.95] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw NativeActionInputError.invalid("拍摄图片暂时无法处理，请重试。") }
        return try jpeg(encoded as Data)
    }

    static func jpeg(_ original: Data) throws -> Data {
        guard original.count <= 20 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(original as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0, width.doubleValue * height.doubleValue <= 32_000_000,
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1600, kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else { throw NativeActionInputError.invalid("照片无法读取或超过20MiB／3200万像素，请选择较小的餐食图片。") }
        let image = UIImage(cgImage: thumbnail)
        for quality in [0.85, 0.7, 0.5, 0.3] {
            if let data = image.jpegData(compressionQuality: quality), data.count <= 2 * 1024 * 1024 { return data }
        }
        throw NativeActionInputError.invalid("图片压缩后仍超过2MiB，请选择较小图片。")
    }
}

@MainActor
struct NativeNutritionRecognitionView: View {
    @ObservedObject var context: NativeNutritionContext
    @State private var date: Date
    @State private var meal = "lunch"
    @State private var usePhoto = false
    @State private var text = ""
    @State private var photo: PhotosPickerItem?
    @State private var jpeg: Data?
    @State private var photoLoading = false
    @State private var recognizing = false
    @State private var error: String?
    @State private var result: NativeJSON = .null
    @State private var editor: NutritionEditorPresentation?
    @State private var photoID = UUID()
    @State private var recovered: RecognitionDraft?
    @State private var persistenceReady = false
    @State private var restoringSignature: String?
    @Environment(\.openURL) private var openURL
    @State private var cameraAuthorizing = false
    @State private var showingCamera = false
    @State private var cameraID: UUID?
    @State private var pageEpoch = UUID()
    @State private var visible = false
    @State private var cameraAccess: NativeNutritionCameraAccess?
    private struct RecognitionDraft: Codable {
        let date: String; let meal: String; let text: String; let usePhoto: Bool; let result: NativeJSON
    }
    private var persistence: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: context.userID, scope: "nutrition-recognition") }
    private var inputSignature: String { [NativeActionDates.day(date), meal, text, String(usePhoto)].joined(separator: "|") }
    init(context: NativeNutritionContext, date: String) { self.context = context; _date = State(initialValue: NativeChartDates.parse(date) ?? Date()) }
    var body: some View {
        Form {
            if let recovered {
                Section("本机未完成识别草稿") {
                    Text("\(recovered.date) · " + NativeNutritionFields.meal(recovered.meal) + "。照片不在恢复内容中。")
                    Button("恢复描述和明细") {
                        restoringSignature = [recovered.date, recovered.meal, recovered.text, String(recovered.usePhoto)].joined(separator: "|")
                        date = NativeChartDates.parse(recovered.date) ?? date; meal = recovered.meal; text = recovered.text
                        usePhoto = recovered.usePhoto; result = recovered.result; self.recovered = nil
                    }
                    Button("删除本机草稿", role: .destructive) { do { try persistence.clear(); self.recovered = nil } catch { self.error = error.localizedDescription } }
                }
            }
            Section {
                Picker("录入方式", selection: $usePhoto) { Text("一句话").tag(false); Text("照片").tag(true) }.pickerStyle(.segmented)
                DatePicker("记录日期", selection: $date, in: ...Date(), displayedComponents: .date)
                Picker("餐次", selection: $meal) { ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0.rawValue) } }
                if usePhoto {
                    let pickerTitle = jpeg == nil ? "从相册选择食物照片" : "更换照片"
                    PhotosPicker(selection: $photo, matching: .images) { Label(pickerTitle, systemImage: "photo") }
                        .disabled(cameraAuthorizing || photoLoading)
                    Button(cameraAuthorizing ? "正在核对相机权限…" : "拍一张餐食照片", systemImage: "camera") {
                        Task { await openCamera() }
                    }.disabled(cameraAuthorizing || photoLoading || context.pending != nil)
                    if cameraAccess == .denied {
                        Text("相机权限未开启。可以从相册选择照片，或在系统设置中允许相机。")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("打开相机权限设置") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }
                    } else if cameraAccess == .restricted {
                        Text("相机访问受系统限制，可以从相册选择食物照片。")
                            .font(.footnote).foregroundStyle(.secondary)
                    } else if cameraAccess == .unavailable {
                        Text("此设备当前没有可用相机。模拟器可通过相册选择测试图片。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if photoLoading { ProgressView("正在本机处理图片…") }
                    if let jpeg, let image = UIImage(data: jpeg) {
                        Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 220)
                        Text("已在本机转为JPEG并移除元数据。点击识别后才上传本张图片。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    TextField("实际吃了多少、配料等补充说明", text: $text, axis: .vertical).lineLimit(3...6)
                } else {
                    TextField("例如：午餐吃了一碗米饭和两个鸡蛋", text: $text, axis: .vertical).lineLimit(4...8)
                }
            }.disabled(recognizing)
            Section {
                Text(usePhoto ? "识别会将本张压缩图片、说明、日期和餐次发送给网站配置的AI服务。照片只留在本页内存中，不存入业务备份。" : "识别会将这段饮食描述、日期和餐次发送给网站配置的AI服务。打开页面和输入文字不会调用AI。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button(recognizing ? "正在识别…" : "识别并生成可编辑草稿") { Task { await recognize() } }
                    .disabled(recognizing || photoLoading || cameraAuthorizing || showingCamera || context.pending != nil || (usePhoto ? jpeg == nil : text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                if recognizing { ProgressView() }
                NativeNutritionErrorRow(text: error)
            }
            if result != .null {
                Section("识别结果，尚未保存") {
                    ForEach(Array(result["warnings"].arrayValue.enumerated()), id: \.offset) { _, warning in Text(warning.stringValue ?? "").font(.footnote).foregroundStyle(.orange) }
                    ForEach(Array(result["drafts"].arrayValue.enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item["name"].stringValue ?? "待核对食物").font(.headline)
                            Text(item["portion"].stringValue ?? "份量待核对").font(.footnote)
                            Text("热量：" + NativeNutritionFields.value(item["calories"], unit: "千卡")).font(.footnote)
                            ForEach(Array(item["warnings"].arrayValue.enumerated()), id: \.offset) { _, warning in Text(warning.stringValue ?? "").font(.caption).foregroundStyle(.orange) }
                        }
                    }
                    if !result["drafts"].arrayValue.isEmpty {
                        Button("逐项核对并确认保存") { editor = NutritionEditorPresentation(rows: result["drafts"].arrayValue) }
                    } else { Text("没有生成可核对的食物，请补充说明或手动记录。") }
                }
            }
        }
        .navigationTitle("识别饮食").navigationBarTitleDisplayMode(.inline)
        .environment(\.timeZone, NativeActionDates.timeZone)
        .onChange(of: inputSignature) { _, value in
            if restoringSignature == value { restoringSignature = nil } else { result = .null }
            if recovered == nil { saveDraft() }
        }
        .onChange(of: result) { _, _ in if recovered == nil { saveDraft() } }
        .task { do { recovered = try persistence.load(RecognitionDraft.self); persistenceReady = true } catch { self.error = error.localizedDescription } }
        .onAppear { visible = true; if !showingCamera { pageEpoch = UUID() } }
        .onDisappear {
            if !showingCamera { visible = false; pageEpoch = UUID(); cameraID = nil; cameraAuthorizing = false }
            saveDraft()
        }
        .onChange(of: photo) { _, item in Task { await loadPhoto(item) } }
        .fullScreenCover(isPresented: $showingCamera, onDismiss: { cameraID = nil }) {
            if let identifier = cameraID {
                NativeNutritionCamera(onCapture: { image in acceptCameraImage(image, identifier: identifier) },
                    onCancel: { closeCamera(identifier: identifier) },
                    onUnavailable: { cameraAccess = .unavailable; closeCamera(identifier: identifier) })
                    .ignoresSafeArea()
            }
        }
        .sheet(item: $editor) { presentation in
            NavigationStack {
                NativeNutritionBatchEditor(context: context, rows: presentation.rows, onSaved: {
                    text = ""; photo = nil; jpeg = nil; result = .null
                    try? persistence.clear()
                })
            }
        }
    }
    private func openCamera() async {
        guard visible, usePhoto, !cameraAuthorizing, !recognizing, context.pending == nil else { return }
        let epoch = pageEpoch
        cameraAuthorizing = true
        defer { if pageEpoch == epoch { cameraAuthorizing = false } }
        let access = await NativeNutritionCameraAccess.requestForUserAction()
        guard visible, pageEpoch == epoch, usePhoto, context.pending == nil, !Task.isCancelled else { return }
        cameraAccess = access
        guard access == .ready else { return }
        cameraID = UUID(); showingCamera = true
    }
    private func closeCamera(identifier: UUID) {
        guard cameraID == identifier else { return }
        cameraID = nil; showingCamera = false
    }
    private func acceptCameraImage(_ image: UIImage, identifier: UUID) {
        guard showingCamera, cameraID == identifier else { return }
        do {
            let prepared = try NativeNutritionPhoto.jpeg(image: image)
            guard cameraID == identifier else { return }
            photoID = UUID(); jpeg = prepared; result = .null; error = nil
        } catch { self.error = error.localizedDescription }
        closeCamera(identifier: identifier)
    }
    private func saveDraft() {
        guard persistenceReady, !text.isEmpty || result != .null else { return }
        do { try persistence.save(RecognitionDraft(date: NativeActionDates.day(date), meal: meal, text: text, usePhoto: usePhoto, result: result)) }
        catch { self.error = error.localizedDescription }
    }
    private func loadPhoto(_ item: PhotosPickerItem?) async {
        let identifier = UUID(); photoID = identifier; photoLoading = true; error = nil; jpeg = nil; result = .null
        defer { if photoID == identifier { photoLoading = false } }
        guard let item else { return }
        do {
            guard let raw = try await item.loadTransferable(type: Data.self), photoID == identifier, !Task.isCancelled else { return }
            let prepared = try NativeNutritionPhoto.jpeg(raw)
            guard photoID == identifier, !Task.isCancelled else { return }; jpeg = prepared
        } catch { if photoID == identifier && !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func recognize() async {
        guard !recognizing else { return }
        recognizing = true; error = nil; result = .null
        defer { recognizing = false }
        do {
            var body: [String: NativeJSON] = ["date": .string(NativeActionDates.day(date)), "meal": .string(meal), "text": .string(text)]
            if usePhoto {
                guard let jpeg else { throw NativeActionInputError.invalid("请先选择食物照片。") }
                body["image"] = .object(["dataUrl": .string("data:image/jpeg;base64," + jpeg.base64EncodedString())])
            }
            let response = try await context.api.json(path: usePhoto ? "health/nutrition/photo" : "health/nutrition/parse", method: "POST", token: context.token, body: .object(body))
            guard !Task.isCancelled else { return }; result = response
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

struct NativeNutritionDraftFields: View {
    @Binding var draft: NativeNutritionDraft
    var context: NativeNutritionContext? = nil
    @State private var pickingFood = false
    @State private var foodError: String?
    var body: some View {
        TextField("食物名称", text: Binding(get: { draft.name }, set: { draft.changeIdentity(name: $0) }))
        TextField("食用份量", text: Binding(get: { draft.portion }, set: { draft.changeIdentity(portion: $0) }))
        DatePicker("记录日期", selection: Binding(get: { NativeChartDates.parse(draft.date) ?? Date() }, set: { draft.date = NativeActionDates.day($0) }), in: ...Date(), displayedComponents: .date)
            .environment(\.timeZone, NativeActionDates.timeZone)
        Picker("餐次", selection: $draft.meal) { ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0.rawValue) } }
        ForEach(NativeNutritionFields.keys, id: \.self) { key in
            VStack(alignment: .leading, spacing: 5) {
                TextField(NativeNutritionFields.title(key) + (key == "calories" ? "（千卡，未知留空）" : "（克，未知留空）"),
                    text: Binding(get: { draft.nutrients[key] ?? "" }, set: { draft.setNutrient(key, text: $0) })).keyboardType(.decimalPad)
                Text("来源：" + NativeNutritionFields.source(draft.provenance[key]?["source"].stringValue)).font(.caption).foregroundStyle(.secondary)
                if let basis = draft.provenance[key]?["basis"].stringValue { Text(basis).font(.caption).foregroundStyle(.secondary) }
                Menu("核对来源") {
                    ForEach(["manual", "label", "unknown"], id: \.self) { source in
                        Button(NativeNutritionFields.source(source)) {
                            var origin = draft.provenance[key]?.objectValue ?? [:]; origin["source"] = .string(source)
                            draft.provenance[key] = .object(origin)
                            if source == "unknown" { draft.nutrients[key] = "" }
                        }
                    }
                }.font(.caption)
            }
        }
        if draft.food != .null {
            Text("已关联食物库版本：" + (draft.food["catalogRelease"].stringValue ?? "原始版本")).font(.caption).foregroundStyle(.secondary)
        }
        if context != nil {
            Button(draft.food == .null ? "从食物库核对食物与份量" : "重新选择食物库与份量") { pickingFood = true }
                .sheet(isPresented: $pickingFood) {
                    if let context {
                        NavigationStack {
                            NativeNutritionFoodsView(api: context.api, token: context.token, userID: context.userID, initialQuery: draft.name) { rows in
                                guard rows.count == 1, let row = rows.first else { foodError = "整餐模板包含多项，请从饮食首页使用整餐模板。"; pickingFood = false; return }
                                let selected = NativeNutritionDraft(row, date: draft.date, meal: draft.meal)
                                draft.name = selected.name; draft.portion = selected.portion; draft.note = selected.note
                                draft.nutrients = selected.nutrients; draft.provenance = selected.provenance
                                draft.food = selected.food; draft.original = selected.original; draft.warnings = selected.warnings
                                pickingFood = false
                            }
                        }
                    }
                }
        }
        if !draft.original["candidates"].arrayValue.isEmpty {
            DisclosureGroup("识别给出的候选，需核对规格") {
                ForEach(Array(draft.original["candidates"].arrayValue.enumerated()), id: \.offset) { _, food in
                    Text((food["name"].stringValue ?? "候选食物") + " · " + (food["serving"]["label"].stringValue ?? food["reference"]["label"].stringValue ?? "请查看规格"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        NativeNutritionErrorRow(text: foodError)
        ForEach(draft.warnings, id: \.self) { Text($0).font(.footnote).foregroundStyle(.orange) }
        TextField("备注与来源说明", text: $draft.note, axis: .vertical).lineLimit(2...5)
    }
}

struct NativeNutritionMacroChart: View {
    let row: NativeJSON
    private var values: [(key: String, value: Double)]? {
        var result: [(key: String, value: Double)] = []
        for key in ["carbs", "protein", "fat"] {
            guard let text = row[key].stringValue, let grams = Double(text), grams.isFinite, grams >= 0 else { return nil }
            result.append((key: key, value: grams * (key == "fat" ? 9 : 4)))
        }
        return result
    }
    var body: some View {
        if let values {
            if values.reduce(0, { $0 + $1.value }) > 0 {
                Chart(Array(values.enumerated()), id: \.offset) { _, item in
                    SectorMark(angle: .value("供能参考", item.value), innerRadius: .ratio(0.64))
                        .foregroundStyle(by: .value("营养素", NativeNutritionFields.title(item.key)))
                }.frame(height: 150)
                Text("按碳水和蛋白质每克4千卡、脂肪每克9千卡估算供能构成，不替代记录热量。")
                    .font(.caption).foregroundStyle(.secondary)
            } else { Text("三项营养素均为已确认的0克。").font(.footnote).foregroundStyle(.secondary) }
        } else { Text("三项营养素尚未填写完整，暂不绘制供能比例。").font(.footnote).foregroundStyle(.secondary) }
    }
}

@MainActor
struct NativeNutritionStatusView: View {
    @ObservedObject var context: NativeNutritionContext
    let date: String
    @State private var status: NativeJSON
    @State private var error: String?
    init(context: NativeNutritionContext, initial: NativeJSON, date: String) {
        self.context = context; self.date = date; _status = State(initialValue: initial)
    }
    var body: some View {
        Form {
            Section(date) {
                ForEach(QuickEntryMeal.allCases) { meal in
                    Picker(meal.title, selection: Binding(get: { status["meals"][meal.rawValue].stringValue ?? "unrecorded" }, set: { setMeal(meal.rawValue, $0) })) {
                        Text("尚未记录").tag("unrecorded"); Text("已记录").tag("recorded"); Text("未进食").tag("skipped")
                    }
                }
                Toggle("当天已记完", isOn: Binding(get: { status["complete"].boolValue == true }, set: { var value = status.objectValue; value["complete"] = .bool($0); status = .object(value) }))
            }
            Text("三次正餐需有记录或明确标记未进食。此标记只表示记录覆盖，不保证实际摄入或营养值准确。").font(.footnote).foregroundStyle(.secondary)
            NativeNutritionErrorRow(text: error ?? context.error)
            Button("保存餐次状态") { Task { await save() } }.disabled(context.busy || context.pending != nil)
            Button("重新读取状态") { Task { await load() } }
        }.navigationTitle("记录完整度").task { await load() }
    }
    private func setMeal(_ meal: String, _ selection: String) {
        var value = status.objectValue, meals = status["meals"].objectValue; meals[meal] = .string(selection); value["meals"] = .object(meals); status = .object(value)
    }
    private func load() async {
        do { let result = try await context.api.json(path: "health/nutrition/status?date=" + date, token: context.token)
            guard !Task.isCancelled else { return }; status = result["dayStatus"]; error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func save() async {
        let body: NativeJSON = .object(["date": .string(date), "complete": status["complete"], "meals": status["meals"], "expectedRevision": status["revision"]])
        if let result = await context.write(NativeNutritionCommand(path: "health/nutrition/status", method: "PATCH", title: "更新餐次完整度", body: body)) { status = result["dayStatus"] }
    }
}
