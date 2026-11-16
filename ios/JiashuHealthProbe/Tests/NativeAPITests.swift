import Foundation
import XCTest
@testable import JiashuHealthProbe

final class NativeAPITests: XCTestCase {
    private var hosts: [String] = []
    private var keychainServices: [String] = []

    override func tearDown() {
        hosts.forEach { NativeStubProtocol.remove(host: $0) }
        keychainServices.forEach { try? NativeSessionStore(service: $0).clear() }
        super.tearDown()
    }

    private func api(_ handler: @escaping (URLRequest) throws -> NativeStubReply) -> NativeAPI {
        let host = "native-" + UUID().uuidString.lowercased() + ".example"
        hosts.append(host)
        NativeStubProtocol.register(host: host, handler: handler)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NativeStubProtocol.self]
        return NativeAPI(baseURL: URL(string: "https://" + host)!, configuration: config)
    }

    private var sessionJSON: String {
        """
        {"accessToken":"synthetic-native-token","expiresAt":"2099-11-16T08:00:00.000Z","user":{"id":"synthetic-user-a","email":"synthetic@example.com"}}
        """
    }

    private func requestBody(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let length = stream.read(&buffer, maxLength: buffer.count)
            if length <= 0 { break }
            data.append(buffer, count: length)
        }
        return data
    }

    func testLoginUsesJSONAndDoesNotAttachBrowserCredentials() async throws {
        let json = sessionJSON
        let client = api { request in
            XCTAssertEqual(request.url?.path, "/api/native/auth/login")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertFalse(request.httpShouldHandleCookies)
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: self.requestBody(request)) as? [String: String])
            XCTAssertEqual(body, ["email": "synthetic@example.com", "password": "synthetic-password"])
            return .json(json)
        }
        let session = try await client.login(email: "synthetic@example.com", password: "synthetic-password")
        XCTAssertEqual(session.user.id, "synthetic-user-a")
        XCTAssertEqual(session.accessToken, "synthetic-native-token")
        XCTAssertFalse(session.isExpired)
    }

    func testRefreshAndLogoutUseTheExistingDeviceSession() async throws {
        let json = sessionJSON
        let client = api { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-token")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            if request.url?.path.hasSuffix("refresh") == true { return .json(json) }
            XCTAssertEqual(request.url?.path, "/api/native/auth/logout")
            return .json("{\"ok\":true}")
        }
        let refreshed = try await client.refresh(token: "synthetic-native-token")
        XCTAssertEqual(refreshed.user.id, "synthetic-user-a")
        try await client.logout(token: refreshed.accessToken)
    }

    func testOverviewPreservesMissingAndRecordedZeroValues() async throws {
        let client = api { request in
            XCTAssertEqual(request.url?.path, "/api/native/overview")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-token")
            return .json("""
            {"asOf":"2026-11-16T08:00:00Z","today":"2026-11-16","health":{"status":"ready","lastSync":null,"recordedMetricCount":1,"metrics":[{"metric":"steps","label":"步数","value":0,"unit":"步","day":"2026-11-16","freshness":"current","points":[{"day":"2026-11-16","value":0}],"average7":0,"observedDays7":1},{"metric":"sleep","label":"睡眠","value":null,"unit":"小时","day":null,"freshness":"missing","points":[],"average7":null,"observedDays7":0}]},"priorities":[]}
            """)
        }
        let overview = try await client.overview(token: "synthetic-native-token")
        XCTAssertEqual(overview.health.metrics[0].value, 0)
        XCTAssertNil(overview.health.metrics[1].value)
        XCTAssertNil(overview.health.lastSync)
    }

    func testHealthUsesExplicitRangeAndPreservesEmptyMetric() async throws {
        let client = api { request in
            XCTAssertEqual(request.url?.query, "days=30")
            return .json("""
            {"summary":{"metrics":{"weight":{"metric":"weight","label":"体重","unit":"kg","latestValue":null,"latestDate":null,"points":[]}},"measurementCount":0,"lastMeasurementAt":null},"measurements":[],"lastSync":null}
            """)
        }
        let health = try await client.health(token: "synthetic-native-token", days: 30)
        XCTAssertNil(health.summary.metrics["weight"]?.latestValue)
        XCTAssertTrue(health.measurements.isEmpty)
    }

    func testImportPreviewAndUploadPreserveExactBatchAndRequireExplicitSourceConfirmation() async throws {
        let payload = Data("{\"version\":1,\"synthetic\":true}".utf8)
        var uploadCount = 0
        let client = api { request in
            XCTAssertEqual(self.requestBody(request), payload)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-token")
            if request.url?.path.hasSuffix("/preview") == true {
                XCTAssertNil(request.value(forHTTPHeaderField: "X-Confirm-Source-Changes"))
                return .json("""
                {"preview":{"token":"synthetic-preview-token","total":1,"added":0,"updated":1,"skipped":0,"sourceChanges":1,"manualOverrides":0,"from":"2026-11-15","to":"2026-11-15","metrics":["步数"],"examples":[]}}
                """)
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Import-Preview"), "synthetic-preview-token")
            uploadCount += 1
            let confirmed = request.value(forHTTPHeaderField: "X-Confirm-Source-Changes")
            if uploadCount == 1 { XCTAssertNil(confirmed, "Automatic sync must never confirm source changes") }
            else { XCTAssertEqual(confirmed, "true") }
            return .json("{\"ok\":true,\"imported\":1,\"skipped\":0,\"lastSync\":\"2026-11-16T08:00:00Z\"}")
        }
        let preview = try await client.preview(token: "synthetic-native-token", payload: payload)
        XCTAssertEqual(preview.sourceChanges, 1)
        let receipt = try await client.upload(token: "synthetic-native-token", payload: payload,
                                               previewToken: preview.token, confirmSourceChanges: false)
        XCTAssertEqual(receipt.imported, 1)
        _ = try await client.upload(token: "synthetic-native-token", payload: payload,
                                    previewToken: preview.token, confirmSourceChanges: true)
    }

    func testExpiredAuthenticationIsRecognizableWithoutDecodingBusinessData() async throws {
        let client = api { _ in .json("{\"error\":\"登录已失效\",\"code\":\"NATIVE_AUTH_REQUIRED\"}", status: 401) }
        do {
            _ = try await client.overview(token: "synthetic-native-token")
            XCTFail("Expected authentication failure")
        } catch let error as NativeAPIError {
            XCTAssertTrue(error.isAuthenticationFailure)
            XCTAssertEqual(error.code, "NATIVE_AUTH_REQUIRED")
            XCTAssertEqual(error.errorDescription, "登录已失效")
        }
    }

    func testRateLimitRetainsServerRetryTime() async throws {
        let client = api { _ in
            NativeStubReply(status: 429, headers: ["Content-Type": "application/json", "Retry-After": "900"],
                            data: Data("{\"error\":\"请稍后重试\",\"code\":\"RATE_LIMITED\"}".utf8))
        }
        do {
            _ = try await client.overview(token: "synthetic-native-token")
            XCTFail("Expected rate limit")
        } catch NativeAPIError.server(let status, _, _, let retryAfter) {
            XCTAssertEqual(status, 429)
            XCTAssertEqual(retryAfter, 900)
        }
    }

    func testMalformedSuccessfulResponseDoesNotProduceFakeEmptyData() async throws {
        let client = api { _ in .json("{\"today\":\"2026-11-16\"}") }
        do {
            _ = try await client.overview(token: "synthetic-native-token")
            XCTFail("Missing health data must fail")
        } catch NativeAPIError.invalidResponse {}
    }

    func testRedirectResponseIsRejected() async throws {
        let client = api { _ in
            NativeStubReply(status: 302, headers: ["Location": "https://different-origin.example/collect"], data: Data())
        }
        do {
            _ = try await client.overview(token: "synthetic-native-token")
            XCTFail("Redirect must not be accepted")
        } catch NativeAPIError.server(let status, _, _, _) {
            XCTAssertEqual(status, 302)
        }
    }

    func testUnsafePathsAndIdentityHeaderOverridesFailBeforeTransport() async throws {
        let client = api { _ in XCTFail("Unsafe request reached transport"); return .json("{}") }
        for path in ["../overview", "/overview", "health/%2e%2e/overview", "health%2fimport", "health#payload=sensitive", "https://other.example/path"] {
            do {
                let _: NativeOverview = try await client.request(path: path, token: "synthetic-native-token")
                XCTFail("Accepted unsafe path: \(path)")
            } catch NativeAPIError.invalidRequest {}
        }
        for header in ["Authorization", "Cookie", "Origin", "X-Page-Owner", "OAI-Authenticated-User-ID"] {
            do {
                let _: NativeOverview = try await client.request(path: "overview", token: "synthetic-native-token", headers: [header: "forged"])
                XCTFail("Accepted identity override")
            } catch NativeAPIError.invalidRequest {}
        }
        let insecure = NativeAPI(baseURL: URL(string: "http://insecure.example")!)
        do {
            _ = try await insecure.overview(token: "synthetic-native-token")
            XCTFail("Accepted HTTP")
        } catch NativeAPIError.invalidRequest {}
    }

    func testGoalReplacementIncludesExplicitNullTargets() throws {
        let data = try JSONEncoder().encode(NativeGoalTargets(steps: 8000, sleep: nil, activeEnergy: nil))
        let values = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(values["steps"] as? Double, 8000)
        XCTAssertTrue(values["sleep"] is NSNull)
        XCTAssertTrue(values["active_energy"] is NSNull)
    }

    func testKeychainStoresOnlySessionAndSupportsReplacementAndClear() throws {
        let service = "synthetic.native-tests." + UUID().uuidString
        keychainServices.append(service)
        let store = NativeSessionStore(service: service)
        XCTAssertNil(try store.load())
        let first = try JSONDecoder().decode(NativeSession.self, from: Data(sessionJSON.utf8))
        try store.save(first)
        XCTAssertEqual(try store.load(), first)
        let next = NativeSession(accessToken: "synthetic-replacement-token", expiresAt: first.expiresAt,
                                 user: NativeUser(id: "synthetic-user-b", email: "b@example.com"))
        try store.save(next)
        XCTAssertEqual(try store.load(), next)
        try store.clear()
        XCTAssertNil(try store.load())
        try store.clear()
    }
}

private struct NativeStubReply {
    let status: Int
    let headers: [String: String]
    let data: Data
    static func json(_ value: String, status: Int = 200) -> Self {
        Self(status: status, headers: ["Content-Type": "application/json"], data: Data(value.utf8))
    }
}

private final class NativeStubProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var handlers: [String: (URLRequest) throws -> NativeStubReply] = [:]
    static func register(host: String, handler: @escaping (URLRequest) throws -> NativeStubReply) {
        lock.lock(); defer { lock.unlock() }; handlers[host] = handler
    }
    static func remove(host: String) {
        lock.lock(); defer { lock.unlock() }; handlers.removeValue(forKey: host)
    }
    override class func canInit(with request: URLRequest) -> Bool {
        lock.lock(); defer { lock.unlock() }; return request.url?.host.map { handlers[$0] != nil } ?? false
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        let handler = request.url?.host.flatMap { Self.handlers[$0] }
        Self.lock.unlock()
        do {
            guard let handler, let url = request.url else { throw URLError(.badURL) }
            let reply = try handler(request)
            let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
