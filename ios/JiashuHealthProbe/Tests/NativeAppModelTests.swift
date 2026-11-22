import Foundation
import Combine
import Security
import XCTest
@testable import JiashuHealthProbe

final class NativeAppModelTests: XCTestCase {
    @MainActor
    func testRestoreDisplaysSavedAccountBeforeNetworkValidationFinishes() async throws {
        let validation = NativeModelReplyGate()
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path.hasSuffix("auth/refresh") == true {
                return .held(validation, NativeModelReply(status: 200, data: try JSONEncoder().encode(context.a)))
            }
            return try context.standardReply(request)
        }
        defer { validation.release(); fixture.cleanup() }
        try fixture.store.save(fixture.context.a)
        let loaded = XCTestExpectation(description: "Saved account reads finish independently of session validation")
        let observation = fixture.model.$loadedHealthDays.sink { if $0 == 30 { loaded.fulfill() } }
        defer { observation.cancel() }
        let restoration = Task { await fixture.model.restore() }
        await validation.waitUntilRequested()
        await fulfillment(of: [loaded], timeout: 10)
        XCTAssertFalse(fixture.model.restoring, "A slow validation must not hold the launch screen")
        XCTAssertEqual(fixture.model.session?.user.id, fixture.context.a.user.id)
        XCTAssertNotNil(fixture.model.health)
        validation.release()
        await restoration.value
        XCTAssertNotNil(fixture.model.overview)
        XCTAssertEqual(fixture.model.loadedHealthDays, 30)
    }

    @MainActor
    func testExpiredSavedSessionDoesNotOpenAuthenticatedUIOrMakeRequests() async throws {
        let fixture = try NativeModelFixture { _, _ in XCTFail("Expired saved login reached transport"); return .immediate(.json([:])) }
        defer { fixture.cleanup() }
        try fixture.store.save(NativeSession(accessToken: fixture.context.a.accessToken, expiresAt: "2000-01-01T00:00:00Z", user: fixture.context.a.user))
        await fixture.model.restore()
        XCTAssertFalse(fixture.model.restoring)
        XCTAssertNil(fixture.model.session)
        XCTAssertNil(try fixture.store.load())
    }

    @MainActor
    func testFailedRangeKeepsItsActualLoadedRangeAndHasIndependentInlineRecovery() async throws {
        let range = NativeModelReplyGate()
        let calls = NativeModelRequestCounter()
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path == "/api/native/overview" { _ = calls.next("overview") }
            if request.url?.path == "/api/native/health", request.url?.query == "days=90" {
                return .held(range, .json(["error": "合成网络故障"], status: 503))
            }
            return try context.standardReply(request)
        }
        defer { range.release(); fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        let change = Task { await fixture.model.reloadHealth(days: 90) }
        await range.waitUntilRequested()
        XCTAssertTrue(fixture.model.healthLoading)
        XCTAssertFalse(fixture.model.overviewLoading)
        XCTAssertEqual(fixture.model.healthDays, 90)
        XCTAssertEqual(fixture.model.loadedHealthDays, 30)
        range.release()
        await change.value
        XCTAssertFalse(fixture.model.healthLoading)
        XCTAssertEqual(fixture.model.healthDays, 90)
        XCTAssertEqual(fixture.model.loadedHealthDays, 30)
        XCTAssertEqual(fixture.model.health?.summary.metrics["steps"]?.latestValue, 100)
        XCTAssertNotNil(fixture.model.healthError)
        XCTAssertNil(fixture.model.overviewError)
        XCTAssertNil(fixture.model.errorMessage)
        XCTAssertEqual(calls.value("overview"), 1, "Only the original overview read should have occurred")
    }

    @MainActor
    func testHealthPublishesWhileAnIndependentOverviewRefreshIsStillWaiting() async throws {
        let overview = NativeModelReplyGate()
        let calls = NativeModelRequestCounter()
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path == "/api/native/overview", calls.next("overview") > 1 {
                return .held(overview, context.overviewReply(value: 101))
            }
            if request.url?.path == "/api/native/health", request.url?.query == "days=90" {
                return .immediate(context.healthReply(value: 90))
            }
            return try context.standardReply(request)
        }
        defer { overview.release(); fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        let loaded = XCTestExpectation(description: "New range published before overview")
        let observation = fixture.model.$loadedHealthDays.sink { if $0 == 90 { loaded.fulfill() } }
        defer { observation.cancel() }
        let reload = Task { await fixture.model.reload(days: 90) }
        await overview.waitUntilRequested()
        await fulfillment(of: [loaded], timeout: 10)
        XCTAssertEqual(fixture.model.health?.summary.metrics["steps"]?.latestValue, 90)
        XCTAssertTrue(fixture.model.overviewLoading)
        XCTAssertFalse(fixture.model.healthLoading)
        overview.release()
        await reload.value
    }

    @MainActor
    func testBriefForegroundVisitsReuseReadsWhileExplicitRefreshStillFetches() async throws {
        let calls = NativeModelRequestCounter()
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path == "/api/native/overview" { _ = calls.next("overview") }
            if request.url?.path == "/api/native/health" { _ = calls.next("health") }
            return try context.standardReply(request)
        }
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        await fixture.model.becameActive()
        await fixture.model.becameActive()
        XCTAssertEqual(calls.value("overview"), 1)
        XCTAssertEqual(calls.value("health"), 1)
        await fixture.model.reloadOverview()
        XCTAssertEqual(calls.value("overview"), 2)
        XCTAssertEqual(calls.value("health"), 1)
        XCTAssertNotNil(fixture.model.overviewUpdatedAt)
        XCTAssertNotNil(fixture.model.healthUpdatedAt)
    }

    @MainActor
    func testLateWorkspaceResponseFromOldLoginIsCancelledAfterAccountSwitch() async throws {
        let response = NativeModelReplyGate()
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path == "/api/native/finance" {
                return .held(response, .json(["owner": context.a.user.id]))
            }
            return try context.standardReply(request)
        }
        defer { response.release(); fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        let old = Task { try await fixture.model.api.json(path: "finance", token: fixture.context.a.accessToken) }
        await response.waitUntilRequested()
        await fixture.model.login(email: fixture.context.b.user.email, password: "synthetic-b-password")
        response.release()
        do { _ = try await old.value; XCTFail("Old account response was published") }
        catch is CancellationError { }
        XCTAssertEqual(fixture.model.session?.user.id, fixture.context.b.user.id)
        XCTAssertEqual(fixture.model.overview?.health.metrics.first?.value, 200)
        XCTAssertNil(fixture.model.errorMessage)
    }

    @MainActor
    func testValidationCannotReplaceSavedLoginWithAnotherOwner() async throws {
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path.hasSuffix("auth/refresh") == true {
                return .immediate(NativeModelReply(status: 200, data: try JSONEncoder().encode(context.b)))
            }
            return try context.standardReply(request)
        }
        defer { fixture.cleanup() }
        try fixture.store.save(fixture.context.a)
        await fixture.model.restore()
        XCTAssertEqual(fixture.model.session, fixture.context.a)
        XCTAssertEqual(try fixture.store.load(), fixture.context.a)
        XCTAssertNotNil(fixture.model.sessionError)
        XCTAssertNil(fixture.model.errorMessage)
    }

    @MainActor
    func testDelayed401ForSupersededTokenCannotExpireRenewedLease() async throws {
        let failure = NativeModelReplyGate()
        let fixture = try NativeModelFixture { _, _ in
            .held(failure, .json(["error": "旧凭据已过期", "code": "NATIVE_SIGN_IN_REQUIRED"], status: 401))
        }
        defer { failure.release(); fixture.cleanup() }
        let api = fixture.model.api, first = fixture.context.a
        let renewed = NativeSession(accessToken: "synthetic-renewed-token", expiresAt: first.expiresAt, user: first.user)
        api.beginSession(first)
        var notified: [String] = []
        api.workspaceAuthenticationFailure = { notified.append($0) }
        let old = Task { try await api.json(path: "finance", token: first.accessToken) }
        await failure.waitUntilRequested()
        XCTAssertTrue(api.renewSession(renewed, replacing: first.accessToken))
        failure.release()
        do { _ = try await old.value; XCTFail("Expected superseded response cancellation") }
        catch is CancellationError { }
        XCTAssertTrue(notified.isEmpty)
    }

    @MainActor
    func testDelayedLogoutFromPreviousAccountCannotClearNewLogin() async throws {
        let logout = NativeModelReplyGate()
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path.hasSuffix("auth/logout") == true {
                return .held(logout, .json(["ok": true]))
            }
            return try context.standardReply(request)
        }
        defer { logout.release(); fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-first-password")
        XCTAssertEqual(fixture.model.session?.user.id, fixture.context.a.user.id)
        let oldLogout = Task { await fixture.model.signOut() }
        await logout.waitUntilRequested()

        await fixture.model.login(email: fixture.context.b.user.email, password: "synthetic-second-password")
        XCTAssertEqual(fixture.model.session?.user.id, fixture.context.b.user.id)
        XCTAssertEqual(fixture.model.health?.summary.metrics["steps"]?.latestValue, 200)
        logout.release()
        await oldLogout.value

        XCTAssertEqual(fixture.model.session?.user.id, fixture.context.b.user.id)
        XCTAssertEqual(fixture.model.overview?.health.metrics.first?.value, 200)
        XCTAssertEqual(fixture.model.health?.summary.metrics["steps"]?.latestValue, 200)
        XCTAssertEqual(try fixture.store.load(), fixture.context.b)
    }

    @MainActor
    func testDelayedRestoreFailureCannotClearNewerLogin() async throws {
        let refresh = NativeModelReplyGate()
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path.hasSuffix("auth/refresh") == true {
                return .held(refresh, .json(["error": "旧会话已失效", "code": "NATIVE_SIGN_IN_REQUIRED"], status: 401))
            }
            return try context.standardReply(request)
        }
        defer { refresh.release(); fixture.cleanup() }
        try fixture.store.save(fixture.context.a)
        let oldRestore = Task { await fixture.model.restore() }
        await refresh.waitUntilRequested()

        await fixture.model.login(email: fixture.context.b.user.email, password: "synthetic-second-password")
        refresh.release()
        await oldRestore.value

        XCTAssertEqual(fixture.model.session, fixture.context.b)
        XCTAssertEqual(try fixture.store.load(), fixture.context.b)
        XCTAssertEqual(fixture.model.overview?.health.metrics.first?.value, 200)
        XCTAssertNil(fixture.model.errorMessage)
    }

    @MainActor
    func testNewAccountDoesNotDisplayPreviousAccountsDataWhileLoading() async throws {
        let newAccountOverview = NativeModelReplyGate()
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path == "/api/native/overview",
               request.value(forHTTPHeaderField: "Authorization") == "Bearer " + context.b.accessToken {
                return .held(newAccountOverview, context.overviewReply(value: 200))
            }
            return try context.standardReply(request)
        }
        defer { newAccountOverview.release(); fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-first-password")
        XCTAssertNotNil(fixture.model.overview)
        XCTAssertNotNil(fixture.model.health)
        let newLogin = Task {
            await fixture.model.login(email: fixture.context.b.user.email, password: "synthetic-second-password")
        }
        await newAccountOverview.waitUntilRequested()

        XCTAssertEqual(fixture.model.session?.user.id, fixture.context.b.user.id)
        XCTAssertNil(fixture.model.overview)
        let healthWhileOverviewWaits = fixture.model.health?.summary.metrics["steps"]?.latestValue
        XCTAssertTrue(healthWhileOverviewWaits == nil || healthWhileOverviewWaits == 200,
                      "Independent reads may show B's data, never A's previous data")
        newAccountOverview.release()
        await newLogin.value
        XCTAssertEqual(fixture.model.overview?.health.metrics.first?.value, 200)
        XCTAssertEqual(fixture.model.health?.summary.metrics["steps"]?.latestValue, 200)
    }

    @MainActor
    func testLatestHealthRangeWinsWhenOlderRequestFinishesLater() async throws {
        let olderRange = NativeModelReplyGate()
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path == "/api/native/health" {
                let days = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
                    .first(where: { $0.name == "days" })?.value
                if days == "7" { return .held(olderRange, context.healthReply(value: 7)) }
                if days == "90" { return .immediate(context.healthReply(value: 90)) }
            }
            return try context.standardReply(request)
        }
        defer { olderRange.release(); fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        let oldReload = Task { await fixture.model.reload(days: 7) }
        await olderRange.waitUntilRequested()

        await fixture.model.reload(days: 90)
        XCTAssertEqual(fixture.model.health?.summary.metrics["steps"]?.latestValue, 90)
        olderRange.release()
        await oldReload.value

        XCTAssertEqual(fixture.model.health?.summary.metrics["steps"]?.latestValue, 90)
        XCTAssertFalse(fixture.model.loading)
        XCTAssertEqual(fixture.model.healthDays, 90)
        await fixture.model.reload()
        XCTAssertEqual(fixture.model.healthDays, 90)
        XCTAssertEqual(fixture.model.health?.summary.metrics["steps"]?.latestValue, 90)
    }

    @MainActor
    func testAuthenticationFailureClearsDisplayedDataAndSecureSession() async throws {
        let calls = NativeModelRequestCounter()
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path == "/api/native/overview", calls.next("overview") > 1 {
                return .immediate(.json(["error": "App 登录已失效，请重新登录。", "code": "NATIVE_SIGN_IN_REQUIRED"], status: 401))
            }
            return try context.standardReply(request)
        }
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        XCTAssertNotNil(fixture.model.overview)
        XCTAssertNotNil(fixture.model.health)
        XCTAssertNotNil(try fixture.store.load())

        await fixture.model.reload()

        XCTAssertNil(fixture.model.session)
        XCTAssertNil(fixture.model.overview)
        XCTAssertNil(fixture.model.health)
        XCTAssertNil(fixture.model.pendingChannelConsent)
        XCTAssertNil(try fixture.store.load())
        XCTAssertNotNil(fixture.model.errorMessage)
    }

    @MainActor
    func testTemporaryRefreshFailurePreservesSecureSavedLogin() async throws {
        let fixture = try NativeModelFixture { request, context in
            if request.url?.path.hasSuffix("auth/refresh") == true {
                return .immediate(.json(["error": "账户服务暂时不可用。", "code": "LOCAL_USERS_UNAVAILABLE"], status: 503))
            }
            return try context.standardReply(request)
        }
        defer { fixture.cleanup() }
        try fixture.store.save(fixture.context.a)

        await fixture.model.restore()

        XCTAssertEqual(fixture.model.session, fixture.context.a)
        XCTAssertEqual(try fixture.store.load(), fixture.context.a)
        XCTAssertFalse(fixture.model.restoring)
        XCTAssertFalse(fixture.model.autoSyncEnabled)
        XCTAssertNotNil(fixture.model.sessionError)
        XCTAssertNil(fixture.model.errorMessage)
    }

    @MainActor
    func testLoginPersistsSessionWithoutPersistingPassword() async throws {
        let password = "synthetic-password-must-not-persist"
        let fixture = try NativeModelFixture { request, context in try context.standardReply(request) }
        defer { fixture.cleanup() }

        await fixture.model.login(email: fixture.context.a.user.email, password: password)

        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: fixture.keychainService, kSecAttrAccount as String: "current-user",
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var raw: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &raw), errSecSuccess)
        let data = try XCTUnwrap(raw as? Data)
        let saved = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(saved.keys), Set(["accessToken", "expiresAt", "user"]))
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains(password))
        XCTAssertEqual(try fixture.store.load(), fixture.context.a)
    }
    @MainActor
    func testDailySourceConsentSavesCredentialBeforeSelectionAndThenSyncsWithoutBatchConfirmation() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let fixture = try NativeModelFixture(reader: reader) { request, context in
            try server.reply(request, context: context)
        }
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")

        await fixture.model.connectHealth()
        XCTAssertNotNil(fixture.model.pendingChannelConsent)
        XCTAssertFalse(fixture.model.autoSyncEnabled)
        XCTAssertEqual(reader.authorizationCount, 1)
        XCTAssertEqual(reader.readCount, 0, "No upload should happen before daily-source consent")
        XCTAssertEqual(server.uploadCount, 0)
        XCTAssertEqual(server.selectionCount, 0)

        await fixture.model.confirmDailyChannel(label: "我的 iPhone")

        XCTAssertNil(fixture.model.pendingChannelConsent)
        XCTAssertTrue(fixture.model.autoSyncEnabled)
        XCTAssertEqual(server.selectionCount, 1)
        XCTAssertEqual(server.savedBeforeSelectionCount, 1)
        XCTAssertEqual(server.uploadCount, 1)
        XCTAssertEqual(fixture.model.lastReceipt?.imported, 1)
        let selected = try XCTUnwrap(fixture.context.deviceStore(for: fixture.context.a).load())
        XCTAssertEqual(server.selectedToken(owner: fixture.context.a.user.id), selected.deviceToken)

        await fixture.model.sync()
        XCTAssertEqual(server.selectionCount, 1, "Continuing sync must not select again")
        XCTAssertEqual(server.uploadCount, 2)
        XCTAssertEqual(reader.authorizationCount, 1)
        XCTAssertNil(fixture.model.pendingChannelConsent)
    }

    @MainActor
    func testPreviouslySelectedDeviceResumesWithoutNewConsentOrHealthPermissionPrompt() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let fixture = try NativeModelFixture(reader: reader) { request, context in
            try server.reply(request, context: context)
        }
        defer { fixture.cleanup() }
        let credential = try NativeHealthDeviceCredential.generate()
        try fixture.context.deviceStore(for: fixture.context.a).save(credential)
        server.configure(owner: fixture.context.a.user.id, token: credential.deviceToken, revision: 3)
        UserDefaults.standard.set(true, forKey: "jiashu.native.health-auto-sync." + fixture.context.a.user.id)

        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")

        XCTAssertTrue(fixture.model.autoSyncEnabled)
        XCTAssertEqual(fixture.model.channel?.revision, 3)
        XCTAssertEqual(fixture.model.channel?.isCurrentDevice, true)
        XCTAssertNil(fixture.model.pendingChannelConsent)
        XCTAssertEqual(reader.authorizationCount, 0)
        XCTAssertEqual(server.selectionCount, 0)
        XCTAssertEqual(server.uploadCount, 1)
        XCTAssertEqual(fixture.model.lastReceipt?.imported, 1)
    }

    @MainActor
    func testUpgradedDeviceUploadsActivityOnlyAfterExplicitAuthorizationEvenWithoutExistingMetrics() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let requests = NativeModelRequestCounter()
        reader.readError = NativeHealthError.noReadableData
        reader.activityBackgroundAvailable = false
        reader.activitySnapshot = NativeAppleActivitySnapshot(capturedAt: NativeDates.parse("2026-11-17T08:00:00Z")!, vitals: [
            .init(day: "2026-11-17", heartRate: .init(average: 77, min: 60, max: 114), restingHeartRate: nil,
                  oxygenSaturation: nil),
        ], workouts: [])
        let fixture = try NativeModelFixture(reader: reader) { request, context in
            guard request.url?.path == "/api/native/health/apple-activity" else { return try server.reply(request, context: context) }
            _ = requests.next("activity")
            let deviceToken = try XCTUnwrap(server.selectedToken(owner: context.a.user.id))
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Sync-Device"), deviceToken)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + context.a.accessToken)
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: nativeModelRequestBody(request)) as? [String: Any])
            XCTAssertEqual(payload["version"] as? Int, 1)
            XCTAssertEqual((payload["vitals"] as? [[String: Any]])?.first?["day"] as? String, "2026-11-17")
            return .immediate(.json(["received": 1, "updated": 1, "syncedAt": "2026-11-17T08:00:00Z"]))
        }
        defer { fixture.cleanup() }
        let credential = try NativeHealthDeviceCredential.generate()
        try fixture.context.deviceStore(for: fixture.context.a).save(credential)
        server.configure(owner: fixture.context.a.user.id, token: credential.deviceToken, revision: 3)
        UserDefaults.standard.set(true, forKey: "jiashu.native.health-auto-sync." + fixture.context.a.user.id)

        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        XCTAssertEqual(reader.observerAppleActivityFlags, [false])
        XCTAssertFalse(fixture.model.appleActivityPermissionRequested)
        XCTAssertEqual(reader.activityReadWindows, [])
        XCTAssertEqual(requests.value("activity"), 0)

        await fixture.model.connectHealth()
        XCTAssertTrue(fixture.model.appleActivityPermissionRequested)
        XCTAssertEqual(reader.authorizationCount, 1)
        XCTAssertEqual(reader.observerAppleActivityFlags, [false, true])
        XCTAssertTrue(fixture.model.observerMessage?.contains("心率") == true)
        XCTAssertEqual(reader.activityReadWindows, [30])
        XCTAssertEqual(requests.value("activity"), 1)
        XCTAssertEqual(server.selectionCount, 0)
        XCTAssertEqual(server.uploadCount, 0)
        XCTAssertNil(fixture.model.lastReceipt)
        XCTAssertEqual(fixture.model.appleActivityLastSync, "2026-11-17T08:00:00Z")

        await reader.notifyChange()
        XCTAssertEqual(reader.activityReadWindows, [30, 7])
        XCTAssertEqual(requests.value("activity"), 2)
    }

    @MainActor
    func testAnotherDeviceTakingOverPausesSyncWithoutSilentReselection() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let fixture = try NativeModelFixture(reader: reader) { request, context in
            try server.reply(request, context: context)
        }
        defer { fixture.cleanup() }
        let local = try NativeHealthDeviceCredential.generate()
        try fixture.context.deviceStore(for: fixture.context.a).save(local)
        server.configure(owner: fixture.context.a.user.id, token: local.deviceToken, revision: 1)
        UserDefaults.standard.set(true, forKey: "jiashu.native.health-auto-sync." + fixture.context.a.user.id)
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        XCTAssertTrue(fixture.model.autoSyncEnabled)
        let uploadsBeforeChange = server.uploadCount
        let other = try NativeHealthDeviceCredential.generate()
        server.configure(owner: fixture.context.a.user.id, token: other.deviceToken, revision: 2)

        await fixture.model.refreshChannelStatus()
        await fixture.model.sync()

        XCTAssertFalse(fixture.model.autoSyncEnabled)
        XCTAssertEqual(fixture.model.channel?.isCurrentDevice, false)
        XCTAssertEqual(fixture.model.channel?.revision, 2)
        XCTAssertEqual(server.selectionCount, 0)
        XCTAssertEqual(server.uploadCount, uploadsBeforeChange)
        XCTAssertEqual(try fixture.context.deviceStore(for: fixture.context.a).load(), local)
        XCTAssertGreaterThan(reader.stopCount, 0)
    }

    @MainActor
    func testLostSelectionAcknowledgementReconcilesSameCredentialWithoutSecondSelection() async throws {
        let server = NativeModelChannelServer()
        server.failNextSelectionAfterCommit = true
        let reader = NativeModelHealthReader()
        let fixture = try NativeModelFixture(reader: reader) { request, context in
            try server.reply(request, context: context)
        }
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        await fixture.model.connectHealth()

        await fixture.model.confirmDailyChannel(label: "我的 iPhone")

        let credential = try XCTUnwrap(fixture.context.deviceStore(for: fixture.context.a).load())
        XCTAssertEqual(server.selectionCount, 1)
        XCTAssertEqual(server.savedBeforeSelectionCount, 1)
        XCTAssertEqual(server.selectedToken(owner: fixture.context.a.user.id), credential.deviceToken)
        XCTAssertGreaterThanOrEqual(server.statusCount, 3)
        XCTAssertTrue(fixture.model.autoSyncEnabled)
        XCTAssertNil(fixture.model.pendingChannelConsent)
        XCTAssertEqual(fixture.model.lastReceipt?.imported, 1)
        await fixture.model.confirmDailyChannel(label: "再次点击")
        XCTAssertEqual(server.selectionCount, 1)
        XCTAssertEqual(try fixture.context.deviceStore(for: fixture.context.a).load(), credential)
    }

    @MainActor
    func testPauseAndLogoutPreserveCredentialWhileOtherAccountGetsSeparateDeviceIdentity() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let fixture = try NativeModelFixture(reader: reader) { request, context in
            try server.reply(request, context: context)
        }
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-a-password")
        await fixture.model.connectHealth()
        await fixture.model.confirmDailyChannel(label: "我的 iPhone")
        let a = try XCTUnwrap(fixture.context.deviceStore(for: fixture.context.a).load())

        await fixture.model.setAutomaticSync(false)
        XCTAssertFalse(fixture.model.autoSyncEnabled)
        XCTAssertEqual(try fixture.context.deviceStore(for: fixture.context.a).load(), a)
        XCTAssertEqual(server.clearCount, 0)
        await fixture.model.signOut()
        XCTAssertNil(fixture.model.session)
        XCTAssertNil(try fixture.store.load())
        XCTAssertEqual(try fixture.context.deviceStore(for: fixture.context.a).load(), a)
        XCTAssertNil(try fixture.context.deviceStore(for: fixture.context.b).load())

        await fixture.model.login(email: fixture.context.b.user.email, password: "synthetic-b-password")
        XCTAssertFalse(fixture.model.autoSyncEnabled)
        await fixture.model.connectHealth()
        XCTAssertNotNil(fixture.model.pendingChannelConsent)
        await fixture.model.confirmDailyChannel(label: "家人的 iPhone")
        let b = try XCTUnwrap(fixture.context.deviceStore(for: fixture.context.b).load())
        XCTAssertNotEqual(a.deviceToken, b.deviceToken)
        XCTAssertEqual(try fixture.context.deviceStore(for: fixture.context.a).load(), a)
        XCTAssertEqual(server.selectedToken(owner: fixture.context.a.user.id), a.deviceToken)
        XCTAssertEqual(server.selectedToken(owner: fixture.context.b.user.id), b.deviceToken)
        XCTAssertEqual(server.selectionCount, 2)
    }

    @MainActor
    func testSelectionRevisionChangedBeforeConsentRequiresAnotherExplicitDecision() async throws {
        let server = NativeModelChannelServer()
        let fixture = try NativeModelFixture(reader: NativeModelHealthReader()) { request, context in
            try server.reply(request, context: context)
        }
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        await fixture.model.connectHealth()
        XCTAssertEqual(fixture.model.pendingChannelConsent?.expectedRevision, 0)
        let another = try NativeHealthDeviceCredential.generate()
        server.configure(owner: fixture.context.a.user.id, token: another.deviceToken, revision: 1)

        await fixture.model.confirmDailyChannel(label: "我的 iPhone")

        XCTAssertFalse(fixture.model.autoSyncEnabled)
        XCTAssertEqual(server.selectionCount, 0)
        XCTAssertEqual(server.uploadCount, 0)
        XCTAssertEqual(fixture.model.pendingChannelConsent?.expectedRevision, 1)
        XCTAssertNil(try fixture.context.deviceStore(for: fixture.context.a).load())
        await fixture.model.confirmDailyChannel(label: "我的 iPhone")
        XCTAssertTrue(fixture.model.autoSyncEnabled)
        XCTAssertEqual(server.selectionCount, 1)
    }

    @MainActor
    func testExplicitReleaseClearsOnlyCurrentOwnersCredential() async throws {
        let server = NativeModelChannelServer()
        let fixture = try NativeModelFixture(reader: NativeModelHealthReader()) { request, context in
            try server.reply(request, context: context)
        }
        defer { fixture.cleanup() }
        let otherOwner = try NativeHealthDeviceCredential.generate()
        try fixture.context.deviceStore(for: fixture.context.b).save(otherOwner)
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        await fixture.model.connectHealth()
        await fixture.model.confirmDailyChannel(label: "我的 iPhone")

        await fixture.model.releaseDailyChannel()

        XCTAssertFalse(fixture.model.autoSyncEnabled)
        XCTAssertFalse(fixture.model.channel?.hasActiveChannel ?? true)
        XCTAssertEqual(server.clearCount, 1)
        XCTAssertNil(try fixture.context.deviceStore(for: fixture.context.a).load())
        XCTAssertEqual(try fixture.context.deviceStore(for: fixture.context.b).load(), otherOwner)
        XCTAssertNotNil(fixture.model.session)
    }

    @MainActor
    func testServerChannelRejectionPausesSyncWithoutAttemptingAnotherSelection() async throws {
        let server = NativeModelChannelServer()
        server.rejectUploadsAsChannelChanged = true
        let fixture = try NativeModelFixture(reader: NativeModelHealthReader()) { request, context in
            try server.reply(request, context: context)
        }
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        await fixture.model.connectHealth()
        await fixture.model.confirmDailyChannel(label: "我的 iPhone")

        XCTAssertFalse(fixture.model.autoSyncEnabled)
        XCTAssertNil(fixture.model.pendingChannelConsent)
        XCTAssertNil(fixture.model.lastReceipt)
        XCTAssertEqual(server.selectionCount, 1)
        XCTAssertEqual(server.uploadCount, 1)
        XCTAssertNotNil(try fixture.context.deviceStore(for: fixture.context.a).load())
        XCTAssertNotNil(fixture.model.session)
    }
    @MainActor
    private func selectedFixture(reader: NativeModelHealthReader, server: NativeModelChannelServer,
                                 backgroundSyncBudget: Duration = .seconds(25)) throws -> NativeModelFixture {
        let fixture = try NativeModelFixture(reader: reader, backgroundSyncBudget: backgroundSyncBudget) { request, context in
            try server.reply(request, context: context)
        }
        let credential = try NativeHealthDeviceCredential.generate()
        try fixture.context.deviceStore(for: fixture.context.a).save(credential)
        server.configure(owner: fixture.context.a.user.id, token: credential.deviceToken, revision: 1)
        UserDefaults.standard.set(true, forKey: "jiashu.native.health-auto-sync." + fixture.context.a.user.id)
        return fixture
    }

    @MainActor
    func testAutomaticInvalidHealthReadHasInlineFailureWithoutPopupOrUpload() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        reader.readError = NativeHealthError.invalidRecord
        let fixture = try selectedFixture(reader: reader, server: server)
        defer { fixture.cleanup() }

        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")

        XCTAssertEqual(reader.readCount, 1)
        XCTAssertNil(fixture.model.errorMessage)
        XCTAssertTrue(fixture.model.syncMessage.contains(NativeHealthError.invalidRecord.localizedDescription))
        XCTAssertNil(fixture.model.lastReceipt)
        XCTAssertEqual(server.previewCount, 0)
        XCTAssertEqual(server.uploadCount, 0)
        XCTAssertTrue(fixture.model.autoSyncEnabled)
        XCTAssertNotNil(try fixture.store.load())
    }

    @MainActor
    func testAutomaticInvalidSnapshotNeverPreviewsOrUploadsPartialRecords() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let captured = NativeDates.parse("2026-11-17T08:00:00Z")!
        reader.snapshotOverride = NativeHealthSnapshot(capturedAt: captured, measurements: [
            NativeHealthMeasurement(id: "synthetic-out-of-range-weight", metric: "weight", value: 601, unit: "kg",
                startDate: "2026-11-17T07:00:00Z", endDate: nil, source: "synthetic-scale", aggregation: "sample"),
        ])
        let fixture = try selectedFixture(reader: reader, server: server)
        defer { fixture.cleanup() }

        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")

        XCTAssertNil(fixture.model.errorMessage)
        XCTAssertTrue(fixture.model.syncMessage.contains(NativeHealthError.invalidRecord.localizedDescription))
        XCTAssertEqual(server.previewCount, 0)
        XCTAssertEqual(server.uploadCount, 0)
        XCTAssertNil(fixture.model.lastReceipt)
    }

    @MainActor
    func testExplicitManualInvalidHealthReadPresentsItsFailure() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        reader.readError = NativeHealthError.invalidRecord
        let fixture = try selectedFixture(reader: reader, server: server)
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        XCTAssertNil(fixture.model.errorMessage)

        await fixture.model.sync()

        XCTAssertEqual(fixture.model.errorMessage, NativeHealthError.invalidRecord.localizedDescription)
        XCTAssertTrue(fixture.model.syncMessage.contains(NativeHealthError.invalidRecord.localizedDescription))
        XCTAssertEqual(reader.readCount, 2)
        XCTAssertEqual(server.uploadCount, 0)
        XCTAssertNil(fixture.model.lastReceipt)
    }

    @MainActor
    func testAutomaticNetworkFailureKeepsExistingManualErrorAndShowsInlineReason() async throws {
        let server = NativeModelChannelServer()
        let fixture = try selectedFixture(reader: NativeModelHealthReader(), server: server)
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        fixture.model.errorMessage = "Synthetic unsaved manual form"
        server.uploadFailureStatus = 503

        await fixture.model.sync(automatic: true)

        XCTAssertEqual(fixture.model.errorMessage, "Synthetic unsaved manual form")
        XCTAssertTrue(fixture.model.syncMessage.contains("Synthetic sync service failed"))
        XCTAssertTrue(fixture.model.autoSyncEnabled)
        XCTAssertNotNil(fixture.model.session)
        XCTAssertEqual(server.uploadCount, 2)
    }

    @MainActor
    func testAutomaticAuthenticationFailureStillClearsAccountWithoutPopup() async throws {
        let server = NativeModelChannelServer()
        server.uploadFailureStatus = 401
        let fixture = try selectedFixture(reader: NativeModelHealthReader(), server: server)
        defer { fixture.cleanup() }

        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")

        XCTAssertNil(fixture.model.session)
        XCTAssertNil(fixture.model.overview)
        XCTAssertNil(fixture.model.health)
        XCTAssertNil(try fixture.store.load())
        XCTAssertNil(fixture.model.errorMessage)
        XCTAssertTrue(fixture.model.syncMessage.contains("Synthetic sync service failed"))
        XCTAssertNotNil(try fixture.context.deviceStore(for: fixture.context.a).load())
    }

    @MainActor
    func testAutomaticChannelRejectionStillPausesWithoutPopup() async throws {
        let server = NativeModelChannelServer()
        server.rejectUploadsAsChannelChanged = true
        let fixture = try selectedFixture(reader: NativeModelHealthReader(), server: server)
        defer { fixture.cleanup() }

        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")

        XCTAssertFalse(fixture.model.autoSyncEnabled)
        XCTAssertNotNil(fixture.model.session)
        XCTAssertNotNil(try fixture.store.load())
        XCTAssertNil(fixture.model.errorMessage)
        XCTAssertNil(fixture.model.lastReceipt)
        XCTAssertTrue(fixture.model.syncMessage.contains("日常同步来源已变化"))
        XCTAssertEqual(server.selectionCount, 0)
        XCTAssertNotNil(try fixture.context.deviceStore(for: fixture.context.a).load())
    }

    @MainActor
    func testManualRetryWaitingForAutomaticReadPerformsOwnVisibleAttempt() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        reader.readError = NativeHealthError.invalidRecord
        let gate = NativeModelReaderGate()
        reader.readGate = gate
        let fixture = try selectedFixture(reader: reader, server: server)
        defer { gate.release(); fixture.cleanup() }
        let activation = Task { await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password") }
        await gate.waitUntilRequested()
        XCTAssertNil(fixture.model.errorMessage)
        let manualStarted = XCTestExpectation(description: "Manual retry joined automatic work")
        let manual = Task { manualStarted.fulfill(); await fixture.model.sync() }
        await fulfillment(of: [manualStarted], timeout: 10)

        gate.release()
        await activation.value
        await manual.value

        XCTAssertEqual(reader.readCount, 2)
        XCTAssertEqual(fixture.model.errorMessage, NativeHealthError.invalidRecord.localizedDescription)
        XCTAssertEqual(server.uploadCount, 0)
        XCTAssertNil(fixture.model.lastReceipt)
    }

    @MainActor
    func testAutomaticRetryWaitingForManualSuccessKeepsItsFailureSilent() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let fixture = try selectedFixture(reader: reader, server: server)
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        let gate = NativeModelReaderGate()
        reader.readGate = gate
        reader.failAtReadCount = 3
        defer { gate.release() }
        let manual = Task { await fixture.model.sync() }
        await gate.waitUntilRequested()
        let automaticStarted = XCTestExpectation(description: "Automatic update joined manual work")
        let automatic = Task { automaticStarted.fulfill(); await fixture.model.sync(automatic: true) }
        await fulfillment(of: [automaticStarted], timeout: 10)

        gate.release()
        await manual.value
        await automatic.value

        XCTAssertEqual(reader.readCount, 3)
        XCTAssertEqual(server.uploadCount, 2)
        XCTAssertNil(fixture.model.errorMessage)
        XCTAssertTrue(fixture.model.syncMessage.contains(NativeHealthError.invalidRecord.localizedDescription))
    }

    @MainActor
    func testBackgroundFailureIsSilentEvenWithoutAutomaticArgument() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let fixture = try selectedFixture(reader: reader, server: server)
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        reader.readError = NativeHealthError.invalidRecord

        await fixture.model.sync(background: true)

        XCTAssertNil(fixture.model.errorMessage)
        XCTAssertTrue(fixture.model.syncMessage.contains(NativeHealthError.invalidRecord.localizedDescription))
        XCTAssertEqual(server.uploadCount, 1)
    }

    @MainActor
    func testObserverAcknowledgesWithinItsBudgetWhileForegroundSyncIsStillRunning() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let fixture = try selectedFixture(reader: reader, server: server, backgroundSyncBudget: .milliseconds(250))
        let gate = NativeModelReaderGate()
        defer { gate.release(); fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        reader.readGate = gate
        let foreground = Task { await fixture.model.sync(automatic: true) }
        await gate.waitUntilRequested()

        let acknowledged = XCTestExpectation(description: "Observer acknowledged while foreground read is held")
        let callback = Task { await reader.notifyChange(); acknowledged.fulfill() }
        await fulfillment(of: [acknowledged], timeout: 5)
        XCTAssertTrue(fixture.model.syncing)
        XCTAssertEqual(reader.readWindows, [30, 30])
        XCTAssertEqual(server.previewCount, 1)
        XCTAssertEqual(server.uploadCount, 1)
        XCTAssertNil(fixture.model.errorMessage)

        gate.release()
        await foreground.value
        await callback.value
        XCTAssertEqual(reader.readWindows, [30, 30])
        XCTAssertEqual(server.uploadCount, 2)
        XCTAssertNotNil(fixture.model.lastReceipt)
    }

    @MainActor
    func testObserverRunsItsOwnSevenDayAttemptWhenForegroundFinishesInTime() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let fixture = try selectedFixture(reader: reader, server: server)
        let gate = NativeModelReaderGate()
        defer { gate.release(); fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        reader.readGate = gate
        let foreground = Task { await fixture.model.sync(automatic: true) }
        await gate.waitUntilRequested()

        let callbackStarted = XCTestExpectation(description: "Observer notified while foreground read is held")
        let callback = Task { callbackStarted.fulfill(); await reader.notifyChange() }
        await fulfillment(of: [callbackStarted], timeout: 5)
        gate.release()
        await foreground.value
        await callback.value

        XCTAssertEqual(reader.readWindows, [30, 30, 7])
        XCTAssertEqual(server.uploadCount, 3)
        XCTAssertNil(fixture.model.errorMessage)
        XCTAssertNotNil(fixture.model.lastReceipt)
    }

    @MainActor
    func testExpiredObserverDoesNotPreviewOrUploadWhenItsReadCompletesLate() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let fixture = try selectedFixture(reader: reader, server: server, backgroundSyncBudget: .seconds(1))
        let gate = NativeModelReaderGate()
        defer { gate.release(); fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        reader.readGate = gate

        let readStarted = XCTestExpectation(description: "Seven-day observer read started")
        reader.readStarted = { readStarted.fulfill() }
        let acknowledged = XCTestExpectation(description: "Observer acknowledged while its own read is held")
        let callback = Task { await reader.notifyChange(); acknowledged.fulfill() }
        await fulfillment(of: [readStarted, acknowledged], timeout: 5, enforceOrder: true)
        XCTAssertEqual(server.previewCount, 1)
        XCTAssertEqual(server.uploadCount, 1)
        XCTAssertNil(fixture.model.errorMessage)

        gate.release()
        await callback.value
        await fixture.model.sync()
        XCTAssertEqual(reader.readWindows, [30, 7, 30])
        XCTAssertEqual(server.previewCount, 2)
        XCTAssertEqual(server.uploadCount, 2)
    }

    @MainActor
    func testLateAutomaticFailureCannotReplaceNewAccountsError() async throws {
        let server = NativeModelChannelServer()
        let reader = NativeModelHealthReader()
        let fixture = try selectedFixture(reader: reader, server: server)
        defer { fixture.cleanup() }
        await fixture.model.login(email: fixture.context.a.user.email, password: "synthetic-password")
        let gate = NativeModelReaderGate()
        reader.readGate = gate
        reader.readError = NativeHealthError.invalidRecord
        defer { gate.release() }
        let automatic = Task { await fixture.model.sync(automatic: true) }
        await gate.waitUntilRequested()
        await fixture.model.login(email: fixture.context.b.user.email, password: "synthetic-b-password")
        fixture.model.errorMessage = "Synthetic new-account manual error"

        gate.release()
        await automatic.value

        XCTAssertEqual(fixture.model.session?.user.id, fixture.context.b.user.id)
        XCTAssertEqual(fixture.model.errorMessage, "Synthetic new-account manual error")
        XCTAssertEqual(fixture.model.overview?.health.metrics.first?.value, 200)
        XCTAssertEqual(server.uploadCount, 1)
    }
}

