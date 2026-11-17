import Combine
import Foundation
import UIKit

struct PendingNativeHealthChannelConsent: Identifiable {
    let id = UUID()
    let ownerID: String
    let expectedRevision: Int
    let currentLabel: String?
    var candidate: NativeHealthDeviceCredential?
}

/// Coordinates the selected device, HealthKit delivery and uploads for the current account.
@MainActor
final class NativeHealthSync: ObservableObject {
    @Published private(set) var authorizingHealth = false
    @Published private(set) var syncing = false
    @Published private(set) var autoSyncEnabled = false
    @Published private(set) var syncMessage = "连接苹果健康后，可在打开 App 或健康数据变化时同步。"
    @Published private(set) var observerMessage: String?
    @Published private(set) var lastReceipt: NativeSyncReceipt?
    @Published var pendingChannelConsent: PendingNativeHealthChannelConsent?
    @Published private(set) var channel: NativeHealthChannel?
    @Published private(set) var configuringChannel = false

    var presentError: ((String?) -> Void)?
    var invalidateSession: (() -> Void)?
    var didFinishForegroundSync: ((NativeSyncReceipt, Bool) async -> Void)?

    private let api: NativeAPI
    private let reader: any NativeHealthReading
    private let healthDeviceService: String
    private let backgroundBudget: Duration
    private let clock = ContinuousClock()
    private var session: NativeSession?
    private var generation = UUID()
    private var observationID: UUID?
    private var channelRequestID = UUID()
    private var lastChannelCheckAt: Date?
    private var lastSyncAttemptAt: Date?
    private var syncRunID = UUID()

    init(api: NativeAPI, reader: any NativeHealthReading, healthDeviceService: String, backgroundBudget: Duration) {
        self.api = api
        self.reader = reader
        self.healthDeviceService = healthDeviceService
        self.backgroundBudget = backgroundBudget
    }

    func restoreObservers() async {
        await observeHealth()
    }

    func prepareForForeground() async {
        guard let current = session, autoSyncEnabled else { return }
        let epoch = generation
        if lastChannelCheckAt.map({ Date().timeIntervalSince($0) >= 60 }) ?? true {
            await refreshChannelStatus(presentError: false)
        }
        guard isCurrent(current.user.id, epoch) else { return }
        await observeHealth()
    }

    func syncOnForeground() async {
        guard autoSyncEnabled, pendingChannelConsent == nil,
              lastSyncAttemptAt.map({ Date().timeIntervalSince($0) > 60 }) ?? true else { return }
        await sync(days: 30, automatic: true)
    }

    func renewSession(_ value: NativeSession) { session = value }

    private func syncKey(_ userID: String) -> String { "jiashu.native.health-auto-sync." + userID }

    private func isCurrent(_ owner: String, _ epoch: UUID) -> Bool {
        generation == epoch && session?.user.id == owner
    }

    private func deviceStore(_ owner: String) -> NativeHealthDeviceStore {
        NativeHealthDeviceStore(userID: owner, service: healthDeviceService)
    }

    func restorePreference(for value: NativeSession) throws {
        session = value
        let userID = value.user.id
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
        presentError?(nil)
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
                presentError?("日常同步来源已变化，请查看最新来源后再次确认。")
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
        await sync()
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
        cancelSyncRun()
        UserDefaults.standard.set(false, forKey: syncKey(owner))
        stopObserving()
    }

    private func stopObserving() {
        observationID = nil
        reader.stopObserving()
        observerMessage = nil
    }

    private func observeHealth() async {
        guard autoSyncEnabled, observationID == nil else { return }
        let id = UUID()
        observationID = id
        do {
            try await reader.startObserving { [weak self] in
                await self?.observedChange(id: id)
            }
        } catch {
            guard observationID == id else { return }
            // Queries stay registered if enabling some background types fails.
            observerMessage = "后台观察暂不可用；打开 App 仍会尝试同步。" + error.localizedDescription
        }
    }

    private func observedChange(id: UUID) async {
        guard observationID == id else { return }
        await syncFromObserver()
    }

    private enum Trigger: Equatable {
        case manual, foreground, observer

        var presentsErrors: Bool { self == .manual }
    }

