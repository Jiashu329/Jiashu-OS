import SwiftUI
import Charts

@MainActor
struct NativeNutritionGoalsView: View {
    @ObservedObject var context: NativeNutritionContext
    @State private var settings: NativeJSON = .null
    @State private var fields = Dictionary(uniqueKeysWithValues: NativeNutritionFields.keys.map { ($0, "") })
    @State private var original = Dictionary(uniqueKeysWithValues: NativeNutritionFields.keys.map { ($0, "") })
    @State private var loading = false
    @State private var message: String?
    @State private var needs = false
    @State private var recovered: [String: String]?
    @State private var persistenceReady = false
    private var persistence: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: context.userID, scope: "nutrition-goal-draft") }
    var body: some View {
        Form {
            if let recovered {
                Section("本机未保存目标") {
                    Text("恢复后请与服务器当前目标核对，再主动保存。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("恢复目标填写") { fields = recovered; self.recovered = nil }
                    Button("删除本机草稿", role: .destructive) { do { try persistence.clear(); self.recovered = nil } catch { message = error.localizedDescription } }
                }
            }
            Section("本人每日参考目标") {
                ForEach(NativeNutritionFields.keys, id: \.self) { key in
                    TextField(NativeNutritionFields.title(key) + (key == "calories" ? "（千卡）" : "（克）"),
                        text: Binding(get: { fields[key] ?? "" }, set: { fields[key] = $0 })).keyboardType(.decimalPad)
                }
                Text("未设置时留空。当前目标不带历史生效日，不用于重新判定过去日期是否达标。")
                    .font(.footnote).foregroundStyle(.secondary)
            }.disabled(loading || context.busy)
            if loading { ProgressView("读取目标…") }
            if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
            if fields != original && settings != .null {
                Section("当前服务器目标，供核对") {
                    ForEach(NativeNutritionFields.keys, id: \.self) { key in
                        LabeledContent(NativeNutritionFields.title(key), value: original[key].flatMap { $0.isEmpty ? nil : $0 } ?? "未设置")
                    }
                }
            }
            NativeNutritionErrorRow(text: context.error)
            Section {
                Button("保存每日目标") { Task { await save() } }.disabled(settings == .null || loading || context.busy || context.pending != nil)
                Button("保留填写并读取最新目标") { Task { await load(keepInput: true) } }.disabled(loading || context.busy)
                Button("AI测算每日热量与营养") { needs = true }.disabled(settings == .null || fields != original || context.busy)
                if fields != original { Text("先保存或核对当前填写，再将测算结果带入目标，避免覆盖未保存内容。")
                    .font(.footnote).foregroundStyle(.secondary) }
            }
            if settings["weightPlan"] != .null {
                Section("关联的体重计划") {
                    LabeledContent("起点", value: NativeNutritionFields.value(settings["weightPlan"]["baselineWeight"], unit: "kg"))
                    LabeledContent("目标", value: NativeNutritionFields.value(settings["weightPlan"]["targetWeight"], unit: "kg"))
                    LabeledContent("期限", value: settings["weightPlan"]["deadline"].stringValue ?? "未知")
                }
            }
        }
        .navigationTitle("每日营养目标").task {
            await load()
            do { recovered = try persistence.load([String: String].self); persistenceReady = true }
            catch { message = error.localizedDescription }
        }
        .onChange(of: fields) { _, _ in
            guard persistenceReady, recovered == nil, fields != original else { return }
            do { try persistence.save(fields) } catch { message = error.localizedDescription }
        }
        .sheet(isPresented: $needs) {
            NavigationStack {
                NativeNutritionNeedsView(context: context) { targets in
                    guard settings != .null, fields == original, !context.busy else { message = "当前目标已变化，请先核对填写。"; return }
                    for key in NativeNutritionFields.keys { fields[key] = targets[key].stringValue ?? "" }
                    message = "已填入参考目标，请核对后点击保存。"
                }
            }
        }
    }
    private func load(keepInput: Bool = false) async {
        loading = true; defer { loading = false }
        do {
            let response = try await context.api.json(path: "health/nutrition/goals", token: context.token)
            guard !Task.isCancelled else { return }; settings = response
            original = Dictionary(uniqueKeysWithValues: NativeNutritionFields.keys.map { ($0, response["goals"][$0].stringValue ?? "") })
            if !keepInput { fields = original } else { message = "已读取最新版本。原填写保留，当前服务器目标见下面对照，核对后可保存。" }
        } catch { message = error.localizedDescription }
    }
    private func save() async {
        do {
            var body: [String: NativeJSON] = [:]
            for key in NativeNutritionFields.keys { body[key] = try NativeNutritionFields.nullable(fields[key] ?? "") }
            body["expectedRevision"] = settings["goals"]["revision"]
            if let result = await context.write(NativeNutritionCommand(path: "health/nutrition/goals", method: "PUT", title: "保存每日营养目标", body: .object(body))) {
                settings = result; original = fields; message = "每日目标已保存。"
                try persistence.clear()
            }
        } catch { message = error.localizedDescription }
    }
}