@MainActor
private final class NativeModelFixture {
    let model: NativeAppModel
    let store: NativeSessionStore
    let context: NativeModelFixtureContext
    let keychainService: String
    let reader: NativeModelHealthReader?
    private let host: String

    init(reader: NativeModelHealthReader? = nil, backgroundSyncBudget: Duration = .seconds(25),
         handler: @escaping (URLRequest, NativeModelFixtureContext) throws -> NativeModelDelivery) throws {
        self.reader = reader
        let unique = UUID().uuidString.lowercased()
        host = "model-" + unique + ".example"
        keychainService = "synthetic.native-model-tests." + unique
        context = NativeModelFixtureContext(unique: unique)
        store = NativeSessionStore(service: keychainService)
        UserDefaults.standard.set(false, forKey: "jiashu.native.health-auto-sync." + context.a.user.id)
        UserDefaults.standard.set(false, forKey: "jiashu.native.health-auto-sync." + context.b.user.id)
        let boundContext = context
        NativeModelProtocol.register(host: host) { request in try handler(request, boundContext) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NativeModelProtocol.self]
        let api = NativeAPI(baseURL: URL(string: "https://" + host)!, configuration: config)
        model = NativeAppModel(api: api, sessions: store, reader: reader,
                               healthDeviceService: context.healthDeviceService, backgroundSyncBudget: backgroundSyncBudget)
    }

