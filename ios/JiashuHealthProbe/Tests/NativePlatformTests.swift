import Foundation
import XCTest
@testable import JiashuHealthProbe

final class NativePlatformTests: XCTestCase {
    func testReadAllFreezesOriginalUnreadIDsInsteadOfSendingReadAll() throws {
        let pending = try NativeNotificationPending.read(owner: "synthetic-owner", ids: ["sync:old", "balance:personal:2026-11"])
        XCTAssertEqual(pending.body["action"].stringValue, "read")
        XCTAssertEqual(pending.body["ids"].arrayValue, [.string("sync:old"), .string("balance:personal:2026-11")])
        let restored = try JSONDecoder().decode(NativeNotificationPending.self, from: JSONEncoder().encode(pending))
        XCTAssertEqual(restored, pending)
        XCTAssertThrowsError(try restored.validate(owner: "another-owner"))
        XCTAssertThrowsError(try NativeNotificationPending.read(owner: "owner", ids: []))
        XCTAssertThrowsError(try NativeNotificationPending.read(owner: "owner", ids: ["sync:a", "sync:a"]))
        XCTAssertThrowsError(try NativeNotificationPending.read(owner: "owner", ids: ["sync:a/b"]))
    }

    func testSettingsKeepExactFourCategoriesAndObservedRevision() throws {
        var preferences = NativeNotificationContract.defaults; preferences["sync"] = false
        let pending = try NativeNotificationPending.settings(owner: "owner", categories: preferences, revision: 7)
        XCTAssertEqual(Set(pending.body.objectValue.keys), ["action", "categories", "expectedRevision"])
        XCTAssertEqual(pending.body["expectedRevision"].intValue, 7)
        XCTAssertEqual(pending.body["categories"]["sync"], .bool(false))
        try pending.validate(owner: "owner")
        preferences["unexpected"] = true
        XCTAssertThrowsError(try NativeNotificationPending.settings(owner: "owner", categories: preferences, revision: 7))
        XCTAssertThrowsError(try NativeNotificationPending.settings(owner: "owner", categories: NativeNotificationContract.defaults, revision: -1))
        var altered = pending.body.objectValue; altered["readAll"] = .bool(true)
        XCTAssertThrowsError(try NativeNotificationPending(ownerID: "owner", body: .object(altered)).validate(owner: "owner"))
    }

    func testFeedDoesNotTreatUnreadCountMismatchOrDuplicateIDsAsEmpty() throws {
        let valid = platformFeed(ids: ["sync:a"])
        XCTAssertEqual(try NativeNotificationContract.feed(valid), valid)
        var fields = valid.objectValue; fields["unreadCount"] = .number(2)
        XCTAssertThrowsError(try NativeNotificationContract.feed(.object(fields)))
        fields = valid.objectValue; fields["unreadIds"] = .array([.string("sync:a"), .string("sync:a")]); fields["unreadCount"] = .number(2)
        XCTAssertThrowsError(try NativeNotificationContract.feed(.object(fields)))
        fields = valid.objectValue; fields["unavailable"] = .array([.string("sync")])
        XCTAssertEqual(try NativeNotificationContract.feed(.object(fields))["unavailable"], .array([.string("sync")]))
    }

    func testNotificationsNavigateNativelyAndKeepFamilyPermissionParameters() {
        let destination = "/finance/activity?ledger=family&book=synthetic-book&bookRevision=7"
        XCTAssertEqual(NativeNotificationContract.destination(destination), destination)
        XCTAssertEqual(NativeNotificationContract.destination("https://www.treefund.asia" + destination), destination)
        XCTAssertEqual(NativeNotificationContract.destination("/sync"), "/sync")
        for href in ["https://evil.example/finance", "//evil.example/sync", "javascript:alert(1)",
                     "https://www.treefund.asia@evil.example/sync", "http://www.treefund.asia/sync",
                     "/api/health/export", "/finance#secret", "/%66inance", "/finance\\evil"] {
            XCTAssertNil(NativeNotificationContract.destination(href), href)
        }
    }

