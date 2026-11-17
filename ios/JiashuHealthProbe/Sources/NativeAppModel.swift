import Combine
import Foundation

/// One authenticated account owns every in-flight operation and its displayed result.
@MainActor
final class NativeAppModel: ObservableObject {
    @Published private(set) var session: NativeSession?
    @Published private(set) var overview: NativeOverview?
    @Published private(set) var health: NativeHealthResponse?
    @Published private(set) var restoring = true
    @Published private(set) var signingIn = false
    @Published private(set) var overviewLoading = false
    @Published private(set) var healthLoading = false
    @Published private(set) var healthDays = 30
    @Published private(set) var loadedHealthDays: Int?
    @Published private(set) var overviewError: String?
    @Published private(set) var healthError: String?
    @Published private(set) var sessionError: String?
    @Published private(set) var overviewUpdatedAt: Date?
    @Published private(set) var healthUpdatedAt: Date?
    @Published var errorMessage: String?

    let api: NativeAPI
    private let sessions: NativeSessionStore
    private let healthSync: NativeHealthSync
    private var healthSyncChanges: AnyCancellable?
    private var generation = UUID()
    private var started = false
    private var activating = false
    private var validatingSession = false
    private var overviewRequestID = UUID()
    private var healthRequestID = UUID()
    private var overviewRequest: Task<NativeOverview, Error>?
    private var healthRequest: Task<NativeHealthResponse, Error>?
    private let foregroundFreshness: TimeInterval = 60
    var loading: Bool { overviewLoading || healthLoading }

    init(api: NativeAPI = NativeAPI(), sessions: NativeSessionStore = NativeSessionStore(),
         reader: (any NativeHealthReading)? = nil, healthDeviceService: String = "asia.treefund.jiashu.native-health-device",
         backgroundSyncBudget: Duration = .seconds(25)) {
        self.api = api
        self.sessions = sessions
        self.healthSync = NativeHealthSync(api: api, reader: reader ?? HealthKitReader(),
                                           healthDeviceService: healthDeviceService, backgroundBudget: backgroundSyncBudget)
        healthSyncChanges = healthSync.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
        healthSync.presentError = { [weak self] message in self?.errorMessage = message }
        healthSync.invalidateSession = { [weak self] in self?.expireSession() }
        healthSync.didFinishForegroundSync = { [weak self] receipt, automatic in
            guard let self, !automatic || receipt.imported > 0 || self.overview == nil || self.health == nil else { return }
            await self.reload(presentError: !automatic)
        }
        self.api.workspaceAuthenticationFailure = { [weak self] token in
            guard let self, self.session?.accessToken == token else { return }
            self.expireSession()
            self.errorMessage = "登录已失效，请重新登录。"
        }
    }

    private func isCurrent(_ owner: String, _ epoch: UUID) -> Bool { generation == epoch && session?.user.id == owner }

    func restore() async {
        guard !started else { return }
        started = true
        let epoch = generation
        defer { if generation == epoch { restoring = false; validatingSession = false } }
        do {
            guard let stored = try sessions.load() else { return }
            guard !stored.isExpired else {
                throw NativeAPIError.server(status: 401, code: "NATIVE_SIGN_IN_REQUIRED",
                    message: "登录已失效，请重新登录。", retryAfter: nil)
            }
            session = stored
            api.beginSession(stored)
            // The saved, unexpired account can render immediately. Validation,
            // network reads and HealthKit work must not hold the launch screen.
            restoring = false
            validatingSession = true
            try healthSync.restorePreference(for: stored)
            async let initialReads: Void = reloadIfNeeded()
            // Register restored HealthKit observers before waiting for network
            // calls, including when iOS cold-launches us for a health update.
            await healthSync.restoreObservers()
            guard isCurrent(stored.user.id, epoch) else { return }
            let valid = try await api.refresh(token: stored.accessToken)
            try Task.checkCancellation()
            guard isCurrent(stored.user.id, epoch), session?.accessToken == stored.accessToken else { return }
            guard valid.user.id == stored.user.id else { throw NativeAPIError.invalidResponse }
            try sessions.save(valid)
            guard api.renewSession(valid, replacing: stored.accessToken) else { return }
            session = valid
            try healthSync.restorePreference(for: valid)
            validatingSession = false
            await initialReads
            guard isCurrent(valid.user.id, epoch) else { return }
            await becameActive()
        } catch is CancellationError {
            // Account changes and view cancellation cannot publish old failures.
        } catch {
            guard generation == epoch else { return }
            // A temporarily unreachable server must not destroy the saved login.
            if (error as? NativeAPIError)?.isAuthenticationFailure == true { expireSession() }
            sessionError = error.localizedDescription
            if (error as? NativeAPIError)?.isAuthenticationFailure == true { errorMessage = error.localizedDescription }
            else if session != nil { validatingSession = false; await reloadIfNeeded() }
        }
    }