    func cleanup() {
        reader?.stopObserving()
        try? store.clear()
        try? context.deviceStore(for: context.a).clear()
        try? context.deviceStore(for: context.b).clear()
        NativeModelProtocol.remove(host: host)
        UserDefaults.standard.removeObject(forKey: "jiashu.native.health-auto-sync." + context.a.user.id)
        UserDefaults.standard.removeObject(forKey: "jiashu.native.health-auto-sync." + context.b.user.id)
        UserDefaults.standard.removeObject(forKey: "jiashu.native.apple-activity-permission-v1." + context.a.user.id)
        UserDefaults.standard.removeObject(forKey: "jiashu.native.apple-activity-permission-v1." + context.b.user.id)
    }
}

private struct NativeModelFixtureContext: Sendable {
    let a: NativeSession
    let b: NativeSession
    let healthDeviceService: String

    init(unique: String) {
        healthDeviceService = "synthetic.native-model-devices." + unique
        a = NativeSession(accessToken: "synthetic-token-a-" + unique, expiresAt: "2099-11-16T08:00:00.000Z",
                          user: NativeUser(id: "synthetic-a-" + unique, email: "a-" + unique + "@example.com"))
        b = NativeSession(accessToken: "synthetic-token-b-" + unique, expiresAt: "2099-11-16T08:00:00.000Z",
                          user: NativeUser(id: "synthetic-b-" + unique, email: "b-" + unique + "@example.com"))
    }

