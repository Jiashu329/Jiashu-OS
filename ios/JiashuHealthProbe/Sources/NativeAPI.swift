import Foundation

/// Native credentials are restricted to this HTTPS origin. Cookies are neither
/// sent nor saved, and redirects are never followed, including same-host ones.
final class NativeAPI: @unchecked Sendable {
    static let websiteURL = URL(string: "https://www.treefund.asia")!
    private let baseURL: URL
    private let session: URLSession
    private let redirectGuard: NativeRedirectGuard
    private let credentialLock = NSLock()
    private var managedCredentials = false
    private var credentialEpoch = UUID()
    private var credentialOwner: String?
    private var currentCredential: String?
    private var credentialAliases = Set<String>()
    @MainActor var workspaceAuthenticationFailure: ((String) -> Void)?

    /// A login starts a new lease even when the same person signs in again.
    /// Only tokens explicitly registered in this lease may follow its renewal.
    func beginSession(_ value: NativeSession) {
        credentialLock.lock(); defer { credentialLock.unlock() }
        managedCredentials = true
        credentialEpoch = UUID()
        credentialOwner = value.user.id
        currentCredential = value.accessToken
        credentialAliases = [value.accessToken]
    }

    @discardableResult
    func renewSession(_ value: NativeSession, replacing previousToken: String) -> Bool {
        credentialLock.lock(); defer { credentialLock.unlock() }
        guard managedCredentials, credentialOwner == value.user.id,
              currentCredential == previousToken else { return false }
        currentCredential = value.accessToken
        credentialAliases.insert(value.accessToken)
        return true
    }

    func endSession() {
        credentialLock.lock(); defer { credentialLock.unlock() }
        managedCredentials = true
        credentialEpoch = UUID()
        credentialOwner = nil
        currentCredential = nil
        credentialAliases.removeAll()
    }

    private struct RequestCredential {
        let token: String
        let epoch: UUID?
    }

    private func requestCredential(_ token: String?) throws -> RequestCredential? {
        guard let token else { return nil }
        credentialLock.lock(); defer { credentialLock.unlock() }
        guard managedCredentials else { return RequestCredential(token: token, epoch: nil) }
        guard credentialAliases.contains(token), let currentCredential, credentialOwner != nil else {
            throw CancellationError()
        }
        return RequestCredential(token: currentCredential, epoch: credentialEpoch)
    }

    private func credentialIsCurrent(_ value: RequestCredential, requireLatestToken: Bool = false) -> Bool {
        credentialLock.lock(); defer { credentialLock.unlock() }
        if let epoch = value.epoch {
            return managedCredentials && epoch == credentialEpoch && credentialOwner != nil
                && (!requireLatestToken || value.token == currentCredential)
        }
        return !managedCredentials
    }

    init(baseURL: URL = NativeAPI.websiteURL, configuration: URLSessionConfiguration? = nil) {
        self.baseURL = baseURL
        let settings = configuration ?? .ephemeral
        settings.urlCredentialStorage = nil
        settings.httpCookieStorage = nil
        settings.httpShouldSetCookies = false
        settings.urlCache = nil
        settings.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        settings.timeoutIntervalForRequest = 30
        settings.timeoutIntervalForResource = 45
        let guardDelegate = NativeRedirectGuard()
        self.redirectGuard = guardDelegate
        self.session = URLSession(configuration: settings, delegate: guardDelegate, delegateQueue: nil)
    }

    func login(email: String, password: String) async throws -> NativeSession {
        struct Login: Encodable { let email: String; let password: String }
        let response: NativeSession = try await request(path: "auth/login", method: "POST",
            body: JSONEncoder().encode(Login(email: email, password: password)))
        return try validatedSession(response)
    }

    func refresh(token: String) async throws -> NativeSession {
        let response: NativeSession = try await request(path: "auth/refresh", method: "POST", token: token)
        return try validatedSession(response)
    }