    private struct Attempt {
        let id: UUID
        let trigger: Trigger
        let days: Int
        let deadline: ContinuousClock.Instant
        let task: Task<Void, Never>
        var repeatUntil: ContinuousClock.Instant?
    }

    private var activeAttempt: Attempt?
    private var attemptWaiters: [UUID: AsyncStream<Void>.Continuation] = [:]

    func sync(days: Int = 30, automatic: Bool = false) async {
        await requestSync(trigger: automatic ? .foreground : .manual, days: days, runID: syncRunID)
    }

    func syncFromObserver() async {
        guard session != nil, autoSyncEnabled, pendingChannelConsent == nil else { return }
        let clock = self.clock
        let deadline = clock.now.advanced(by: backgroundBudget)
        let runID = syncRunID
        // Awaiting Task.value would make the callback wait for unrelated work even
        // after cancellation. The request waits on a cancellation-aware stream.
        await withTaskGroup(of: Void.self) { group in
            group.addTask { @MainActor [weak self] in
                guard let self else { return }
                await self.requestSync(trigger: .observer, days: 7, runID: runID, observerDeadline: deadline)
            }
            group.addTask {
                do { try await clock.sleep(until: deadline) }
                catch { /* The operation finished before its deadline. */ }
            }
            _ = await group.next()
            group.cancelAll()
        }
    }

    private func requestSync(trigger: Trigger, days: Int, runID: UUID,
                             observerDeadline: ContinuousClock.Instant? = nil) async {
        while !Task.isCancelled, syncRunID == runID, session != nil,
              autoSyncEnabled, pendingChannelConsent == nil {
            if let observerDeadline, clock.now >= observerDeadline { return }
            if let running = activeAttempt {
                // Preserve range and presentation for manual and automatic work.
                // An observer can share background work, with its own wait deadline.
                if !running.task.isCancelled, running.trigger == trigger,
                   days <= running.days, clock.now < running.deadline {
                    let limit = min(observerDeadline ?? running.deadline, running.deadline)
                    activeAttempt?.repeatUntil = max(running.repeatUntil ?? limit, limit)
                    await waitForAttempt()
                    return
                }
                await waitForAttempt()
            } else {
                startAttempt(trigger: trigger, days: days, runID: runID,
                             deadline: observerDeadline ?? clock.now.advanced(by: .seconds(120)))
                await waitForAttempt()
                return
            }
        }
    }

    private func waitForAttempt() async {
        let (stream, completion) = AsyncStream<Void>.makeStream()
        let id = UUID()
        attemptWaiters[id] = completion
        defer { attemptWaiters.removeValue(forKey: id) }
        for await _ in stream { }
    }