    func deviceStore(for session: NativeSession) -> NativeHealthDeviceStore {
        NativeHealthDeviceStore(userID: session.user.id, service: healthDeviceService)
    }

    func owner(for request: URLRequest) -> NativeSession {
        request.value(forHTTPHeaderField: "Authorization") == "Bearer " + b.accessToken ? b : a
    }

    func standardReply(_ request: URLRequest) throws -> NativeModelDelivery {
        let path = request.url?.path ?? ""
        if path.hasSuffix("auth/login") {
            let body = try JSONSerialization.jsonObject(with: nativeModelRequestBody(request)) as? [String: String]
            let session = body?["email"] == b.user.email ? b : a
            return .immediate(NativeModelReply(status: 200, data: try JSONEncoder().encode(session)))
        }
        let isB = request.value(forHTTPHeaderField: "Authorization") == "Bearer " + b.accessToken
        let value = isB ? 200.0 : 100.0
        if path.hasSuffix("auth/refresh") {
            return .immediate(NativeModelReply(status: 200, data: try JSONEncoder().encode(isB ? b : a)))
        }
        if path.hasSuffix("auth/logout") { return .immediate(.json(["ok": true])) }
        if path == "/api/native/overview" { return .immediate(overviewReply(value: value)) }
        if path == "/api/native/health" { return .immediate(healthReply(value: value)) }
        XCTFail("Unexpected model request: \(path)")
        return .immediate(.json(["error": "Unexpected fixture request"], status: 404))
    }

