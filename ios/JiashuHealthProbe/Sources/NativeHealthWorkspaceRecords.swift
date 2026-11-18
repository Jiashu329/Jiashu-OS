import SwiftUI

enum NativeHealthRecordRequest {
    static func operation(record: NativeJSON, action: String, value: String, reason: String) throws -> NativeHealthWorkspaceMutation {
        guard let key = record["recordKey"].stringValue, !key.isEmpty,
              let revision = record["revision"].intValue, revision >= 0,
              ["correct","hide","restore","reset"].contains(action), reason.utf16.count <= 500 else {
            throw NativeHealthWorkspaceError.invalid("请先读取完整记录，再选择操作；说明最多500字。")
        }
        var body: [String:NativeJSON] = ["action":.string(action),"expectedRevision":.number(Double(revision)),
            "expectedBaseExportedAt":record["base"]["exportedAt"],"reason":.string(reason.trimmingCharacters(in:.whitespacesAndNewlines))]
        if action == "correct" {
            let text = value.trimmingCharacters(in:.whitespacesAndNewlines)
            guard text.range(of:#"^\d+(?:\.\d+)?$"#,options:.regularExpression) != nil,
                  let number = Double(text), number.isFinite,
                  let metric = QuickEntryMetric(rawValue:record["metric"].stringValue ?? ""), metric.acceptedRange.contains(number),
                  metric != .steps || number.rounded() == number else { throw NativeHealthWorkspaceError.invalid("请核对本指标的有效数值与单位，未知不能填0。") }
            body["value"] = .number(number)
        }
        return .init(path:"health/records/" + NativeHealthWorkspaceFormat.encodedSegment(key),method:"PATCH",body:.object(body),label:actionLabel(action) + " · " + (record["day"].stringValue ?? ""))
    }
    static func actionLabel(_ action: String) -> String { ["create":"补录","correct":"更正数值","hide":"屏蔽记录","restore":"恢复显示","reset":"恢复最新同步值"][action] ?? action }
}

/// The focused day changes only the list query, never a recovered edit or its
/// original request. The chart's complete range remains available as context.
struct NativeHealthRecordDayContext: Equatable {
    let day: String
    let date: Date
    let metric: String
    let trendRange: NativeHealthWorkspaceRange
    let dayRange: NativeHealthWorkspaceRange

    init?(day: String, metric: String, trendRange: NativeHealthWorkspaceRange, now: Date = Date()) {
        guard QuickEntryMetric(rawValue: metric) != nil,
              let date = NativeHealthWorkspaceFormat.date(day),
              day >= trendRange.from, day <= trendRange.to,
              let range = try? NativeHealthWorkspaceRange(from: date, to: date, now: now) else { return nil }
        self.day = day; self.date = date; self.metric = metric
        self.trendRange = trendRange; dayRange = range
    }

