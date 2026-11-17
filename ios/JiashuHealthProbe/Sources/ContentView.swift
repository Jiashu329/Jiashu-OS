import SwiftUI
import Charts

enum NativeTab: Hashable { case today, health, review, settings }

struct ContentView: View {
    @ObservedObject var model: NativeAppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: NativeTab = .today
    var body: some View {
        Group {
            if model.restoring {
                VStack(spacing: 24) { NativeBrand(); ProgressView("正在恢复登录…") }
            } else if let session = model.session {
                TabView(selection: $tab) {
                    NativeTodayView(model: model, tab: $tab)
                        .tabItem { Label("今天", systemImage: "sun.max") }.tag(NativeTab.today)
                    NativeHealthView(model: model)
                        .tabItem { Label("健康", systemImage: "heart") }.tag(NativeTab.health)
                    NavigationStack { HealthWeeklyReviewView(api: model.api, token: session.accessToken, userID: session.user.id) }
                        .tabItem { Label("复盘", systemImage: "calendar") }.tag(NativeTab.review)
                    NativeSettingsView(model: model)
                        .tabItem { Label("我的", systemImage: "person.crop.circle") }.tag(NativeTab.settings)
                }.id(session.user.id)
            } else { NativeLoginView(model: model) }
        }
        .tint(.indigo)
        .task { await model.restore() }
        .onChange(of: scenePhase) { _, phase in if phase == .active && !model.restoring { Task { await model.becameActive() } } }
        .sheet(item: $model.pendingChannelConsent) { _ in
            NativeDailyChannelConsent(model: model)
        }
        .alert("操作未完成", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("知道了") { model.errorMessage = nil }
        } message: { Text(model.errorMessage ?? "") }
    }
}

private struct NativeBrand: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "heart.text.clipboard.fill").font(.system(size: 42)).foregroundStyle(.white)
                .frame(width: 88, height: 88).background(.indigo.gradient, in: RoundedRectangle(cornerRadius: 25))
            Text("Jiashu OS").font(.largeTitle.bold())
            Text("把生活的变化，看得更清楚").foregroundStyle(.secondary)
        }
    }
}

private struct NativeLoginView: View {
    @ObservedObject var model: NativeAppModel
    @State private var email = ""
    @State private var password = ""
    @FocusState private var passwordFocused: Bool
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 30) {
                    NativeBrand().padding(.top, 40)
                    VStack(alignment: .leading, spacing: 20) {
                        Text("登录你的生活空间").font(.title2.bold())
                        TextField("邮箱", text: $email).textContentType(.username).keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.next)
                            .onSubmit { passwordFocused = true }
                            .padding().background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                        SecureField("密码", text: $password).textContentType(.password).focused($passwordFocused).submitLabel(.go)
                            .onSubmit { login() }
                            .padding().background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                        Button(action: login) {
                            HStack { if model.signingIn { ProgressView().tint(.white) }; Text(model.signingIn ? "正在登录…" : "登录").fontWeight(.semibold) }
                                .frame(maxWidth: .infinity, minHeight: 36)
                        }.buttonStyle(.borderedProminent).controlSize(.large)
                            .disabled(model.signingIn || email.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                        Text("使用 www.treefund.asia 的现有账号。登录状态保存在此设备的钥匙串中。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }.padding(24).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24))
                    Text("苹果健康授权会在登录后，由你主动开启。").font(.footnote).foregroundStyle(.secondary)
                }.padding(24).frame(maxWidth: 520).frame(maxWidth: .infinity)
            }.background(Color(.systemGroupedBackground)).scrollDismissesKeyboard(.interactively)
        }
    }
    private func login() {
        guard !email.isEmpty, !password.isEmpty, !model.signingIn else { return }
        passwordFocused = false
        Task { await model.login(email: email, password: password); if model.session != nil { password = "" } }
    }
}

