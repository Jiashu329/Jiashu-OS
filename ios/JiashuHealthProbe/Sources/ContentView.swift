import SwiftUI

enum NativeTab: Hashable { case today, health, finance, life, settings }

struct ContentView: View {
    @ObservedObject var model: NativeAppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: NativeTab = .today
    @State private var healthMetric = "steps"
    @State private var healthRoute = UUID()
    var body: some View {
        Group {
            if model.restoring {
                VStack(spacing: 24) { NativeBrand(); ProgressView() }
            } else if let session = model.session {
                TabView(selection: $tab) {
                    NativeTodayView(model: model) { metric in
                        healthMetric = metric; healthRoute = UUID(); tab = .health
                    }.tabItem { Label("今天", systemImage: "sun.max") }.tag(NativeTab.today)
                    NativeHealthView(model: model, initialMetric: healthMetric).id(healthRoute)
                        .tabItem { Label("健康", systemImage: "heart") }.tag(NativeTab.health)
                    NativeFinanceRoot(api: model.api, token: session.accessToken, userID: session.user.id)
                        .tabItem { Label("财务", systemImage: "chart.bar.xaxis") }.tag(NativeTab.finance)
                    NavigationStack { NativeLifeRoot(api: model.api, token: session.accessToken, userID: session.user.id) }
                        .tabItem { Label("书影音", systemImage: "books.vertical") }.tag(NativeTab.life)
                    NativeSettingsView(model: model)
                        .tabItem { Label("我的", systemImage: "person.crop.circle") }.tag(NativeTab.settings)
                }.id(session.user.id)
            } else { NativeLoginView(model: model) }
        }
        .tint(.indigo).environmentObject(model)
        .environment(\.timeZone, StepCalendar.calendar.timeZone)
        .environment(\.calendar, StepCalendar.calendar).privacySensitive()
        .onChange(of: model.session?.user.id) { _, _ in
            tab = .today; healthMetric = "steps"; healthRoute = UUID()
        }
        .task { await model.restore() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && !model.restoring { Task { await model.becameActive() } }
        }
        .sheet(item: $model.pendingChannelConsent) { _ in NativeDailyChannelConsent(model: model) }
    }
}

private struct NativeBrand: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "heart.text.clipboard.fill").font(.system(size: 36))
                .foregroundStyle(.white).frame(width: 76, height: 76)
                .background(.indigo.gradient, in: RoundedRectangle(cornerRadius: 22))
            Text("Jiashu OS").font(.largeTitle.bold())
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
                VStack(spacing: 32) {
                    NativeBrand().padding(.top, 40)
                    VStack(alignment: .leading, spacing: 20) {
                        Text("登录").font(.title2.bold())
                        TextField("邮箱", text: $email).textContentType(.username).keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.next)
                            .onSubmit { passwordFocused = true }
                            .padding().background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                        SecureField("密码", text: $password).textContentType(.password).focused($passwordFocused).submitLabel(.go)
                            .onSubmit { login() }
                            .padding().background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                        if let error = model.errorMessage { NativeInlineNotice(error, tone: .error) }
                        if let error = model.sessionError { NativeInlineNotice(error, tone: .error) }
                        Button(action: login) {
                            HStack {
                                if model.signingIn { ProgressView().tint(.white) }
                                Text(model.signingIn ? "正在登录…" : "登录").fontWeight(.semibold)
                            }.frame(maxWidth: .infinity, minHeight: 32)
                        }.buttonStyle(.borderedProminent).controlSize(.large)
                            .disabled(model.signingIn || email.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                        Text("使用 treefund.asia 的账号").font(.footnote).foregroundStyle(.secondary)
                    }.padding(24).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
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
    static func title(_ key: String) -> String {
        ["steps":"步数", "active_energy":"活动能量", "sleep":"睡眠", "weight":"体重", "lean_body_mass":"去脂体重", "body_fat":"估算体脂率"][key] ?? key
    }
    static func unit(_ key: String) -> String {
        ["steps":"步", "active_energy":"千卡", "sleep":"小时", "weight":"kg", "lean_body_mass":"kg", "body_fat":"%"][key] ?? ""
    }
    static func icon(_ key: String) -> String {
        ["steps":"figure.walk", "active_energy":"flame.fill", "sleep":"moon.fill", "weight":"scalemass.fill", "lean_body_mass":"figure.strengthtraining.traditional", "body_fat":"chart.pie.fill"][key] ?? "heart"
    }
    static func value(_ value: Double?, key: String) -> String {
        guard let value else { return "—" }
        if key == "steps" { return value.formatted(.number.precision(.fractionLength(0))) }
        return value.formatted(.number.precision(.fractionLength(0...1)))
    }
    static func date(_ day: String?) -> String {
        guard let day, let date = NativeChartDates.parse(day) else { return "暂无记录" }
        if day == StepCalendar.dayString(for: Date()) { return "今天" }
        return NativeActionDates.formatted(date, pattern: "M月d日")
    }
}