    func login(email: String, password: String) async {
        guard !signingIn else { return }
        signingIn = true
        errorMessage = nil
        let epoch = generation
        var operationEpoch = epoch
        defer { signingIn = false }
        do {
            let loggedIn = try await api.login(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            try Task.checkCancellation()
            guard generation == epoch else { return }
            try sessions.save(loggedIn)
            clearDisplayedAccount()
            operationEpoch = generation
            session = loggedIn
            api.beginSession(loggedIn)
            try healthSync.restorePreference(for: loggedIn)
            await becameActive()
        } catch is CancellationError { }
        catch { if generation == operationEpoch { errorMessage = error.localizedDescription } }
    }

    func becameActive() async {
        guard !activating, !validatingSession else { return }
        guard let current = session else {
            // Keychain may have been unavailable before the first device unlock.
            // A later foreground activation can restore it without a new login.
            if started { started = false; await restore() }
            return
        }
        activating = true
        let epoch = generation
        defer { if generation == epoch { activating = false } }
        do {
            if let expiry = current.expiryDate, expiry.timeIntervalSinceNow < 3 * 86400 {
                let refreshed = try await api.refresh(token: current.accessToken)
                try Task.checkCancellation()
                guard isCurrent(current.user.id, epoch), session?.accessToken == current.accessToken else { return }
                guard refreshed.user.id == current.user.id else { throw NativeAPIError.invalidResponse }
                try sessions.save(refreshed)
                guard api.renewSession(refreshed, replacing: current.accessToken) else { return }
                session = refreshed
                healthSync.renewSession(refreshed)
            }
            sessionError = nil
            await healthSync.prepareForForeground()
            guard isCurrent(current.user.id, epoch) else { return }
            await reloadIfNeeded()
            guard isCurrent(current.user.id, epoch) else { return }
            await healthSync.syncOnForeground()
        } catch is CancellationError { }
        catch {
            guard isCurrent(current.user.id, epoch) else { return }
            sessionError = error.localizedDescription
            handle(error, owner: current.user.id, epoch: epoch, token: current.accessToken, presentError: false)
        }
    }

    func reload(days: Int? = nil, presentError: Bool = true) async {
        async let home: Void = loadOverview(force: true, presentError: presentError)
        await reloadHealth(days: days, presentError: presentError)
        await home
    }

    func reloadOverview(presentError: Bool = true) async {
        await loadOverview(force: true, presentError: presentError)
    }

    /// A range change reads only health, keeping unrelated overview work intact.
    func reloadHealth(days: Int? = nil, presentError: Bool = true) async {
        await loadHealth(days: days ?? healthDays, force: true, presentError: presentError)
    }

    private func reloadIfNeeded() async {
        async let home: Void = loadOverview(force: false, presentError: false)
        await loadHealth(days: healthDays, force: false, presentError: false)
        await home
    }

    private func loadOverview(force: Bool, presentError: Bool) async {
        guard let current = session else { return }
        if !force {
            if let active = overviewRequest { _ = try? await active.value; return }
            if overview != nil, let updated = overviewUpdatedAt, Date().timeIntervalSince(updated) < foregroundFreshness { return }
        }
        let epoch = generation
        let requestID = UUID()
        overviewRequestID = requestID
        overviewRequest?.cancel()
        overviewLoading = true
        overviewError = nil
        let request = Task { try await api.overview(token: current.accessToken) }
        overviewRequest = request
        defer {
            if generation == epoch && overviewRequestID == requestID { overviewLoading = false; overviewRequest = nil }
        }
        do {
            let value = try await withTaskCancellationHandler(operation: { try await request.value }, onCancel: { request.cancel() })
            try Task.checkCancellation()
            guard isCurrent(current.user.id, epoch), overviewRequestID == requestID else { return }
            overview = value
            overviewUpdatedAt = Date()
        } catch is CancellationError { }
        catch {
            guard isCurrent(current.user.id, epoch), overviewRequestID == requestID else { return }
            overviewError = error.localizedDescription
            handleReadFailure(error, current: current, epoch: epoch, presentError: presentError)
        }
    }

    private func loadHealth(days: Int, force: Bool, presentError: Bool) async {
        guard let current = session else { return }
        guard (1...360).contains(days) else { healthError = NativeAPIError.invalidRequest.localizedDescription; return }
        if !force {
            if let active = healthRequest { _ = try? await active.value; return }
            if health != nil, loadedHealthDays == days, let updated = healthUpdatedAt,
               Date().timeIntervalSince(updated) < foregroundFreshness { return }
        }
        healthDays = days
        let epoch = generation, requestID = UUID()
        healthRequestID = requestID
        healthRequest?.cancel()
        healthLoading = true
        healthError = nil
        let request = Task { try await api.health(token: current.accessToken, days: days) }
        healthRequest = request
        defer {
            if generation == epoch && healthRequestID == requestID { healthLoading = false; healthRequest = nil }
        }
        do {
            let value = try await withTaskCancellationHandler(operation: { try await request.value }, onCancel: { request.cancel() })
            try Task.checkCancellation()
            guard isCurrent(current.user.id, epoch), healthRequestID == requestID else { return }
            health = value
            loadedHealthDays = days
            healthUpdatedAt = Date()
        } catch is CancellationError { }
        catch {
            guard isCurrent(current.user.id, epoch), healthRequestID == requestID else { return }
            healthError = error.localizedDescription
            handleReadFailure(error, current: current, epoch: epoch, presentError: presentError)
        }
    }

    private func handleReadFailure(_ error: Error, current: NativeSession, epoch: UUID, presentError: Bool) {
        // Read failures have inline recovery. Authentication still clears the
        // account and may ask for a new login; writes keep their own semantics.
        handle(error, owner: current.user.id, epoch: epoch, token: current.accessToken,
               presentError: presentError && (error as? NativeAPIError)?.isAuthenticationFailure == true)
    }

    var authorizingHealth: Bool { healthSync.authorizingHealth }
    var syncing: Bool { healthSync.syncing }
    var autoSyncEnabled: Bool { healthSync.autoSyncEnabled }
    var syncMessage: String { healthSync.syncMessage }
    var observerMessage: String? { healthSync.observerMessage }
    var lastReceipt: NativeSyncReceipt? { healthSync.lastReceipt }
    var channel: NativeHealthChannel? { healthSync.channel }
    var configuringChannel: Bool { healthSync.configuringChannel }

    var pendingChannelConsent: PendingNativeHealthChannelConsent? {
        get { healthSync.pendingChannelConsent }
        set { healthSync.pendingChannelConsent = newValue }
    }

    func connectHealth() async { await healthSync.connectHealth() }
    func cancelDailyChannelConsent() { healthSync.cancelDailyChannelConsent() }
    func confirmDailyChannel(label: String) async { await healthSync.confirmDailyChannel(label: label) }
    func refreshChannelStatus() async { await healthSync.refreshChannelStatus() }
    func releaseDailyChannel() async { await healthSync.releaseDailyChannel() }
    func setAutomaticSync(_ enabled: Bool) async { await healthSync.setAutomaticSync(enabled) }

    func sync(background: Bool = false, days: Int = 30, automatic: Bool = false) async {
        if background { await healthSync.syncFromObserver() }
        else { await healthSync.sync(days: days, automatic: automatic) }
    }

    func signOut() async {
        guard let current = session else { return }
        let epoch = generation
        do { try await api.logout(token: current.accessToken) }
        catch {
            guard isCurrent(current.user.id, epoch) else { return }
            if (error as? NativeAPIError)?.isAuthenticationFailure != true { errorMessage = error.localizedDescription; return }
        }
        guard isCurrent(current.user.id, epoch) else { return }
        clearDisplayedAccount()
        do { try sessions.clear() } catch { errorMessage = error.localizedDescription }
    }

    private func clearDisplayedAccount() {
        generation = UUID()
        api.endSession()
        overviewRequestID = UUID()
        healthRequestID = UUID()
        overviewRequest?.cancel()
        healthRequest?.cancel()
        overviewRequest = nil
        healthRequest = nil
        healthSync.endSession()
        session = nil
        overview = nil
        health = nil
        healthDays = 30
        loadedHealthDays = nil
        overviewUpdatedAt = nil
        healthUpdatedAt = nil
        overviewError = nil
        healthError = nil
        sessionError = nil
        overviewLoading = false
        healthLoading = false
        activating = false
        validatingSession = false
        restoring = false
    }

    private func expireSession() {
        clearDisplayedAccount()
        try? sessions.clear()
    }

    private func handle(_ error: Error, owner: String, epoch: UUID, token: String, presentError: Bool = true) {
        guard isCurrent(owner, epoch) else { return }
        if let failure = error as? NativeAPIError, failure.isAuthenticationFailure {
            guard session?.accessToken == token else { return }
            expireSession()
        }
        if presentError { errorMessage = error.localizedDescription }
    }
}
