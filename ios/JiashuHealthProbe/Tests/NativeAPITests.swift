import Foundation
import Security
import XCTest
@testable import JiashuHealthProbe

final class NativeAPITests: XCTestCase {
    private var hosts: [String] = []
    private var keychainServices: [String] = []
    private var deviceStores: [NativeHealthDeviceStore] = []

    override func tearDown() {
        hosts.forEach { NativeStubProtocol.remove(host: $0) }
        deviceStores.forEach { try? $0.clear() }
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

    func testChannelStatusWithoutCredentialDoesNotSelectOrAssumeThisDevice() async throws {
        let client = api { request in
            XCTAssertEqual(request.url?.path, "/api/native/sync/channel")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.url?.query)
            XCTAssertNil(request.httpBody)
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Sync-Device"))
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Confirm-Source-Changes"))
            return .json("{\"revision\":0,\"deviceId\":null,\"label\":null,\"updatedAt\":null,\"isCurrentDevice\":false}")
        }
        let channel = try await client.channel(token: "synthetic-native-token")
        XCTAssertEqual(channel.revision, 0)
        XCTAssertFalse(channel.hasActiveChannel)
        XCTAssertFalse(channel.isCurrentDevice)
    }

    func testChannelStatusUsesCredentialOnlyAsHeaderAndRetainsOtherDeviceStatus() async throws {
        let credential = try NativeHealthDeviceCredential.generate()
        let client = api { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Sync-Device"), credential.deviceToken)
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            XCTAssertNil(request.url?.query)
            return .json("{\"revision\":4,\"deviceId\":\"synthetic-other-device\",\"label\":\"另一台 iPhone\",\"updatedAt\":\"2026-11-17T08:00:00Z\",\"isCurrentDevice\":false}")
        }
        let channel = try await client.channel(token: "synthetic-native-token", deviceToken: credential.deviceToken)
        XCTAssertTrue(channel.hasActiveChannel)
        XCTAssertFalse(channel.isCurrentDevice, "An active account channel must not automatically authorize this phone")
    }

