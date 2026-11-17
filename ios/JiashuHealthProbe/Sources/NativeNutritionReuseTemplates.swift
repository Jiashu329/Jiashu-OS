import SwiftUI

enum NativeNutritionReuseDraft {
    static func make(_ source: NativeJSON, date: String, meal: String) throws -> NativeJSON {
        var draft = NativeNutritionDraft(source, date: date, meal: meal)
        draft.date = date; draft.meal = meal
        return try draft.payload()
    }
    static func templateDefinition(_ source: NativeJSON, kind: String = "meal", name: String = "") -> NativeJSON {
        let components = source.arrayValue.map { item -> NativeJSON in
            var fields: [String: NativeJSON] = ["name": item["name"], "portion": item["portion"], "grams": .null,
                "provenance": item["provenance"]]
            for key in NativeNutritionFields.keys { fields[key] = item[key] }
            let selection = NativeNutritionFields.selection(item["food"])
            if selection != .null { fields["food"] = selection }
            return .object(fields)
        }
        return .object(["kind": .string(kind), "name": .string(name), "note": .string(""), "baseServings": .string("1"),
            "totalWeight": .null, "components": .array(components)])
    }
}

@MainActor
struct NativeNutritionReuseView: View {
    @ObservedObject var context: NativeNutritionContext
    let date: String
    let onDraft: ([NativeJSON]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var meal = "lunch"
    @State private var data: NativeJSON = .null
    @State private var loading = false
    @State private var error: String?
    @State private var deleting: String?
    @State private var requestID = UUID()
    init(context: NativeNutritionContext, date: String, initialMeal: String = NativeNutritionEntrySelection.suggestedMeal(),
         onDraft: @escaping ([NativeJSON]) -> Void) {
        self.context = context; self.date = date; self.onDraft = onDraft
        _meal = State(initialValue: initialMeal)
    }
    var body: some View {
        List {
            Section("带入记录的位置") {
                LabeledContent("日期", value: date)
                Picker("餐次", selection: $meal) { ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0.rawValue) } }
            }.listRowBackground(NativePalette.surface)
            Section {
                NavigationLink("复制某天的一餐") { NativeNutritionMealCopyView(context: context, targetDate: date, initialMeal: meal, onDraft: onDraft) }
                NavigationLink("自建食物、食谱和整餐模板") { NativeNutritionTemplatesView(context: context, initialDate: date, initialMeal: meal, onDraft: onDraft) }
            }.listRowBackground(NativePalette.surface)
            if loading { ProgressView("正在读取常吃食物…") }
            NativeNutritionErrorRow(text: error ?? context.error)
            if data != .null {
                reuseSection("收藏", values: data["favorites"].arrayValue, favorite: true)
                reuseSection("最近记录", values: data["recent"].arrayValue, favorite: false)
            }
            Section { Text("带入只生成可编辑草稿。原食物库版本、营养来源和未知值继续保留，确认保存后才创建新记录。").font(.footnote).foregroundStyle(NativePalette.muted) }.listRowBackground(NativePalette.surface)
        }.nativeGeometricPage().navigationTitle("常吃与复用").task { await load() }.refreshable { await load() }
            .onChange(of: context.changes) { _, _ in Task { await load() } }
            .confirmationDialog("从常用食物中移除此项？已保存的饮食记录继续保留。", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                if let id = deleting { Button("移出常用", role: .destructive) { Task { await removeFavorite(id) } } }
            }
    }
    private func reuseSection(_ title: String, values: [NativeJSON], favorite: Bool) -> some View {
        Section(title) {
            if values.isEmpty { Text("暂无" + title).foregroundStyle(NativePalette.muted) }
            ForEach(Array(values.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 10) {
                    Text(item["name"].stringValue ?? "食物").font(.body.weight(.semibold)).foregroundStyle(NativePalette.ink)
                    Text((item["portion"].stringValue ?? "") + " · 热量 " + NativeNutritionFields.value(item["calories"], unit: "千卡"))
                        .font(.footnote).foregroundStyle(NativePalette.muted)
                    HStack {
                        Button("带入明细") { adopt(item) }
                        Spacer()
                        if favorite {
                            Button("移出常用", role: .destructive) { deleting = item["id"].stringValue }
                        } else if item["id"].stringValue != nil, item["revision"].intValue != nil {
                            Button("保存为常用") { Task { await self.favorite(item) } }
                        }
                    }.font(.subheadline).disabled(context.busy || context.pending != nil)
                }.padding(.vertical, 8)
            }
        }.listRowBackground(NativePalette.surface)
    }
    private func adopt(_ item: NativeJSON) {
        do { onDraft([try NativeNutritionReuseDraft.make(item, date: date, meal: meal)]); dismiss() }
        catch { self.error = error.localizedDescription }
    }
    private func load() async {
        let id = UUID(); requestID = id; loading = true; error = nil
        defer { if requestID == id { loading = false } }
        do {
            let value = try await context.api.json(path: "health/nutrition/reuse", token: context.token)
            guard !Task.isCancelled, requestID == id else { return }; data = value
        } catch { if requestID == id, !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func favorite(_ item: NativeJSON) async {
        let body: NativeJSON = .object(["entryId": item["id"], "expectedRevision": item["revision"]])
        if await context.write(NativeNutritionCommand(path: "health/nutrition/reuse", title: "保存常用食物", body: body)) != nil { await load() }
    }
    private func removeFavorite(_ id: String) async {
        if await context.write(NativeNutritionCommand(path: "health/nutrition/favorites?id=" + id, method: "DELETE", title: "移出常用食物", body: .null)) != nil { await load() }
        deleting = nil
    }
}

@MainActor
private struct NativeNutritionMealCopyView: View {
    @ObservedObject var context: NativeNutritionContext
    let targetDate: String
    let onDraft: ([NativeJSON]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var fromDate = Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date()
    @State private var fromMeal = "lunch"
    @State private var toMeal = "lunch"
    @State private var preview: NativeJSON = .null
    @State private var busy = false
    @State private var error: String?
    @State private var resultMessage: String?
    init(context: NativeNutritionContext, targetDate: String, initialMeal: String, onDraft: @escaping ([NativeJSON]) -> Void) {
        self.context = context; self.targetDate = targetDate; self.onDraft = onDraft
        let selected = NativeChartDates.parse(targetDate) ?? Date()
        _fromDate = State(initialValue: NativeActionDates.calendar.date(byAdding: .day, value: -1, to: selected) ?? selected)
        _fromMeal = State(initialValue: initialMeal); _toMeal = State(initialValue: initialMeal)
    }
    private var selection: [String: NativeJSON] { ["fromDate": .string(NativeActionDates.day(fromDate)), "fromMeal": .string(fromMeal), "toDate": .string(targetDate), "toMeal": .string(toMeal)] }
    var body: some View {
        Form {
            Section("来源餐次") {
                DatePicker("来源日期", selection: $fromDate, in: ...Date(), displayedComponents: .date)
                Picker("来源餐次", selection: $fromMeal) { ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0.rawValue) } }
            }.listRowBackground(NativePalette.surface)
            Section("目标餐次") {
                LabeledContent("目标日期", value: targetDate)
                Picker("目标餐次", selection: $toMeal) { ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0.rawValue) } }
                Button("预览将复制的食物") { Task { await loadPreview() } }.disabled(busy || context.busy || context.pending != nil)
            }.listRowBackground(NativePalette.surface)
            if preview != .null {
                Section("预览") {
                    Text("\(preview["count"].intValue ?? 0)项食物，\(preview["unknownCount"].intValue ?? 0)项热量未知")
                    ForEach(Array(preview["entries"].arrayValue.enumerated()), id: \.offset) { _, row in
                        VStack(alignment: .leading) { Text(row["name"].stringValue ?? "食物"); Text((row["portion"].stringValue ?? "") + " · " + NativeNutritionFields.value(row["calories"], unit: "千卡")).font(.footnote).foregroundStyle(NativePalette.muted) }
                    }
                    Button("调整明细后再保存") { adoptRows() }.disabled(context.pending != nil)
                    Button("确认原样复制这一餐") { Task { await copy() } }.disabled(context.busy || context.pending != nil)
                    Text("确认原样复制会直接创建独立记录，并在服务器再次核对来源餐次未变化。调整明细只生成草稿。").font(.footnote).foregroundStyle(NativePalette.muted)
                }.listRowBackground(NativePalette.surface)
            }
            if busy || context.busy { ProgressView() }
            NativeNutritionErrorRow(text: error ?? context.error)
            if let resultMessage { Text(resultMessage).foregroundStyle(.green) }
        }.nativeGeometricPage().navigationTitle("复制餐次").environment(\.timeZone, NativeActionDates.timeZone)
            .onChange(of: fromDate) { _, _ in invalidate() }.onChange(of: fromMeal) { _, _ in invalidate() }.onChange(of: toMeal) { _, _ in invalidate() }
    }
    private func invalidate() { preview = .null; resultMessage = nil }
    private func loadPreview() async {
        busy = true; error = nil; preview = .null; defer { busy = false }
        let frozen = selection
        do {
            var body = frozen; body["action"] = .string("preview")
            let response = try await context.api.json(path: "health/nutrition/copy", method: "POST", token: context.token, body: .object(body))
            guard !Task.isCancelled, selection == frozen else { return }; preview = response["preview"]
        } catch { if !Task.isCancelled, selection == frozen { self.error = error.localizedDescription } }
    }
    private func adoptRows() {
        do { onDraft(try preview["entries"].arrayValue.map { try NativeNutritionReuseDraft.make($0, date: targetDate, meal: toMeal) }); dismiss() }
        catch { self.error = error.localizedDescription }
    }
    private func copy() async {
        guard let token = preview["previewToken"].stringValue else { return }
        var body = selection; body["action"] = .string("copy"); body["previewToken"] = .string(token)
        if let result = await context.write(NativeNutritionCommand(path: "health/nutrition/copy", title: "复制餐次", body: .object(body))) {
            resultMessage = "已复制\(result["entries"].arrayValue.count)项食物。"; preview = .null
        }
    }
}

