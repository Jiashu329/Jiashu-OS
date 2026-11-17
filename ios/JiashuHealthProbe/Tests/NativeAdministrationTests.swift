import Foundation
import XCTest
@testable import JiashuHealthProbe

final class NativeAdministrationTests: XCTestCase {
    private var stores: [NativeAdministrationPendingStore] = []
    override func tearDown() {
        stores.forEach { try? $0.clear() }
        super.tearDown()
    }

    func testProviderBlankSecretPreservesExistingCredentialsAndRevisionIsExplicit() throws {
        let ai = try NativeAdministrationContract.providerSave(kind: .ai, revision: 8, secret: "", model: "MiniMax-M3", region: "cn")
        XCTAssertEqual(ai["expectedRevision"].intValue, 8)
        XCTAssertTrue(ai["apiKey"].isNull)
        XCTAssertEqual(ai["model"].stringValue, "MiniMax-M3")
        let media = try NativeAdministrationContract.providerSave(kind: .media, revision: 3, secret: "synthetic-read-token", model: "", region: "")
        XCTAssertEqual(media["token"].stringValue, "synthetic-read-token")
        XCTAssertTrue(media["apiKey"].isNull)
        XCTAssertTrue(media["model"].isNull)
        XCTAssertEqual(NativeAdministrationContract.providerTest(kind: .ai, revision: 8)["consent"].boolValue, true)
        XCTAssertTrue(NativeAdministrationContract.providerTest(kind: .media, revision: 3)["consent"].isNull)
        XCTAssertThrowsError(try NativeAdministrationContract.providerSave(kind: .ai, revision: 0, secret: "line\nbreak", model: "MiniMax-M3", region: "cn"))
        XCTAssertThrowsError(try NativeAdministrationContract.providerSave(kind: .ai, revision: 0, secret: "", model: "not-a-model", region: "cn"))
    }

    func testUserCommandsNormalizeEmailKeepBlankPasswordAndProtectTheAdministrator() throws {
        let created = try NativeAdministrationContract.createUser(email: " Person@Example.Test ", password: "synthetic-password-2026")
        XCTAssertEqual(created["email"].stringValue, "person@example.test")
        let user: NativeJSON = .object(["revision": .integer(7), "isAdmin": .bool(false)])
        let edited = try NativeAdministrationContract.editUser(user, email: "person@example.test", password: "", active: false)
        XCTAssertEqual(edited["expectedRevision"].intValue, 7)
        XCTAssertEqual(edited["status"].stringValue, "disabled")
        XCTAssertTrue(edited["password"].isNull)
        XCTAssertThrowsError(try NativeAdministrationContract.createUser(email: "invalid", password: "synthetic-password-2026"))
        XCTAssertThrowsError(try NativeAdministrationContract.createUser(email: "person@example.test", password: "short"))
        XCTAssertThrowsError(try NativeAdministrationContract.editUser(.object(["revision": .integer(1), "isAdmin": .bool(true)]), email: "owner@example.test", password: "", active: false))
    }

    func testSensitivePendingCommandsRoundTripOnlyInTheSameOwnerAndFeatureKeychainPartition() throws {
        let service = "native-admin-test-" + UUID().uuidString
        let original = NativeAdministrationPendingStore(ownerID: "owner-a", scope: "provider.ai", service: service)
        let otherOwner = NativeAdministrationPendingStore(ownerID: "owner-b", scope: "provider.ai", service: service)
        let otherFeature = NativeAdministrationPendingStore(ownerID: "owner-a", scope: "users", service: service)
        stores = [original, otherOwner, otherFeature]
        let command = NativeAdministrationPending(ownerID: "owner-a", scope: "provider.ai", path: "ai/settings", method: "PUT",
            body: .object(["apiKey": .string("synthetic-secret"), "expectedRevision": .integer(4)]), label: "保存 AI 服务")
        try original.save(command)
        XCTAssertEqual(try original.load(), command)
        XCTAssertNil(try otherOwner.load())
        XCTAssertNil(try otherFeature.load())
        XCTAssertThrowsError(try otherOwner.save(command))
        XCTAssertThrowsError(try otherFeature.save(command))
        try original.clear()
        XCTAssertNil(try original.load())
    }

    @MainActor
    func testUncertainProviderWritesRetainTheFrozenOperationAndDoNotOverwriteNewerSettingsOnConflict() async throws {
        let host = "native-admin-" + UUID().uuidString.lowercased() + ".example"
        let state = AdministrationStubState()
        AdministrationStubProtocol.register(host: host, state: state)
        defer { AdministrationStubProtocol.remove(host: host) }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [AdministrationStubProtocol.self]
        let api = NativeAPI(baseURL: URL(string: "https://" + host)!, configuration: config)
        let owner = "admin-test-" + UUID().uuidString
        let pendingStore = NativeAdministrationPendingStore(ownerID: owner, scope: "provider.ai")
        stores.append(pendingStore)
        let model = NativeAdministrationContext(api: api, token: "synthetic-token", userID: owner, scope: "provider.ai", path: "ai/settings")
        await model.load()
        XCTAssertTrue(model.ready)
        let body = try NativeAdministrationContract.providerSave(kind: .ai, revision: 4, secret: "synthetic-secret", model: "MiniMax-M3", region: "cn")
        await model.begin(path: "ai/settings", method: "PUT", body: body, label: "保存 AI 服务")
        let original = model.pending
        XCTAssertNotNil(original)
        XCTAssertEqual(original?.body, body)
        XCTAssertEqual(try pendingStore.load()?.id, original?.id)
        state.conflict = true
        await model.resume()
        XCTAssertEqual(model.pending?.id, original?.id)
        XCTAssertEqual(model.pending?.body, body)
        XCTAssertEqual(state.bodies.count, 2)
        XCTAssertEqual(state.bodies.first, state.bodies.last)
        XCTAssertEqual(model.data["settings"]["revision"].intValue, 4)
        model.discard()
        XCTAssertNil(try pendingStore.load())
    }
}

private final class AdministrationStubState: @unchecked Sendable {
    private let lock = NSLock()
    private var conflicting = false
    private var sentBodies: [Data] = []
    var conflict: Bool { get { lock.withLock { conflicting } } set { lock.withLock { conflicting = newValue } } }
    var bodies: [Data] { lock.withLock { sentBodies } }
    func response(_ request: URLRequest) -> (Int, String) {
        lock.withLock {
            if request.httpMethod == "GET" { return (200, "{\"canManage\":true,\"settings\":{\"configured\":true,\"revision\":4,\"model\":\"MiniMax-M3\",\"region\":\"cn\"}}") }
            if let body = request.httpBody { sentBodies.append(body) }
            else if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let size = stream.read(&buffer, maxLength: buffer.count); if size <= 0 { break }; data.append(buffer, count: size) }
                sentBodies.append(data)
            }
            return conflicting ? (409, "{\"error\":\"设置版本已变化\",\"code\":\"AI_SETTINGS_CONFLICT\"}")
                : (503, "{\"error\":\"服务暂不可用\",\"code\":\"SETTINGS_UNAVAILABLE\"}")
        }
    }
}

private final class AdministrationStubProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var handlers: [String: AdministrationStubState] = [:]
    static func register(host: String, state: AdministrationStubState) { lock.withLock { handlers[host] = state } }
    static func remove(host: String) { _ = lock.withLock { handlers.removeValue(forKey: host) } }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host.map { host in lock.withLock { handlers[host] != nil } } ?? false }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, let host = url.host, let state = Self.lock.withLock({ Self.handlers[host] }) else { return }
        let (status, body) = state.response(request)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