    func logout(token: String) async throws {
        let response: NativeAcknowledgement = try await request(path: "auth/logout", method: "POST", token: token)
        guard response.ok else { throw NativeAPIError.invalidResponse }
    }

    func overview(token: String) async throws -> NativeOverview {
        try await request(path: "overview", token: token)
    }

    func health(token: String, days: Int = 30) async throws -> NativeHealthResponse {
        guard (1...360).contains(days) else { throw NativeAPIError.invalidRequest }
        return try await request(path: "health?days=\(days)", token: token)
    }

    func preview(token: String, payload: Data, deviceToken: String? = nil) async throws -> NativeImportPreview {
        struct Envelope: Decodable { let preview: NativeImportPreview }
        let headers = try syncDeviceHeaders(deviceToken)
        let response: Envelope = try await request(path: "health/import/preview", method: "POST", token: token, body: payload, headers: headers)
        return response.preview
    }

    func upload(token: String, payload: Data, previewToken: String, confirmSourceChanges: Bool = false, deviceToken: String? = nil) async throws -> NativeSyncReceipt {
        var headers = try syncDeviceHeaders(deviceToken)
        headers["X-Import-Preview"] = previewToken
        if confirmSourceChanges { headers["X-Confirm-Source-Changes"] = "true" }
        return try await request(path: "health/import", method: "POST", token: token, body: payload, headers: headers)
    }

    func uploadAppleActivity(token: String, payload: Data, deviceToken: String) async throws -> NativeAppleActivitySyncReceipt {
        let headers = try syncDeviceHeaders(deviceToken)
        let receipt: NativeAppleActivitySyncReceipt = try await request(path: "health/apple-activity", method: "POST",
            token: token, body: payload, headers: headers)
        guard receipt.received > 0, (0...receipt.received).contains(receipt.updated),
              NativeHealthCalendar.parseTimestamp(receipt.syncedAt) != nil else { throw NativeAPIError.invalidResponse }
        return receipt
    }

    /// Reading status never selects a device. Supplying the local credential lets
    /// the server distinguish this phone from another already selected phone.
    func channel(token: String, deviceToken: String? = nil) async throws -> NativeHealthChannel {
        let headers = try syncDeviceHeaders(deviceToken)
        let response: NativeHealthChannel = try await request(path: "sync/channel", token: token, headers: headers)
        return try validatedChannel(response)
    }

