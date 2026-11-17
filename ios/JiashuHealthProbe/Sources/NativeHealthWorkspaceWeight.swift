import SwiftUI
import Charts

enum NativeWeightPlanRequest {
    static func plan(baseline: String, target: String, start: Date, deadline: Date, enabled: Bool, now: Date = Date()) throws -> NativeJSON {
        func mass(_ text: String) throws -> NativeJSON {
            let value = text.trimmingCharacters(in:.whitespacesAndNewlines)
            guard value.range(of:#"^\d+(?:\.\d+)?$"#,options:.regularExpression) != nil,let number = Double(value),number.isFinite,(10...600).contains(number) else {
                throw NativeHealthWorkspaceError.invalid("请明确填写10–600 kg之间的起始体重和目标体重。")
            }; return .number(number)
        }
        let startDay = NativeActionDates.day(start), deadlineDay = NativeActionDates.day(deadline)
        guard startDay >= "1970-01-01",startDay <= NativeActionDates.day(now),deadlineDay > startDay,deadlineDay <= "2100-12-31" else { throw NativeHealthWorkspaceError.invalid("起始日期不能晚于今天，目标日期应晚于起点且在支持的日历范围内。") }
        return try .object(["baselineWeight":mass(baseline),"targetWeight":mass(target),"startDate":.string(startDay),"deadline":.string(deadlineDay),"enabled":.bool(enabled)])
    }
    static func matchesSaved(_ operation: NativeHealthWorkspaceMutation, response: NativeJSON) -> Bool {
        guard operation.method == "PUT",let expected = operation.body["expectedRevision"].intValue,
              response["settings"]["revision"].intValue == expected + 1 else { return false }
        return ["baselineWeight","targetWeight","startDate","deadline","enabled"].allSatisfy { response["settings"][$0] == operation.body[$0] }
    }
}