private struct NativeTodayView: View {
    @ObservedObject var model: NativeAppModel
    let showHealth: (String) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var quickWeight = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text(Date(), style: .date).font(.subheadline).foregroundStyle(.secondary)
                    if let error = model.sessionError { NativeInlineNotice(error, tone: .attention) }
                    if let session = model.session {
                        if typeSize.isAccessibilitySize { VStack(spacing: 12) { recordActions(session) } }
                        else { HStack(spacing: 12) { recordActions(session) } }
                        NativeHomeWeeklyAction(model: model)
                    }
                    healthOverview
                    NativeHomeWorkspaceCards(model: model)
                }.padding(20)
            }.background(Color(.systemGroupedBackground)).navigationTitle("今天")
                .toolbar { ToolbarItem(placement: .topBarTrailing) { NativeHomeInboxButton(model: model) } }
                .refreshable { await model.reload() }
                .sheet(isPresented: $quickWeight) {
                    if let session = model.session {
                        HealthQuickEntryView(api: model.api, token: session.accessToken, userID: session.user.id,
                                             initialMetric: .weight) { await model.reload() }
                    }
                }
        }
    }
    @ViewBuilder private func recordActions(_ session: NativeSession) -> some View {
        NavigationLink { NativeNutritionRoot(api: model.api, token: session.accessToken, userID: session.user.id, initialCompose: true) } label: {
            Label("记一餐", systemImage: "fork.knife").frame(maxWidth: .infinity, minHeight: 36)
        }.buttonStyle(.borderedProminent).controlSize(.large)
        Button { quickWeight = true } label: {
            Label("记体重", systemImage: "plus").frame(maxWidth: .infinity, minHeight: 36)
        }.buttonStyle(.bordered).controlSize(.large)
    }
    private var healthOverview: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("健康近况").font(.headline); Spacer()
                Button("全部") { showHealth("steps") }.frame(minWidth: 44, minHeight: 44)
            }
            if let overview = model.overview {
                VStack(spacing: 0) {
                    ForEach(["steps", "sleep", "weight"], id: \.self) { key in
                        let metric = overview.health.metrics.first { $0.metric == key }
                        Button { showHealth(key) } label: {
                            HStack(spacing: 14) {
                                Image(systemName: MetricDisplay.icon(key)).foregroundStyle(.indigo).frame(width: 24)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(MetricDisplay.title(key)).font(.subheadline)
                                    Text(MetricDisplay.date(metric?.day)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 8)
                                ViewThatFits(in: .horizontal) {
                                    HStack(alignment: .firstTextBaseline, spacing: 4) { metricValue(metric, key: key) }
                                    VStack(alignment: .trailing, spacing: 2) { metricValue(metric, key: key) }
                                }
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                            }.padding(.vertical, 16).padding(.horizontal, 16).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityElement(children: .combine)
                        if key != "weight" { Divider().padding(.leading, 54) }
                    }
                }.background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                if model.overviewLoading { ProgressView().accessibilityLabel("正在更新近况") }
                if let error = model.overviewError { NativeInlineNotice(error, tone: .error) }
            } else if model.overviewLoading { ProgressView("读取近况…").frame(maxWidth: .infinity).padding() }
            else {
                NativeInlineNotice(model.overviewError ?? "暂无近况", tone: .neutral)
                Button("重试") { Task { await model.reload() } }
            }
        }
    }
    @ViewBuilder private func metricValue(_ metric: NativeHomeMetric?, key: String) -> some View {
        Text(MetricDisplay.value(metric?.value, key: key)).font(.title3.weight(.semibold)).monospacedDigit()
        if metric?.value != nil { Text(MetricDisplay.unit(key)).font(.caption).foregroundStyle(.secondary) }
    }
}