    /// The caller must securely persist this credential before selecting it, so
    /// a timeout can be reconciled by reading status with the same credential.
    func selectChannel(token: String, deviceToken: String, label: String, expectedRevision: Int) async throws -> NativeHealthChannel {
        struct Selection: Encodable { let deviceToken: String; let label: String; let expectedRevision: Int }
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard NativeHealthDeviceCredential(deviceToken: deviceToken).isValid,
              (0...9_007_199_254_740_991).contains(expectedRevision), !trimmed.isEmpty, trimmed.utf16.count <= 40,
              !label.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw NativeAPIError.invalidRequest }
        let body = try JSONEncoder().encode(Selection(deviceToken: deviceToken, label: trimmed, expectedRevision: expectedRevision))
        let response: NativeHealthChannel = try await request(path: "sync/channel", method: "PUT", token: token, body: body)
        return try validatedChannel(response)
    }

    func clearChannel(token: String, deviceToken: String, expectedRevision: Int) async throws -> NativeHealthChannel {
        struct Clear: Encodable { let expectedRevision: Int }
        guard (0...9_007_199_254_740_991).contains(expectedRevision) else { throw NativeAPIError.invalidRequest }
        let headers = try syncDeviceHeaders(deviceToken)
        let body = try JSONEncoder().encode(Clear(expectedRevision: expectedRevision))
        let response: NativeHealthChannel = try await request(path: "sync/channel", method: "DELETE", token: token, body: body, headers: headers)
        return try validatedChannel(response)
    }

    private func syncDeviceHeaders(_ deviceToken: String?) throws -> [String: String] {
        guard let deviceToken else { return [:] }
        guard NativeHealthDeviceCredential(deviceToken: deviceToken).isValid else { throw NativeAPIError.invalidRequest }
        return ["X-Sync-Device": deviceToken]
    }

    private func validatedChannel(_ response: NativeHealthChannel) throws -> NativeHealthChannel {
        guard (0...9_007_199_254_740_991).contains(response.revision),
              response.deviceId.map({ !$0.isEmpty }) ?? true,
              !response.isCurrentDevice || response.deviceId != nil else { throw NativeAPIError.invalidResponse }
        return response
    }

    func importHistory(token: String) async throws -> NativeImportHistoryResponse {
        try await request(path: "health/import", token: token)
    }

    func goals(token: String) async throws -> NativeGoalSettings {
        try await request(path: "health/goals", token: token)
    }

    func saveGoals(token: String, targets: NativeGoalTargets, expectedRevision: Int, effectiveFrom: String) async throws -> NativeGoalSettings {
        struct Update: Encodable {
            let targets: NativeGoalTargets
            let expectedRevision: Int
            let effectiveFrom: String
        }
        let body = try JSONEncoder().encode(Update(targets: targets, expectedRevision: expectedRevision, effectiveFrom: effectiveFrom))
        return try await request(path: "health/goals", method: "PUT", token: token, body: body)
    }

    func review(token: String, week: String? = nil) async throws -> NativeWeeklyReviewResponse {
        var parts = URLComponents()
        parts.path = "health/review"
        if let week { parts.queryItems = [URLQueryItem(name: "week", value: week)] }
        guard let path = parts.string else { throw NativeAPIError.invalidRequest }
        return try await request(path: path, token: token)
    }

    /// Shared by native feature extensions. The path is relative to /api/native/;
    /// caller-supplied identity, cookie and origin headers are never accepted.
    func request<Response: Decodable>(path: String, method: String = "GET", token: String? = nil,
                                      body: Data? = nil, headers: [String: String] = [:],
                                      reportWorkspaceFailure: Bool = false) async throws -> Response {
        let result = try await transport(path: path, method: method, token: token, body: body,
                                         contentType: "application/json", headers: headers,
                                         reportWorkspaceFailure: reportWorkspaceFailure)
        guard result.mimeType == "application/json" else { throw NativeAPIError.invalidResponse }
        do { return try JSONDecoder().decode(Response.self, from: result.data) }
        catch { throw NativeAPIError.invalidResponse }
    }

    func json(path: String, method: String = "GET", token: String, body: NativeJSON? = nil,
              headers: [String: String] = [:]) async throws -> NativeJSON {
        try await request(path: path, method: method, token: token, body: body?.encodedData(), headers: headers,
                          reportWorkspaceFailure: true)
    }

    /// Downloads stay on the authenticated origin; the caller shares a local
    /// file rather than exposing a bearer token in an export URL.
    func download(path: String, token: String, headers: [String: String] = [:]) async throws -> NativeDownload {
        try await transport(path: path, method: "GET", token: token, body: nil,
                            contentType: "application/json", headers: headers, reportWorkspaceFailure: true)
    }

    func upload(path: String, method: String = "POST", token: String, data: Data,
                contentType: String = "application/json", headers: [String: String] = [:]) async throws -> NativeJSON {
        let result = try await transport(path: path, method: method, token: token, body: data,
                                         contentType: contentType, headers: headers, reportWorkspaceFailure: true)
        guard result.mimeType == "application/json" else { throw NativeAPIError.invalidResponse }
        do { return try JSONDecoder().decode(NativeJSON.self, from: result.data) }
        catch { throw NativeAPIError.invalidResponse }
    }

    private func reportWorkspaceAuthentication(_ error: NativeAPIError, credential: RequestCredential?) async {
        guard error.isAuthenticationFailure, error.code == "NATIVE_SIGN_IN_REQUIRED", let credential else { return }
        await MainActor.run {
            // A delayed 401 for a superseded token must not sign out its renewal.
            guard credentialIsCurrent(credential, requireLatestToken: true) else { return }
            workspaceAuthenticationFailure?(credential.token)
        }
    }

    private func transport(path: String, method: String, token: String?, body: Data?,
                           contentType: String, headers: [String: String],
                           reportWorkspaceFailure: Bool = false) async throws -> NativeDownload {
        try Task.checkCancellation()
        let credential = try requestCredential(token)
        let url = try requestURL(path: path)
        let route = url.path.removingPercentEncoding ?? url.path
        let bodyLimit: Int
        switch route {
        case "/api/native/data/backup", "/api/native/backup": bodyLimit = 16 * 1024 * 1024 + 128 * 1024
        case "/api/native/health/nutrition/photo": bodyLimit = 3 * 1024 * 1024
        case "/api/native/life/douban/import": bodyLimit = 4 * 1024 * 1024
        default: bodyLimit = 512 * 1024
        }
        guard ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method),
              contentType == "application/json", body.map({ $0.count <= bodyLimit }) ?? true else {
            throw NativeAPIError.invalidRequest
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 30)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let token = credential?.token {
            guard !token.isEmpty, token.utf8.count <= 2048, token.utf8.allSatisfy({ (33...126).contains($0) }) else {
                throw NativeAPIError.invalidRequest
            }
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        for (key, value) in headers {
            let lower = key.lowercased()
            guard !["authorization", "cookie", "origin", "host", "x-page-owner", "content-type", "content-length",
                    "x-jso-native-client", "forwarded", "proxy-authorization", "proxy-authenticate"].contains(lower),
                  !lower.hasPrefix("oai-"), !lower.hasPrefix("x-auth"), !lower.hasPrefix("x-forwarded-"),
                  !key.contains(where: { $0.isNewline }), !value.contains(where: { $0.isNewline }) else {
                throw NativeAPIError.invalidRequest
            }
            request.setValue(value, forHTTPHeaderField: key)
        }
        let data: Data
        let rawResponse: URLResponse
        do { (data, rawResponse) = try await session.data(for: request) }
        catch is CancellationError { throw CancellationError() }
        catch let error as URLError where error.code == .cancelled { throw CancellationError() }
        catch { throw NativeAPIError.connection }
        try Task.checkCancellation()
        if let credential, !credentialIsCurrent(credential) { throw CancellationError() }
        guard let response = rawResponse as? HTTPURLResponse, response.url == request.url else {
            throw NativeAPIError.invalidResponse
        }
        let responseLimit = ["/api/native/data/backup", "/api/native/backup"].contains(route)
            ? 18 * 1024 * 1024 : route.hasPrefix("/api/native/life/douban") ? 8 * 1024 * 1024 : 4 * 1024 * 1024
        guard data.count <= responseLimit else { throw NativeAPIError.responseTooLarge }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401, let credential,
               !credentialIsCurrent(credential, requireLatestToken: true) { throw CancellationError() }
            let failure = try? JSONDecoder().decode(NativeServerFailure.self, from: data)
            let retryAfter = response.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
            let error = NativeAPIError.server(status: response.statusCode, code: failure?.code,
                message: failure?.error ?? NativeAPIError.message(for: response.statusCode), retryAfter: retryAfter)
            if reportWorkspaceFailure { await reportWorkspaceAuthentication(error, credential: credential) }
            throw error
        }
        let mime = response.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?
            .trimmingCharacters(in: .whitespaces).lowercased() ?? "application/octet-stream"
        let filename = Self.downloadFilename(response.value(forHTTPHeaderField: "Content-Disposition"))
        return NativeDownload(data: data, filename: filename, mimeType: mime)
    }

    private static func downloadFilename(_ disposition: String?) -> String? {
        guard let disposition else { return nil }
        let parts = disposition.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        let encoded = parts.first(where: { $0.lowercased().hasPrefix("filename*=utf-8''") })
            .flatMap { String($0.dropFirst("filename*=UTF-8''".count)).removingPercentEncoding }
        let plain = parts.first(where: { $0.lowercased().hasPrefix("filename=") })
            .map { String($0.dropFirst("filename=".count)).trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
        guard let value = encoded ?? plain, !value.isEmpty, value.utf8.count <= 200,
              !value.contains("/"), !value.contains("\\"), ![".", ".."].contains(value),
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
        return value
    }

    private func validatedSession(_ response: NativeSession) throws -> NativeSession {
        guard !response.accessToken.isEmpty, response.accessToken.utf8.count <= 2048,
              !response.user.id.isEmpty, !response.user.email.isEmpty,
              let expiry = response.expiryDate, expiry > Date() else { throw NativeAPIError.invalidResponse }
        return response
    }

    private func requestURL(path: String) throws -> URL {
        let route = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
        let segments = route.split(separator: "/", omittingEmptySubsequences: false)
        let recordKey = segments.count > 2 ? String(segments[2]).removingPercentEncoding ?? "" : ""
        let encodedRecord = segments.count >= 3 && segments.count <= 4 && segments[0] == "health"
            && segments[1] == "records" && !segments[2].isEmpty
            && (segments.count == 3 || segments[3] == "history")
            && ["steps:", "active_energy:", "sleep:", "weight:", "lean_body_mass:"].contains(where: recordKey.hasPrefix)
        guard baseURL.scheme == "https", baseURL.host != nil, baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil, ["", "/"].contains(baseURL.path),
              !path.isEmpty, path.utf8.count <= 4096, !path.hasPrefix("/"),
              !path.contains("#"), !path.contains("\\"), !path.contains(where: { $0.isNewline }),
              let parts = URLComponents(string: path), parts.scheme == nil, parts.host == nil,
              let decoded = parts.percentEncodedPath.removingPercentEncoding,
              !decoded.contains("\\"), encodedRecord || !decoded.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              encodedRecord || !parts.percentEncodedPath.lowercased().contains("%2f"),
              !parts.percentEncodedPath.lowercased().contains("%25"),
              let url = URL(string: "/api/native/" + path, relativeTo: baseURL)?.absoluteURL,
              url.scheme == baseURL.scheme, url.host == baseURL.host, url.port == baseURL.port,
              url.path.hasPrefix("/api/native/") else { throw NativeAPIError.invalidRequest }
        return url
    }
}

