import SwiftUI
import Security

private func nfText(_ value: NativeJSON) -> String {
    value.stringValue ?? value.doubleValue.map { String($0) } ?? ""
}
private func nfValue(_ text: String) -> NativeJSON { text.isEmpty ? .null : .string(text) }
private func nfPath(_ path: String, query: [String: String]) -> String {
    var parts = URLComponents(); parts.path = path
    parts.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
    return parts.string ?? path
}

/// Builds an editable nutrition input while preserving the selected immutable
/// release. Unknown nutrients stay null; a changed drink is never a catalog claim.
enum NativeFoodSelectionDraft {
    static func scaled(_ value: Double?, amount: String, divisor: String = "1") throws -> NativeJSON {
        guard let value else { return .null }
        guard value.isFinite, value >= 0, let original = Decimal(string: String(value)),
              let amount = Decimal(string: amount), let divisor = Decimal(string: divisor), divisor > 0 else {
            throw NativeActionInputError.invalid("食物份量或来源营养值无效。")
        }
        var result = original * amount / divisor, rounded = Decimal()
        NSDecimalRound(&rounded, &result, 1, .plain)
        guard rounded >= 0, rounded <= 20_000 else { throw NativeActionInputError.invalid("此份量的营养值超出支持范围。") }
        return .string(String(format: "%.1f", NSDecimalNumber(decimal: rounded).doubleValue))
    }

    static func make(food: NativeJSON, amount: String, unit: String, date: String, meal: String,
                     drinkLabel: String? = nil, officialDrinkMatches: Bool = true) throws -> NativeJSON {
        guard amount.range(of: #"^\d+(?:\.\d{1,3})?$"#, options: .regularExpression) != nil,
              let quantity = Double(amount), quantity.isFinite, quantity > 0, quantity <= 1000,
              let name = food["name"].stringValue, !name.isEmpty else {
            throw NativeActionInputError.invalid("请填写大于0、最多三位小数的份量。")
        }
        let basis = food["basis"].stringValue ?? "weight"
        let reference = basis == "perServing" ? food["serving"] : food["reference"]
        let isOfficial = officialDrinkMatches && (basis == "perServing" || basis == "weight")
        let specification = drinkLabel ?? reference["label"].stringValue ?? ""
        var draft: [String: NativeJSON] = ["date": .string(date), "meal": .string(meal), "name": .string(name),
            "portion": .string(amount + unit + (specification.isEmpty ? "" : "（" + specification + "）")),
            "note": .string(officialDrinkMatches ? "" : "所选饮品配置暂无官方营养，已清除原配置营养值，需本人核对。")]
        var origins: [String: NativeJSON] = [:]
        var multiplier = amount
        if basis == "weight" {
            let weight: Double?
            if unit == "g" { weight = 1 }
            else if unit == "kg" { weight = 1000 }
            else { weight = food["portions"].arrayValue.first(where: { $0["unit"].stringValue == unit })?["grams"].doubleValue }
            guard let weight, weight > 0, quantity * weight <= 20_000 else { throw NativeActionInputError.invalid("所选单位没有可靠克重。") }
            multiplier = String(quantity * weight)
        }
        for key in ["calories", "carbs", "protein", "fat"] {
            let source: Double?
            if !officialDrinkMatches { source = nil }
            else if basis == "perServing" { source = reference[key == "calories" ? "kcal" : key].doubleValue }
            else if basis == "weight" { source = food[key == "calories" ? "kcalPer100g" : key + "Per100g"].doubleValue }
            else { source = reference[key].doubleValue }
            let nutrient = try scaled(source, amount: multiplier, divisor: basis == "weight" ? "100" : "1")
            draft[key] = nutrient
            let basisText = (food["source"]["name"].stringValue ?? "来源资料") + "；" + (food["source"]["version"].stringValue ?? "")
            origins[key] = .object(["source": .string(nutrient.stringValue == nil ? "unknown" : isOfficial ? "catalog" : "manual"),
                "basis": .string(String(basisText.prefix(300))), "portion": draft["portion"] ?? .string(""), "originalValue": nutrient])
        }
        draft["provenance"] = .object(origins)
        if isOfficial {
            guard let id = food["id"].stringValue, let release = food["catalogRelease"].stringValue, !release.isEmpty else {
                throw NativeActionInputError.invalid("食物库发布版本缺失，请重新选择。")
            }
            draft["food"] = .object(["id": .string(id), "amount": .number(quantity), "unit": .string(unit), "catalogRelease": .string(release)])
        }
        return .object(draft)
    }
}

@MainActor
struct NativeNutritionFoodsView: View {
    let api: NativeAPI
    let token: String
    let userID: String
    let onDraft: ([NativeJSON]) -> Void
    let initialDate: String
    let initialMeal: String
    @State private var query = ""
    @State private var scope = "all"
    @State private var brand = ""
    @State private var category = ""
    @State private var response: NativeJSON = .null
    @State private var offset = 0
    @State private var busy = false
    @State private var loaded = false
    @State private var error: String?
    @State private var requestID = UUID()