    func testSelectingChannelSendsCredentialAndRevisionAsOneExplicitSelection() async throws {
        let credential = try NativeHealthDeviceCredential.generate()
        let client = api { request in
            XCTAssertEqual(request.url?.path, "/api/native/sync/channel")
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Sync-Device"))
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Confirm-Source-Changes"))
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: self.requestBody(request)) as? [String: Any])
            XCTAssertEqual(Set(body.keys), Set(["deviceToken", "label", "expectedRevision"]))
            XCTAssertEqual(body["deviceToken"] as? String, credential.deviceToken)
            XCTAssertEqual(body["label"] as? String, "我的 iPhone")
            XCTAssertEqual(body["expectedRevision"] as? Int, 4)
            return .json("{\"revision\":5,\"deviceId\":\"synthetic-this-device\",\"label\":\"我的 iPhone\",\"updatedAt\":\"2026-11-17T08:00:00Z\",\"isCurrentDevice\":true}")
        }
        let channel = try await client.selectChannel(token: "synthetic-native-token", deviceToken: credential.deviceToken,
                                                      label: " 我的 iPhone ", expectedRevision: 4)
        XCTAssertEqual(channel.revision, 5)
        XCTAssertTrue(channel.isCurrentDevice)
    }

    func testClearingChannelIncludesCurrentCredentialAndExpectedRevision() async throws {
        let credential = try NativeHealthDeviceCredential.generate()
        let client = api { request in
            XCTAssertEqual(request.url?.path, "/api/native/sync/channel")
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Sync-Device"), credential.deviceToken)
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Confirm-Source-Changes"))
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: self.requestBody(request)) as? [String: Int])
            XCTAssertEqual(body, ["expectedRevision": 5])
            return .json("{\"revision\":6,\"deviceId\":null,\"label\":null,\"updatedAt\":\"2026-11-17T08:00:00Z\",\"isCurrentDevice\":false}")
        }
        let channel = try await client.clearChannel(token: "synthetic-native-token", deviceToken: credential.deviceToken, expectedRevision: 5)
        XCTAssertEqual(channel.revision, 6)
        XCTAssertFalse(channel.hasActiveChannel)
    }

    func testSelectedDevicePreviewAndUploadDoNotForgePerBatchSourceConfirmation() async throws {
        let credential = try NativeHealthDeviceCredential.generate()
        let payload = Data("{\"version\":1,\"synthetic\":true}".utf8)
        let client = api { request in
            XCTAssertEqual(self.requestBody(request), payload)
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Sync-Device"), credential.deviceToken)
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Confirm-Source-Changes"))
            XCTAssertNil(request.url?.query, "A device credential must never enter a URL")
            if request.url?.path.hasSuffix("preview") == true {
                return .json("""
                {"preview":{"token":"synthetic-preview-token","total":1,"added":0,"updated":1,"skipped":0,"sourceChanges":1,"manualOverrides":0,"from":"2026-11-16","to":"2026-11-16","metrics":["步数"],"examples":[]}}
                """)
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Import-Preview"), "synthetic-preview-token")
            return .json("{\"ok\":true,\"imported\":1,\"skipped\":0,\"lastSync\":\"2026-11-17T08:00:00Z\"}")
        }
        let preview = try await client.preview(token: "synthetic-native-token", payload: payload, deviceToken: credential.deviceToken)
        XCTAssertEqual(preview.sourceChanges, 1)
        let receipt = try await client.upload(token: "synthetic-native-token", payload: payload, previewToken: preview.token,
                                             deviceToken: credential.deviceToken)
        XCTAssertEqual(receipt.imported, 1)
    }

    func testInvalidDeviceCredentialAndSelectionAreRejectedBeforeTransport() async throws {
        let client = api { _ in XCTFail("Invalid device settings reached transport"); return .json("{}") }
        for invalid in ["", "jso_sync_short", "jso_sync_" + String(repeating: "a", count: 43),
                        "jso_sync_" + String(repeating: "A", count: 42) + "+", "Bearer credential"] {
            do {
                _ = try await client.channel(token: "synthetic-native-token", deviceToken: invalid)
                XCTFail("Invalid credential accepted")
            } catch NativeAPIError.invalidRequest {}
        }
        let valid = try NativeHealthDeviceCredential.generate()
        do {
            _ = try await client.selectChannel(token: "synthetic-native-token", deviceToken: valid.deviceToken, label: "iPhone", expectedRevision: -1)
            XCTFail("Negative revision accepted")
        } catch NativeAPIError.invalidRequest {}
        do {
            _ = try await client.selectChannel(token: "synthetic-native-token", deviceToken: valid.deviceToken, label: "iPhone\n", expectedRevision: 0)
            XCTFail("Control character accepted")
        } catch NativeAPIError.invalidRequest {}
    }

    func testDeviceCredentialsContain32RandomBytesAndCanonicalURLSafeEncoding() throws {
        var generated = Set<String>()
        for _ in 0..<128 {
            let credential = try NativeHealthDeviceCredential.generate()
            XCTAssertTrue(credential.isValid)
            XCTAssertEqual(credential.deviceToken.count, 52)
            XCTAssertTrue(credential.deviceToken.hasPrefix("jso_sync_"))
            XCTAssertFalse(credential.deviceToken.contains("="))
            XCTAssertFalse(credential.deviceToken.contains("+"))
            XCTAssertFalse(credential.deviceToken.contains("/"))
            let suffix = String(credential.deviceToken.dropFirst(9))
            let decoded = Data(base64Encoded: suffix.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=")
            XCTAssertEqual(decoded?.count, 32)
            XCTAssertTrue(generated.insert(credential.deviceToken).inserted, "Generated credentials must not repeat")
            let json = try JSONEncoder().encode(credential)
            XCTAssertEqual(try JSONDecoder().decode(NativeHealthDeviceCredential.self, from: json), credential)
        }
    }

    func testDeviceCredentialKeychainIsAccountScopedAndIndependentOfLogin() throws {
        let service = "synthetic.native-device-tests." + UUID().uuidString
        keychainServices.append(service)
        let a = NativeHealthDeviceStore(userID: "synthetic-user-a", service: service)
        let b = NativeHealthDeviceStore(userID: "synthetic-user-b", service: service)
        deviceStores += [a, b]
        let credentialA = try NativeHealthDeviceCredential.generate()
        let credentialB = try NativeHealthDeviceCredential.generate()
        XCTAssertNil(try a.load())
        XCTAssertNil(try b.load())
        try a.save(credentialA)
        XCTAssertNil(try b.load())
        try b.save(credentialB)
        try NativeSessionStore(service: service).clear()
        XCTAssertEqual(try a.load(), credentialA, "Logging out must preserve this user's device identity")
        XCTAssertEqual(try b.load(), credentialB)
        var attributes: CFTypeRef?
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: "https://www.treefund.asia|synthetic-user-a", kSecReturnAttributes as String: true]
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &attributes), errSecSuccess)
        let metadata = try XCTUnwrap(attributes as? [String: Any])
        XCTAssertEqual(metadata[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        try a.clear()
        XCTAssertNil(try a.load())
        XCTAssertEqual(try b.load(), credentialB)
    }

    func testCorruptedDeviceKeychainValueIsRejectedRatherThanRegeneratedSilently() throws {
        let service = "synthetic.native-device-tests." + UUID().uuidString
        let store = NativeHealthDeviceStore(userID: "synthetic-user-a", service: service)
        deviceStores.append(store)
        try store.save(NativeHealthDeviceCredential.generate())
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: "https://www.treefund.asia|synthetic-user-a"]
        let invalid: [String: Any] = [kSecValueData as String: Data("{\"deviceToken\":\"invalid\"}".utf8)]
        XCTAssertEqual(SecItemUpdate(query as CFDictionary, invalid as CFDictionary), errSecSuccess)
        XCTAssertThrowsError(try store.load())
        XCTAssertThrowsError(try NativeHealthDeviceStore(userID: "").load())
    }

    func testRawBackupUploadDoesNotReencodeSignedJSONAndDownloadRetainsBytes() async throws {
        let original = Data(#"{"z":1e-7,"a":"\u4f60","amount_minor":"900719925474099312345"}"#.utf8)
        let client = api { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-token")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            if request.httpMethod == "POST" {
                XCTAssertEqual(self.requestBody(request), original)
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
                return .json("{\"ok\":true}")
            }
            return NativeStubReply(status: 200, headers: ["Content-Type": "application/json", "Content-Disposition": "attachment; filename=backup.json"], data: original)
        }
        let uploaded = try await client.upload(path: "data/backup", token: "synthetic-native-token", data: original)
        XCTAssertEqual(uploaded["ok"].boolValue, true)
        let downloaded = try await client.download(path: "data/backup", token: "synthetic-native-token")
        XCTAssertEqual(downloaded.data, original)
        XCTAssertEqual(downloaded.filename, "backup.json")
    }

    func testRouteSpecificUploadLimitsPermitExactBoundaryAndRejectOverflow() async throws {
        let client = api { request in
            XCTAssertEqual(request.httpMethod, "POST")
            return .json("{\"ok\":true}")
        }
        let limits = [("health/import", 512 * 1024), ("health/nutrition/photo", 3 * 1024 * 1024),
                      ("life/douban/import", 4 * 1024 * 1024), ("data/backup", 16 * 1024 * 1024 + 128 * 1024)]
        for (path, limit) in limits {
            _ = try await client.upload(path: path, token: "synthetic-native-token", data: Data(repeating: 32, count: limit))
            do {
                _ = try await client.upload(path: path, token: "synthetic-native-token", data: Data(repeating: 32, count: limit + 1))
                XCTFail("Oversized request was accepted for " + path)
            } catch NativeAPIError.invalidRequest {}
        }
        do {
            _ = try await client.upload(path: "health/nutrition/photo", token: "synthetic-native-token", data: Data(), contentType: "image/jpeg")
            XCTFail("Non-JSON request bypassed the fixed protocol")
        } catch NativeAPIError.invalidRequest {}
    }

    func testRouteSpecificDownloadLimitsRejectOversizedResponses() async throws {
        for (path, limit) in [("health/export", 4 * 1024 * 1024), ("life/douban", 8 * 1024 * 1024), ("data/backup", 18 * 1024 * 1024)] {
            let accepted = api { _ in NativeStubReply(status: 200, headers: ["Content-Type": "application/octet-stream"], data: Data(repeating: 65, count: limit)) }
            let downloaded = try await accepted.download(path: path, token: "synthetic-native-token")
            XCTAssertEqual(downloaded.data.count, limit)
            let rejected = api { _ in NativeStubReply(status: 200, headers: ["Content-Type": "application/octet-stream"], data: Data(repeating: 65, count: limit + 1)) }
            do {
                _ = try await rejected.download(path: path, token: "synthetic-native-token")
                XCTFail("Oversized response was accepted for " + path)
            } catch NativeAPIError.responseTooLarge {}
        }
    }

    func testDownloadFilenamesAreDecodedAndUnsafeNamesAreDiscarded() async throws {
        let cases: [(String, String?)] = [
            ("attachment; filename=health.json", "health.json"),
            ("attachment; filename*=UTF-8''%E5%81%A5%E5%BA%B7.json", "健康.json"),
            ("attachment; filename=../backup.json", nil),
            ("attachment; filename*=UTF-8''..%2Fbackup.json", nil),
            ("attachment; filename*=UTF-8''folder%5Cbackup.json", nil),
            ("attachment; filename*=UTF-8''bad%00name.json", nil),
            ("attachment; filename=..", nil),
            ("attachment; filename=" + String(repeating: "a", count: 201), nil),
        ]
        for (header, expected) in cases {
            let client = api { _ in NativeStubReply(status: 200,
                headers: ["Content-Type": "application/json", "Content-Disposition": header], data: Data("{}".utf8)) }
            let download = try await client.download(path: "health/export", token: "synthetic-native-token")
            XCTAssertEqual(download.filename, expected)
        }
    }

    func testEncodedSlashIsAllowedOnlyInsideRecognizedHealthRecordKey() async throws {
        let client = api { request in
            XCTAssertTrue(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.percentEncodedPath.contains("%2F"))
            return .json("{\"ok\":true}")
        }
        _ = try await client.json(path: "health/records/weight:synthetic%2Fsample/history", token: "synthetic-native-token")
        for path in ["finance/accounts/a%2Fb", "health/records/unrecognized%2Fkey", "health/records/weight:synthetic%252Fsample"] {
            do {
                _ = try await client.json(path: path, token: "synthetic-native-token")
                XCTFail("Unsupported encoded path reached transport")
            } catch NativeAPIError.invalidRequest {}
        }
    }

    func testExtendedTransportCannotOverrideTrustedOrContentHeaders() async throws {
        let client = api { _ in XCTFail("Forbidden header reached transport"); return .json("{}") }
        for header in ["Content-Type", "Content-Length", "X-JSO-Native-Client", "Forwarded", "X-Forwarded-Host", "Proxy-Authorization", "X-Auth-User-ID", "OAI-Authenticated-User-ID", "Cookie", "Origin"] {
            do {
                _ = try await client.download(path: "data/backup", token: "synthetic-native-token", headers: [header: "forged"])
                XCTFail("Header override accepted: " + header)
            } catch NativeAPIError.invalidRequest {}
        }
    }

    @MainActor
    func testWorkspaceAuthenticationCallbackRequiresNativeCodeAndKeepsOriginalToken() async throws {
        var notified: [String] = []
        let client = api { _ in .json("{\"error\":\"App 登录已失效\",\"code\":\"NATIVE_SIGN_IN_REQUIRED\"}", status: 401) }
        client.workspaceAuthenticationFailure = { notified.append($0) }
        do { _ = try await client.json(path: "finance", token: "synthetic-workspace-token"); XCTFail("Expected 401") }
        catch let error as NativeAPIError { XCTAssertTrue(error.isAuthenticationFailure) }
        do { _ = try await client.download(path: "finance/export", token: "synthetic-workspace-token"); XCTFail("Expected 401") }
        catch let error as NativeAPIError { XCTAssertTrue(error.isAuthenticationFailure) }
        do { _ = try await client.upload(path: "data/backup", token: "synthetic-workspace-token", data: Data("{}".utf8)); XCTFail("Expected 401") }
        catch let error as NativeAPIError { XCTAssertTrue(error.isAuthenticationFailure) }
        XCTAssertEqual(notified, Array(repeating: "synthetic-workspace-token", count: 3))
        do { _ = try await client.health(token: "synthetic-health-token"); XCTFail("Expected 401") }
        catch let error as NativeAPIError { XCTAssertTrue(error.isAuthenticationFailure) }
        XCTAssertEqual(notified.count, 3, "Original health flow owns automatic/manual error presentation")
        for (status, code) in [(401, "OTHER_SIGN_IN_REQUIRED"), (403, "NATIVE_SIGN_IN_REQUIRED")] {
            let unrelated = api { _ in .json("{\"error\":\"Synthetic error\",\"code\":\"" + code + "\"}", status: status) }
            unrelated.workspaceAuthenticationFailure = { notified.append($0) }
            do { _ = try await unrelated.json(path: "finance", token: "synthetic-unrelated-token"); XCTFail("Expected rejection") }
            catch is NativeAPIError {}
        }
        XCTAssertEqual(notified.count, 3)
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