@MainActor
struct NativeNutritionNeedsView: View {
    @ObservedObject var context: NativeNutritionContext
    let onApply: (NativeJSON) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var age = ""
    @State private var height = ""
    @State private var weight = ""
    @State private var sex = ""
    @State private var activity = "sedentary"
    @State private var goal = "maintain"
    @State private var result: NativeJSON = .null
    @State private var loading = false
    @State private var error: String?
    private var signature: String { [age, height, weight, sex, activity, goal].joined(separator: "|") }
    var body: some View {
        Form {
            Section("本次测算资料") {
                TextField("年龄（18–80岁）", text: $age).keyboardType(.numberPad)
                TextField("身高（cm）", text: $height).keyboardType(.decimalPad)
                TextField("体重（kg）", text: $weight).keyboardType(.decimalPad)
                Picker("公式性别系数", selection: $sex) { Text("请主动选择").tag(""); Text("男性系数").tag("male"); Text("女性系数").tag("female") }
                Picker("活动水平", selection: $activity) {
                    Text("久坐").tag("sedentary"); Text("轻度活动").tag("light"); Text("中度活动").tag("moderate"); Text("高度活动").tag("active"); Text("极高活动").tag("veryActive")
                }
                Picker("体重方向", selection: $goal) { Text("维持").tag("maintain"); Text("减重").tag("lose"); Text("增重").tag("gain") }
            }.disabled(loading)
            Section {
                Text("适用于一般成人，不适用于孕期、哺乳期或需要特殊营养治疗的情形。点击测算才发送本次身体资料供AI解读；资料不保存到个人档案。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button(loading ? "正在测算…" : "测算并请求AI解读") { Task { await calculate() } }.disabled(loading)
                if loading { ProgressView() }
                NativeNutritionErrorRow(text: error)
            }
            if result != .null {
                Section("固定公式参考结果") {
                    LabeledContent("静息能量估值", value: NativeNutritionFields.value(result["estimate"]["bmr"], unit: "千卡／天"))
                    LabeledContent("维持热量估值", value: NativeNutritionFields.value(result["estimate"]["maintenanceCalories"], unit: "千卡／天"))
                    LabeledContent("BMI参考", value: NativeNutritionFields.value(result["estimate"]["bmi"]))
                    ForEach(NativeNutritionFields.keys, id: \.self) { key in
                        LabeledContent(NativeNutritionFields.title(key), value: NativeNutritionFields.value(result["estimate"]["targets"][key], unit: key == "calories" ? "千卡" : "克"))
                    }
                    ForEach(Array(result["estimate"]["warnings"].arrayValue.enumerated()), id: \.offset) { _, warning in Text(warning.stringValue ?? "").font(.footnote).foregroundStyle(.orange) }
                }
                Section("AI解读") {
                    Text(result["ai"]["text"].stringValue ?? result["ai"]["message"].stringValue ?? "本次未生成AI解读，公式结果仍可核对。")
                }
                Section("方法与来源") {
                    Text("Mifflin–St Jeor公式估算静息消耗，再按所选活动系数及方向生成参考目标；不代表实测个人消耗或医学处方。")
                        .font(.footnote).foregroundStyle(.secondary)
                    ForEach(Array(result["estimate"]["sources"].arrayValue.enumerated()), id: \.offset) { _, source in
                        if let string = source["url"].stringValue, let url = URL(string: string), url.scheme == "https" {
                            Link(source["title"].stringValue ?? "来源", destination: url)
                        }
                    }
                }
                Button("填入每日目标草稿") { onApply(result["estimate"]["targets"]); dismiss() }
            }
        }
        .navigationTitle("营养需求测算").navigationBarTitleDisplayMode(.inline)
        .onChange(of: signature) { _, _ in result = .null }
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(loading) } }
    }
    private func calculate() async {
        guard let ageValue = Int(age), let heightValue = Double(height), let weightValue = Double(weight), !sex.isEmpty else {
            error = "请完整填写年龄、身高、体重，并主动选择公式系数。"; return
        }
        loading = true; error = nil; result = .null; let input = signature
        defer { loading = false }
        do {
            let response = try await context.api.json(path: "health/nutrition/needs", method: "POST", token: context.token,
                body: .object(["age": .number(Double(ageValue)), "heightCm": .number(heightValue), "weightKg": .number(weightValue),
                    "sex": .string(sex), "activity": .string(activity), "goal": .string(goal)]))
            guard !Task.isCancelled, signature == input else { return }; result = response
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

@MainActor
struct NativeNutritionReviewView: View {
    @ObservedObject var context: NativeNutritionContext
    @State private var date: Date
    @State private var days = 7
    @State private var metric = "calories"
    @State private var data: NativeJSON = .null
    @State private var loading = false
    @State private var error: String?
    @State private var requestID = UUID()
    init(context: NativeNutritionContext, initialDate: Date) { self.context = context; _date = State(initialValue: initialDate) }
    private var selection: String { NativeActionDates.day(date) + String(days) }
    var body: some View {
        List {
            Section {
                DatePicker("截止日期", selection: $date, in: ...Date(), displayedComponents: .date)
                Picker("回顾范围", selection: $days) { Text("7天").tag(7); Text("30天").tag(30) }.pickerStyle(.segmented)
                Picker("营养指标", selection: $metric) { ForEach(NativeNutritionFields.keys, id: \.self) { Text(NativeNutritionFields.title($0)).tag($0) } }
            }
            if loading { ProgressView("读取饮食回顾…") }
            NativeNutritionErrorRow(text: error)
            if error != nil { Button("重试") { Task { await load() } } }
            if data != .null {
                Section("记录覆盖") {
                    LabeledContent("有食物记录", value: "\(data["summary"]["recordedDays"].intValue ?? 0)天")
                    LabeledContent("本人标记记完", value: "\(data["summary"]["completeDays"].intValue ?? 0)天")
                    LabeledContent("本项完整可比较", value: "\(data["summary"]["nutrientAverages"][metric]["comparableDays"].intValue ?? 0)天")
                    LabeledContent("完整记录日均", value: NativeNutritionFields.value(data["summary"]["nutrientAverages"][metric]["average"], unit: metric == "calories" ? "千卡" : "克"))
                    NativeNutritionTotals(nutrients: data["summary"]["nutrients"])
                }
                Section("已知部分的每日记录") {
                    Chart {
                        ForEach(Array(data["days"].arrayValue.enumerated()), id: \.offset) { _, day in
                            if let date = NativeChartDates.parse(day["date"].stringValue ?? ""),
                               let text = day["nutrients"][metric]["total"].stringValue, let value = Double(text) {
                                BarMark(x: .value("日期", date), y: .value(NativeNutritionFields.title(metric), value)).foregroundStyle(.indigo.gradient)
                            }
                        }
                    }.frame(height: 180)
                    Text("未知日期不画作0；柱高仅为已知小计，缺项不代表实际全天摄入。")
                        .font(.footnote).foregroundStyle(.secondary)
                    ForEach(Array(data["days"].arrayValue.enumerated()), id: \.offset) { _, day in
                        VStack(alignment: .leading, spacing: 3) {
                            LabeledContent(day["date"].stringValue ?? "日期", value: NativeNutritionFields.value(day["nutrients"][metric]["total"]))
                            Text("\(day["entryCount"].intValue ?? 0)项食物 · 本项未知\(day["nutrients"][metric]["unknownCount"].intValue ?? 0)项 · " + (day["complete"].boolValue == true ? "已记完" : "未记完"))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("餐次分布") {
                    ForEach(Array(data["meals"].arrayValue.enumerated()), id: \.offset) { _, meal in
                        LabeledContent(meal["label"].stringValue ?? "餐次", value: NativeNutritionFields.value(meal["nutrients"][metric]["total"]))
                    }
                }
                Section("统计口径") {
                    ForEach(Array(data["limitations"].arrayValue.enumerated()), id: \.offset) { _, note in Text(note.stringValue ?? "").font(.footnote).foregroundStyle(.secondary) }
                }
            }
        }
        .navigationTitle("饮食回顾").environment(\.timeZone, NativeActionDates.timeZone)
        .task(id: selection) { await load() }.refreshable { await load() }
    }
    private func load() async {
        let selected = selection, id = UUID(); requestID = id; loading = true; data = .null; error = nil
        do {
            let response = try await context.api.json(path: "health/nutrition/review?date=" + NativeActionDates.day(date) + "&days=" + String(days), token: context.token)
            guard !Task.isCancelled, requestID == id, selected == selection else { return }; data = response
        } catch { if !Task.isCancelled && requestID == id { self.error = error.localizedDescription } }
        if requestID == id { loading = false }
    }
}