private struct NativeHomeWeeklyAction: View {
    @ObservedObject var model: NativeAppModel
    @State private var action: NativeWeeklyActionEntry?
    private var week: String { NativeActionDates.day(NativeActionDates.monday(Date())) }
    var body: some View {
        if let session = model.session {
            NavigationLink { HealthWeeklyReviewView(api: model.api, token: session.accessToken, userID: session.user.id) } label: {
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: "calendar").font(.title3).foregroundStyle(.indigo)
                    VStack(alignment: .leading, spacing: 7) {
                        Text("本周行动").font(.subheadline).foregroundStyle(.secondary)
                        Text(action?.weekStart == week ? action?.text ?? "回顾这一周，选一件小事" : "回顾这一周，选一件小事").font(.headline)
                        if let action, action.weekStart == week { Text(action.status.title).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
            }.buttonStyle(.plain)
                .task(id: week + (model.overview?.asOf ?? "")) {
                    let owner = session.user.id
                    do {
                        let value = try await model.api.weeklyAction(token: session.accessToken, week: week)
                        guard !Task.isCancelled, model.session?.user.id == owner else { return }
                        action = value
                    } catch { /* Keep the last visible action; the review page provides retry. */ }
                }
        }
    }
}

private struct NativeHealthView: View {
    @ObservedObject var model: NativeAppModel
    let initialMetric: String
    var body: some View {
        NavigationStack {
            if let session = model.session {
                NativeHealthRangeWorkspace(api: model.api, token: session.accessToken, userID: session.user.id, initialMetric: initialMetric)
                    .navigationTitle("健康")
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Menu {
                                NavigationLink("饮食") { NativeNutritionRoot(api: model.api, token: session.accessToken, userID: session.user.id) }
                                NavigationLink("每周复盘") { HealthWeeklyReviewView(api: model.api, token: session.accessToken, userID: session.user.id) }
                                NavigationLink("记录管理") { NativeHealthRecordsWorkspace(api: model.api, token: session.accessToken, userID: session.user.id) }
                                NavigationLink("健康目标") { NativeHealthGoalsWorkspace(api: model.api, token: session.accessToken, userID: session.user.id) }
                                NavigationLink("体重计划") { NativeWeightPlanWorkspace(api: model.api, token: session.accessToken, userID: session.user.id) }
                            } label: { Label("日常", systemImage: "square.grid.2x2") }
                        }
                    }
            }
        }
    }
}

struct NativeSettingsView: View {
    @ObservedObject var model: NativeAppModel
    @State private var signingOut = false
    @State private var signOutError: String?
    var body: some View {
        NavigationStack {
            List {
                if let session = model.session {
                    Section { Label(session.user.email, systemImage: "person.crop.circle").textSelection(.enabled) }
                    Section {
                        NavigationLink { NativeSyncCenter(model: model) } label: { Label("同步中心", systemImage: "arrow.triangle.2.circlepath") }
                        NavigationLink { NativeFinanceRoot(api: model.api, token: session.accessToken, userID: session.user.id, initialPath: "/finance?ledger=family", embedded: true) } label: { Label("家庭与账本", systemImage: "person.2") }
                        NavigationLink { NativeNotificationsView(api: model.api, token: session.accessToken, userID: session.user.id) } label: { Label("消息与提醒", systemImage: "bell") }
                    }
                    Section {
                        NavigationLink { NativeBackupView(api: model.api, token: session.accessToken, userID: session.user.id) } label: { Label("备份与恢复", systemImage: "externaldrive") }
                        NavigationLink { NativeSettingsWorkspaceRoot(api: model.api, token: session.accessToken, userID: session.user.id) } label: { Label("账号与服务", systemImage: "gearshape") }
                    }
                }
                if let signOutError { NativeInlineNotice(signOutError, tone: .error) }
                Section { Button("退出登录", role: .destructive) { signingOut = true } }
            }.navigationTitle("我的")
                .confirmationDialog("退出此账号？", isPresented: $signingOut, titleVisibility: .visible) {
                    Button("退出登录", role: .destructive) {
                        Task {
                            model.errorMessage = nil; await model.signOut()
                            if model.session != nil { signOutError = model.errorMessage }
                        }
                    }
                }
        }
    }
}