private enum MetricDisplay {
    static let keys = ["steps", "active_energy", "sleep", "weight", "lean_body_mass"]
    static func title(_ key: String) -> String { ["steps":"步数", "active_energy":"活动能量", "sleep":"睡眠", "weight":"体重", "lean_body_mass":"去脂体重", "body_fat":"估算体脂率"][key] ?? key }
    static func unit(_ key: String) -> String { ["steps":"步", "active_energy":"千卡", "sleep":"小时", "weight":"kg", "lean_body_mass":"kg", "body_fat":"%"][key] ?? "" }
    static func icon(_ key: String) -> String { ["steps":"figure.walk", "active_energy":"flame.fill", "sleep":"moon.fill", "weight":"scalemass.fill", "lean_body_mass":"figure.strengthtraining.traditional", "body_fat":"chart.pie.fill"][key] ?? "heart.fill" }
    static func color(_ key: String) -> Color {
        switch key { case "steps": return .green; case "active_energy": return .orange; case "sleep": return .indigo; case "weight": return .blue; default: return .teal }
    }
    static func source(_ value: String?) -> String {
        guard let value else { return "无来源" }
        if value == "apple-health-merged" { return "苹果健康 · 系统合并" }
        if value.hasPrefix("apple-health-sleep:") { return "苹果健康 · 睡眠来源 " + String(value.suffix(6)) }
        if value.hasPrefix("apple-health-mass:") { return "苹果健康 · 测量来源 " + String(value.suffix(6)) }
        if value.hasPrefix("manual") { return "手工记录" }
        return value
    }
    static func value(_ value: Double?, key: String) -> String {
        guard let value else { return "—" }
        if key == "steps" { return value.formatted(.number.precision(.fractionLength(0))) }
        return value.formatted(.number.precision(.fractionLength(0...1)))
    }
}

private struct NativeTodayView: View {
    @ObservedObject var model: NativeAppModel
    @Binding var tab: NativeTab
    @State private var quickEntry = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(model.overview?.today ?? StepCalendar.dayString(for: Date())).font(.subheadline).foregroundStyle(.secondary)
                        Text("照顾好今天的自己").font(.title2.bold())
                    }
                    NativeSyncCard(model: model)
                    HStack { Text("健康近况").font(.title3.bold()); Spacer(); Button("查看趋势") { tab = .health }.font(.subheadline) }
                    if let overview = model.overview {
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                            ForEach(overview.health.metrics) { metric in
                                VStack(alignment: .leading, spacing: 12) {
                                    Label(metric.label, systemImage: MetricDisplay.icon(metric.metric)).font(.subheadline.weight(.medium)).foregroundStyle(MetricDisplay.color(metric.metric))
                                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                                        Text(MetricDisplay.value(metric.value, key: metric.metric)).font(.title.bold()).monospacedDigit().minimumScaleFactor(0.65)
                                        Text(MetricDisplay.unit(metric.metric)).font(.caption).foregroundStyle(.secondary)
                                    }.lineLimit(1)
                                    Text(metric.day.map { $0 + (metric.freshness == "stale" ? " · 待更新" : "") } ?? "暂无记录").font(.caption).foregroundStyle(.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20)).accessibilityElement(children: .combine)
                            }
                        }
                        Text("显示最新可用记录，日期见各卡片；未取得的记录保持为空。").font(.footnote).foregroundStyle(.secondary)
                    } else if model.loading { ProgressView("正在读取近况…").frame(maxWidth: .infinity).padding(30) }
                    else { ContentUnavailableView("暂未取得总览", systemImage: "heart.text.square", description: Text("下拉刷新，或先连接苹果健康。")) }
                    Button { quickEntry = true } label: { Label("记饮食或补记健康数据", systemImage: "plus.circle.fill").frame(maxWidth: .infinity, minHeight: 34) }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                    if let session = model.session {
                        NavigationLink {
                            NativeNutritionDayView(api: model.api, token: session.accessToken, userID: session.user.id) { await model.reload() }
                        } label: {
                            Label("查看饮食记录与营养小计", systemImage: "fork.knife").frame(maxWidth: .infinity, minHeight: 34)
                        }.buttonStyle(.bordered).controlSize(.large)
                    }
                    Button { tab = .review } label: {
                        HStack {
                            Image(systemName: "calendar.badge.clock").font(.title2)
                            VStack(alignment: .leading, spacing: 6) { Text("给这一周一点回顾").font(.headline); Text("看看变化，选一项接下来的行动").font(.subheadline).foregroundStyle(.secondary) }
                            Spacer(); Image(systemName: "chevron.right").font(.footnote)
                        }.padding(20).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                    }.buttonStyle(.plain)
                }.padding(20)
            }.background(Color(.systemGroupedBackground)).navigationTitle("今天")
                .refreshable { await model.reload() }
                .sheet(isPresented: $quickEntry) {
                    if let session = model.session { HealthQuickEntryView(api: model.api, token: session.accessToken, userID: session.user.id) { await model.reload() } }
                }
        }
    }
}