struct NativeDownload: Sendable {
    let data: Data
    let filename: String?
    let mimeType: String
}

private struct NativeAcknowledgement: Decodable { let ok: Bool }
private struct NativeServerFailure: Decodable { let error: String; let code: String? }

private final class NativeRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum NativeAPIError: Error, LocalizedError, Sendable {
    case invalidRequest
    case invalidResponse
    case connection
    case responseTooLarge
    case server(status: Int, code: String?, message: String, retryAfter: TimeInterval?)

    var isAuthenticationFailure: Bool {
        if case .server(let status, _, _, _) = self { return status == 401 }
        return false
    }
    var code: String? {
        if case .server(_, let code, _, _) = self { return code }
        return nil
    }
    var errorDescription: String? {
        switch self {
        case .invalidRequest: return "请求内容无效，请核对后重试。"
        case .invalidResponse: return "服务器返回的资料不完整，请稍后重试。"
        case .connection: return "连接服务器失败，请检查网络后重试。"
        case .responseTooLarge: return "返回的记录过多，请缩小日期范围后重试。"
        case .server(_, _, let message, _): return message
        }
    }
    static func message(for status: Int) -> String {
        switch status {
        case 401: return "登录已失效，请重新登录。"
        case 403: return "当前账号没有此操作权限。"
        case 404: return "服务器尚未提供此功能，请核对服务版本。"
        case 409: return "记录已变化，请刷新后重新核对。"
        case 429: return "请求较多，请稍后重试。"
        case 500...599: return "服务器暂时不可用，请稍后重试。"
        default: return "请求未完成，请稍后重试。"
        }
    }
}