    func overviewReply(value: Double) -> NativeModelReply {
        .json(["asOf": "2026-11-16T08:00:00Z", "today": "2026-11-16", "health": [
            "status": "ready", "lastSync": "2026-11-16T08:00:00Z", "recordedMetricCount": 1,
            "metrics": [["metric": "steps", "label": "步数", "value": value, "unit": "步", "day": "2026-11-16",
                "freshness": "current", "points": [["day": "2026-11-16", "value": value]],
                "average7": value, "observedDays7": 1]]], "priorities": []])
    }

    func healthReply(value: Double) -> NativeModelReply {
        let point: [String: Any] = ["day": "2026-11-16", "value": value, "measuredAt": "2026-11-16T08:00:00Z", "source": "synthetic-health"]
        let metric: [String: Any] = ["metric": "steps", "label": "步数", "unit": "count", "latestValue": value,
                                  "latestDate": "2026-11-16T08:00:00Z", "points": [point]]
        let measurement: [String: Any] = ["id": "synthetic-step", "metric": "steps", "value": value, "unit": "count",
            "startDate": "2026-11-15T16:00:00Z", "endDate": "2026-11-16T08:00:00Z", "source": "synthetic-health", "aggregation": "daily"]
        return .json(["summary": ["metrics": ["steps": metric], "measurementCount": 1, "lastMeasurementAt": "2026-11-16T08:00:00Z"],
                      "measurements": [measurement], "lastSync": "2026-11-16T08:00:00Z"])
    }
}