    static func initial(day: String?, metric: String, from: String?, to: String?, now: Date = Date()) -> Self? {
        guard let day, let from = from.flatMap(NativeHealthWorkspaceFormat.date),
              let to = to.flatMap(NativeHealthWorkspaceFormat.date),
              let range = try? NativeHealthWorkspaceRange(from: from, to: to, now: now) else { return nil }
        return Self(day: day, metric: metric, trendRange: range, now: now)
    }
}

struct NativeHealthRecordsWorkspace: View {
    private enum EditingField: Hashable { case value, reason }
    let api: NativeAPI
    let token: String
    let userID: String
    private let dayContext: NativeHealthRecordDayContext?
    @State private var from = NativeActionDates.calendar.date(byAdding:.day,value:-29,to:Date())!
    @State private var to = Date()
    @State private var metric = "all"
    @State private var includeDeleted = false
    @State private var records: [NativeJSON] = []
    @State private var cursor: String?
    @State private var loadedQuery = ""
    @State private var selected: NativeJSON = .null
    @State private var changes: [NativeJSON] = []
    @State private var action = "correct"
    @State private var value = ""
    @State private var reason = ""
    @State private var conflict = false
    @State private var pending: NativeHealthWorkspaceMutation?
    @State private var pendingSelection: NativeJSON = .null
    @State private var switching = false
    @State private var confirming = false
    @State private var quickEntry = false
    @State private var showingDetail = false
    @FocusState private var editingField: EditingField?
    @State private var confirmClose = false
    @State private var confirmDiscardDraft = false
    @State private var busy = false
    @State private var loaded = false
    @State private var draftReady = false
    @State private var message: String?
    private var store: NativeHealthWorkspaceMutationStore { .init(userID:userID,scope:"records") }
    private var draftStore: NativeWorkspacePersistence { .init(userID:userID,scope:"health-record-form") }
    private var signature: String { NativeActionDates.day(from) + NativeActionDates.day(to) + metric + String(includeDeleted) }
    private var dirty: Bool { !reason.isEmpty || (selected["recordKey"].stringValue != nil && value != (selected["effective"]["value"].doubleValue.map { String($0) } ?? "")) || action != "correct" }
    private var draftSignature: String { (selected["recordKey"].stringValue ?? "") + action + value + reason }
    private var viewingFocusedDay: Bool {
        guard let dayContext else { return false }
        return NativeActionDates.day(from) == dayContext.day && NativeActionDates.day(to) == dayContext.day && metric == dayContext.metric
    }
    private var queryDateLabel: String {
        let first = NativeActionDates.day(from), last = NativeActionDates.day(to)
        return first == last ? first : first + " — " + last
    }
    init(api: NativeAPI, token: String, userID: String, initialMetric: String? = nil,
         initialFrom: String? = nil, initialTo: String? = nil, initialDay: String? = nil, compose: Bool = false) {
        self.api = api; self.token = token; self.userID = userID
        let metric = initialMetric.flatMap(QuickEntryMetric.init(rawValue:))?.rawValue ?? "all"
        let context = NativeHealthRecordDayContext.initial(day: initialDay, metric: metric, from: initialFrom, to: initialTo)
        dayContext = context
        _metric = State(initialValue: metric)
        if let date = initialFrom.flatMap(NativeHealthWorkspaceFormat.date),date <= Date() { _from = State(initialValue:date) }
        if let date = initialTo.flatMap(NativeHealthWorkspaceFormat.date),date <= Date() { _to = State(initialValue:date) }
        if let context {
            _from = State(initialValue: context.date); _to = State(initialValue: context.date)
            _includeDeleted = State(initialValue: true)
        }
        _quickEntry = State(initialValue: compose)
    }
    var body: some View {
        List {
            Section("查看记录") {
                if let dayContext {
                    Text(metric == "all" ? "全部指标" : NativeHealthWorkspaceFormat.metric(metric)).font(.headline)
                    Text(queryDateLabel).font(.subheadline)
                    Text("趋势范围 " + dayContext.trendRange.label).font(.caption).foregroundStyle(.secondary)
                    DisclosureGroup("调整范围与指标") { queryFields }
                } else {
                    queryFields
                }
                Toggle("包含已屏蔽",isOn:$includeDeleted)
                Button("更新列表") { Task { await load(more:false) } }.disabled(busy)
                Button(viewingFocusedDay ? "补记这天数据" : "补记健康数据") { quickEntry = true }.disabled(busy || pending != nil)
            }.disabled(busy)
            if let pending {
                Section("保存结果待确认") {
                    Text(pending.label)
                    Text("填写已安全保留，查看后可继续确认保存。")
                        .font(.footnote).foregroundStyle(.secondary)
                    if dayContext != nil {
                        Text("上次操作仍对应原记录，不随日期筛选改变。").font(.caption).foregroundStyle(.secondary)
                    }
                    Button("查看保存状态") { Task { await openPendingDetail(pending) } }.disabled(busy)
                }
            }
            if pending == nil,selected["recordKey"].stringValue != nil,dirty {
                Section("未完成的填写") {
                    Text(recordTitle(selected))
                    if let dayContext, selected["day"].stringValue != dayContext.day {
                        Text("这份草稿属于另一日期，仍保留原记录。").font(.caption).foregroundStyle(.secondary)
                    }
                    Button("继续编辑") { showingDetail = true }
                    Button("放弃填写",role:.destructive) { confirmDiscardDraft = true }
                }
            }
            Section("记录列表") {
                if loadedQuery != signature { Text("筛选已变化，请读取后查看对应记录。") }
                ForEach(Array(records.enumerated()),id:\.offset) { _,record in
                    Button {
                        if dirty { pendingSelection = record; switching = true } else { Task { await read(record,keepDraft:false) } }
                    } label: {
                        HStack(spacing:12) {
                            VStack(alignment:.leading,spacing:6) {
                                LabeledContent(viewingFocusedDay ? recordClock(record) : recordTitle(record),value:recordValue(record))
                                Text(listOrigin(record) + (record["deleted"].boolValue == true ? " · 已屏蔽":"")).font(.caption).foregroundStyle(.secondary)
                            }
                            Image(systemName:"chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                        }.foregroundStyle(.primary)
                    }.disabled(busy || pending != nil || loadedQuery != signature)
                }
                if records.isEmpty && loadedQuery == signature && !busy {
                    Text(viewingFocusedDay ? "这天没有记录" : "当前已读取范围没有记录，缺失不表示0。")
                }
                if cursor != nil { Button("读取更多记录") { Task { await load(more:true) } }.disabled(busy || loadedQuery != signature) }
            }
            if busy { ProgressView("正在核对记录…") }
            NativeHealthWorkspaceMessage(message:message)
        }.nativeGeometricPage().navigationTitle("健康记录")
            .environment(\.timeZone,NativeActionDates.timeZone)
            .task {
                do {
                    pending = try store.load(); loaded = true
                    if let draft = try draftStore.load(NativeHealthWorkspaceFormDraft.self) {
                        selected = draft.snapshot; value = draft.fields["value"] ?? ""; reason = draft.fields["reason"] ?? ""
                        action = draft.fields["action"] ?? "correct"; conflict = true
                        message = "已恢复本机未提交的填写。请读取最新记录并核对后再保存。"
                    }
                    draftReady = true
                } catch { message = error.localizedDescription }
                await load(more:false)
            }
            .onChange(of:draftSignature) { _,_ in saveDraft() }
            .onDisappear { saveDraft() }
            .sheet(isPresented:$quickEntry) {
                HealthQuickEntryView(api:api,token:token,userID:userID,initialMetric:QuickEntryMetric(rawValue:metric) ?? .weight,
                                     initialDate: viewingFocusedDay ? dayContext?.date ?? Date() : Date()) { await load(more:false) }
            }
            .sheet(isPresented:$showingDetail) { detailSheet }
            .confirmationDialog("放弃这次未保存的填写？",isPresented:$confirmDiscardDraft,titleVisibility:.visible) {
                Button("放弃填写",role:.destructive) { discardUnsentDraft() }
                Button("继续填写",role:.cancel) { }
            } message: { Text("只清理本机未提交的内容，已保存的记录不受影响。") }
            .confirmationDialog("放弃未保存填写并切换记录？",isPresented:$switching,titleVisibility:.visible) {
                Button("放弃填写并切换",role:.destructive) { Task { await read(pendingSelection,keepDraft:false) } }
                Button("继续填写",role:.cancel) { }
            }
    }
    @ViewBuilder private var queryFields: some View {
        DatePicker("开始",selection:$from,in:...Date(),displayedComponents:.date)
        DatePicker("结束",selection:$to,in:...Date(),displayedComponents:.date)
        Picker("指标",selection:$metric) {
            Text("全部").tag("all")
            ForEach(NativeHealthWorkspaceFormat.metricKeys,id:\.self) { Text(NativeHealthWorkspaceFormat.metric($0)).tag($0) }
        }
    }
    private var detailSheet: some View {
        NavigationStack {
            List {
                detailSummary
                if let pending { pendingDetail(pending) }
                if let message {
                    Section { Text(message).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled).accessibilityAddTraits(.updatesFrequently) }
                }
                if busy { Section { ProgressView("正在确认…") } }
                editSection
                evidenceSection
                historySection
            }
            .nativeGeometricPage().navigationTitle("记录详情")
            .navigationBarTitleDisplayMode(.inline)
            .environment(\.timeZone,NativeActionDates.timeZone)
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement:.confirmationAction) { Button("完成") { closeDetail() }.disabled(busy) }
                ToolbarItemGroup(placement:.keyboard) { Spacer(); Button("完成输入") { hideKeyboard() } }
            }
            .interactiveDismissDisabled(busy || dirty || pending != nil)
            .confirmationDialog("确认修改记录的显示或来源？",isPresented:$confirming,titleVisibility:.visible) {
                Button(NativeHealthRecordRequest.actionLabel(action),role:action == "hide" || action == "reset" ? .destructive:nil) { Task { await prepare() } }
                Button("取消",role:.cancel) { action = "correct" }
            } message: { Text(impactText) }
            .confirmationDialog("保留这次未保存的填写？",isPresented:$confirmClose,titleVisibility:.visible) {
                Button("保留草稿并关闭") { if saveDraft() { showingDetail = false } }
                Button("放弃填写",role:.destructive) { discardUnsentDraft() }
                Button("继续编辑",role:.cancel) { }
            } message: { Text("草稿只保存在此设备，不会写入健康记录。") }
        }
    }
    private var detailSummary: some View {
        let key: String = selected["metric"].stringValue ?? ""
        return Section {
            Text(NativeHealthWorkspaceFormat.metric(key)).font(.headline)
            Text(recordValue(selected)).font(.largeTitle.weight(.semibold)).monospacedDigit()
            Text(selected["day"].stringValue ?? "日期未知").foregroundStyle(.secondary)
            Text(origin(selected) + (selected["deleted"].boolValue == true ? " · 已屏蔽":"")).font(.footnote).foregroundStyle(.secondary)
        }
    }
    private func pendingDetail(_ operation: NativeHealthWorkspaceMutation) -> some View {
        let action: String = operation.body["action"].stringValue ?? "correct"
        let title: String = NativeHealthRecordRequest.actionLabel(action)
        let savedValue: String = NativeHealthWorkspaceFormat.text(operation.body["value"])
        return Section("保存结果待确认") {
            Text(title)
            if action == "correct" { LabeledContent("待保存的值",value:savedValue) }
            Text("原填写已安全保留，继续确认不会换成新的提交。").font(.footnote).foregroundStyle(.secondary)
            Button("继续确认保存") { Task { await submit(operation) } }.disabled(busy)
        }
    }
    private var editSection: some View {
        Section("更正记录") {
            TextField("核对后的数值",text:$value).keyboardType(.decimalPad).focused($editingField,equals:.value)
            TextField("修改说明（可选）",text:$reason,axis:.vertical).lineLimit(2...4).focused($editingField,equals:.reason)
            Text("原始数据仍保留，更正会用于图表和回顾。").font(.footnote).foregroundStyle(.secondary)
            if conflict { Text("这条记录已更新。请先查看最新内容，再核对保留的填写。").foregroundStyle(.orange) }
            Button("保存更正") { action = "correct"; Task { await prepare() } }
                .buttonStyle(.borderedProminent)
                .disabled(busy || pending != nil || conflict || !loaded || !draftReady)
            Button("查看最新内容，保留填写") { Task { await read(selected,keepDraft:true) } }.disabled(busy || pending != nil)
            Menu("其他操作") {
                if selected["deleted"].boolValue == true {
                    Button("恢复显示") { action = "restore"; confirming = true }
                } else {
                    Button("屏蔽这条记录",role:.destructive) { action = "hide"; confirming = true }
                }
                if selected["base"]["exportedAt"].stringValue != nil {
                    Button("恢复最新同步值",role:.destructive) { action = "reset"; confirming = true }
                }
            }.disabled(busy || pending != nil || conflict || !loaded || !draftReady)
        }.disabled(busy || pending != nil)
    }
    private var evidenceSection: some View {
        Section {
            DisclosureGroup("来源与修改依据") {
                Text(selected["effective"]["source"].stringValue ?? "来源未知").font(.footnote)
                Text(measurementPeriod).font(.caption).foregroundStyle(.secondary)
                LabeledContent("修改版本",value:NativeHealthWorkspaceFormat.text(selected["revision"]))
                if selected["base"]["measurement"]["value"].doubleValue != nil {
                    LabeledContent("最新同步原值",value:NativeHealthWorkspaceFormat.text(selected["base"]["measurement"]["value"]))
                    Text(selected["base"]["measurement"]["source"].stringValue ?? "来源未知").font(.caption)
                    Text("导出时间：" + localTimestamp(selected["base"]["exportedAt"].stringValue)).font(.caption).foregroundStyle(.secondary)
                }
                if selected["override"]["value"].doubleValue != nil { LabeledContent("人工更正值",value:NativeHealthWorkspaceFormat.text(selected["override"]["value"])) }
            }
        }
    }
    private var historySection: some View {
        Section {
            DisclosureGroup("修改历史") {
                Button("读取修改历史") { Task { await loadHistory() } }.disabled(busy)
                ForEach(Array(changes.enumerated()),id:\.offset) { _,change in historyRow(change) }
            }
        }
    }
    private func historyRow(_ change: NativeJSON) -> some View {
        let date: String = localTimestamp(change["createdAt"].stringValue)
        let action: String = NativeHealthRecordRequest.actionLabel(change["action"].stringValue ?? "")
        let title: String = "\(date) · \(action)"
        let before: String = NativeHealthWorkspaceFormat.text(change["before"]["effective"]["value"])
        let after: String = NativeHealthWorkspaceFormat.text(change["after"]["effective"]["value"])
        let beforeStatus: String = change["before"]["deleted"].boolValue == true ? "已屏蔽":"显示"
        let afterStatus: String = change["after"]["deleted"].boolValue == true ? "已屏蔽":"显示"
        return DisclosureGroup(title) {
            LabeledContent("之前",value:before)
            LabeledContent("之后",value:after)
            Text("\(beforeStatus) → \(afterStatus)").font(.caption)
            Text(change["reason"].stringValue ?? "无说明").font(.footnote)
            LabeledContent("此前同步原值",value:NativeHealthWorkspaceFormat.text(change["before"]["base"]["measurement"]["value"]))
            LabeledContent("此后同步原值",value:NativeHealthWorkspaceFormat.text(change["after"]["base"]["measurement"]["value"]))
        }
    }
    private func recordTitle(_ record: NativeJSON) -> String {
        let date: String = record["day"].stringValue ?? ""
        let metric: String = NativeHealthWorkspaceFormat.metric(record["metric"].stringValue ?? "")
        return "\(date) · \(metric)"
    }
    private func recordValue(_ record: NativeJSON) -> String {
        let value: String = NativeHealthWorkspaceFormat.text(record["effective"]["value"])
        let unit: String = NativeHealthWorkspaceFormat.unit(record["metric"].stringValue ?? "")
        return "\(value) \(unit)"
    }
    private func localTimestamp(_ value: String?) -> String {
        guard let value,let date = NativeDates.parse(value) else { return "时间未知" }
        return NativeActionDates.formatted(date,pattern:"yyyy-MM-dd HH:mm")
    }
    private func recordClock(_ record: NativeJSON) -> String {
        let key = record["metric"].stringValue == "sleep" ? "endDate" : "startDate"
        let stamp = record["effective"][key].stringValue ?? record["effective"]["startDate"].stringValue
        guard let stamp, let date = NativeDates.parse(stamp) else { return "时间未知" }
        return NativeActionDates.formatted(date,pattern:"HH:mm")
    }
    private func listOrigin(_ record: NativeJSON) -> String {
        guard viewingFocusedDay, let source = record["effective"]["source"].stringValue, !source.isEmpty else { return origin(record) }
        let provenance = origin(record)
        return provenance == "同步记录" ? source : source + " · " + provenance
    }
    private var measurementPeriod: String {
        let start: String = localTimestamp(selected["effective"]["startDate"].stringValue)
        guard let end = selected["effective"]["endDate"].stringValue else { return start }
        return start + " — " + localTimestamp(end)
    }
    private func closeDetail() {
        hideKeyboard()
        if pending != nil { showingDetail = false }
        else if dirty { confirmClose = true }
        else { showingDetail = false }
    }
    private func hideKeyboard() { editingField = nil }
    private func discardUnsentDraft() {
        guard pending == nil else { return }
        do {
            try draftStore.clear(); selected = .null; value = ""; reason = ""; action = "correct"
            changes = []; conflict = false; showingDetail = false; message = nil
        } catch { message = error.localizedDescription }
    }
    private func openPendingDetail(_ operation: NativeHealthWorkspaceMutation) async {
        guard !busy else { return }
        showingDetail = true
        let prefix = "health/records/"
        guard operation.path.hasPrefix(prefix),let key = String(operation.path.dropFirst(prefix.count)).removingPercentEncoding,!key.isEmpty else { return }
        if selected["recordKey"].stringValue != key {
            await read(.object(["recordKey":.string(key)]),keepDraft:false)
        }
    }
    private var impactText: String {
        switch action {
        case "hide": return "这条记录将从健康图表、目标与回顾中排除；原值与修改历史仍保留，可恢复。"
        case "restore": return "重新计入当前有效记录；人工覆盖若存在仍优先于同步原值。"
        case "reset": return "清除人工覆盖与屏蔽状态，重新采用最新同步原值；后续同步会继续更新原值。"
        default: return "人工更正覆盖展示与回顾中的有效值；原同步值与历史保留，后续同步不会悄悄覆盖人工更正。"
        }
    }
    private func origin(_ record: NativeJSON) -> String {
        if record["manual"].boolValue == true { return "人工补录" }
        if case .object = record["override"] { return "人工更正" }
        return "同步记录"
    }
    private func load(more: Bool) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            guard NativeActionDates.day(from) <= NativeActionDates.day(to),NativeActionDates.day(from) >= "1970-01-01" else { throw NativeHealthWorkspaceError.invalid("请核对起止日期。") }
            var query = [URLQueryItem(name:"from",value:NativeActionDates.day(from)),URLQueryItem(name:"to",value:NativeActionDates.day(to)),URLQueryItem(name:"metric",value:metric),URLQueryItem(name:"includeDeleted",value:includeDeleted ? "1":"0"),URLQueryItem(name:"limit",value:"100")]
            if more,let cursor { query.append(URLQueryItem(name:"cursor",value:cursor)) }
            let result = try await api.json(path:NativeHealthWorkspaceFormat.path("health/records",query:query),token:token)
            if more { records += result["records"].arrayValue } else { records = result["records"].arrayValue }
            cursor = result["nextCursor"].stringValue; loadedQuery = signature; message = nil
        } catch { message = error.localizedDescription }
    }
    private func read(_ record: NativeJSON, keepDraft: Bool) async {
        guard !busy,let key = record["recordKey"].stringValue else { return }; busy = true; defer { busy = false }
        do {
            let result = try await api.json(path:"health/records/" + NativeHealthWorkspaceFormat.encodedSegment(key),token:token)
            guard result["record"]["recordKey"].stringValue == key else { throw NativeAPIError.invalidResponse }
            selected = result["record"]; conflict = false; changes = []; showingDetail = true
            if !keepDraft { value = selected["effective"]["value"].doubleValue.map { String($0) } ?? ""; reason = ""; action = "correct" }
            message = keepDraft ? "已更新记录，填写已保留。核对后可保存。":nil
        } catch { message = error.localizedDescription }
    }
    private func loadHistory() async {
        guard !busy,let key = selected["recordKey"].stringValue else { return }; busy = true; defer { busy = false }
        do { changes = try await api.json(path:"health/records/" + NativeHealthWorkspaceFormat.encodedSegment(key) + "/history",token:token)["history"].arrayValue }
        catch { message = error.localizedDescription }
    }
    private func prepare() async {
        guard !busy,pending == nil,!conflict,loaded,draftReady,selected["recordKey"].stringValue != nil else { return }
        do { let operation = try NativeHealthRecordRequest.operation(record:selected,action:action,value:value,reason:reason); try store.save(operation); pending = operation; await submit(operation) }
        catch { message = error.localizedDescription }
    }
    @discardableResult private func saveDraft() -> Bool {
        guard draftReady,pending == nil else { return pending != nil }
        do {
            if selected["recordKey"].stringValue != nil && dirty {
                try draftStore.save(NativeHealthWorkspaceFormDraft(fields:["value":value,"reason":reason,"action":action],dates:[:],snapshot:selected))
            } else { try draftStore.clear() }
            return true
        } catch { message = error.localizedDescription; return false }
    }
    private func submit(_ operation: NativeHealthWorkspaceMutation) async {
        guard !busy else { return }; busy = true; message = nil
        do {
            let result = try await operation.send(api:api,token:token)
            guard result["record"]["recordKey"].stringValue != nil else { throw NativeAPIError.invalidResponse }
            try store.clear(); try draftStore.clear(); pending = nil; selected = result["record"]; value = selected["effective"]["value"].doubleValue.map { String($0) } ?? ""; reason = ""; action = "correct"; conflict = false; changes = []
            busy = false; await load(more:false); message = "已保存。"
        } catch {
            message = error.localizedDescription
            if NativeHealthWorkspaceFormat.definiteRejection(error) {
                do { try store.clear(); pending = nil; conflict = true } catch { message = error.localizedDescription }
            } else { message = (message ?? "") + " 填写已保留，请继续确认保存。" }
        }
        busy = false
    }
}