    private func startAttempt(trigger: Trigger, days: Int, runID: UUID, deadline: ContinuousClock.Instant) {
        let id = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.runAttempt(id: id, runID: runID)
        }
        activeAttempt = Attempt(id: id, trigger: trigger, days: days, deadline: deadline, task: task)
    }

    private func runAttempt(id: UUID, runID: UUID) async {
        guard let operation = activeAttempt, operation.id == id else { return }
        let backgroundID = UIApplication.shared.beginBackgroundTask(withName: "Jiashu Health Sync") { operation.task.cancel() }
        let deadlineTask = Task {
            do {
                try await clock.sleep(until: operation.deadline)
                operation.task.cancel()
            } catch { /* The operation finished before its deadline. */ }
        }
        defer {
            deadlineTask.cancel()
            if backgroundID != .invalid { UIApplication.shared.endBackgroundTask(backgroundID) }
            finishAttempt(id)
        }
        var deadline = operation.deadline
        while !Task.isCancelled, syncRunID == runID, clock.now < deadline {
            activeAttempt?.repeatUntil = nil
            await performSync(trigger: operation.trigger, days: operation.days, runID: runID, deadline: deadline)
            guard activeAttempt?.id == id, let nextDeadline = activeAttempt?.repeatUntil else { break }
            deadline = nextDeadline
        }
    }

    private func finishAttempt(_ id: UUID) {
        guard activeAttempt?.id == id else { return }
        activeAttempt = nil
        for waiter in attemptWaiters.values { waiter.finish() }
        attemptWaiters.removeAll()
    }

    private func cancelSyncRun() {
        syncRunID = UUID()
        activeAttempt?.task.cancel()
    }

    private func performSync(trigger: Trigger, days: Int, runID: UUID, deadline: ContinuousClock.Instant) async {
        guard let current = session, autoSyncEnabled, pendingChannelConsent == nil else { return }
        let epoch = generation
        let presentError = trigger.presentsErrors
        syncing = true
        lastSyncAttemptAt = Date()
        syncMessage = "正在读取苹果健康…"
        if presentError { self.presentError?(nil) }
        defer { if generation == epoch { syncing = false } }
        do {
            guard let credential = try deviceStore(current.user.id).load() else {
                pauseAutomaticSync(owner: current.user.id)
                syncMessage = "请先确认这台 iPhone 为日常同步来源。"
                return
            }
            let snapshot = try await reader.read(days: days)
            try checkAttemptDeadline(deadline)
            guard isCurrent(current.user.id, epoch), syncRunID == runID, autoSyncEnabled else { return }
            guard !snapshot.measurements.isEmpty else {
                syncMessage = "本次未取得可同步记录。请检查健康权限和记录范围；缺失数据不会记为零。"
                return
            }
            let payload = try snapshot.encodePayload()
            syncMessage = "正在核对服务器记录…"
            let preview = try await api.preview(token: current.accessToken, payload: payload, deviceToken: credential.deviceToken)
            try checkAttemptDeadline(deadline)
            guard isCurrent(current.user.id, epoch), syncRunID == runID, autoSyncEnabled else { return }
            // Source strings describe the underlying watch/scale; server policy
            // grants this selected phone ongoing authority, never a blanket header.
            let receipt = try await api.upload(token: current.accessToken, payload: payload,
                previewToken: preview.token, confirmSourceChanges: false, deviceToken: credential.deviceToken)
            guard isCurrent(current.user.id, epoch) else { return }
            lastReceipt = receipt
            if autoSyncEnabled { syncMessage = "服务器已确认：写入 \(receipt.imported) 条，跳过 \(receipt.skipped) 条。" }
            if trigger != .observer { await didFinishForegroundSync?(receipt, trigger == .foreground) }
        } catch {
            guard isCurrent(current.user.id, epoch), syncRunID == runID, autoSyncEnabled else { return }
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

    private func checkAttemptDeadline(_ deadline: ContinuousClock.Instant) throws {
        try Task.checkCancellation()
        if clock.now >= deadline { throw CancellationError() }
    }

    func endSession() {
        generation = UUID()
        session = nil
        channelRequestID = UUID()
        cancelSyncRun()
        if let operation = activeAttempt { finishAttempt(operation.id) }
        stopObserving()
        authorizingHealth = false
        pendingChannelConsent = nil
        channel = nil
        configuringChannel = false
        lastReceipt = nil
        autoSyncEnabled = false
        syncing = false
        lastChannelCheckAt = nil
        lastSyncAttemptAt = nil
        syncMessage = "连接苹果健康后，可在打开 App 或健康数据变化时同步。"
    }

    private func handle(_ error: Error, owner: String, epoch: UUID, token: String, presentError: Bool = true) {
        guard isCurrent(owner, epoch) else { return }
        if let failure = error as? NativeAPIError, failure.isAuthenticationFailure {
            guard session?.accessToken == token else { return }
            invalidateSession?()
            if !presentError { syncMessage = "同步已暂停：" + error.localizedDescription }
        }
        if let failure = error as? NativeAPIError,
           ["HEALTH_SYNC_CHANNEL_REQUIRED", "HEALTH_SYNC_CHANNEL_CHANGED", "SYNC_DEVICE_INVALID",
            "NATIVE_HEALTH_CHANNEL_DEVICE_INVALID", "NATIVE_HEALTH_CHANNEL_NOT_CURRENT"].contains(failure.code ?? "") {
            pauseAutomaticSync(owner: owner)
            pendingChannelConsent = nil
            syncMessage = "日常同步来源已变化，自动同步已暂停。请在设置中核对后重新确认。"
        }
        if presentError { self.presentError?(error.localizedDescription) }
    }
}