private struct NativeSyncCard: View {
    @ObservedObject var model: NativeAppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "heart.circle.fill").font(.title2).foregroundStyle(.indigo)
                Text(model.autoSyncEnabled ? "健康同步已开启" : "连接苹果健康").font(.headline)
                Spacer(); if model.syncing { ProgressView() }
            }
            Text(model.syncMessage).font(.subheadline).foregroundStyle(.secondary)
            if let note = model.observerMessage { Text(note).font(.footnote).foregroundStyle(.orange) }
            if !model.autoSyncEnabled {
                Text("读取步数、活动能量、睡眠、体重和去脂体重，仅同步授权后实际可读的记录。").font(.footnote).foregroundStyle(.secondary)
                Button(model.authorizingHealth ? "等待系统授权…" : "确认日常来源并同步") {
                    Task { await model.connectHealth() }
                }.buttonStyle(.borderedProminent)
                    .disabled(model.syncing || model.authorizingHealth || model.configuringChannel)
            } else {
                Button(model.syncing ? "正在同步…" : "立即同步最近 30 天") { Task { await model.sync() } }.buttonStyle(.bordered).disabled(model.syncing)
            }
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
    }
}

private struct NativeDailyChannelConsent: View {
    @ObservedObject var model: NativeAppModel
    @State private var label = "这台 iPhone"
    private var trimmedLabel: String { label.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        NavigationStack {
            Form {
                if let pending = model.pendingChannelConsent {
                    Section("选择日常健康同步设备") {
                        TextField("设备名称", text: $label)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        if let currentLabel = pending.currentLabel {
                            LabeledContent("将替换的日常来源", value: currentLabel)
                        }
                    }
                    Section("确认后会怎样") {
                        Label("这台 iPhone 成为此账户的日常健康同步来源。", systemImage: "iphone")
                        Text("读取你授权的步数、活动能量、睡眠、体重和去脂体重。手机或手表提供的苹果健康记录变化后，App 会自动尝试同步，无需逐批确认来源。")
                        Text("旧快捷指令和其他同步设备将不能继续向这个日常通道写入；已有人工更正和屏蔽记录继续保留。")
                        Text("后台同步时机由 iOS 决定；你仍可在 App 内手动同步。暂停自动同步会保留这次设备选择。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section {
                        Button("确认并开启自动同步") {
                            Task { await model.confirmDailyChannel(label: trimmedLabel) }
                        }
                        .disabled(trimmedLabel.isEmpty || trimmedLabel.utf16.count > 40 || model.configuringChannel)
                        if model.configuringChannel { ProgressView("正在确认日常同步来源…") }
                        if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
                    }
                }
            }
            .disabled(model.configuringChannel)
            .navigationTitle("确认日常健康来源")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { model.cancelDailyChannelConsent() }.disabled(model.configuringChannel)
                }
            }
            .interactiveDismissDisabled(model.configuringChannel)
        }
    }
}