struct NativeSyncCenter: View {
    @ObservedObject var model: NativeAppModel
    @State private var syncDays = 30
    @State private var releasingChannel = false
    var body: some View {
        List {
            Section("苹果健康") {
                HStack {
                    Label(model.autoSyncEnabled ? "自动同步已开启" : "自动同步未开启", systemImage: "heart"); Spacer()
                    if model.syncing || model.configuringChannel || model.authorizingHealth { ProgressView() }
                }
                if let channel = model.channel, channel.hasActiveChannel {
                    LabeledContent("日常设备", value: channel.label ?? "iPhone")
                    if !channel.isCurrentDevice { Text("当前来源是另一台设备").font(.footnote).foregroundStyle(.secondary) }
                }
                if model.autoSyncEnabled || model.channel?.isCurrentDevice == true {
                    Toggle("自动同步", isOn: Binding(get: { model.autoSyncEnabled }, set: { value in Task { await model.setAutomaticSync(value) } }))
                        .disabled(model.authorizingHealth || model.configuringChannel || model.syncing)
                    Picker("补充范围", selection: $syncDays) { Text("7天").tag(7); Text("30天").tag(30); Text("90天").tag(90) }
                    Button(model.syncing ? "正在同步…" : "立即同步") { Task { await model.sync(days: syncDays) } }
                        .disabled(!model.autoSyncEnabled || model.syncing || model.configuringChannel)
                } else {
                    Button(model.authorizingHealth ? "等待授权…" : "连接这台 iPhone") { Task { await model.connectHealth() } }
                        .disabled(model.syncing || model.authorizingHealth || model.configuringChannel)
                }
                Text(model.syncMessage).font(.footnote).foregroundStyle(.secondary)
                if let note = model.observerMessage { NativeInlineNotice(note, tone: .attention) }
                if let error = model.errorMessage { NativeInlineNotice(error, tone: .error) }
            }
            if let session = model.session {
                Section {
                    NavigationLink("健康历史与诊断") { NativeHealthSyncWorkspace(api: model.api, token: session.accessToken, userID: session.user.id) }
                    NavigationLink("书影音同步") { NativeLifeSyncCenter(api: model.api, token: session.accessToken, userID: session.user.id) }
                    NavigationLink("其他接入方式") { NativeSyncConnectionsView(api: model.api, token: session.accessToken, userID: session.user.id) }
                }
            }
            Section {
                DisclosureGroup("同步说明") {
                    Text("仅读取授权数据；后台时机由 iOS 决定。暂停不会解除日常设备。")
                    Text("人工更正继续保留；苹果健康中删除的记录需要另行核对。")
                }.font(.footnote).foregroundStyle(.secondary)
                if model.channel?.isCurrentDevice == true {
                    Button("解除日常设备", role: .destructive) { releasingChannel = true }
                        .disabled(model.syncing || model.configuringChannel || model.authorizingHealth)
                }
            }
        }.navigationTitle("同步中心").navigationBarTitleDisplayMode(.inline)
            .task { model.errorMessage = nil; await model.refreshChannelStatus() }
            .refreshable { await model.refreshChannelStatus() }
            .confirmationDialog("解除这台日常设备？", isPresented: $releasingChannel, titleVisibility: .visible) {
                Button("解除设备", role: .destructive) { Task { await model.releaseDailyChannel() } }
            } message: { Text("此设备将停止上传，已有记录保留。") }
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
                    Section("日常设备") {
                        TextField("设备名称", text: $label)
                        if let current = pending.currentLabel { LabeledContent("将替换", value: current) }
                    }
                    Section {
                        Text("读取授权的步数、能量、睡眠及体重记录，之后自动尝试同步。")
                        Text("旧设备和快捷指令将停止向此日常通道写入；已有记录与人工更正保留。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if let error = model.errorMessage { NativeInlineNotice(error, tone: .error) }
                }
            }.disabled(model.configuringChannel).navigationTitle("确认日常设备").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { model.cancelDailyChannelConsent() }.disabled(model.configuringChannel) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(model.configuringChannel ? "确认中…" : "确认") { Task { await model.confirmDailyChannel(label: trimmedLabel) } }
                            .disabled(trimmedLabel.isEmpty || trimmedLabel.utf16.count > 40 || model.configuringChannel)
                    }
                }.interactiveDismissDisabled(model.configuringChannel)
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
