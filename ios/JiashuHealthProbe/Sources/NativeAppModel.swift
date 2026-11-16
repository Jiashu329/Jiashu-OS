import Foundation
import SwiftUI

struct PendingHealthImport: Identifiable {
    let id = UUID()
    let ownerID: String
    let payload: Data
    let preview: NativeImportPreview
}

/// One authenticated account owns every in-flight operation and its displayed result.
@MainActor
final class NativeAppModel: ObservableObject {
    @Published private(set) var session: NativeSession?
    @Published private(set) var overview: NativeOverview?
    @Published private(set) var health: NativeHealthResponse?
    @Published private(set) var restoring = true
    @Published private(set) var signingIn = false
    @Published private(set) var loading = false
    @Published private(set) var syncing = false
    @Published private(set) var autoSyncEnabled = false
    @Published private(set) var syncMessage = "连接苹果健康后，可在打开 App 或健康数据变化时同步。"
    @Published private(set) var observerMessage: String?
    @Published private(set) var lastReceipt: NativeSyncReceipt?
    @Published var pendingImport: PendingHealthImport?
    @Published var errorMessage: String?

    let api: NativeAPI
    private let sessions: NativeSessionStore
    private let reader: HealthKitReader
    private var generation = UUID()
    private var started = false
    private var activating = false
    private var observationsStarted = false
    private var lastAutomaticAttempt: Date?

    init(api: NativeAPI = NativeAPI(), sessions: NativeSessionStore = NativeSessionStore(), reader: HealthKitReader? = nil) {
        self.api = api
        self.sessions = sessions
        self.reader = reader ?? HealthKitReader()
    }

    private func syncKey(_ userID: String) -> String { "jiashu.native.health-auto-sync." + userID }
    private func isCurrent(_ owner: String, _ epoch: UUID) -> Bool { generation == epoch && session?.user.id == owner }

    func restore() async {
        guard !started else { return }
        started = true
        defer { restoring = false }
        do {
            guard let stored = try sessions.load() else { return }
            let valid = try await api.refresh(token: stored.accessToken)
            try sessions.save(valid)
            session = valid
            autoSyncEnabled = UserDefaults.standard.bool(forKey: syncKey(valid.user.id))
            await becameActive()
        } catch {
            // A temporarily unreachable server must not destroy the saved login.
            if let apiError = error as? NativeAPIError, apiError.isAuthenticationFailure { try? sessions.clear() }
            errorMessage = error.localizedDescription
        }
    }