private struct NativeHealthView: View {
    @ObservedObject var model: NativeAppModel
    @State private var metric = "steps"
    @State private var days = 30
    @State private var quickEntry = false
    var selected: NativeMetricSummary? { model.health?.summary.metrics[metric] }
    var body: some View {
        NavigationStack {
            List {
                Section { NativeSyncCard(model: model).listRowInsets(EdgeInsets()).listRowBackground(Color.clear) }
                Section {
                    Picker("指标", selection: $metric) { ForEach(MetricDisplay.keys, id: \.self) { Text(MetricDisplay.title($0)).tag($0) } }
                    Picker("范围", selection: $days) { Text("7 天").tag(7); Text("30 天").tag(30); Text("90 天").tag(90); Text("180 天").tag(180); Text("360 天").tag(360) }.pickerStyle(.segmented)
                }
                if let summary = selected {
                    Section(MetricDisplay.title(metric) + "趋势") {
                        HStack(alignment: .firstTextBaseline) {
                            Text(MetricDisplay.value(summary.latestValue, key: metric)).font(.largeTitle.bold()).monospacedDigit()
                            Text(MetricDisplay.unit(metric)).foregroundStyle(.secondary)
                        }
                        if !summary.points.isEmpty {
                            NativeTrendChart(summary: summary).frame(height: 200).padding(.vertical, 10)
                            Text("\(summary.points.count) 个有记录日期，缺失日期不补零。").font(.footnote).foregroundStyle(.secondary)
                        } else { Text("所选范围暂无可用记录").foregroundStyle(.secondary) }
                    }
                    Section("每日记录") {
                        ForEach(summary.points.reversed()) { point in
                            VStack(alignment: .leading, spacing: 7) {
                                HStack { Text(point.day); Spacer(); Text(MetricDisplay.value(point.value, key: metric) + " " + MetricDisplay.unit(metric)).monospacedDigit() }
                                if metric == "sleep", let stage = point.sleepStages {
                                    Text("深睡 \(stage.deep.formatted(.number.precision(.fractionLength(1)))) · 核心 \(stage.core.formatted(.number.precision(.fractionLength(1)))) · REM \(stage.rem.formatted(.number.precision(.fractionLength(1)))) 小时").font(.caption).foregroundStyle(.secondary)
                                }
                                if let source = point.source { Text(MetricDisplay.source(source)).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                            }.padding(.vertical, 4)
                        }
                    }
                } else if model.loading { ProgressView("读取记录…") }
                else { ContentUnavailableView("暂无健康记录", systemImage: "heart.text.square", description: Text("连接苹果健康或手动记录后，即可查看趋势。")) }
            }.navigationTitle("健康")
                .toolbar { Button { quickEntry = true } label: { Image(systemName: "plus") }.accessibilityLabel("补记健康数据") }
                .refreshable { await model.reload(days: days) }
                .onChange(of: days) { _, value in Task { await model.reload(days: value) } }
                .sheet(isPresented: $quickEntry) {
                    if let session = model.session { HealthQuickEntryView(api: model.api, token: session.accessToken, userID: session.user.id) { await model.reload(days: days) } }
                }
        }
    }
}

private struct NativeTrendChart: View {
    let summary: NativeMetricSummary
    var body: some View {
        Chart(summary.points) { point in
            if let date = NativeChartDates.parse(point.day) {
                if ["steps", "sleep", "active_energy"].contains(summary.metric) {
                    BarMark(x: .value("日期", date), y: .value(summary.label, point.value)).foregroundStyle(MetricDisplay.color(summary.metric).gradient)
                } else {
                    LineMark(x: .value("日期", date), y: .value(summary.label, point.value)).foregroundStyle(MetricDisplay.color(summary.metric))
                    PointMark(x: .value("日期", date), y: .value(summary.label, point.value)).foregroundStyle(MetricDisplay.color(summary.metric))
                }
            }
        }
    }
}

enum NativeChartDates {
    static func parse(_ day: String) -> Date? {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai"); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        return formatter.date(from: day)
    }
}

private struct NativeSettingsView: View {
    @ObservedObject var model: NativeAppModel
    @State private var signingOut = false
    @State private var releasingChannel = false
    @State private var syncDays = 30
    var body: some View {
        NavigationStack {
            Form {
                Section("当前账户") { LabeledContent("邮箱", value: model.session?.user.email ?? ""); LabeledContent("服务", value: "www.treefund.asia") }
                Section("苹果健康") {
                    Toggle("自动同步", isOn: Binding(get: { model.autoSyncEnabled }, set: { enabled in Task { await model.setAutomaticSync(enabled) } }))
                        .disabled(model.authorizingHealth || model.configuringChannel)
                    if let channel = model.channel {
                        if channel.deviceId != nil {
                            LabeledContent("日常同步来源", value: channel.label ?? "已选择的设备")
                            Text(channel.isCurrentDevice ? "当前选定的是这台 iPhone。" : "当前选定的是另一台设备。")
                                .font(.footnote).foregroundStyle(.secondary)
                            if let updatedAt = channel.updatedAt, let date = NativeDates.parse(updatedAt) {
                                LabeledContent("选择时间", value: date.formatted(date: .abbreviated, time: .shortened))
                            }
                            if channel.isCurrentDevice {
                                Button("解除日常同步来源", role: .destructive) { releasingChannel = true }
                                    .disabled(model.syncing || model.configuringChannel || model.authorizingHealth)
                            } else {
                                Button("设为这台 iPhone") { Task { await model.connectHealth() } }
                                    .disabled(model.syncing || model.configuringChannel || model.authorizingHealth)
                            }
                        } else {
                            Text("尚未选择日常同步来源。")
                                .font(.footnote).foregroundStyle(.secondary)
                            Button("设为这台 iPhone") { Task { await model.connectHealth() } }
                                .disabled(model.syncing || model.configuringChannel || model.authorizingHealth)
                        }
                    } else {
                        Button("读取日常同步来源") { Task { await model.refreshChannelStatus() } }
                            .disabled(model.configuringChannel)
                    }
                    Picker("补同步范围", selection: $syncDays) { Text("最近 7 天").tag(7); Text("最近 30 天").tag(30); Text("最近 90 天").tag(90) }
                    Button("同步所选范围") { Task { await model.sync(days: syncDays) } }.disabled(!model.autoSyncEnabled || model.syncing || model.configuringChannel)
                    Text("打开 App 和健康数据变化时尝试同步，后台唤醒时机由 iOS 决定。只读取健康记录，不写入苹果健康。").font(.footnote).foregroundStyle(.secondary)
                    Text("关闭自动同步只暂停上传，保留当前日常来源；再次开启时无需重复选择这台设备。").font(.footnote).foregroundStyle(.secondary)
                    Text("同步保留人工更正。苹果健康中删除的样本不会自动删除服务器记录，需要在记录管理中核对。").font(.footnote).foregroundStyle(.secondary)
                }
                if let session = model.session {
                    Section {
                        NavigationLink("健康目标") { NativeGoalsView(api: model.api, token: session.accessToken) }
                        NavigationLink("同步历史") { NativeImportHistoryView(api: model.api, token: session.accessToken) }
                    }
                }
                Section { Link("打开桌面与管理网页版", destination: NativeAPI.websiteURL); Button("退出登录", role: .destructive) { signingOut = true } }
            }.navigationTitle("我的")
                .task { await model.refreshChannelStatus() }
                .confirmationDialog(
                    releasingChannel ? "解除后，这台设备将停止日常健康同步。服务器已有记录和人工更正继续保留。" : "退出后暂停此账户的 App 同步。",
                    isPresented: Binding(get: { releasingChannel || signingOut }, set: { if !$0 { releasingChannel = false; signingOut = false } }),
                    titleVisibility: .visible
                ) {
                    if releasingChannel {
                        Button("解除日常同步来源", role: .destructive) { Task { await model.releaseDailyChannel() } }
                    } else {
                        Button("退出登录", role: .destructive) { Task { await model.signOut() } }
                    }
                }
        }
    }
}

private struct NativeGoalsView: View {
    let api: NativeAPI
    let token: String
    @State private var settings: NativeGoalSettings?
    @State private var steps = ""
    @State private var sleep = ""
    @State private var energy = ""
    @State private var busy = false
    @State private var message: String?
    @State private var conflict = false
    var body: some View {
        Form {
            Section {
                field("步数（步）", text: $steps); field("睡眠（小时）", text: $sleep); field("活动能量（千卡）", text: $energy)
            } footer: { Text("留空表示未设置。从北京时间今天生效，历史目标继续保留。") }
            if let message { Text(message).foregroundStyle(.secondary) }
            Button(busy ? "正在保存…" : "保存目标") { Task { await save() } }.disabled(busy || settings == nil || conflict)
            if conflict { Button("保留填写并读取最新版本") { Task { await load(keepInput: true) } } }
        }.navigationTitle("健康目标").navigationBarTitleDisplayMode(.inline).disabled(busy).task { await load() }
    }
    private func field(_ title: String, text: Binding<String>) -> some View {
        HStack { Text(title); Spacer(); TextField("未设置", text: text).keyboardType(.decimalPad).multilineTextAlignment(.trailing) }
    }
    private func load(keepInput: Bool = false) async {
        busy = true; defer { busy = false }
        do {
            let value = try await api.goals(token: token); settings = value; conflict = false
            if !keepInput {
                steps = value.targets.steps.map { String($0) } ?? ""; sleep = value.targets.sleep.map { String($0) } ?? ""; energy = value.targets.activeEnergy.map { String($0) } ?? ""
            } else { message = "已读取最新版本，请核对后再次保存。" }
        } catch { message = error.localizedDescription }
    }
    private func save() async {
        guard let settings else { return }
        let fields = [steps, sleep, energy].map { $0.trimmingCharacters(in: .whitespaces) }
        guard fields.allSatisfy({ $0.isEmpty || (Double($0).map { $0.isFinite && $0 > 0 } ?? false) }) else { message = "请填写有效的正数，或留空。"; return }
        busy = true; defer { busy = false }
        do {
            self.settings = try await api.saveGoals(token: token, targets: NativeGoalTargets(steps: Double(fields[0]), sleep: Double(fields[1]), activeEnergy: Double(fields[2])), expectedRevision: settings.revision, effectiveFrom: StepCalendar.dayString(for: Date()))
            message = "目标已保存。"
        } catch {
            if case NativeAPIError.server(let status, _, _, _) = error, status == 409 { conflict = true }
            message = error.localizedDescription
        }
    }
}

private struct NativeImportHistoryView: View {
    let api: NativeAPI
    let token: String
    @State private var history: NativeImportHistoryResponse?
    @State private var error: String?
    var body: some View {
        List {
            if let history {
                if history.batches.isEmpty { ContentUnavailableView("暂无同步历史", systemImage: "clock.arrow.circlepath") }
                ForEach(history.batches) { batch in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(NativeDates.parse(batch.createdAt)?.formatted(date: .abbreviated, time: .shortened) ?? batch.createdAt).font(.headline)
                        Text("写入 \(batch.imported) 条 · 跳过 \(batch.skipped) 条").font(.subheadline)
                        if batch.revertedAt != nil { Text("已回退").font(.caption).foregroundStyle(.secondary) }
                    }.padding(.vertical, 4)
                }
            } else if error == nil { ProgressView("读取同步历史…") }
            if let error { Text(error); Button("重试") { Task { await load() } } }
        }.navigationTitle("同步历史").task { await load() }.refreshable { await load() }
    }
    private func load() async {
        do { history = try await api.importHistory(token: token); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