    init(api: NativeAPI, token: String, userID: String, initialQuery: String = "",
         initialDate: String = NativeActionDates.day(Date()), initialMeal: String = NativeNutritionEntrySelection.suggestedMeal(),
         onDraft: @escaping ([NativeJSON]) -> Void) {
        self.api = api; self.token = token; self.userID = userID; self.onDraft = onDraft
        self.initialDate = initialDate; self.initialMeal = initialMeal
        _query = State(initialValue: initialQuery)
    }

    var body: some View {
        List {
            Section {
                Picker("范围", selection: $scope) { Text("全部食物").tag("all"); Text("公共食物").tag("public"); Text("我的食物").tag("mine") }
                Picker("品牌", selection: $brand) {
                    Text("全部品牌").tag("")
                    ForEach(Array(response["brands"].arrayValue.enumerated()), id: \.offset) { _, item in
                        Text((item["name"].stringValue ?? "品牌") + "（\(item["count"].intValue ?? 0)）").tag(item["id"].stringValue ?? "")
                    }
                }
                Picker("分类", selection: $category) {
                    Text("全部分类").tag("")
                    ForEach(Array(response["categories"].arrayValue.enumerated()), id: \.offset) { _, item in
                        Text((item["name"].stringValue ?? "分类") + "（\(item["count"].intValue ?? 0)）").tag(item["name"].stringValue ?? "")
                    }
                }
            }
            if busy { ProgressView("正在查找食物…") }
            if let error { Section { Text(error).foregroundStyle(.red); Button("重试") { Task { await load(offset) } } } }
            if loaded && error == nil {
                Section("共\(response["total"].intValue ?? 0)项") {
                    ForEach(Array(response["foods"].arrayValue.enumerated()), id: \.offset) { _, food in
                        NavigationLink {
                            NativeNutritionFoodDetail(api: api, token: token, userID: userID, food: food,
                                canManage: response["canManage"].boolValue == true, initialDate: initialDate, initialMeal: initialMeal, onDraft: onDraft)
                        } label: {
                            HStack(spacing: 12) {
                                if let path = response["images"][food["id"].stringValue ?? ""]["src"].stringValue,
                                   let url = URL(string: path, relativeTo: NativeAPI.websiteURL)?.absoluteURL, url.scheme == "https" {
                                    AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { Image(systemName: "fork.knife") }
                                        .frame(width: 58, height: 58).clipShape(RoundedRectangle(cornerRadius: 9))
                                }
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(food["name"].stringValue ?? "食物").fontWeight(.medium)
                                    Text(food["category"].stringValue ?? "").font(.caption).foregroundStyle(.secondary)
                                    Text(food["serving"]["label"].stringValue ?? food["reference"]["label"].stringValue ?? "每100克").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    if response["foods"].arrayValue.isEmpty { Text("没有符合筛选条件的食物").foregroundStyle(.secondary) }
                }
                Section {
                    HStack {
                        Button("上一页") { Task { await load(max(0, offset - 24)) } }.disabled(offset == 0 || busy)
                        Spacer()
                        Text("第\(offset / 24 + 1)页").foregroundStyle(.secondary)
                        Spacer()
                        Button("下一页") { Task { await load(offset + 24) } }
                            .disabled(offset + 24 >= (response["total"].intValue ?? 0) || busy)
                    }
                }
            }
            if response["canManage"].boolValue == true {
                Section { NavigationLink("管理公共食物库") { NativeNutritionManagedFoodsView(api: api, token: token, userID: userID) } }
            }
        }
        .navigationTitle("食物库")
        .searchable(text: $query, prompt: "名称、品牌或别名")
        .onSubmit(of: .search) { Task { await load(0) } }
        .onChange(of: scope) { _, _ in brand = ""; category = ""; Task { await load(0) } }
        .onChange(of: brand) { _, _ in category = ""; Task { await load(0) } }
        .onChange(of: category) { _, _ in Task { await load(0) } }
        .task { if !loaded { await load(0) } }
        .refreshable { await load(offset) }
    }

    private func load(_ requestedOffset: Int) async {
        let id = UUID(); requestID = id; busy = true; error = nil
        defer { if requestID == id { busy = false } }
        do {
            let value = try await api.json(path: nfPath("health/foods", query: ["q": query, "scope": scope, "brand": brand,
                "category": category, "offset": String(requestedOffset), "limit": "24"]), token: token)
            guard !Task.isCancelled, requestID == id else { return }
            response = value; offset = value["offset"].intValue ?? requestedOffset; loaded = true
            if let normalizedBrand = value["brand"].stringValue, normalizedBrand != brand { brand = normalizedBrand }
            if let normalizedCategory = value["category"].stringValue, normalizedCategory != category { category = normalizedCategory }
        } catch { if requestID == id, !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

@MainActor
private struct NativeNutritionFoodDetail: View {
    let api: NativeAPI
    let token: String
    let userID: String
    let food: NativeJSON
    let canManage: Bool
    let onDraft: ([NativeJSON]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var date = Date()
    @State private var meal = "lunch"
    @State private var amount = "1"
    @State private var unit = "份"
    @State private var cup = ""
    @State private var temperature = ""
    @State private var sweetness = ""
    @State private var templateWeight = false
    @State private var template: NativeJSON = .null
    @State private var preview: NativeJSON = .null
    @State private var busy = false
    @State private var error: String?
    @State private var initialized = false
    init(api: NativeAPI, token: String, userID: String, food: NativeJSON, canManage: Bool,
         initialDate: String, initialMeal: String, onDraft: @escaping ([NativeJSON]) -> Void) {
        self.api = api; self.token = token; self.userID = userID; self.food = food
        self.canManage = canManage; self.onDraft = onDraft
        _date = State(initialValue: NativeChartDates.parse(initialDate) ?? Date())
        _meal = State(initialValue: initialMeal)
    }
    private var basis: String { food["basis"].stringValue ?? "weight" }
    private var isDrink: Bool { food["id"].stringValue?.hasPrefix("luckin-cn:") == true }
    private var referenceLabel: String { food["serving"]["label"].stringValue ?? food["reference"]["label"].stringValue ?? "" }
    private var officialConfig: [String] { referenceLabel.components(separatedBy: CharacterSet(charactersIn: "/／")).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    private var cupOptions: [String] { configurationOptions(#"^(?:小杯|中杯|大杯|超大杯|\d+(?:\.\d+)?(?:oz|OZ|ml|mL|毫升))$"#, common: ["中杯","大杯","超大杯"]) }
    private var temperatureOptions: [String] { configurationOptions(#"^(?:冰|热|温|去冰|少冰|标准冰|正常冰|全冰去水)$"#, common: ["冰","热","温","少冰","去冰","全冰去水"]) }
    private var sweetnessOptions: [String] { configurationOptions(#"^(?:不另外加糖|无糖|少糖|半糖|微甜|标准糖|全糖|正常糖|多糖|三分糖|七分糖)$"#, common: ["不另外加糖","无糖","微甜","少糖","半糖","标准糖","全糖"]) }
    private var defaultCup: String { configurationDefault(cupOptions) }
    private var defaultTemperature: String { configurationDefault(temperatureOptions) }
    private var defaultSweetness: String { configurationDefault(sweetnessOptions) }
    private var matchesOfficial: Bool { !isDrink || !defaultCup.isEmpty && !defaultTemperature.isEmpty && !defaultSweetness.isEmpty && cup == defaultCup && temperature == defaultTemperature && sweetness == defaultSweetness }
    private var drinkLabel: String? {
        guard isDrink else { return nil }
        let chosen = [cup.isEmpty ? "杯型未选择" : cup, temperature.isEmpty ? "冰热未选择" : temperature, sweetness.isEmpty ? "糖度未选择" : sweetness]
        let fixed = officialConfig.filter { !cupOptions.contains($0) && !temperatureOptions.contains($0) && !sweetnessOptions.contains($0) }
        return (chosen + fixed).joined(separator: "/")
    }

    var body: some View {
        Form {
            Section(food["name"].stringValue ?? "食物详情") {
                Text(food["description"].stringValue ?? "")
                LabeledContent("参考规格", value: referenceLabel.isEmpty ? "每100克" : referenceLabel)
                ForEach(["calories","carbs","protein","fat"], id: \.self) { key in
                    LabeledContent(["calories":"热量","carbs":"碳水","protein":"蛋白质","fat":"脂肪"][key] ?? key,
                        value: displayedNutrient(key))
                }
                DisclosureGroup("营养资料来源") {
                    Text(food["source"]["name"].stringValue ?? "来源未注明")
                    Text("版本：" + (food["source"]["version"].stringValue ?? "未注明")).font(.footnote).foregroundStyle(.secondary)
                    if let urlString = food["source"]["url"].stringValue, let url = URL(string: urlString), url.scheme == "https" { Link("查看原始资料", destination: url) }
                }
            }
            if isDrink {
                Section("核对饮品配置") {
                    configurationPicker("杯型", value: $cup, options: cupOptions)
                    configurationPicker("冰热", value: $temperature, options: temperatureOptions)
                    configurationPicker("糖度", value: $sweetness, options: sweetnessOptions)
                    Text(matchesOfficial ? "所选配置与官网参考一致。" : "此配置暂无对应官方营养。带入时将清除原配置数值，未知不会补零。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section("实际食用份量") {
                DatePicker("日期", selection: $date, in: ...Date(), displayedComponents: .date)
                Picker("餐次", selection: $meal) { Text("早餐").tag("breakfast"); Text("午餐").tag("lunch"); Text("晚餐").tag("dinner"); Text("加餐").tag("snack") }
                TextField("数量", text: $amount).keyboardType(.decimalPad)
                if basis == "weight" {
                    Picker("单位", selection: $unit) {
                        Text("克").tag("g"); Text("千克").tag("kg")
                        ForEach(Array(food["portions"].arrayValue.enumerated()), id: \.offset) { _, item in Text(item["label"].stringValue ?? item["unit"].stringValue ?? "参考单位").tag(item["unit"].stringValue ?? "g") }
                    }
                } else if basis == "template", template["totalWeight"].stringValue != nil {
                    Toggle("按成品重量（克）换算", isOn: $templateWeight)
                } else { Text("按上述规格的份数记录，不推算克重。 ").font(.footnote).foregroundStyle(.secondary) }
            }
            if basis == "template" {
                Section {
                    Button("预览模板换算") { Task { await previewTemplate() } }.disabled(busy || template["id"].stringValue == nil)
                    ForEach(Array(preview["rows"].arrayValue.enumerated()), id: \.offset) { _, row in
                        VStack(alignment: .leading) { Text(row["name"].stringValue ?? "食物"); Text((row["portion"].stringValue ?? "") + " · " + (row["calories"].stringValue.map { $0 + "千卡" } ?? "热量未知")).font(.footnote).foregroundStyle(.secondary) }
                    }
                    if !preview["rows"].arrayValue.isEmpty {
                        Button("带入可编辑明细") { onDraft(preview["rows"].arrayValue); dismiss() }
                    }
                }
            } else {
                Section {
                    Button(basis == "managed" || basis == "catalogOnly" ? "带入手工核对" : "带入可编辑记录") { prepareDraft() }
                    Text("此操作只准备明细，核对并确认保存后才会创建饮食记录。").font(.footnote).foregroundStyle(.secondary)
                }
            }
            if canManage, basis != "template", basis != "managed" {
                Section { NavigationLink("建立此食品的维护副本") { NativeNutritionManagedFoodEditor(api: api, token: token, userID: userID, originalFood: food) } }
            }
            if busy { ProgressView() }
            if let error { Text(error).foregroundStyle(.red) }
        }.navigationTitle("食物详情").navigationBarTitleDisplayMode(.inline)
            .environment(\.timeZone, NativeActionDates.timeZone)
            .task { await initialize() }
            .onChange(of: amount) { _, _ in preview = .null }
            .onChange(of: date) { _, _ in preview = .null }
            .onChange(of: meal) { _, _ in preview = .null }
            .onChange(of: templateWeight) { _, _ in preview = .null }
    }

    private func configurationOptions(_ pattern: String, common: [String]) -> [String] {
        var result = [""]
        for value in officialConfig.filter({ $0.range(of: pattern, options: .regularExpression) != nil }) + common where !result.contains(value) { result.append(value) }
        return result
    }
    private func configurationDefault(_ options: [String]) -> String {
        let matches = Set(officialConfig.filter { !$0.isEmpty && options.contains($0) })
        return matches.count == 1 ? matches.first! : ""
    }
    private func configurationPicker(_ title: String, value: Binding<String>, options: [String]) -> some View {
        Picker(title, selection: value) { ForEach(options, id: \.self) { Text($0.isEmpty ? "请选择" : $0).tag($0) } }
    }
    private func displayedNutrient(_ key: String) -> String {
        if !matchesOfficial { return "未知" }
        let value: NativeJSON
        if basis == "perServing" { value = food["serving"][key == "calories" ? "kcal" : key] }
        else if ["managed","catalogOnly","template"].contains(basis) { value = food["reference"][key] }
        else { value = food[key == "calories" ? "kcalPer100g" : key + "Per100g"] }
        return value.doubleValue.map { $0.formatted() + (key == "calories" ? " 千卡" : " 克") } ?? "未知"
    }
    private func initialize() async {
        guard !initialized else { return }; initialized = true
        unit = basis == "weight" ? "g" : "份"; amount = basis == "weight" ? "100" : "1"
        cup = defaultCup; temperature = defaultTemperature; sweetness = defaultSweetness
        if basis == "template", let id = food["templateId"].stringValue {
            busy = true; defer { busy = false }
            do {
                let result = try await api.json(path: "health/nutrition/templates/" + id, token: token)
                guard !Task.isCancelled else { return }; template = result["template"]
                guard template["revision"].intValue == food["revision"].intValue else { throw NativeActionInputError.invalid("模板已更新，请返回我的食物重新选择。") }
            } catch { self.error = error.localizedDescription }
        }
    }
    private func prepareDraft() {
        do {
            let row = try NativeFoodSelectionDraft.make(food: food, amount: amount, unit: unit, date: NativeActionDates.day(date), meal: meal, drinkLabel: drinkLabel, officialDrinkMatches: matchesOfficial)
            onDraft([row]); dismiss()
        } catch { self.error = error.localizedDescription }
    }
    private func previewTemplate() async {
        guard let id = template["id"].stringValue, let revision = template["revision"].intValue else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let body: NativeJSON = .object(["mode": .string(templateWeight ? "weight" : "servings"), "amount": .string(amount),
                "date": .string(NativeActionDates.day(date)), "meal": .string(meal), "expectedRevision": .number(Double(revision))])
            let result = try await api.json(path: "health/nutrition/templates/" + id + "/preview", method: "POST", token: token, body: body)
            guard !Task.isCancelled, body["amount"].stringValue == amount,
                  body["date"].stringValue == NativeActionDates.day(date), body["meal"].stringValue == meal,
                  body["mode"].stringValue == (templateWeight ? "weight" : "servings") else { return }
            preview = result["preview"]
        } catch { self.error = error.localizedDescription }
    }
}

private struct NativeFoodAdminOperation: Codable {
    let id: String
    let body: Data
}
private struct NativeFoodAdminPendingStore {
    let userID: String
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "asia.treefund.jiashu.nutrition-food-admin", kSecAttrAccount as String: "https://www.treefund.asia|" + userID,
        kSecAttrSynchronizable as String: false] }
    func load() throws -> NativeFoodAdminOperation? {
        var search = query; search[kSecReturnData as String] = true; search[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(search as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw NativeActionInputError.keychain(status) }
        return try JSONDecoder().decode(NativeFoodAdminOperation.self, from: data)
    }
    func save(_ operation: NativeFoodAdminOperation) throws {
        let changes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(operation), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound { var addition = query; changes.forEach { addition[$0.key] = $0.value }; status = SecItemAdd(addition as CFDictionary, nil) }
        guard status == errSecSuccess else { throw NativeActionInputError.keychain(status) }
    }
    func clear() throws { let status = SecItemDelete(query as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeActionInputError.keychain(status) } }
}

@MainActor
private final class NativeFoodAdminModel: ObservableObject {
    let api: NativeAPI; let token: String; let userID: String
    @Published var items: [NativeJSON] = []
    @Published var pending: NativeFoodAdminOperation?
    @Published var error: String?
    @Published var busy = false
    @Published var loaded = false
    @Published var lastSaved: NativeJSON = .null
    init(api: NativeAPI, token: String, userID: String) { self.api = api; self.token = token; self.userID = userID }
    func load() async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do {
            pending = try NativeFoodAdminPendingStore(userID: userID).load()
            let result = try await api.json(path: "health/foods/manage", token: token)
            guard !Task.isCancelled else { return }; items = result["items"].arrayValue; loaded = true
        } catch { self.error = error.localizedDescription }
    }
    func perform(_ command: NativeJSON) async -> Bool {
        guard pending == nil, !busy else { error = "请先核对待确认的原食品操作。"; return false }
        do {
            let operation = NativeFoodAdminOperation(id: UUID().uuidString.lowercased(), body: try command.encodedData())
            try NativeFoodAdminPendingStore(userID: userID).save(operation); pending = operation
            return await retry()
        } catch { self.error = error.localizedDescription; return false }
    }
    func retry() async -> Bool {
        guard let pending, !busy else { return false }; busy = true; error = nil; defer { busy = false }
        do {
            let body = try JSONDecoder().decode(NativeJSON.self, from: pending.body)
            let result = try await api.json(path: "health/foods/manage", method: "POST", token: token, body: body, headers: ["Idempotency-Key": pending.id])
            guard !Task.isCancelled else { return false }
            try NativeFoodAdminPendingStore(userID: userID).clear(); self.pending = nil; lastSaved = result["item"]
            if let id = lastSaved["id"].stringValue { items.removeAll { $0["id"].stringValue == id }; items.insert(lastSaved, at: 0) }
            return true
        } catch {
            if case NativeAPIError.server(let status, _, _, _) = error, [400,403,404,409,413,415,422].contains(status) {
                do { try NativeFoodAdminPendingStore(userID: userID).clear(); self.pending = nil }
                catch { self.error = error.localizedDescription; return false }
            }
            self.error = error.localizedDescription + (self.pending == nil ? "" : " 原操作已安全保留，请继续核对。"); return false
        }
    }
}

@MainActor
struct NativeNutritionManagedFoodsView: View {
    let api: NativeAPI; let token: String; let userID: String
    @StateObject private var model: NativeFoodAdminModel
    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID
        _model = StateObject(wrappedValue: NativeFoodAdminModel(api: api, token: token, userID: userID))
    }
    var body: some View {
        List {
            Section {
                NavigationLink("新增公共食品草稿") { NativeNutritionManagedFoodEditor(api: api, token: token, userID: userID) }
                Text("草稿仅管理员可见；审核发布后才供所有成员查找。已发布版本不会改写历史饮食。").font(.footnote).foregroundStyle(.secondary)
            }
            if model.pending != nil { Section("待确认操作") { Button("继续核对原食品操作") { Task { _ = await model.retry() } }; Text("处理前不能提交其他维护操作。").font(.footnote).foregroundStyle(.secondary) } }
            if model.busy { ProgressView() }
            if let error = model.error { Text(error).foregroundStyle(.red) }
            if model.loaded {
                ForEach(Array(model.items.enumerated()), id: \.offset) { _, item in
                    NavigationLink {
                        NativeNutritionManagedFoodEditor(api: api, token: token, userID: userID, item: item)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item["draft"]["name"].stringValue ?? "食品")
                            Text(statusLabel(item["status"].stringValue ?? "") + " · 版本\(item["revision"].intValue ?? 0)" + (item["hasDraftChanges"].boolValue == true ? " · 有未发布修改" : ""))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if model.items.isEmpty { Text("尚未建立维护食品").foregroundStyle(.secondary) }
            }
        }.navigationTitle("公共食物库管理").task { await model.load() }.refreshable { await model.load() }
    }
    private func statusLabel(_ value: String) -> String { ["draft":"草稿","published":"已发布","archived":"已下架"][value] ?? value }
}

@MainActor
private struct NativeNutritionManagedFoodEditor: View {
    let api: NativeAPI; let token: String; let userID: String
    let originalFood: NativeJSON
    let recoveryScope: String
    @State private var item: NativeJSON
    @StateObject private var model: NativeFoodAdminModel
    @State private var name = ""
    @State private var aliases = ""
    @State private var brandChoice = "custom"
    @State private var customBrandID = "custom-" + UUID().uuidString.lowercased()
    @State private var brandName = ""
    @State private var category = ""
    @State private var description = ""
    @State private var sourceName = ""
    @State private var sourceURL = ""
    @State private var portion = ""
    @State private var calories = ""
    @State private var carbs = ""
    @State private var protein = ""
    @State private var fat = ""
    @State private var imageURL = ""
    @State private var initialized = false
    @State private var publishPreview = false
    @State private var confirmArchive = false
    @State private var notice: String?
    @State private var recoverableDraft: NativeJSON?
    @State private var draftBaseline: NativeJSON = .null
    @State private var draftReady = false
    init(api: NativeAPI, token: String, userID: String, item: NativeJSON = .null, originalFood: NativeJSON = .null) {
        self.api = api; self.token = token; self.userID = userID; self.originalFood = originalFood
        self.recoveryScope = "nutrition-food-form:" + (item["id"].stringValue ?? originalFood["id"].stringValue ?? "new")
        _item = State(initialValue: item)
        _model = StateObject(wrappedValue: NativeFoodAdminModel(api: api, token: token, userID: userID))
    }
    private var isArchived: Bool { item["status"].stringValue == "archived" }
    private var formDraft: NativeJSON {
        .object(["item": item, "name": .string(name), "aliases": .string(aliases), "brandChoice": .string(brandChoice),
            "customBrandID": .string(customBrandID), "brandName": .string(brandName), "category": .string(category),
            "description": .string(description), "sourceName": .string(sourceName), "sourceURL": .string(sourceURL),
            "portion": .string(portion), "calories": .string(calories), "carbs": .string(carbs), "protein": .string(protein),
            "fat": .string(fat), "imageURL": .string(imageURL)])
    }
    private var draftStore: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: userID, scope: recoveryScope) }
    var body: some View {
        Form {
            if recoverableDraft != nil {
                Section("本机未完成的食品填写") {
                    Text("已找到此账号加密保存的填写。恢复仅填入表单，不发布或提交；旧版本仍需核对。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("恢复填写") { restoreForm() }
                    Button("放弃本机草稿", role: .destructive) { discardForm() }
                }
            }
            Section("食品与规格") {
                TextField("食品名称", text: $name)
                TextField("别名，以逗号分隔", text: $aliases)
                Picker("品牌", selection: $brandChoice) { Text("麦当劳").tag("mcd-cn"); Text("瑞幸").tag("luckin-cn"); Text("其他品牌").tag("custom") }
                if brandChoice == "custom" { TextField("品牌名称", text: $brandName) }
                TextField("分类", text: $category)
                TextField("每份规格", text: $portion)
                TextField("食品说明", text: $description, axis: .vertical).lineLimit(2...5)
            }.disabled(model.pending != nil || model.busy || recoverableDraft != nil)
            Section("每份营养（未知留空）") {
                nutrientField("热量／千卡", text: $calories); nutrientField("碳水／克", text: $carbs)
                nutrientField("蛋白质／克", text: $protein); nutrientField("脂肪／克", text: $fat)
            }.disabled(model.pending != nil || model.busy || recoverableDraft != nil)
            Section("可核对的来源") {
                TextField("来源名称", text: $sourceName)
                TextField("来源 HTTPS 链接", text: $sourceURL).textInputAutocapitalization(.never).keyboardType(.URL)
                TextField("食品图片链接（可选）", text: $imageURL).textInputAutocapitalization(.never).keyboardType(.URL)
                if let url = URL(string: imageURL, relativeTo: NativeAPI.websiteURL)?.absoluteURL, url.scheme == "https", !imageURL.isEmpty {
                    AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { Image(systemName: "photo") }.frame(height: 130)
                }
            }.disabled(model.pending != nil || model.busy || recoverableDraft != nil)
            if !item["published"].objectValue.isEmpty {
                Section("当前发布版本") {
                    Text(item["published"]["name"].stringValue ?? "")
                    Text(item["published"]["portionLabel"].stringValue ?? "")
                    Text("热量：" + (item["published"]["calories"].stringValue ?? "未知") + " 千卡")
                }
            }
            if item["id"].stringValue != nil {
                Section("服务器当前草稿（供核对）") {
                    Text(item["draft"]["name"].stringValue ?? "")
                    Text(item["draft"]["portionLabel"].stringValue ?? "")
                    ForEach(["calories","carbs","protein","fat"], id: \.self) { key in
                        LabeledContent(NativeNutritionFields.title(key), value: item["draft"][key].stringValue ?? "未知")
                    }
                }
            }
            Section {
                if model.pending != nil {
                    Button("继续核对原食品操作") { Task { if await model.retry() { adoptSaved() } } }
                } else {
                    Button("保存草稿") { Task { await saveDraft() } }.disabled(model.busy || recoverableDraft != nil || name.trimmingCharacters(in: .whitespaces).isEmpty)
                    if item["id"].stringValue != nil {
                        Button("审核发布已保存草稿") { publishPreview = true }.disabled(model.busy || isArchived || recoverableDraft != nil)
                        if isArchived { Button("恢复食品") { Task { await mutate("restore") } }.disabled(model.busy || recoverableDraft != nil) }
                        else { Button("下架食品", role: .destructive) { confirmArchive = true }.disabled(model.busy || recoverableDraft != nil) }
                    }
                }
                if model.busy { ProgressView("正在核对食品操作…") }
                if let notice { Text(notice).foregroundStyle(.secondary) }
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Button("保留填写，读取最新食品版本") { Task { await reloadItem() } }.disabled(model.busy || model.pending != nil)
            }
        }.navigationTitle(item["id"].stringValue == nil ? "新增食品草稿" : "维护食品")
            .task { await initialize() }
            .onChange(of: formDraft) { _, _ in persistForm() }
            .onDisappear { persistForm() }
            .sheet(isPresented: $publishPreview) {
                NavigationStack {
                    Form {
                        Section("将发布已保存的草稿") {
                            Text(item["draft"]["name"].stringValue ?? "")
                            Text(item["draft"]["portionLabel"].stringValue ?? "")
                            Text(item["draft"]["description"].stringValue ?? "")
                            ForEach(["calories","carbs","protein","fat"], id: \.self) { key in LabeledContent(key == "calories" ? "热量" : key == "carbs" ? "碳水" : key == "protein" ? "蛋白质" : "脂肪", value: item["draft"][key].stringValue ?? "未知") }
                            Text("来源：" + (item["draft"]["sourceName"].stringValue ?? ""))
                            Text(item["draft"]["sourceUrl"].stringValue ?? "")
                            Text("此次发布只使用服务器中已保存草稿；当前表单尚未保存的修改不会发布。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Button("确认发布") { Task { await mutate("publish"); if model.pending == nil, model.error == nil { publishPreview = false } } }.disabled(model.busy)
                        if let error = model.error { Text(error).foregroundStyle(.red) }
                    }.navigationTitle("审核发布").toolbar { Button("关闭") { publishPreview = false }.disabled(model.busy) }.interactiveDismissDisabled(model.busy)
                }
            }
            .confirmationDialog("下架后成员无法在当前公共食物库选择此食品，已有饮食记录与发布快照继续保留。", isPresented: $confirmArchive, titleVisibility: .visible) {
                Button("确认下架", role: .destructive) { Task { await mutate("archive") } }
            }
    }
    private func nutrientField(_ title: String, text: Binding<String>) -> some View { TextField(title, text: text).keyboardType(.decimalPad) }
    private func initialize() async {
        guard !initialized else { return }; initialized = true
        await model.load(); fillForm(); draftBaseline = formDraft
        do { recoverableDraft = try draftStore.load(NativeJSON.self) }
        catch { model.error = error.localizedDescription }
        draftReady = true
    }
    private func fillForm() {
        if item["id"].stringValue != nil {
            let draft = item["draft"]; name = draft["name"].stringValue ?? ""; aliases = draft["aliases"].arrayValue.compactMap(\.stringValue).joined(separator: ", ")
            let brand = draft["brandId"].stringValue ?? ""; brandChoice = ["mcd-cn","luckin-cn"].contains(brand) ? brand : "custom"; if brand.hasPrefix("custom-") { customBrandID = brand }
            brandName = draft["brandName"].stringValue ?? ""; category = draft["category"].stringValue ?? ""; description = draft["description"].stringValue ?? ""
            sourceName = draft["sourceName"].stringValue ?? ""; sourceURL = draft["sourceUrl"].stringValue ?? ""; portion = draft["portionLabel"].stringValue ?? ""
            calories = draft["calories"].stringValue ?? ""; carbs = draft["carbs"].stringValue ?? ""; protein = draft["protein"].stringValue ?? ""; fat = draft["fat"].stringValue ?? ""; imageURL = draft["imageUrl"].stringValue ?? ""
        } else if originalFood["id"].stringValue != nil {
            name = originalFood["name"].stringValue ?? ""; aliases = originalFood["aliases"].arrayValue.compactMap(\.stringValue).joined(separator: ", ")
            brandChoice = originalFood["id"].stringValue?.hasPrefix("luckin-cn:") == true ? "luckin-cn" : "mcd-cn"
            category = originalFood["category"].stringValue ?? ""; description = originalFood["description"].stringValue ?? ""
            sourceName = originalFood["source"]["name"].stringValue ?? ""; sourceURL = originalFood["source"]["url"].stringValue ?? ""
            let values = originalFood["basis"].stringValue == "perServing" ? originalFood["serving"] : originalFood["reference"]
            portion = values["label"].stringValue ?? ""; calories = nfText(values[originalFood["basis"].stringValue == "perServing" ? "kcal" : "calories"])
            carbs = nfText(values["carbs"]); protein = nfText(values["protein"]); fat = nfText(values["fat"])
        }
    }
    private func saveDraft() async {
        let brandID = brandChoice == "custom" ? customBrandID : brandChoice
        var definition: [String: NativeJSON] = ["name": .string(name), "aliases": .array(aliases.components(separatedBy: CharacterSet(charactersIn: ",，\n")).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.map(NativeJSON.string)),
            "brandId": .string(brandID), "brandName": .string(brandChoice == "mcd-cn" ? "麦当劳" : brandChoice == "luckin-cn" ? "瑞幸" : brandName),
            "category": .string(category), "description": .string(description), "sourceName": .string(sourceName), "sourceUrl": .string(sourceURL),
            "portionLabel": .string(portion), "imageUrl": .string(imageURL)]
        for (key, value) in [("calories",calories),("carbs",carbs),("protein",protein),("fat",fat)] { definition[key] = nfValue(value.trimmingCharacters(in: .whitespaces)) }
        var command: [String: NativeJSON] = ["action": .string("save"), "expectedRevision": .number(Double(item["revision"].intValue ?? 0)),
            "definition": .object(definition), "replacesId": item["replacesId"].stringValue.map(NativeJSON.string) ?? originalFood["id"].stringValue.map(NativeJSON.string) ?? .null]
        if let id = item["id"].stringValue { command["id"] = .string(id) }
        if await model.perform(.object(command)) { adoptSaved() }
    }
    private func mutate(_ action: String) async {
        guard let id = item["id"].stringValue, let revision = item["revision"].intValue else { return }
        var localFields = formDraft.objectValue, baseFields = draftBaseline.objectValue
        localFields.removeValue(forKey: "item"); baseFields.removeValue(forKey: "item")
        let preserveUnsubmittedFields = localFields != baseFields
        if await model.perform(.object(["action": .string(action), "id": .string(id), "expectedRevision": .number(Double(revision))])) {
            if preserveUnsubmittedFields {
                item = model.lastSaved
                var baseline = draftBaseline.objectValue; baseline["item"] = item; draftBaseline = .object(baseline)
                notice = "服务器中的食品操作已完成，本页尚未提交的填写仍保留。"
                persistForm()
            } else { adoptSaved() }
        }
    }
    private func adoptSaved() {
        draftReady = false; item = model.lastSaved; fillForm(); draftBaseline = formDraft
        do { try draftStore.clear(); recoverableDraft = nil }
        catch { model.error = error.localizedDescription }
        draftReady = true
    }
    private func persistForm() {
        guard draftReady, recoverableDraft == nil, formDraft != draftBaseline else { return }
        do { try draftStore.save(formDraft) } catch { model.error = error.localizedDescription }
    }
    private func restoreForm() {
        guard let saved = recoverableDraft else { return }
        draftReady = false
        item = saved["item"]; name = saved["name"].stringValue ?? ""; aliases = saved["aliases"].stringValue ?? ""
        brandChoice = saved["brandChoice"].stringValue ?? "custom"; customBrandID = saved["customBrandID"].stringValue ?? customBrandID
        brandName = saved["brandName"].stringValue ?? ""; category = saved["category"].stringValue ?? ""; description = saved["description"].stringValue ?? ""
        sourceName = saved["sourceName"].stringValue ?? ""; sourceURL = saved["sourceURL"].stringValue ?? ""; portion = saved["portion"].stringValue ?? ""
        calories = saved["calories"].stringValue ?? ""; carbs = saved["carbs"].stringValue ?? ""; protein = saved["protein"].stringValue ?? ""
        fat = saved["fat"].stringValue ?? ""; imageURL = saved["imageURL"].stringValue ?? ""
        recoverableDraft = nil; draftReady = true
        notice = "已恢复本机填写，尚未提交。请核对来源和服务器版本。"
    }
    private func discardForm() {
        do { try draftStore.clear(); recoverableDraft = nil; draftBaseline = formDraft }
        catch { model.error = error.localizedDescription }
    }
    private func reloadItem() async {
        guard let id = item["id"].stringValue else { return }
        await model.load()
        guard model.error == nil else { return }
        if let latest = model.items.first(where: { $0["id"].stringValue == id }) {
            item = latest
            notice = "已读取最新版本，原填写仍保留。请对照当前发布内容后再保存。"
        }
    }
}