    func login(email: String, password: String) async {
        guard !signingIn else { return }
        signingIn = true
        errorMessage = nil
        defer { signingIn = false }
        do {
            let loggedIn = try await api.login(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            try sessions.save(loggedIn)
            generation = UUID()
            session = loggedIn
            autoSyncEnabled = UserDefaults.standard.bool(forKey: syncKey(loggedIn.user.id))
            await becameActive()
        } catch { errorMessage = error.localizedDescription }
    }

    func becameActive() async {
        guard !activating, let current = session else { return }
        activating = true
        let epoch = generation
        defer { activating = false }
        do {
            if let expiry = current.expiryDate, expiry.timeIntervalSinceNow < 3 * 86400 {
                let refreshed = try await api.refresh(token: current.accessToken)
                guard isCurrent(current.user.id, epoch) else { return }
                try sessions.save(refreshed)
                session = refreshed
            }
            await reload()
            guard isCurrent(current.user.id, epoch), autoSyncEnabled else { return }
            await observeHealth()
            // Foreground visits are a fallback for background delivery, whose timing iOS controls.
            if pendingImport == nil, lastAutomaticAttempt.map({ Date().timeIntervalSince($0) > 60 }) ?? true {
                await sync(background: false)
            }
        } catch { handle(error, owner: current.user.id, epoch: epoch) }
    }

    func reload(days: Int = 30) async {
        guard !loading, let current = session else { return }
        let epoch = generation
        loading = true
        defer { if generation == epoch { loading = false } }
        let overviewRequest = Task { try await api.overview(token: current.accessToken) }
        let healthRequest = Task { try await api.health(token: current.accessToken, days: days) }
        do {
            let value = try await overviewRequest.value
            if isCurrent(current.user.id, epoch) { overview = value }
        } catch { handle(error, owner: current.user.id, epoch: epoch) }
        do {
            let value = try await healthRequest.value
            if isCurrent(current.user.id, epoch) { health = value }
        } catch { handle(error, owner: current.user.id, epoch: epoch) }
    }

    func connectHealth() async {
        guard let current = session, !syncing else { return }
        let epoch = generation
        do {
            // This is the only place that requests the system permission dialog.
            try await reader.authorize()
            guard isCurrent(current.user.id, epoch) else { return }
            autoSyncEnabled = true
            UserDefaults.standard.set(true, forKey: syncKey(current.user.id))
            await observeHealth()
            await sync(background: false)
        } catch { handle(error, owner: current.user.id, epoch: epoch) }
    }

    func setAutomaticSync(_ enabled: Bool) async {
        guard let current = session else { return }
        if enabled { await connectHealth(); return }
        autoSyncEnabled = false
        UserDefaults.standard.set(false, forKey: syncKey(current.user.id))
        reader.stopObserving()
        observationsStarted = false
        observerMessage = nil
        syncMessage = "自动同步已暂停，服务器已有记录继续保留。"
    }

    private func observeHealth() async {
        guard autoSyncEnabled, !observationsStarted else { return }
        do {
            try await reader.startObserving { [weak self] in
                await self?.sync(background: true)
            }
            observationsStarted = true
            observerMessage = nil
        } catch {
            observerMessage = "后台观察暂不可用；打开 App 仍会尝试同步。" + error.localizedDescription
        }
    }

    func sync(background: Bool = false, days: Int = 30) async {
        guard !syncing, let current = session, autoSyncEnabled, pendingImport == nil else { return }
        let epoch = generation
        syncing = true
        lastAutomaticAttempt = Date()
        syncMessage = "正在读取苹果健康…"
        if !background { errorMessage = nil }
        defer { if generation == epoch { syncing = false } }
        do {
            let snapshot = try await reader.read(days: days)
            try Task.checkCancellation()
            guard isCurrent(current.user.id, epoch), autoSyncEnabled else { return }
            guard !snapshot.measurements.isEmpty else {
                syncMessage = "本次未取得可同步记录。请检查健康权限和记录范围；缺失数据不会记为零。"
                return
            }
            let payload = try snapshot.encodePayload()
            syncMessage = "正在核对服务器记录…"
            let preview = try await api.preview(token: current.accessToken, payload: payload)
            guard isCurrent(current.user.id, epoch), autoSyncEnabled else { return }
            if preview.sourceChanges > 0 {
                pendingImport = PendingHealthImport(ownerID: current.user.id, payload: payload, preview: preview)
                syncMessage = "检测到健康数据来源变化，请在 App 中核对后确认。"
                return
            }
            let receipt = try await api.upload(token: current.accessToken, payload: payload, previewToken: preview.token, confirmSourceChanges: false)
            guard isCurrent(current.user.id, epoch) else { return }
            lastReceipt = receipt
            syncMessage = "服务器已确认：写入 \(receipt.imported) 条，跳过 \(receipt.skipped) 条。"
            if !background { await reload() }
        } catch {
            guard isCurrent(current.user.id, epoch) else { return }
            syncMessage = "本次同步未完成，下次打开 App 会再次核对；也可手动重试。"
            handle(error, owner: current.user.id, epoch: epoch)
        }
    }

    func confirmSourceChange() async {
        guard !syncing, let pending = pendingImport, let current = session, pending.ownerID == current.user.id else { return }
        let epoch = generation
        syncing = true
        defer { if generation == epoch { syncing = false } }
        do {
            let receipt = try await api.upload(token: current.accessToken, payload: pending.payload, previewToken: pending.preview.token, confirmSourceChanges: true)
            guard isCurrent(current.user.id, epoch) else { return }
            lastReceipt = receipt
            pendingImport = nil
            syncMessage = "服务器已确认：写入 \(receipt.imported) 条，跳过 \(receipt.skipped) 条。"
            await reload()
        } catch {
            // A changed/stale preview needs a fresh explicit decision, never an automatic retry.
            if case NativeAPIError.server(let status, _, _, _) = error, status == 409, isCurrent(current.user.id, epoch) {
                do {
                    let preview = try await api.preview(token: current.accessToken, payload: pending.payload)
                    if isCurrent(current.user.id, epoch) { pendingImport = PendingHealthImport(ownerID: current.user.id, payload: pending.payload, preview: preview) }
                } catch { handle(error, owner: current.user.id, epoch: epoch) }
            }
            handle(error, owner: current.user.id, epoch: epoch)
        }
    }

    func signOut() async {
        guard let current = session else { return }
        do { try await api.logout(token: current.accessToken) }
        catch {
            if (error as? NativeAPIError)?.isAuthenticationFailure != true { errorMessage = error.localizedDescription; return }
        }
        clearDisplayedAccount()
        do { try sessions.clear() } catch { errorMessage = error.localizedDescription }
    }

    private func clearDisplayedAccount() {
        generation = UUID()
        reader.stopObserving()
        observationsStarted = false
        session = nil
        overview = nil
        health = nil
        pendingImport = nil
        lastReceipt = nil
        autoSyncEnabled = false
        syncing = false
        loading = false
        activating = false
        lastAutomaticAttempt = nil
        observerMessage = nil
        syncMessage = "连接苹果健康后，可在打开 App 或健康数据变化时同步。"
    }

    private func handle(_ error: Error, owner: String, epoch: UUID) {
        guard isCurrent(owner, epoch) else { return }
        if let failure = error as? NativeAPIError, failure.isAuthenticationFailure {
            clearDisplayedAccount()
            try? sessions.clear()
        }
        errorMessage = error.localizedDescription
    }
}
