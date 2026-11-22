import SwiftUI

enum NativeTab: Hashable { case today, health, finance, life, applications }

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
                    NativeApplicationDirectory(model: model, session: session)
                        .tabItem { Label("应用", systemImage: "square.grid.2x2") }.tag(NativeTab.applications)
                }.id(session.user.id)
            } else { NativeLoginView(model: model) }
        }
        .nativeGeometricPage().environmentObject(model)
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
                .foregroundStyle(NativePalette.onAccent).frame(width: 76, height: 76)
                .background(NativePalette.accent.gradient, in: UnevenRoundedRectangle(topLeadingRadius: 24, bottomLeadingRadius: 24, bottomTrailingRadius: 10, topTrailingRadius: 24))
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
                            .padding().background(NativePalette.canvas, in: RoundedRectangle(cornerRadius: 12))
                        SecureField("密码", text: $password).textContentType(.password).focused($passwordFocused).submitLabel(.go)
                            .onSubmit { login() }
                            .padding().background(NativePalette.canvas, in: RoundedRectangle(cornerRadius: 12))
                        if let error = model.errorMessage ?? model.sessionError { NativeInlineNotice(error, tone: .error) }
                        Button(action: login) {
                            HStack {
                                if model.signingIn { ProgressView().tint(.white) }
                                Text(model.signingIn ? "正在登录…" : "登录").fontWeight(.semibold)
                            }.frame(maxWidth: .infinity, minHeight: 32)
                        }.buttonStyle(.borderedProminent).controlSize(.large)
                            .disabled(model.signingIn || email.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                        Text("使用 treefund.asia 的账号").font(.footnote).foregroundStyle(.secondary)
                    }.padding(24).background(NativePalette.surface, in: RoundedRectangle(cornerRadius: 20))
                }.padding(24).frame(maxWidth: 520).frame(maxWidth: .infinity)
            }.background(NativePalette.canvas).scrollDismissesKeyboard(.interactively)
        }
    }
    private func login() {
        guard !email.isEmpty, !password.isEmpty, !model.signingIn else { return }
        passwordFocused = false
        Task { await model.login(email: email, password: password); if model.session != nil { password = "" } }
    }
}

private struct NativeTodayView: View {
    @ObservedObject var model: NativeAppModel
    let showHealth: (String) -> Void
    @State private var hasShownHome = false
    private var dateLabel: String {
        let now = Date()
        let weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
        let weekday = NativeActionDates.calendar.component(.weekday, from: now)
        return NativeActionDates.formatted(now, pattern: "M月d日") + " · " + weekdays[weekday - 1]
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(dateLabel)
                        .font(.subheadline).foregroundStyle(NativePalette.muted)
                    if let error = model.sessionError, error != model.overviewError {
                        NativeInlineNotice(error, tone: .attention)
                    }
                    NativeHomeFollowThrough(model: model)
                    NativeHomeHealthCards(model: model, showHealth: showHealth)
                    NativeHomeWorkspaceCards(model: model)
                }.padding(.horizontal, 22).padding(.top, 8).padding(.bottom, 24)
                    .frame(maxWidth: 680).frame(maxWidth: .infinity)
            }.nativeGeometricPage().navigationTitle("今天")
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        if let session = model.session {
                            NavigationLink {
                                NativeNutritionRoot(api: model.api, token: session.accessToken, userID: session.user.id,
                                                    initialCompose: true, quickSuggestions: true) {
                                    await model.reloadOverview(presentError: false)
                                }
                            } label: {
                                Text("记一餐").frame(minHeight: 44)
                            }.accessibilityIdentifier("today-record-meal")
                        }
                        NativeHomeInboxButton(model: model)
                    }
                }
                .refreshable { await model.reload() }
                .task {
                    if hasShownHome { await model.reload(presentError: false) }
                    else { hasShownHome = true }
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
        List {
            if let session = model.session {
                Section {
                    HStack(spacing: 14) {
                        Image(systemName: "person.crop.circle.fill").font(.system(size: 36))
                            .foregroundStyle(NativePalette.accent)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Jiashu OS").font(.headline)
                            Text(session.user.email).font(.subheadline).foregroundStyle(NativePalette.muted)
                                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                    }.padding(.vertical, 8)
                }.listRowBackground(NativePalette.surface)
            }
            if let signOutError { NativeInlineNotice(signOutError, tone: .error) }
            Section { Button("退出登录", role: .destructive) { signingOut = true } }
        }
        .nativeGeometricPage().navigationTitle("我的").navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("退出此账号？", isPresented: $signingOut, titleVisibility: .visible) {
            Button("退出登录", role: .destructive) {
                Task {
                    model.errorMessage = nil
                    await model.signOut()
                    if model.session != nil { signOutError = model.errorMessage }
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
                    if !model.appleActivityPermissionRequested {
                        Button(model.authorizingHealth ? "等待授权…" : "更新健康数据授权") { Task { await model.connectHealth() } }
                            .disabled(model.syncing || model.authorizingHealth || model.configuringChannel)
                    }
                    Picker("补充范围", selection: $syncDays) { Text("7天").tag(7); Text("30天").tag(30); Text("90天").tag(90) }
                    Button(model.syncing ? "正在同步…" : "立即同步") { Task { await model.sync(days: syncDays) } }
                        .disabled(!model.autoSyncEnabled || model.syncing || model.configuringChannel || model.authorizingHealth)
                } else {
                    Button(model.authorizingHealth ? "等待授权…" : "连接这台 iPhone") { Task { await model.connectHealth() } }
                        .disabled(model.syncing || model.authorizingHealth || model.configuringChannel)
                }
                if !model.appleActivityPermissionRequested {
                    Text("将获准的每日心率与血氧汇总、静息心率及训练记录上传到你的 Jiashu OS 账号。可在苹果健康授权页选择允许读取的项目。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Text(model.syncMessage).font(.footnote).foregroundStyle(.secondary)
                if let activity = model.appleActivitySyncMessage { Text(activity).font(.footnote).foregroundStyle(.secondary) }
                if let note = model.observerMessage { NativeInlineNotice(note, tone: .attention) }
                if let error = model.errorMessage, !model.syncMessage.contains(error) { NativeInlineNotice(error, tone: .error) }
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
        }.nativeGeometricPage().navigationTitle("同步中心").navigationBarTitleDisplayMode(.inline)
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
                        Text("将你授权的步数、活动能量、睡眠、体重、心率、血氧和训练同步到你的 Jiashu OS 账号。")
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