    func testUnknownNonIdempotentConnectionCreationNeverPermitsAutomaticResubmission() throws {
        let errors: [Error] = [NativeAPIError.connection, NativeAPIError.invalidResponse, CancellationError(),
                               NativeAPIError.server(status: 503, code: nil, message: "暂不可用", retryAfter: nil),
                               NativeAPIError.server(status: 409, code: nil, message: "冲突", retryAfter: nil)]
        for error in errors {
            XCTAssertFalse(NativeSyncConnectionRules.definitiveCreationRejection(error))
        }
        XCTAssertTrue(NativeSyncConnectionRules.definitiveCreationRejection(
            NativeAPIError.server(status: 400, code: nil, message: "无效名称", retryAfter: nil)))
        let pending = NativeSyncPendingCreation(ownerID: "owner", label: "我的手机", startedAt: "2026-11-17T00:00:00.000Z")
        let saved = try JSONEncoder().encode(pending)
        XCTAssertEqual(try JSONDecoder().decode(NativeSyncPendingCreation.self, from: saved), pending)
        let keys = try XCTUnwrap(JSONSerialization.jsonObject(with: saved) as? [String: Any])
        XCTAssertEqual(Set(keys.keys), ["ownerID", "label", "startedAt"], "An uncertain creation stores no plaintext credential")
    }

    func testConnectionLabelUsesBackendUTF16LimitAndRejectsControls() throws {
        XCTAssertEqual(try NativeSyncConnectionRules.validatedLabel("  我的 iPhone  "), "我的 iPhone")
        XCTAssertThrowsError(try NativeSyncConnectionRules.validatedLabel("bad\nname"))
        XCTAssertThrowsError(try NativeSyncConnectionRules.validatedLabel(""))
        XCTAssertThrowsError(try NativeSyncConnectionRules.validatedLabel(String(repeating: "📱", count: 21)))
        XCTAssertEqual(try NativeSyncConnectionRules.validatedLabel(String(repeating: "📱", count: 20)).utf16.count, 40)
    }

    @MainActor
    func testUnknownReadResponseRetriesSameIDsEvenAfterNewMessagesArrive() async throws {
        let calls = PlatformCalls(), fixture = platformClient { request in
            if request.httpMethod == "POST" {
                let body = try JSONDecoder().decode(NativeJSON.self, from: platformBody(request))
                let count = calls.record(body)
                return count == 1 ? PlatformReply(status: 503, value: .object(["error": .string("未知保存结果")]))
                    : PlatformReply(value: .object(["ok": .bool(true), "readCount": .number(1)]))
            }
            return PlatformReply(value: platformFeed(ids: calls.count == 0 ? ["sync:old"] : ["sync:old", "sync:new"]))
        }
        let owner = "platform-read-" + UUID().uuidString
        defer { fixture.cleanup(); try? NativeWorkspacePersistence(userID: owner, scope: "notifications-pending-command").clear() }
        let model = NativeNotificationsModel(api: fixture.api, token: "synthetic-token", userID: owner)
        await model.activate(token: "synthetic-token", userID: owner)
        await model.markAllVisibleUnread()
        XCTAssertNotNil(model.pending)
        await model.load()
        XCTAssertEqual(model.feed["unreadCount"].intValue, 2)
        await model.retry()
        XCTAssertNil(model.pending)
        XCTAssertEqual(calls.bodies.count, 2)
        XCTAssertEqual(calls.bodies[0], calls.bodies[1])
        XCTAssertEqual(calls.bodies[1]["ids"].arrayValue, [.string("sync:old")])
    }

    @MainActor
    func testSettingsConflictPreservesDraftAndRequiresExplicitRevisionRefresh() async throws {
        let calls = PlatformCalls(), fixture = platformClient { request in
            if request.httpMethod == "POST" {
                let body = try JSONDecoder().decode(NativeJSON.self, from: platformBody(request))
                let count = calls.record(body)
                if count == 1 { return PlatformReply(status: 409, value: .object(["error": .string("设置已变化"), "code": .string("NOTIFICATIONS_SETTINGS_CHANGED")])) }
                return PlatformReply(value: .object(["settings": .object([
                    "categories": body["categories"], "revision": .number(4), "updatedAt": .string("2026-11-17T00:00:00.000Z")])]))
            }
            let revision = calls.count == 0 ? 2 : calls.count == 1 ? 3 : 4
            let preferences = calls.count >= 2
                ? (calls.bodies.last?["categories"].objectValue ?? [:]).compactMapValues(\.boolValue)
                : NativeNotificationContract.defaults
            return PlatformReply(value: platformFeed(ids: [], revision: revision, preferences: preferences))
        }
        let owner = "platform-settings-" + UUID().uuidString
        defer { fixture.cleanup(); try? NativeWorkspacePersistence(userID: owner, scope: "notifications-pending-command").clear() }
        let model = NativeNotificationsModel(api: fixture.api, token: "synthetic-token", userID: owner)
        await model.activate(token: "synthetic-token", userID: owner)
        model.setCategory("sync", enabled: false)
        await model.saveSettings()
        XCTAssertTrue(model.settingsConflict)
        XCTAssertEqual(model.preferences["sync"], false)
        XCTAssertNil(model.pending)
        await model.saveSettings()
        XCTAssertEqual(calls.count, 1, "A conflict must not silently adopt a new version")
        await model.load(rebaseSettings: true)
        XCTAssertFalse(model.settingsConflict)
        XCTAssertEqual(model.settingsRevision, 3)
        XCTAssertEqual(model.preferences["sync"], false)
        await model.saveSettings()
        XCTAssertEqual(calls.bodies.last?["expectedRevision"].intValue, 3)
        XCTAssertEqual(model.settingsRevision, 4)
        XCTAssertEqual(model.preferences["sync"], false)
    }

