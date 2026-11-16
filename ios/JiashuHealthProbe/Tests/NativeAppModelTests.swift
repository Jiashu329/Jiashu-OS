import Foundation
import Security
import XCTest
@testable import JiashuHealthProbe

final class NativeAppModelTests: XCTestCase {
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
        XCTAssertNil(fixture.model.health)
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
        XCTAssertNil(fixture.model.pendingImport)
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
        XCTAssertNotNil(fixture.model.errorMessage)
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
}

@MainActor
private final class NativeModelFixture {
    let model: NativeAppModel
    let store: NativeSessionStore
    let context: NativeModelFixtureContext
    let keychainService: String
    private let host: String

    init(handler: @escaping (URLRequest, NativeModelFixtureContext) throws -> NativeModelDelivery) throws {
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
        model = NativeAppModel(api: api, sessions: store)
    }

    func cleanup() {
        try? store.clear()
        NativeModelProtocol.remove(host: host)
        UserDefaults.standard.removeObject(forKey: "jiashu.native.health-auto-sync." + context.a.user.id)
        UserDefaults.standard.removeObject(forKey: "jiashu.native.health-auto-sync." + context.b.user.id)
    }
}

private struct NativeModelFixtureContext: Sendable {
    let a: NativeSession
    let b: NativeSession

    init(unique: String) {
        a = NativeSession(accessToken: "synthetic-token-a-" + unique, expiresAt: "2099-11-16T08:00:00.000Z",
                          user: NativeUser(id: "synthetic-a-" + unique, email: "a-" + unique + "@example.com"))
        b = NativeSession(accessToken: "synthetic-token-b-" + unique, expiresAt: "2099-11-16T08:00:00.000Z",
                          user: NativeUser(id: "synthetic-b-" + unique, email: "b-" + unique + "@example.com"))
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