@MainActor
struct NativeNutritionTemplatesView: View {
    @ObservedObject var context: NativeNutritionContext
    let onDraft: ([NativeJSON]) -> Void
    let initialDate: String
    let initialMeal: String
    @State private var includeArchived = false
    @State private var templates: [NativeJSON] = []
    @State private var busy = false
    @State private var loaded = false
    @State private var error: String?
    @State private var requestID = UUID()
    init(context: NativeNutritionContext, initialDate: String = NativeActionDates.day(Date()),
         initialMeal: String = NativeNutritionEntrySelection.suggestedMeal(), onDraft: @escaping ([NativeJSON]) -> Void) {
        self.context = context; self.initialDate = initialDate; self.initialMeal = initialMeal; self.onDraft = onDraft
    }
    var body: some View {
        List {
            Section {
                NavigationLink("新建自建食物／食谱／整餐") { NativeNutritionTemplateEditor(context: context) }
                NavigationLink("从已有餐次整理模板") { NativeNutritionTemplateFromMeal(context: context, initialDate: initialDate, initialMeal: initialMeal) }
                Toggle("显示已归档模板", isOn: $includeArchived)
            }.listRowBackground(NativePalette.surface)
            if busy { ProgressView("正在读取模板…") }
            NativeNutritionErrorRow(text: error ?? context.error)
            ForEach(Array(templates.enumerated()), id: \.offset) { _, template in
                NavigationLink { NativeNutritionTemplateDetail(context: context, initial: template, initialDate: initialDate, initialMeal: initialMeal, onDraft: onDraft) } label: {
                    HStack(spacing: 14) {
                        Image(systemName: "square.stack").font(.title3).foregroundStyle(NativePalette.accent)
                            .frame(width: 42, height: 42).background(NativePalette.soft, in: RoundedRectangle(cornerRadius: 14))
                        VStack(alignment: .leading, spacing: 7) {
                            Text(template["name"].stringValue ?? "模板").font(.body.weight(.medium)).foregroundStyle(NativePalette.ink)
                            Text(kindTitle(template["kind"].stringValue) + " · \(template["components"].arrayValue.count)项 · 版本\(template["revision"].intValue ?? 0)" + (template["archivedAt"].isNull ? "" : " · 已归档"))
                                .font(.caption).foregroundStyle(NativePalette.muted)
                        }
                    }.padding(.vertical, 7)
                }
            }
            if loaded && templates.isEmpty && error == nil { Text("暂无模板").foregroundStyle(NativePalette.muted) }
        }.nativeGeometricPage().navigationTitle("我的食物与模板")
            .task { await load() }.refreshable { await load() }
            .onChange(of: includeArchived) { _, _ in Task { await load() } }
            .onChange(of: context.changes) { _, _ in Task { await load() } }
    }
    private func kindTitle(_ kind: String?) -> String { ["food":"自建食物","recipe":"食谱","meal":"整餐"][kind ?? ""] ?? "模板" }
    private func load() async {
        let id = UUID(); requestID = id; busy = true; error = nil; defer { if requestID == id { busy = false } }
        do {
            let result = try await context.api.json(path: "health/nutrition/templates?includeArchived=" + (includeArchived ? "1" : "0"), token: context.token)
            guard !Task.isCancelled, requestID == id else { return }; templates = result["templates"].arrayValue; loaded = true
        } catch { if requestID == id, !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

@MainActor
private struct NativeNutritionTemplateDetail: View {
    @ObservedObject var context: NativeNutritionContext
    let initial: NativeJSON
    let onDraft: ([NativeJSON]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var template: NativeJSON = .null
    @State private var date = Date()
    @State private var meal = "lunch"
    @State private var amount = "1"
    @State private var byWeight = false
    @State private var preview: NativeJSON = .null
    @State private var busy = false
    @State private var error: String?
    @State private var confirmArchive = false
    init(context: NativeNutritionContext, initial: NativeJSON, initialDate: String, initialMeal: String,
         onDraft: @escaping ([NativeJSON]) -> Void) {
        self.context = context; self.initial = initial; self.onDraft = onDraft
        _date = State(initialValue: NativeChartDates.parse(initialDate) ?? Date()); _meal = State(initialValue: initialMeal)
    }
    private var current: NativeJSON { template == .null ? initial : template }
    var body: some View {
        Form {
            Section(current["name"].stringValue ?? "模板详情") {
                Text(current["note"].stringValue ?? "")
                LabeledContent("基础份数", value: current["baseServings"].stringValue ?? "未注明")
                LabeledContent("成品总重量", value: current["totalWeight"].stringValue.map { $0 + "克" } ?? "未知")
                ForEach(Array(current["components"].arrayValue.enumerated()), id: \.offset) { _, component in
                    VStack(alignment: .leading) { Text(component["name"].stringValue ?? "成分"); Text((component["portion"].stringValue ?? "") + " · 热量 " + NativeNutritionFields.value(component["calories"], unit: "千卡")).font(.footnote).foregroundStyle(NativePalette.muted) }
                }
            }.listRowBackground(NativePalette.surface)
            if current["archivedAt"].isNull {
                Section("使用前换算") {
                    DatePicker("日期", selection: $date, in: ...Date(), displayedComponents: .date)
                    Picker("餐次", selection: $meal) { ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0.rawValue) } }
                    Toggle("按成品克重换算", isOn: $byWeight).disabled(current["totalWeight"].isNull)
                    TextField(byWeight ? "实际食用克重" : "实际份数", text: $amount).keyboardType(.decimalPad)
                    Button("预览换算后的明细") { Task { await loadPreview() } }.disabled(busy || context.pending != nil)
                }.listRowBackground(NativePalette.surface)
                if preview != .null {
                    Section("换算预览") {
                        ForEach(NativeNutritionFields.keys, id: \.self) { key in
                            LabeledContent(NativeNutritionFields.title(key) + "已知小计", value: NativeNutritionFields.value(preview["nutrients"][key]["total"], unit: key == "calories" ? "千卡" : "克"))
                            Text("\(preview["nutrients"][key]["unknownCount"].intValue ?? 0)项未知").font(.caption).foregroundStyle(NativePalette.muted)
                        }
                        ForEach(Array(preview["rows"].arrayValue.enumerated()), id: \.offset) { _, row in
                            Text((row["name"].stringValue ?? "食物") + " · " + (row["portion"].stringValue ?? ""))
                        }
                        Button("带入可编辑饮食明细") { onDraft(preview["rows"].arrayValue); dismiss() }
                    }.listRowBackground(NativePalette.surface)
                }
                Section {
                    NavigationLink("编辑模板") { NativeNutritionTemplateEditor(context: context, initial: current) }
                    Button("归档模板", role: .destructive) { confirmArchive = true }.disabled(context.busy || context.pending != nil)
                }.listRowBackground(NativePalette.surface)
            } else {
                Section {
                    Text("此模板已归档，历史饮食记录不变。可复制内容建立新的模板。")
                    NavigationLink("复制为新模板") { NativeNutritionTemplateEditor(context: context, initial: current, copyAsNew: true) }
                }.listRowBackground(NativePalette.surface)
            }
            if busy || context.busy { ProgressView() }
            NativeNutritionErrorRow(text: error ?? context.error)
        }.nativeGeometricPage().navigationTitle("模板详情").navigationBarTitleDisplayMode(.inline).environment(\.timeZone, NativeActionDates.timeZone)
            .task { await reload() }.onChange(of: context.changes) { _, _ in Task { await reload() } }
            .onChange(of: date) { _, _ in preview = .null }.onChange(of: meal) { _, _ in preview = .null }
            .onChange(of: amount) { _, _ in preview = .null }.onChange(of: byWeight) { _, _ in preview = .null }
            .confirmationDialog("归档后此模板不能用于新记录，已有记录保持不变。", isPresented: $confirmArchive, titleVisibility: .visible) {
                Button("确认归档", role: .destructive) { Task { await archive() } }
            }
    }
    private func reload() async {
        guard let id = initial["id"].stringValue else { return }; busy = true; error = nil; defer { busy = false }
        do { let result = try await context.api.json(path: "health/nutrition/templates/" + id, token: context.token)
            guard !Task.isCancelled else { return }; template = result["template"]; preview = .null
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func loadPreview() async {
        guard let id = current["id"].stringValue else { return }
        let body: NativeJSON = .object(["mode": .string(byWeight ? "weight" : "servings"), "amount": .string(amount),
            "date": .string(NativeActionDates.day(date)), "meal": .string(meal), "expectedRevision": current["revision"]])
        busy = true; error = nil; defer { busy = false }
        do {
            let value = try await context.api.json(path: "health/nutrition/templates/" + id + "/preview", method: "POST", token: context.token, body: body)
            guard !Task.isCancelled, body["amount"].stringValue == amount, body["date"].stringValue == NativeActionDates.day(date), body["meal"].stringValue == meal,
                  body["mode"].stringValue == (byWeight ? "weight" : "servings") else { return }
            preview = value["preview"]
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func archive() async {
        guard let id = current["id"].stringValue else { return }
        if let response = await context.write(NativeNutritionCommand(path: "health/nutrition/templates/" + id, method: "DELETE", title: "归档饮食模板", body: .object(["expectedRevision": current["revision"]]))) { template = response["template"]; preview = .null }
    }
}

private struct NativeTemplateComponentDraft: Identifiable {
    let id = UUID()
    var draft: NativeNutritionDraft
    var grams: String
    init(_ raw: NativeJSON = .null) { draft = NativeNutritionDraft(raw); grams = raw["grams"].stringValue ?? "" }
    var recovery: NativeJSON {
        var fields: [String: NativeJSON] = ["name": .string(draft.name), "portion": .string(draft.portion), "grams": .string(grams),
            "provenance": .object(draft.provenance), "food": draft.food]
        for key in NativeNutritionFields.keys { fields[key] = .string(draft.nutrients[key] ?? "") }
        return .object(fields)
    }
    func payload() throws -> NativeJSON {
        let validated = try draft.payload()
        var fields = validated.objectValue
        for key in ["date", "meal", "note"] { fields.removeValue(forKey: key) }
        fields["grams"] = grams.trimmingCharacters(in: .whitespaces).isEmpty ? .null : .string(grams)
        return .object(fields)
    }
}

@MainActor
private struct NativeNutritionTemplateEditor: View {
    @ObservedObject var context: NativeNutritionContext
    @Environment(\.dismiss) private var dismiss
    let initial: NativeJSON
    let copyAsNew: Bool
    @State private var name = ""
    @State private var kind = "food"
    @State private var note = ""
    @State private var servings = "1"
    @State private var totalWeight = ""
    @State private var components: [NativeTemplateComponentDraft] = []
    @State private var revision: NativeJSON = .null
    @State private var initialized = false
    @State private var error: String?
    @State private var pickingFood = false
    @State private var latestVersion: NativeJSON = .null
    @State private var recoverableDraft: NativeJSON?
    @State private var draftBaseline: NativeJSON = .null
    @State private var draftReady = false
    init(context: NativeNutritionContext, initial: NativeJSON = .null, copyAsNew: Bool = false) {
        self.context = context; self.initial = initial; self.copyAsNew = copyAsNew
    }
    private var recoveryScope: String { "nutrition-template-form:" + (copyAsNew ? "copy-" : "") + (initial["id"].stringValue ?? "new") }
    private var draftStore: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: context.userID, scope: recoveryScope) }
    private var formDraft: NativeJSON {
        .object(["name": .string(name), "kind": .string(kind), "note": .string(note), "servings": .string(servings),
            "totalWeight": .string(totalWeight), "revision": revision, "components": .array(components.map(\.recovery))])
    }
    var body: some View {
        Form {
            if recoverableDraft != nil {
                Section("本机未完成的模板") {
                    Text("恢复只填入原内容与版本，不会保存或创建模板。")
                        .font(.footnote).foregroundStyle(NativePalette.muted)
                    Button("恢复填写") { restoreForm() }
                    Button("放弃本机草稿", role: .destructive) { discardForm() }
                }.listRowBackground(NativePalette.surface)
            }
            Section("模板定义") {
                Picker("类型", selection: $kind) { Text("自建食物").tag("food"); Text("食谱").tag("recipe"); Text("整餐").tag("meal") }
                TextField("模板名称", text: $name)
                TextField("基础份数", text: $servings).keyboardType(.decimalPad)
                TextField("成品总重量／克（可选）", text: $totalWeight).keyboardType(.decimalPad)
                TextField("模板说明", text: $note, axis: .vertical).lineLimit(2...4)
            }.listRowBackground(NativePalette.surface).disabled(context.busy || context.pending != nil || recoverableDraft != nil)
            ForEach($components) { $component in
                Section(component.draft.name.isEmpty ? "成分" : component.draft.name) {
                    TextField("成分名称", text: Binding(get: { component.draft.name }, set: { component.draft.changeIdentity(name: $0) }))
                    TextField("基础份量说明", text: Binding(get: { component.draft.portion }, set: { component.draft.changeIdentity(portion: $0) }))
                    TextField("此成分重量／克（未知留空）", text: $component.grams).keyboardType(.decimalPad)
                    ForEach(NativeNutritionFields.keys, id: \.self) { key in
                        TextField(NativeNutritionFields.title(key) + (key == "calories" ? "／千卡" : "／克"), text: Binding(get: { component.draft.nutrients[key] ?? "" }, set: { component.draft.setNutrient(key, text: $0) })).keyboardType(.decimalPad)
                        Text("来源：" + NativeNutritionFields.source(component.draft.provenance[key]?["source"].stringValue)).font(.caption).foregroundStyle(NativePalette.muted)
                    }
                    if let release = component.draft.food["catalogRelease"].stringValue { Text("食物库版本：" + release).font(.caption).foregroundStyle(NativePalette.muted) }
                }.listRowBackground(NativePalette.surface).disabled(context.busy || context.pending != nil || recoverableDraft != nil)
            }.onDelete { if components.count > 1 { components.remove(atOffsets: $0) } }
            if components.count < 30 {
                Button("添加手工成分") { components.append(NativeTemplateComponentDraft()) }.disabled(context.pending != nil || context.busy || recoverableDraft != nil || kind == "food")
                Button("从食物库加入成分") { pickingFood = true }.disabled(context.pending != nil || context.busy || recoverableDraft != nil || kind == "food" && !components.isEmpty && !components[0].draft.name.isEmpty)
            }
            Text("自建食物需1项成分，食谱／整餐可含1–30项。未知营养保持未知；模板修改不回写既有饮食。").font(.footnote).foregroundStyle(NativePalette.muted)
            NativeNutritionErrorRow(text: error ?? context.error)
            Button(context.busy ? "正在保存…" : "保存模板") { Task { await save() } }.disabled(context.busy || context.pending != nil || recoverableDraft != nil)
            if initial["id"].stringValue != nil && !copyAsNew {
                Button("保留填写，读取最新版本") { Task { await loadRevision() } }.disabled(context.busy || context.pending != nil)
            }
            if latestVersion != .null {
                Section("服务器最新模板（供核对）") {
                    Text(latestVersion["name"].stringValue ?? "")
                    Text("基础份数：" + (latestVersion["baseServings"].stringValue ?? ""))
                    Text(latestVersion["note"].stringValue ?? "")
                    ForEach(Array(latestVersion["components"].arrayValue.enumerated()), id: \.offset) { _, component in
                        Text((component["name"].stringValue ?? "成分") + " · " + (component["portion"].stringValue ?? "") + " · 热量 " + NativeNutritionFields.value(component["calories"], unit: "千卡"))
                    }
                }.listRowBackground(NativePalette.surface)
            }
        }.nativeGeometricPage().navigationTitle(initial["id"].isNull || copyAsNew ? "创建模板" : "编辑模板")
            .task { initialize() }
            .onChange(of: formDraft) { _, _ in persistForm() }
            .onDisappear { persistForm() }
            .sheet(isPresented: $pickingFood) {
                NavigationStack {
                    NativeNutritionFoodsView(api: context.api, token: context.token, userID: context.userID) { rows in
                        let incoming = rows.map { NativeTemplateComponentDraft($0) }
                        if kind == "food" { components = Array(incoming.prefix(1)) }
                        else { components.append(contentsOf: incoming.prefix(max(0, 30 - components.count))) }
                        pickingFood = false
                    }.toolbar { Button("关闭") { pickingFood = false } }
                }
            }
    }
    private func initialize() {
        guard !initialized else { return }; initialized = true
        name = initial["name"].stringValue ?? ""; kind = initial["kind"].stringValue ?? "food"; note = initial["note"].stringValue ?? ""
        servings = initial["baseServings"].stringValue ?? "1"; totalWeight = initial["totalWeight"].stringValue ?? ""
        revision = initial["revision"]
        components = initial["components"].arrayValue.map(NativeTemplateComponentDraft.init)
        if components.isEmpty { components = [NativeTemplateComponentDraft()] }
        draftBaseline = formDraft
        do { recoverableDraft = try draftStore.load(NativeJSON.self) } catch { self.error = error.localizedDescription }
        draftReady = true
    }
    private func save() async {
        do {
            guard !name.trimmingCharacters(in: .whitespaces).isEmpty, components.count >= 1, components.count <= 30,
                  kind != "food" || components.count == 1 else { throw NativeActionInputError.invalid("请填写名称并核对成分数量。") }
            var fields: [String: NativeJSON] = ["kind": .string(kind), "name": .string(name), "note": .string(note), "baseServings": .string(servings),
                "totalWeight": totalWeight.isEmpty ? .null : .string(totalWeight), "components": .array(try components.map { try $0.payload() })]
            let path: String, method: String
            if let id = initial["id"].stringValue, !copyAsNew { path = "health/nutrition/templates/" + id; method = "PUT"; fields["expectedRevision"] = revision }
            else { path = "health/nutrition/templates"; method = "POST" }
            if await context.write(NativeNutritionCommand(path: path, method: method, title: "保存饮食模板", body: .object(fields))) != nil {
                draftReady = false
                try draftStore.clear(); recoverableDraft = nil; draftBaseline = formDraft
                dismiss()
            }
        } catch { self.error = error.localizedDescription }
    }
    private func loadRevision() async {
        guard let id = initial["id"].stringValue else { return }
        do { let result = try await context.api.json(path: "health/nutrition/templates/" + id, token: context.token)
            guard !Task.isCancelled else { return }; latestVersion = result["template"]; revision = latestVersion["revision"]
            error = "已读取服务器版本，原填写仍保留。请对照最新资料后再保存。"
        } catch { self.error = error.localizedDescription }
    }
    private func persistForm() {
        guard draftReady, recoverableDraft == nil, formDraft != draftBaseline else { return }
        do { try draftStore.save(formDraft) } catch { self.error = error.localizedDescription }
    }
    private func restoreForm() {
        guard let saved = recoverableDraft else { return }; draftReady = false
        name = saved["name"].stringValue ?? ""; kind = saved["kind"].stringValue ?? "food"; note = saved["note"].stringValue ?? ""
        servings = saved["servings"].stringValue ?? "1"; totalWeight = saved["totalWeight"].stringValue ?? ""
        revision = saved["revision"]; components = saved["components"].arrayValue.map(NativeTemplateComponentDraft.init)
        if components.isEmpty { components = [NativeTemplateComponentDraft()] }
        recoverableDraft = nil; draftReady = true
    }
    private func discardForm() {
        do { try draftStore.clear(); recoverableDraft = nil; draftBaseline = formDraft }
        catch { self.error = error.localizedDescription }
    }
}

@MainActor
private struct NativeNutritionTemplateFromMeal: View {
    @ObservedObject var context: NativeNutritionContext
    @State private var date = Date()
    @State private var meal = "lunch"
    @State private var rows: [NativeJSON] = []
    @State private var busy = false
    @State private var loaded = false
    @State private var error: String?
    init(context: NativeNutritionContext, initialDate: String, initialMeal: String) {
        self.context = context
        _date = State(initialValue: NativeChartDates.parse(initialDate) ?? Date()); _meal = State(initialValue: initialMeal)
    }
    var body: some View {
        Form {
            Section("选择已有餐次") {
                DatePicker("日期", selection: $date, in: ...Date(), displayedComponents: .date)
                Picker("餐次", selection: $meal) { ForEach(QuickEntryMeal.allCases) { Text($0.title).tag($0.rawValue) } }
                Button("读取餐次") { Task { await load() } }.disabled(busy)
            }.listRowBackground(NativePalette.surface)
            if busy { ProgressView() }
            NativeNutritionErrorRow(text: error)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in Text((row["name"].stringValue ?? "食物") + " · " + (row["portion"].stringValue ?? "")) }
            if !rows.isEmpty {
                NavigationLink("整理为新的整餐模板") {
                    NativeNutritionTemplateEditor(context: context, initial: NativeNutritionReuseDraft.templateDefinition(.array(rows), name: NativeActionDates.day(date) + " " + NativeNutritionFields.meal(meal)))
                }
            } else if loaded { Text("这个餐次暂无记录").foregroundStyle(NativePalette.muted) }
        }.nativeGeometricPage().navigationTitle("从餐次创建模板").environment(\.timeZone, NativeActionDates.timeZone)
            .onChange(of: date) { _, _ in rows = []; loaded = false }.onChange(of: meal) { _, _ in rows = []; loaded = false }
    }
    private func load() async {
        let day = NativeActionDates.day(date), selectedMeal = meal
        busy = true; error = nil; defer { busy = false }
        do { let result = try await context.api.json(path: "health/nutrition?date=" + day, token: context.token)
            guard !Task.isCancelled, NativeActionDates.day(date) == day, meal == selectedMeal else { return }
            let selected = result["entries"].arrayValue.filter { $0["meal"].stringValue == selectedMeal && $0["deleted"].boolValue != true }
            guard selected.count <= 30 else { throw NativeActionInputError.invalid("此餐超过30项，请先整理后再创建模板。") }
            rows = selected; loaded = true
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}