    @MainActor
    func testCredentialRenewalKeepsUnsavedReminderPreferencesAndFilterWithoutReload() async throws {
        let requests = PlatformCalls()
        let fixture = platformClient { request in
            _ = requests.record(.object(["authorization": .string(request.value(forHTTPHeaderField: "Authorization") ?? "")]))
            return PlatformReply(value: platformFeed(ids: ["sync:existing"], revision: 2))
        }
        let owner = "platform-renewal-draft-" + UUID().uuidString
        defer { fixture.cleanup(); try? NativeWorkspacePersistence(userID: owner, scope: "notifications-pending-command").clear() }
        let model = NativeNotificationsModel(api: fixture.api, token: "synthetic-old-token", userID: owner)
        await model.activate(token: "synthetic-old-token", userID: owner)
        await model.filter(unread: true)
        model.setCategory("sync", enabled: false)
        let originalFeed = model.feed, originalRequestCount = requests.count

        model.updateCredential(token: "synthetic-renewed-token", userID: owner)
        XCTAssertEqual(requests.count, originalRequestCount, "Renewal must not restore or reload over an active editor")
        XCTAssertEqual(model.feed, originalFeed)
        XCTAssertEqual(model.preferences["sync"], false)
        XCTAssertEqual(model.settingsRevision, 2)
        XCTAssertTrue(model.unreadOnly)
        XCTAssertTrue(model.canSavePreferences)
        await model.load()
        XCTAssertEqual(requests.bodies.last?["authorization"].stringValue, "Bearer synthetic-renewed-token")
        XCTAssertEqual(model.preferences["sync"], false)
    }

    @MainActor
    func testCredentialRenewalRetainsFrozenReminderWriteAndRetriesWithNewCredential() async throws {
        let calls = PlatformCalls()
        let fixture = platformClient { request in
            if request.httpMethod == "POST" {
                let body = try JSONDecoder().decode(NativeJSON.self, from: platformBody(request))
                let count = calls.record(.object(["body": body, "authorization": .string(request.value(forHTTPHeaderField: "Authorization") ?? "")]))
                if count == 1 { return PlatformReply(status: 503, value: .object(["error": .string("合成未知保存结果")])) }
                return PlatformReply(value: .object(["settings": .object(["categories": body["categories"], "revision": .integer(3)])]))
            }
            let preferences = calls.count >= 2 ? (calls.bodies.last?["body"]["categories"].objectValue ?? [:]).compactMapValues(\.boolValue) : NativeNotificationContract.defaults
            return PlatformReply(value: platformFeed(ids: [], revision: calls.count >= 2 ? 3 : 2, preferences: preferences))
        }
        let owner = "platform-renewal-pending-" + UUID().uuidString
        defer { fixture.cleanup(); try? NativeWorkspacePersistence(userID: owner, scope: "notifications-pending-command").clear() }
        let model = NativeNotificationsModel(api: fixture.api, token: "synthetic-old-token", userID: owner)
        await model.activate(token: "synthetic-old-token", userID: owner)
        model.setCategory("balances", enabled: false)
        await model.saveSettings()
        let original = try XCTUnwrap(model.pending)

        model.updateCredential(token: "synthetic-renewed-token", userID: owner)
        XCTAssertEqual(model.pending, original)
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(model.preferences["balances"], false)
        await model.retry()
        XCTAssertNil(model.pending)
        XCTAssertEqual(calls.bodies[0]["body"], calls.bodies[1]["body"])
        XCTAssertEqual(calls.bodies[1]["authorization"].stringValue, "Bearer synthetic-renewed-token")
    }