private func nativeModelRequestBody(_ request: URLRequest) -> Data {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open(); defer { stream.close() }
    var data = Data(), buffer = [UInt8](repeating: 0, count: 1024)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        data.append(buffer, count: count)
    }
    return data
}

private struct NativeModelReply: Sendable {
    let status: Int
    let data: Data
    static func json(_ values: [String: Any], status: Int = 200) -> Self {
        Self(status: status, data: try! JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]))
    }
}
private enum NativeModelDelivery {
    case immediate(NativeModelReply)
    case held(NativeModelReplyGate, NativeModelReply)
}

/// Test-controlled arrival/release gates remove timing assumptions from races.
private final class NativeModelReplyGate: @unchecked Sendable {
    private let lock = NSLock()
    private var seen = false
    private var released = false
    private let requested = XCTestExpectation(description: "Controlled request arrived")
    private var completions: [() -> Void] = []

    func waitUntilRequested() async {
        let result = await XCTWaiter.fulfillment(of: [requested], timeout: 10)
        XCTAssertEqual(result, .completed, "Expected controlled request did not arrive")
    }
    func hold(_ completion: @escaping () -> Void) {
        lock.lock()
        let firstRequest = !seen
        seen = true
        if !released { completions.append(completion) }
        let deliverNow = released
        lock.unlock()
        if firstRequest { requested.fulfill() }
        if deliverNow { completion() }
    }
    func release() {
        lock.lock()
        released = true
        let pending = completions
        completions.removeAll()
        lock.unlock()
        pending.forEach { $0() }
    }
}

