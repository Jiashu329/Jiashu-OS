import Foundation
import SwiftUI
import UIKit

struct PendingNativeHealthChannelConsent: Identifiable {
    let id = UUID()
    let ownerID: String
    let expectedRevision: Int
    let currentLabel: String?
    var candidate: NativeHealthDeviceCredential?
}

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
    @Published private(set) var authorizingHealth = false
    @Published private(set) var syncing = false
    @Published private(set) var autoSyncEnabled = false
    @Published private(set) var syncMessage = "连接苹果健康后，可在打开 App 或健康数据变化时同步。"
    @Published private(set) var observerMessage: String?
    @Published private(set) var lastReceipt: NativeSyncReceipt?
    @Published var pendingChannelConsent: PendingNativeHealthChannelConsent?
    @Published private(set) var channel: NativeHealthChannel?
    @Published private(set) var configuringChannel = false
    @Published var errorMessage: String?

    let api: NativeAPI
    private let sessions: NativeSessionStore
    private let reader: any NativeHealthReading
    private let healthDeviceService: String
    private var generation = UUID()
    private var started = false
    private var activating = false
    private var validatingSession = false
    private var observationsStarted = false
    private var observationStartID: UUID?
    private var syncOperation: Task<Void, Never>?
    private var syncOperationID: UUID?
    private var syncIsBackground = false
    private var syncIsAutomatic = false
    private var syncDays = 0
    private var syncAgain = false
    private var overviewRequestID = UUID()
    private var healthRequestID = UUID()
    private var overviewRequest: Task<NativeOverview, Error>?
    private var healthRequest: Task<NativeHealthResponse, Error>?
    private let foregroundFreshness: TimeInterval = 60
    private var lastChannelCheckAt: Date?
    private var lastAutomaticAttempt: Date?
    private var channelRequestID = UUID()

    var loading: Bool { overviewLoading || healthLoading }

    init(api: NativeAPI = NativeAPI(), sessions: NativeSessionStore = NativeSessionStore(), reader: (any NativeHealthReading)? = nil, healthDeviceService: String = "asia.treefund.jiashu.native-health-device") {
        self.api = api
        self.sessions = sessions
        self.reader = reader ?? HealthKitReader()
        self.healthDeviceService = healthDeviceService
        self.api.workspaceAuthenticationFailure = { [weak self] token in
            guard let self, self.session?.accessToken == token else { return }
            self.clearDisplayedAccount()
            try? self.sessions.clear()
            self.errorMessage = "登录已失效，请重新登录。"
        }
    }

    private func syncKey(_ userID: String) -> String { "jiashu.native.health-auto-sync." + userID }
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
            try restoreSyncPreference(userID: stored.user.id)
            async let initialReads: Void = reloadIfNeeded()
            // Register restored HealthKit observers before waiting for network
            // calls, including when iOS cold-launches us for a health update.
            if autoSyncEnabled { await observeHealth() }
            let valid = try await api.refresh(token: stored.accessToken)
            try Task.checkCancellation()
            guard isCurrent(stored.user.id, epoch), session?.accessToken == stored.accessToken else { return }
            guard valid.user.id == stored.user.id else { throw NativeAPIError.invalidResponse }
            try sessions.save(valid)
            guard api.renewSession(valid, replacing: stored.accessToken) else { return }
            session = valid
            try restoreSyncPreference(userID: valid.user.id)
            validatingSession = false
            await initialReads
            await becameActive()
        } catch is CancellationError {
            // Account changes and view cancellation cannot publish old failures.
        } catch {
            guard generation == epoch else { return }
            // A temporarily unreachable server must not destroy the saved login.
            if let apiError = error as? NativeAPIError, apiError.isAuthenticationFailure { clearDisplayedAccount(); try? sessions.clear() }
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
            try restoreSyncPreference(userID: loggedIn.user.id)
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
            }
            sessionError = nil
            if autoSyncEnabled, lastChannelCheckAt.map({ Date().timeIntervalSince($0) >= foregroundFreshness }) ?? true {
                await refreshChannelStatus(presentError: false)
            }
            guard isCurrent(current.user.id, epoch) else { return }
            if autoSyncEnabled { await observeHealth() }
            await reloadIfNeeded()
            guard isCurrent(current.user.id, epoch), autoSyncEnabled else { return }
            await observeHealth()
            // Foreground visits are a fallback for background delivery, whose timing iOS controls.
            if pendingChannelConsent == nil, lastAutomaticAttempt.map({ Date().timeIntervalSince($0) > 60 }) ?? true {
                await sync(background: false, automatic: true)
            }
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

    private func deviceStore(_ owner: String) -> NativeHealthDeviceStore {
        NativeHealthDeviceStore(userID: owner, service: healthDeviceService)
    }

    private func restoreSyncPreference(userID: String) throws {
        let requested = UserDefaults.standard.bool(forKey: syncKey(userID))
        if requested {
            do { autoSyncEnabled = try deviceStore(userID).load() != nil }
            catch NativeHealthDeviceStoreError.invalidCredential { autoSyncEnabled = false }
        }
        else { autoSyncEnabled = false }
        if requested && !autoSyncEnabled {
            UserDefaults.standard.set(false, forKey: syncKey(userID))
            syncMessage = "请先确认日常同步来源，之后会自动同步。"
        }
    }

    func connectHealth() async {
        guard let current = session, !syncing, !authorizingHealth, !configuringChannel else { return }
        let epoch = generation
        channelRequestID = UUID()
        authorizingHealth = true
        defer { if generation == epoch { authorizingHealth = false } }
        do {
            // HealthKit permission and the server's daily-source selection are
            // distinct decisions. Only this explicit user action requests either.
            try await reader.authorize()
            guard isCurrent(current.user.id, epoch) else { return }
            let credential: NativeHealthDeviceCredential?
            do { credential = try deviceStore(current.user.id).load() }
            catch NativeHealthDeviceStoreError.invalidCredential {
                // Only an explicit reconnect discards a corrupted credential.
                // A locked/unavailable Keychain remains untouched for retry.
                try deviceStore(current.user.id).clear()
                credential = nil
            }
            let status = try await api.channel(token: current.accessToken, deviceToken: credential?.deviceToken)
            guard isCurrent(current.user.id, epoch) else { return }
            channel = status
            lastChannelCheckAt = Date()
            if status.isCurrentDevice, credential != nil {
                pendingChannelConsent = nil
                await activateDailySync(owner: current.user.id, epoch: epoch)
            } else {
                pauseAutomaticSync(owner: current.user.id)
                pendingChannelConsent = PendingNativeHealthChannelConsent(ownerID: current.user.id,
                    expectedRevision: status.revision, currentLabel: status.label, candidate: nil)
                syncMessage = "确认由这台 iPhone 的苹果健康负责日常同步后，即可自动更新。"
            }
        } catch { handle(error, owner: current.user.id, epoch: epoch, token: current.accessToken) }
    }

    func cancelDailyChannelConsent() { if !configuringChannel { pendingChannelConsent = nil } }

    func confirmDailyChannel(label: String) async {
        guard let current = session, var pending = pendingChannelConsent,
              pending.ownerID == current.user.id, !configuringChannel else { return }
        let epoch = generation
        channelRequestID = UUID()
        configuringChannel = true
        errorMessage = nil
        defer { if generation == epoch { configuringChannel = false } }
        do {
            // Reconcile a lost acknowledgement before attempting another write.
            // A candidate is saved before PUT and reused across uncertain retries.
            let saved = try deviceStore(current.user.id).load()
            let status = try await api.channel(token: current.accessToken, deviceToken: saved?.deviceToken)
            guard isCurrent(current.user.id, epoch), pendingChannelConsent?.id == pending.id else { return }
            channel = status
            if status.isCurrentDevice, saved != nil {
                pendingChannelConsent = nil
                await activateDailySync(owner: current.user.id, epoch: epoch)
                return
            }
            guard status.revision == pending.expectedRevision else {
                pendingChannelConsent = PendingNativeHealthChannelConsent(ownerID: current.user.id,
                    expectedRevision: status.revision, currentLabel: status.label, candidate: nil)
                errorMessage = "日常同步来源已变化，请查看最新来源后再次确认。"
                return
            }
            let credential = try pending.candidate ?? NativeHealthDeviceCredential.generate()
            try deviceStore(current.user.id).save(credential)
            pending.candidate = credential
            pendingChannelConsent = pending
            let selected: NativeHealthChannel
            do {
                selected = try await api.selectChannel(token: current.accessToken, deviceToken: credential.deviceToken,
                    label: label, expectedRevision: pending.expectedRevision)
            } catch {
                let originalError = error
                guard isCurrent(current.user.id, epoch) else { return }
                // Never invent a new device key just because the response was lost.
                if let reconciled = try? await api.channel(token: current.accessToken, deviceToken: credential.deviceToken),
                   reconciled.isCurrentDevice {
                    selected = reconciled
                } else { throw originalError }
            }
            guard isCurrent(current.user.id, epoch), pendingChannelConsent?.id == pending.id else { return }
            guard selected.isCurrentDevice else { throw NativeAPIError.invalidResponse }
            channel = selected
            pendingChannelConsent = nil
            await activateDailySync(owner: current.user.id, epoch: epoch)
        } catch { handle(error, owner: current.user.id, epoch: epoch, token: current.accessToken) }
    }

    private func activateDailySync(owner: String, epoch: UUID) async {
        guard isCurrent(owner, epoch) else { return }
        autoSyncEnabled = true
        UserDefaults.standard.set(true, forKey: syncKey(owner))
        await observeHealth()
        guard isCurrent(owner, epoch), autoSyncEnabled else { return }
        await sync(background: false)
    }

    func refreshChannelStatus(presentError: Bool = true) async {
        guard let current = session, !configuringChannel, !authorizingHealth else { return }
        let epoch = generation
        let requestID = UUID()
        channelRequestID = requestID
        do {
            let credential = try deviceStore(current.user.id).load()
            let status = try await api.channel(token: current.accessToken, deviceToken: credential?.deviceToken)
            guard isCurrent(current.user.id, epoch), channelRequestID == requestID else { return }
            channel = status
            lastChannelCheckAt = Date()
            if autoSyncEnabled && (!status.isCurrentDevice || credential == nil) {
                pauseAutomaticSync(owner: current.user.id)
                syncMessage = "日常同步来源已变化，自动同步已暂停。可在设置中确认由这台 iPhone 同步。"
            }
        } catch {
            guard channelRequestID == requestID else { return }
            if !presentError, isCurrent(current.user.id, epoch) { syncMessage = "自动核对同步来源未完成：" + error.localizedDescription }
            handle(error, owner: current.user.id, epoch: epoch, token: current.accessToken, presentError: presentError)
        }
    }

    func releaseDailyChannel() async {
        guard let current = session, !configuringChannel else { return }
        let epoch = generation
        channelRequestID = UUID()
        configuringChannel = true
        pauseAutomaticSync(owner: current.user.id)
        defer { if generation == epoch { configuringChannel = false } }
        do {
            guard let credential = try deviceStore(current.user.id).load() else { throw NativeAPIError.invalidRequest }
            let status = try await api.channel(token: current.accessToken, deviceToken: credential.deviceToken)
            guard isCurrent(current.user.id, epoch) else { return }
            let cleared: NativeHealthChannel
            if !status.hasActiveChannel { cleared = status }
            else {
                guard status.isCurrentDevice else {
                    channel = status
                    throw NativeAPIError.server(status: 409, code: "NATIVE_HEALTH_CHANNEL_NOT_CURRENT",
                        message: "日常来源已由其他设备接管，请刷新后核对。", retryAfter: nil)
                }
                do {
                    cleared = try await api.clearChannel(token: current.accessToken,
                        deviceToken: credential.deviceToken, expectedRevision: status.revision)
                } catch {
                    let originalError = error
                    guard isCurrent(current.user.id, epoch) else { return }
                    if let reconciled = try? await api.channel(token: current.accessToken, deviceToken: credential.deviceToken),
                       !reconciled.hasActiveChannel { cleared = reconciled }
                    else { throw originalError }
                }
            }
            guard isCurrent(current.user.id, epoch) else { return }
            guard !cleared.hasActiveChannel else { throw NativeAPIError.invalidResponse }
            try deviceStore(current.user.id).clear()
            channel = cleared
            pendingChannelConsent = nil
            syncMessage = "日常同步来源已解除，已有记录继续保留。"
        } catch { handle(error, owner: current.user.id, epoch: epoch, token: current.accessToken) }
    }

    func setAutomaticSync(_ enabled: Bool) async {
        guard let current = session else { return }
        if enabled { await connectHealth(); return }
        pauseAutomaticSync(owner: current.user.id)
        syncMessage = "自动同步已暂停，日常来源选择和已有记录继续保留。"
    }

    private func pauseAutomaticSync(owner: String) {
        autoSyncEnabled = false
        syncOperation?.cancel()
        observationStartID = nil
        UserDefaults.standard.set(false, forKey: syncKey(owner))
        reader.stopObserving()
        observationsStarted = false
        observerMessage = nil
    }

    private func observeHealth() async {
        guard autoSyncEnabled, !observationsStarted, observationStartID == nil, let current = session else { return }
        let epoch = generation, operationID = UUID()
        observationStartID = operationID
        do {
            try await reader.startObserving { [weak self] in
                guard let self else { return }
                await self.observedChange(owner: current.user.id, epoch: epoch)
            }
            guard isCurrent(current.user.id, epoch), autoSyncEnabled, observationStartID == operationID else { return }
            observationStartID = nil
            observationsStarted = true
            observerMessage = nil
        } catch {
            guard isCurrent(current.user.id, epoch), autoSyncEnabled, observationStartID == operationID else { return }
            observationStartID = nil
            // Queries stay registered even if this device cannot enable every
            // background type; do not repeatedly tear them down on foreground.
            observationsStarted = true
            observerMessage = "后台观察暂不可用；打开 App 仍会尝试同步。" + error.localizedDescription
        }
    }

    private func observedChange(owner: String, epoch: UUID) async {
        guard isCurrent(owner, epoch), autoSyncEnabled else { return }
        await sync(background: true, automatic: true)
    }

    func sync(background: Bool = false, days: Int = 30, automatic: Bool = false) async {
        guard let current = session, autoSyncEnabled, pendingChannelConsent == nil else { return }
        if let running = syncOperation {
            // Automatic and manual attempts keep their own presentation context.
            // A waiter with a different mode, range or budget gets its own turn;
            // a silent callback never schedules another visible manual retry.
            let automaticRequest = background || automatic
            if running.isCancelled || automaticRequest != syncIsAutomatic || (!background && (syncIsBackground || days > syncDays)) {
                let epoch = generation, operationID = syncOperationID
                await running.value
                guard isCurrent(current.user.id, epoch), autoSyncEnabled else { return }
                if syncOperationID == operationID { syncOperation = nil; syncOperationID = nil }
                await sync(background: background, days: days, automatic: automatic)
                return
            }
            syncAgain = true
            await running.value
            return
        }
        let operationID = UUID(), epoch = generation
        syncOperationID = operationID
        syncIsBackground = background
        syncIsAutomatic = background || automatic
        syncDays = background ? 7 : days
        syncAgain = false
        let operation = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.syncAgain = false
                await self.performSync(background: background, days: background ? 7 : days, automatic: automatic)
            } while self.syncAgain && !Task.isCancelled && self.generation == epoch && self.autoSyncEnabled && self.pendingChannelConsent == nil
        }
        syncOperation = operation
        let backgroundID = UIApplication.shared.beginBackgroundTask(withName: "Jiashu Health Sync") { operation.cancel() }
        let deadline = Task {
            do { try await Task.sleep(nanoseconds: background ? 25_000_000_000 : 120_000_000_000); operation.cancel() }
            catch { /* The operation finished before its deadline. */ }
        }
        await operation.value
        deadline.cancel()
        if backgroundID != .invalid { UIApplication.shared.endBackgroundTask(backgroundID) }
        if syncOperationID == operationID { syncOperation = nil; syncOperationID = nil; syncAgain = false }
    }

    private func performSync(background: Bool, days: Int, automatic: Bool) async {
        guard !Task.isCancelled, let current = session, autoSyncEnabled, pendingChannelConsent == nil else { return }
        let epoch = generation
        let presentError = !background && !automatic
        syncing = true
        lastAutomaticAttempt = Date()
        syncMessage = "正在读取苹果健康…"
        if presentError { errorMessage = nil }
        defer { if generation == epoch { syncing = false } }
        do {
            guard let credential = try deviceStore(current.user.id).load() else {
                pauseAutomaticSync(owner: current.user.id)
                syncMessage = "请先确认这台 iPhone 为日常同步来源。"
                return
            }
            let snapshot = try await reader.read(days: days)
            try Task.checkCancellation()
            guard isCurrent(current.user.id, epoch), autoSyncEnabled else { return }
            guard !snapshot.measurements.isEmpty else {
                syncMessage = "本次未取得可同步记录。请检查健康权限和记录范围；缺失数据不会记为零。"
                return
            }
            let payload = try snapshot.encodePayload()
            syncMessage = "正在核对服务器记录…"
            let preview = try await api.preview(token: current.accessToken, payload: payload, deviceToken: credential.deviceToken)
            guard isCurrent(current.user.id, epoch), autoSyncEnabled else { return }
            // Source strings describe the underlying watch/scale; server policy
            // grants this selected phone ongoing authority, never a blanket header.
            let receipt = try await api.upload(token: current.accessToken, payload: payload,
                previewToken: preview.token, confirmSourceChanges: false, deviceToken: credential.deviceToken)
            guard isCurrent(current.user.id, epoch) else { return }
            lastReceipt = receipt
            if autoSyncEnabled { syncMessage = "服务器已确认：写入 \(receipt.imported) 条，跳过 \(receipt.skipped) 条。" }
            if !background && (!automatic || receipt.imported > 0 || overview == nil || health == nil) {
                await reload(presentError: presentError)
            }
        } catch {
            guard isCurrent(current.user.id, epoch) else { return }
            if !autoSyncEnabled { return }
            if error is CancellationError {
                syncMessage = "本次同步已暂停，将在下次打开 App 时重试。"
                return
            }
            if case NativeHealthError.noReadableData = error {
                syncMessage = "本次未取得可同步记录。请核对系统健康读取权限和记录范围；缺失不会记为零。"
                return
            }
            if let failure = error as? NativeAPIError, failure.isAuthenticationFailure,
               session?.accessToken != current.accessToken { return }
            syncMessage = "本次同步未完成：" + error.localizedDescription + " 可稍后重试。"
            handle(error, owner: current.user.id, epoch: epoch, token: current.accessToken, presentError: presentError)
        }
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
        channelRequestID = UUID()
        overviewRequestID = UUID()
        healthRequestID = UUID()
        overviewRequest?.cancel()
        healthRequest?.cancel()
        overviewRequest = nil
        healthRequest = nil
        syncOperation?.cancel()
        syncOperation = nil
        syncOperationID = nil
        syncAgain = false
        observationStartID = nil
        reader.stopObserving()
        observationsStarted = false
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
        authorizingHealth = false
        pendingChannelConsent = nil
        channel = nil
        configuringChannel = false
        lastReceipt = nil
        autoSyncEnabled = false
        syncing = false
        overviewLoading = false
        healthLoading = false
        activating = false
        validatingSession = false
        restoring = false
        lastChannelCheckAt = nil
        lastAutomaticAttempt = nil
        observerMessage = nil
        syncMessage = "连接苹果健康后，可在打开 App 或健康数据变化时同步。"
    }

    private func handle(_ error: Error, owner: String, epoch: UUID, token: String, presentError: Bool = true) {
        guard isCurrent(owner, epoch) else { return }
        if let failure = error as? NativeAPIError, failure.isAuthenticationFailure {
            guard session?.accessToken == token else { return }
            clearDisplayedAccount()
            try? sessions.clear()
            if !presentError { syncMessage = "同步已暂停：" + error.localizedDescription }
        }
        if let failure = error as? NativeAPIError,
           ["HEALTH_SYNC_CHANNEL_REQUIRED", "HEALTH_SYNC_CHANNEL_CHANGED", "SYNC_DEVICE_INVALID",
            "NATIVE_HEALTH_CHANNEL_DEVICE_INVALID", "NATIVE_HEALTH_CHANNEL_NOT_CURRENT"].contains(failure.code ?? "") {
            pauseAutomaticSync(owner: owner)
            pendingChannelConsent = nil
            syncMessage = "日常同步来源已变化，自动同步已暂停。请在设置中核对后重新确认。"
        }
        if presentError { errorMessage = error.localizedDescription }
    }
}