struct NativeWeightPlanWorkspace: View {
    let api: NativeAPI
    let token: String
    let userID: String
    @State private var data: NativeJSON = .null
    @State private var cycles: [NativeJSON] = []
    @State private var baseline = ""
    @State private var target = ""
    @State private var start = Date()
    @State private var deadline = NativeActionDates.calendar.date(byAdding:.day,value:90,to:Date())!
    @State private var enabled = true
    @State private var pending: NativeHealthWorkspaceMutation?
    @State private var operationKind = "save"
    @State private var confirming = false
    @State private var confirmStart = false
    @State private var isEditing = false
    @FocusState private var focusedWeight: String?
    @State private var busy = false
    @State private var loaded = false
    @State private var formRevision = 0
    @State private var draftReady = false
    @State private var conflict = false
    @State private var message: String?
    private var store: NativeHealthWorkspaceMutationStore { .init(userID:userID,scope:"weight-plan") }
    private var draftStore: NativeWorkspacePersistence { .init(userID:userID,scope:"health-weight-plan-form") }
    private var revision: Int { formRevision }
    private var draftSignature: String { baseline + target + NativeActionDates.day(start) + NativeActionDates.day(deadline) + String(enabled) }
    private var archived: Bool { data["cycle"]["archivedAt"].stringValue != nil }
    private var hasCurrent: Bool { data["cycle"]["id"].stringValue != nil && !archived }
    var body: some View {
        List {
            pendingSection
            currentPlanSection
            observationsSection
            editEntrySection
            historySection
            if busy { ProgressView("正在确认…") }
            NativeHealthWorkspaceMessage(message:message)
        }.navigationTitle("体重计划")
            .environment(\.timeZone,NativeActionDates.timeZone)
            .task {
                do {
                    pending = try store.load()
                    let draft = try draftStore.load(NativeHealthWorkspaceFormDraft.self)
                    await load(populate:pending == nil && draft == nil)
                    if let draft {
                        baseline = draft.fields["baseline"] ?? ""; target = draft.fields["target"] ?? ""
                        start = draft.dates["start"] ?? start; deadline = draft.dates["deadline"] ?? deadline
                        enabled = draft.fields["enabled"] == "true"; formRevision = draft.snapshot["revision"].intValue ?? 0
                        conflict = true; message = "未保存的计划已恢复，可点“继续核对填写”查看最新内容。"
                    }
                    draftReady = true
                } catch { message = error.localizedDescription }
            }
            .onChange(of:draftSignature) { _,_ in saveDraft() }
            .onDisappear { saveDraft() }
            .sheet(isPresented:$isEditing) { editorSheet }
            .confirmationDialog(operationKind == "archive" ? "归档当前体重周期？":"保存已核对的体重计划？",isPresented:$confirming,titleVisibility:.visible) {
                Button(operationKind == "archive" ? "确认归档":"确认保存",role:operationKind == "archive" ? .destructive:nil) { Task { await prepare() } }
                Button("取消",role:.cancel) { }
            } message: { Text(confirmationMessage) }
    }
    @ViewBuilder private var pendingSection: some View {
        if let pending {
            Section("保存结果待确认") {
                Text(pending.label)
                Text("原填写已安全保留，继续确认不会另建周期。").font(.footnote).foregroundStyle(.secondary)
                Button("继续确认保存") { Task { await submit(pending,recovering:true) } }.disabled(busy)
            }
        }
    }
    private var currentPlanSection: some View {
        Section("本周期目标") {
            if loaded,data["settings"]["baselineWeight"].doubleValue != nil {
                LabeledContent("起始体重",value:mass(data["settings"]["baselineWeight"]))
                LabeledContent("目标体重",value:mass(data["settings"]["targetWeight"]))
                LabeledContent("目标日期",value:data["settings"]["deadline"].stringValue ?? "未知")
                if data["progress"]["status"].stringValue != nil { progress(data["progress"]) }
                else { Text(archived ? "此周期已归档，可开始新周期。":"计划当前未启用。").foregroundStyle(.secondary) }
            } else if loaded { Text("尚未设置体重计划，可先记录体重，再确定目标。").foregroundStyle(.secondary) }
            else { Text("尚未读取计划").foregroundStyle(.secondary) }
        }
    }
    private var observationsSection: some View {
        Section("近期实测") {
            LabeledContent("最新体重",value:mass(data["observations"]["latestWeight"]))
            LabeledContent("记录日期",value:data["observations"]["latestDate"].stringValue ?? "暂无")
            LabeledContent("近7天日均",value:mass(data["observations"]["average7"]))
            LabeledContent("有记录日期",value:NativeHealthWorkspaceFormat.text(data["observations"]["recordedDays7"]) + " / 7 天")
            observationChart
            DisclosureGroup("变化速度与计算依据") {
                rate(data["observations"]["rate7"],label:"近7天")
                rate(data["observations"]["rate30"],label:"近30天")
                Text("按实际记录的首末值和日期跨度计算；不足两个不同日期时不估算。").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
    @ViewBuilder private var observationChart: some View {
        let points = data["observations"]["points"].arrayValue.compactMap(NativeWorkspaceHealthPoint.init)
        if !points.isEmpty {
            Chart(points) { point in
                if let date = NativeHealthWorkspaceFormat.date(point.day) { PointMark(x:.value("日期",date),y:.value("实测kg",point.value)).foregroundStyle(.teal) }
            }.frame(height:180)
        }
    }
    private var editEntrySection: some View {
        Section {
            Button(conflict ? "继续核对填写":hasCurrent ? "编辑计划":"开始新周期") { isEditing = true }
                .disabled(busy || pending != nil || !loaded || !draftReady)
            if hasCurrent {
                DisclosureGroup("周期管理") {
                    Text("归档会冻结当前总结并停用计划，全部实测记录继续保留。").font(.footnote).foregroundStyle(.secondary)
                    Button("归档当前周期",role:.destructive) { operationKind = "archive"; confirming = true }.disabled(busy || pending != nil || conflict)
                }
            }
        }
    }
    private var historySection: some View {
        Section {
            DisclosureGroup("历史周期") {
                ForEach(Array(cycles.enumerated()),id:\.offset) { _,cycle in archivedCycle(cycle) }
                if cycles.count < (data["cycleCount"].intValue ?? 0) { Button("读取更早周期") { Task { await moreCycles() } }.disabled(busy) }
                if cycles.isEmpty { Text("暂无归档周期。").foregroundStyle(.secondary) }
            }
        }
    }
    private func archivedCycle(_ cycle: NativeJSON) -> some View {
        let title: String = cycleTitle(cycle)
        return DisclosureGroup(title) {
            LabeledContent("起点",value:mass(cycle["settings"]["baselineWeight"]))
            LabeledContent("目标",value:mass(cycle["settings"]["targetWeight"]))
            LabeledContent("归档时日均",value:mass(cycle["summary"]["average7"]))
            LabeledContent("归档时间",value:cycle["archivedAt"].stringValue ?? "未知")
            rate(cycle["summary"]["rate7"],label:"归档时7天")
            rate(cycle["summary"]["rate30"],label:"归档时30天")
            if cycle["summary"]["progress"]["status"].stringValue != nil { progress(cycle["summary"]["progress"]) }
        }
    }
    private var editorSheet: some View {
        NavigationStack {
            Form {
                pendingSection
                planFormSection
                NativeHealthWorkspaceMessage(message:message)
                Text("关闭后会保留填写；保存后才更新计划。").font(.footnote).foregroundStyle(.secondary)
            }
            .navigationTitle(hasCurrent ? "编辑体重计划":"新体重周期").navigationBarTitleDisplayMode(.inline)
            .environment(\.timeZone,NativeActionDates.timeZone)
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement:.confirmationAction) { Button("完成") { focusedWeight = nil; if saveDraft() { isEditing = false } }.disabled(busy) }
                ToolbarItemGroup(placement:.keyboard) { Spacer(); Button("完成输入") { focusedWeight = nil } }
            }
            .interactiveDismissDisabled(busy || hasUnsentDraft)
            .onDisappear { saveDraft() }
            .confirmationDialog("开始新的体重周期？",isPresented:$confirmStart,titleVisibility:.visible) {
                Button("开始新周期") { Task { await prepare() } }
                Button("取消",role:.cancel) { }
            } message: { Text(confirmationMessage) }
        }
    }
    private var planFormSection: some View {
        Section("计划内容") {
            TextField("起始体重（kg）",text:$baseline).keyboardType(.decimalPad).focused($focusedWeight,equals:"baseline")
            if let last = data["observations"]["latestWeight"].doubleValue {
                Button("用最新实测填入起点") { baseline = String(last) }
            }
            TextField("目标体重（kg）",text:$target).keyboardType(.decimalPad).focused($focusedWeight,equals:"target")
            DatePicker("起始日期",selection:$start,in:...Date(),displayedComponents:.date)
            DatePicker("目标日期",selection:$deadline,displayedComponents:.date)
            Toggle("启用计划",isOn:$enabled)
            if conflict { Text("计划已更新。请先查看最新内容，再核对保留的填写。").foregroundStyle(.orange) }
            Button(hasCurrent ? "保存计划":"开始新周期") {
                focusedWeight = nil; operationKind = hasCurrent ? "save":"start"
                if hasCurrent { Task { await prepare() } } else { confirmStart = true }
            }.buttonStyle(.borderedProminent).disabled(!loaded || !draftReady || conflict || busy || pending != nil)
            Button("查看最新计划，保留填写") { Task { await load(populate:false) } }.disabled(busy || pending != nil)
        }.disabled(busy || pending != nil)
    }
    private func mass(_ value: NativeJSON) -> String { NativeHealthWorkspaceFormat.text(value) + " kg" }
    private var hasUnsentDraft: Bool {
        let current = data["settings"]
        return (!baseline.isEmpty || !target.isEmpty) && (Double(baseline) != current["baselineWeight"].doubleValue || Double(target) != current["targetWeight"].doubleValue ||
            NativeActionDates.day(start) != current["startDate"].stringValue || NativeActionDates.day(deadline) != current["deadline"].stringValue || enabled != current["enabled"].boolValue)
    }
    @ViewBuilder private func rate(_ value: NativeJSON,label: String) -> some View {
        let title: String = label + "变化速度"
        let speed: String = NativeHealthWorkspaceFormat.text(value["kgPerWeek"])
        let recordedDays: String = NativeHealthWorkspaceFormat.text(value["recordedDays"])
        let daysBetween: String = NativeHealthWorkspaceFormat.text(value["daysBetween"])
        let from: String = value["from"].stringValue ?? "未知"
        let to: String = value["to"].stringValue ?? "未知"
        let speedLabel: String = "\(speed) kg/周"
        let coverage: String = "记录 \(recordedDays) 天，跨度 \(daysBetween) 天；\(from) — \(to)"
        LabeledContent(title,value:speedLabel)
        Text(coverage).font(.caption).foregroundStyle(.secondary)
    }
    @ViewBuilder private func progress(_ value: NativeJSON) -> some View {
        let statusKey: String = value["status"].stringValue ?? ""
        let statuses: [String:String] = ["active":"进行中","achieved":"近7天日均达成","ended":"已到期","missing":"缺少实测"]
        let status: String = statuses[statusKey] ?? "未知"
        let sustained: NativeJSON = value["sustained"]
        let sustainedLabel: String = sustained["achieved"].boolValue == true ? "最近7天逐日达成":"尚不满足逐日条件"
        let recordedDays: String = NativeHealthWorkspaceFormat.text(sustained["recordedDays"])
        let qualifyingDays: String = NativeHealthWorkspaceFormat.text(sustained["qualifyingDays"])
        let coverage: String = "7天内有记录 \(recordedDays) 天，达成本人目标 \(qualifyingDays) 天。维持目标不使用持续达成判定。"
        LabeledContent("当前状态",value:status)
        LabeledContent("距目标",value:NativeHealthWorkspaceFormat.text(value["gapKg"]) + " kg")
        LabeledContent("目标进度",value:NativeHealthWorkspaceFormat.text(value["progressPercent"]) + "%")
        LabeledContent("剩余天数",value:NativeHealthWorkspaceFormat.text(value["remainingDays"]))
        DisclosureGroup("参考与持续达成依据") {
            LabeledContent("日历参考体重",value:mass(value["referenceWeight"]))
            LabeledContent("持续达成",value:sustainedLabel)
            Text(coverage).font(.caption).foregroundStyle(.secondary)
        }
    }
    private func cycleTitle(_ cycle: NativeJSON) -> String {
        let from: String = cycle["settings"]["startDate"].stringValue ?? ""
        let to: String = cycle["settings"]["deadline"].stringValue ?? ""
        return "\(from) — \(to)"
    }
    private var confirmationMessage: String {
        if operationKind == "archive" { return "冻结当前周期的计划与总结，停用周期并保留实测记录。" }
        let from: String = NativeActionDates.day(start)
        let to: String = NativeActionDates.day(deadline)
        return "起始 \(baseline) kg → 目标 \(target) kg；\(from) — \(to)。目标与实测分开显示。"
    }
    private func load(populate: Bool) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            data = try await api.json(path:"health/weight-plan",token:token); cycles = data["cycles"].arrayValue; loaded = true; conflict = false
            formRevision = data["settings"]["revision"].intValue ?? 0
            if populate,data["settings"]["baselineWeight"].doubleValue != nil {
                baseline = data["settings"]["baselineWeight"].doubleValue.map { String($0) } ?? ""
                target = data["settings"]["targetWeight"].doubleValue.map { String($0) } ?? ""
                start = data["settings"]["startDate"].stringValue.flatMap(NativeHealthWorkspaceFormat.date) ?? start
                deadline = data["settings"]["deadline"].stringValue.flatMap(NativeHealthWorkspaceFormat.date) ?? deadline
                enabled = data["settings"]["enabled"].boolValue ?? false
            }
        } catch { message = error.localizedDescription }
    }
    private func moreCycles() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { cycles += try await api.json(path:"health/weight-plan/cycles?offset=\(cycles.count)",token:token)["cycles"].arrayValue }
        catch { message = error.localizedDescription }
    }
    private func prepare() async {
        guard !busy,pending == nil,loaded,draftReady,!conflict else { return }
        do {
            var body: [String:NativeJSON] = ["expectedRevision":.number(Double(revision))]
            let path: String; let method: String
            if operationKind == "archive" { body["action"] = .string("archive"); path = "health/weight-plan/cycles"; method = "POST" }
            else {
                let plan = try NativeWeightPlanRequest.plan(baseline:baseline,target:target,start:start,deadline:deadline,enabled:enabled)
                if operationKind == "start" { body["action"] = .string("start"); body["plan"] = plan; path = "health/weight-plan/cycles"; method = "POST" }
                else { plan.objectValue.forEach { body[$0.key] = $0.value }; path = "health/weight-plan"; method = "PUT" }
            }
            let operation = NativeHealthWorkspaceMutation(path:path,method:method,body:.object(body),label:operationKind == "archive" ? "归档当前体重周期":operationKind == "start" ? "开始新的体重周期":"保存当前体重计划")
            try store.save(operation); pending = operation; await submit(operation,recovering:false)
        } catch { message = error.localizedDescription }
    }
    @discardableResult private func saveDraft() -> Bool {
        guard draftReady,pending == nil else { return pending != nil }
        let current = data["settings"]
        let edited = Double(baseline) != current["baselineWeight"].doubleValue || Double(target) != current["targetWeight"].doubleValue ||
            NativeActionDates.day(start) != current["startDate"].stringValue || NativeActionDates.day(deadline) != current["deadline"].stringValue || enabled != current["enabled"].boolValue
        do {
            if edited && (!baseline.isEmpty || !target.isEmpty) {
                try draftStore.save(NativeHealthWorkspaceFormDraft(fields:["baseline":baseline,"target":target,"enabled":String(enabled)],dates:["start":start,"deadline":deadline],snapshot:.object(["revision":.number(Double(formRevision))])))
            } else { try draftStore.clear() }
            return true
        } catch { message = error.localizedDescription; return false }
    }
    private func submit(_ operation: NativeHealthWorkspaceMutation,recovering: Bool) async {
        guard !busy else { return }; busy = true; message = nil
        do {
            let result: NativeJSON
            if recovering,operation.method == "PUT" {
                let current = try await api.json(path:"health/weight-plan",token:token)
                if NativeWeightPlanRequest.matchesSaved(operation,response:current) { result = current }
                else { result = try await operation.send(api:api,token:token) }
            } else { result = try await operation.send(api:api,token:token) }
            guard result["settings"]["revision"].intValue != nil else { throw NativeAPIError.invalidResponse }
            try store.clear(); try draftStore.clear(); pending = nil; busy = false; await load(populate:true); message = "计划已保存。"; isEditing = false
        } catch {
            message = error.localizedDescription
            if NativeHealthWorkspaceFormat.definiteRejection(error) {
                do { try store.clear(); pending = nil; conflict = true } catch { message = error.localizedDescription }
            } else { message = (message ?? "") + " 填写已保留，请继续确认保存。" }
        }
        busy = false
    }
}