private final class NativeModelRequestCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    func next(_ name: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        let count = (counts[name] ?? 0) + 1
        counts[name] = count
        return count
    }
    func value(_ name: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return counts[name] ?? 0
    }
}

private final class NativeModelProtocol: URLProtocol, @unchecked Sendable {
    private static let registryLock = NSLock()
    private static var handlers: [String: (URLRequest) throws -> NativeModelDelivery] = [:]
    private let stateLock = NSLock()
    private var stopped = false
    static func register(host: String, handler: @escaping (URLRequest) throws -> NativeModelDelivery) {
        registryLock.lock(); defer { registryLock.unlock() }; handlers[host] = handler
    }
    static func remove(host: String) {
        registryLock.lock(); defer { registryLock.unlock() }; handlers.removeValue(forKey: host)
    }
    override class func canInit(with request: URLRequest) -> Bool {
        registryLock.lock(); defer { registryLock.unlock() }; return request.url?.host.map { handlers[$0] != nil } ?? false
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.registryLock.lock()
        let handler = request.url?.host.flatMap { Self.handlers[$0] }
        Self.registryLock.unlock()
        do {
            guard let handler else { throw URLError(.badURL) }
            switch try handler(request) {
            case .immediate(let reply): deliver(reply)
            case .held(let gate, let reply): gate.hold { [weak self] in self?.deliver(reply) }
            }
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    private func deliver(_ reply: NativeModelReply) {
        stateLock.lock(); let canDeliver = !stopped; stateLock.unlock()
        guard canDeliver, let url = request.url else { return }
        let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { stateLock.lock(); stopped = true; stateLock.unlock() }
}

@MainActor
private final class NativeModelHealthReader: NativeHealthReading {
    private(set) var authorizationCount = 0
    private(set) var readWindows: [Int] = []
    var readCount: Int { readWindows.count }
    private(set) var stopCount = 0
    private(set) var observerCount = 0
    var readError: Error?
    var failAtReadCount: Int?
    var snapshotOverride: NativeHealthSnapshot?
    var activitySnapshot: NativeAppleActivitySnapshot?
    var activityBackgroundAvailable = true
    private(set) var activityReadWindows: [Int] = []
    private(set) var observerAppleActivityFlags: [Bool] = []
    var readGate: NativeModelReaderGate?
    var readStarted: (() -> Void)?
    private var callback: (@Sendable () async -> Void)?

    func authorize() async throws { authorizationCount += 1 }

    func read(days: Int) async throws -> NativeHealthSnapshot {
        readWindows.append(days)
        readStarted?()
        readStarted = nil
        if let gate = readGate {
            readGate = nil
            await gate.hold()
        }
        if let failAtReadCount, readCount >= failAtReadCount { throw NativeHealthError.invalidRecord }
        if let readError { throw readError }
        if let snapshotOverride { return snapshotOverride }
        let captured = NativeDates.parse("2026-11-17T08:00:00Z")!
        return NativeHealthSnapshot(capturedAt: captured, measurements: [
            NativeHealthMeasurement(id: "synthetic-daily-steps", metric: "steps", value: 1234, unit: "count",
                startDate: "2026-11-16T16:00:00.000Z", endDate: "2026-11-17T08:00:00.000Z",
                source: "apple-health-merged", aggregation: "daily"),
        ])
    }

    func readAppleActivity(days: Int) async throws -> NativeAppleActivitySnapshot? {
        activityReadWindows.append(days)
        return activitySnapshot
    }

    func startObserving(includingAppleActivity: Bool, onChange: @escaping @Sendable () async -> Void) async throws -> Bool {
        observerCount += 1
        observerAppleActivityFlags.append(includingAppleActivity)
        callback = onChange
        return !includingAppleActivity || activityBackgroundAvailable
    }

    func notifyChange() async {
        guard let callback else { XCTFail("Expected a registered HealthKit observer"); return }
        await callback()
    }

    func stopObserving() { stopCount += 1; callback = nil }
}

/// A small stateful server fixture models account-scoped source selection and
/// an acknowledgement lost after commit. All observations cross a lock, and
/// no fixture secret is logged or placed in UserDefaults.
private final class NativeModelChannelServer: @unchecked Sendable {
    private struct Selection {
        let revision: Int
        let token: String?
        let label: String?
    }
    private let lock = NSLock()
    private var selections: [String: Selection] = [:]
    private var selectionsWritten = 0
    private var statusesRead = 0
    private var uploadsReceived = 0
    private var previewsReceived = 0
    private var uploadFailure: Int?
    private var channelsCleared = 0
    private var credentialsSavedBeforeWrite = 0
    private var failSelection = false
    private var rejectUploads = false

    var selectionCount: Int { locked { selectionsWritten } }
    var statusCount: Int { locked { statusesRead } }
    var uploadCount: Int { locked { uploadsReceived } }
    var previewCount: Int { locked { previewsReceived } }
    var uploadFailureStatus: Int? {
        get { locked { uploadFailure } }
        set { locked { uploadFailure = newValue } }
    }
    var clearCount: Int { locked { channelsCleared } }
    var savedBeforeSelectionCount: Int { locked { credentialsSavedBeforeWrite } }
    var failNextSelectionAfterCommit: Bool {
        get { locked { failSelection } }
        set { locked { failSelection = newValue } }
    }
    var rejectUploadsAsChannelChanged: Bool {
        get { locked { rejectUploads } }
        set { locked { rejectUploads = newValue } }
    }

    private func locked<T>(_ operation: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }; return operation()
    }

    func configure(owner: String, token: String?, revision: Int) {
        locked { selections[owner] = Selection(revision: revision, token: token, label: token == nil ? nil : "Synthetic iPhone") }
    }

    func selectedToken(owner: String) -> String? { locked { selections[owner]?.token } }

    private func statusReply(owner: String, credential: String?) -> NativeModelReply {
        let selection = locked { selections[owner] ?? Selection(revision: 0, token: nil, label: nil) }
        let active = selection.token != nil
        let current = credential != nil && selection.token == credential
        return .json([
            "revision": selection.revision,
            "deviceId": active ? "synthetic-selected-device" as Any : NSNull(),
            "label": selection.label.map { $0 as Any } ?? NSNull(),
            "updatedAt": selection.revision == 0 ? NSNull() : "2026-11-17T08:00:00Z" as Any,
            "isCurrentDevice": active && current,
        ])
    }

    func reply(_ request: URLRequest, context: NativeModelFixtureContext) throws -> NativeModelDelivery {
        let path = request.url?.path ?? ""
        let owner = context.owner(for: request)
        let suppliedDevice = request.value(forHTTPHeaderField: "X-Sync-Device")
        if path == "/api/native/sync/channel" {
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            if request.httpMethod == "GET" {
                locked { statusesRead += 1 }
                return .immediate(statusReply(owner: owner.user.id, credential: suppliedDevice))
            }
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: nativeModelRequestBody(request)) as? [String: Any])
            let expected = try XCTUnwrap(body["expectedRevision"] as? Int)
            if request.httpMethod == "PUT" {
                let token = try XCTUnwrap(body["deviceToken"] as? String)
                let label = try XCTUnwrap(body["label"] as? String)
                let persisted = try context.deviceStore(for: owner).load()
                XCTAssertEqual(persisted?.deviceToken, token, "The exact selected credential must already be in Keychain before PUT")
                let result: (matched: Bool, failAfterCommit: Bool) = locked {
                    selectionsWritten += 1
                    if persisted?.deviceToken == token { credentialsSavedBeforeWrite += 1 }
                    guard (selections[owner.user.id]?.revision ?? 0) == expected else { return (false, false) }
                    selections[owner.user.id] = Selection(revision: expected + 1, token: token, label: label)
                    let fail = failSelection
                    failSelection = false
                    return (true, fail)
                }
                if !result.matched {
                    return .immediate(.json(["error": "来源设置已变化", "code": "NATIVE_HEALTH_CHANNEL_CONFLICT"], status: 409))
                }
                if result.failAfterCommit {
                    return .immediate(.json(["error": "回执暂时不可用", "code": "HEALTH_STORAGE_UNAVAILABLE"], status: 503))
                }
                return .immediate(statusReply(owner: owner.user.id, credential: token))
            }
            if request.httpMethod == "DELETE" {
                let cleared: Bool = locked {
                    channelsCleared += 1
                    guard let selection = selections[owner.user.id], selection.revision == expected,
                          suppliedDevice != nil, selection.token == suppliedDevice else { return false }
                    selections[owner.user.id] = Selection(revision: expected + 1, token: nil, label: nil)
                    return true
                }
                if !cleared {
                    return .immediate(.json(["error": "来源设置已变化", "code": "NATIVE_HEALTH_CHANNEL_NOT_CURRENT"], status: 409))
                }
                return .immediate(statusReply(owner: owner.user.id, credential: suppliedDevice))
            }
        }
        if path == "/api/native/health/import/preview" || (path == "/api/native/health/import" && request.httpMethod == "POST") {
            let selected = selectedToken(owner: owner.user.id)
            XCTAssertNotNil(suppliedDevice)
            XCTAssertEqual(suppliedDevice, selected)
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Confirm-Source-Changes"), "Daily source consent must never manufacture a per-batch source confirmation")
            if path.hasSuffix("preview") {
                locked { previewsReceived += 1 }
                return .immediate(.json([
                    "preview": ["token": "synthetic-preview-token", "total": 1, "added": 0, "updated": 1,
                        "skipped": 0, "sourceChanges": 1, "manualOverrides": 0, "from": "2026-11-17",
                        "to": "2026-11-17", "metrics": ["步数"], "examples": []] as [String: Any],
                ]))
            }
            let result = locked { uploadsReceived += 1; return (rejectUploads, uploadFailure) }
            if let status = result.1 {
                return .immediate(.json(["error": "Synthetic sync service failed", "code": status == 401 ? "NATIVE_SIGN_IN_REQUIRED" : "HEALTH_STORAGE_UNAVAILABLE"], status: status))
            }
            if result.0 {
                return .immediate(.json(["error": "日常同步来源已变化", "code": "HEALTH_SYNC_CHANNEL_CHANGED"], status: 409))
            }
            return .immediate(.json(["ok": true, "imported": 1, "skipped": 0,
                "lastSync": "2026-11-17T08:00:00Z", "batchId": "synthetic-batch"]))
        }
        return try context.standardReply(request)
    }
}


@MainActor
private final class NativeModelReaderGate {
    private let requested = XCTestExpectation(description: "Health read is suspended")
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false

    func hold() async {
        requested.fulfill()
        await withCheckedContinuation { continuation in
            if released { continuation.resume() }
            else { self.continuation = continuation }
        }
    }

    func waitUntilRequested() async {
        let result = await XCTWaiter.fulfillment(of: [requested], timeout: 10)
        XCTAssertEqual(result, .completed)
    }

    func release() {
        released = true
        continuation?.resume()
        continuation = nil
    }
}