    @MainActor
    func testPendingNotificationsAreAccountScopedAndNeverAutoSubmittedOnRestore() async throws {
        let calls = PlatformCalls(), fixture = platformClient { request in
            if request.httpMethod == "POST" { _ = calls.record(.null) }
            return PlatformReply(value: platformFeed(ids: []))
        }
        let a = "platform-a-" + UUID().uuidString, b = "platform-b-" + UUID().uuidString
        let storeA = NativeWorkspacePersistence(userID: a, scope: "notifications-pending-command")
        let storeB = NativeWorkspacePersistence(userID: b, scope: "notifications-pending-command")
        defer { fixture.cleanup(); try? storeA.clear(); try? storeB.clear() }
        try storeA.save(NativeNotificationPending.read(owner: a, ids: ["sync:a"]))
        let model = NativeNotificationsModel(api: fixture.api, token: "synthetic-b-token", userID: b)
        await model.activate(token: "synthetic-b-token", userID: b)
        XCTAssertNil(model.pending)
        await model.activate(token: "synthetic-a-token", userID: a)
        XCTAssertEqual(model.pending?.ownerID, a)
        XCTAssertEqual(calls.count, 0)
        model.invalidate()
        XCTAssertNil(model.pending)
        XCTAssertTrue(model.feed.isNull)
    }
}

private func platformFeed(ids: [String], revision: Int = 0, preferences: [String: Bool] = NativeNotificationContract.defaults) -> NativeJSON {
    .object(["items": .array(ids.map { id in .object(["id": .string(id), "category": .string("sync"),
        "title": .string("合成同步提醒"), "summary": .string("核对合成记录"), "href": .string("/sync"),
        "createdAt": .string("2026-11-17T00:00:00.000Z"), "readAt": .null]) }),
        "total": .integer(ids.count), "unreadCount": .integer(ids.count), "unreadIds": .array(ids.map(NativeJSON.string)),
        "offset": .number(0), "limit": .number(20), "hasMore": .bool(false), "unavailable": .array([]), "truncated": .bool(false),
        "settings": .object(["categories": .object(preferences.mapValues(NativeJSON.bool)),
                             "revision": .integer(revision), "updatedAt": .null])])
}

private func platformBody(_ request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open(); defer { stream.close() }
    var output = Data(), buffer = [UInt8](repeating: 0, count: 1024)
    while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; output.append(buffer, count: count) }
    return output
}

private final class PlatformCalls: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [NativeJSON] = []
    var bodies: [NativeJSON] { lock.lock(); defer { lock.unlock() }; return values }
    var count: Int { bodies.count }
    func record(_ body: NativeJSON) -> Int { lock.lock(); defer { lock.unlock() }; values.append(body); return values.count }
}

private struct PlatformReply {
    var status = 200
    let value: NativeJSON
}
private struct PlatformClient {
    let api: NativeAPI
    let host: String
    func cleanup() { NativePlatformProtocol.remove(host: host) }
}
private func platformClient(_ handler: @escaping (URLRequest) throws -> PlatformReply) -> PlatformClient {
    let host = "platform-" + UUID().uuidString.lowercased() + ".example"
    NativePlatformProtocol.register(host: host, handler: handler)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NativePlatformProtocol.self]
    return PlatformClient(api: NativeAPI(baseURL: URL(string: "https://" + host)!, configuration: configuration), host: host)
}
private final class NativePlatformProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var handlers: [String: (URLRequest) throws -> PlatformReply] = [:]
    static func register(host: String, handler: @escaping (URLRequest) throws -> PlatformReply) { lock.lock(); defer { lock.unlock() }; handlers[host] = handler }
    static func remove(host: String) { lock.lock(); defer { lock.unlock() }; handlers.removeValue(forKey: host) }
    override class func canInit(with request: URLRequest) -> Bool { lock.lock(); defer { lock.unlock() }; return handlers[request.url?.host ?? ""] != nil }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let handler = Self.handlers[request.url?.host ?? ""]; Self.lock.unlock()
        do {
            guard let handler, let url = request.url else { throw URLError(.badURL) }
            let reply = try handler(request), data = try reply.value.encodedData()
            let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
