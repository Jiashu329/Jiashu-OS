import Foundation

/// Native credentials are restricted to this HTTPS origin. Cookies are neither
/// sent nor saved, and redirects are never followed, including same-host ones.
final class NativeAPI: @unchecked Sendable {
    static let websiteURL = URL(string: "https://www.treefund.asia")!
    private let baseURL: URL
    private let session: URLSession
    private let redirectGuard: NativeRedirectGuard

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

    func preview(token: String, payload: Data) async throws -> NativeImportPreview {
        struct Envelope: Decodable { let preview: NativeImportPreview }
        let response: Envelope = try await request(path: "health/import/preview", method: "POST", token: token, body: payload)
        return response.preview
    }

    func upload(token: String, payload: Data, previewToken: String, confirmSourceChanges: Bool = false) async throws -> NativeSyncReceipt {
        var headers = ["X-Import-Preview": previewToken]
        if confirmSourceChanges { headers["X-Confirm-Source-Changes"] = "true" }
        return try await request(path: "health/import", method: "POST", token: token, body: payload, headers: headers)
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
                                      body: Data? = nil, headers: [String: String] = [:]) async throws -> Response {
        try Task.checkCancellation()
        let url = try requestURL(path: path)
        guard ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method),
              body.map({ $0.count <= 512 * 1024 }) ?? true else { throw NativeAPIError.invalidRequest }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 30)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token {
            guard !token.isEmpty, token.utf8.count <= 2048, token.utf8.allSatisfy({ (33...126).contains($0) }) else {
                throw NativeAPIError.invalidRequest
            }
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        for (key, value) in headers {
            let lower = key.lowercased()
            guard !["authorization", "cookie", "origin", "host", "x-page-owner"].contains(lower),
                  !lower.hasPrefix("oai-"), !lower.hasPrefix("x-auth"),
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
        guard let response = rawResponse as? HTTPURLResponse, response.url == request.url else {
            throw NativeAPIError.invalidResponse
        }
        guard data.count <= 4 * 1024 * 1024 else { throw NativeAPIError.responseTooLarge }
        guard (200..<300).contains(response.statusCode) else {
            let failure = try? JSONDecoder().decode(NativeServerFailure.self, from: data)
            let retryAfter = response.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
            throw NativeAPIError.server(status: response.statusCode, code: failure?.code,
                message: failure?.error ?? NativeAPIError.message(for: response.statusCode), retryAfter: retryAfter)
        }
        guard response.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?
            .trimmingCharacters(in: .whitespaces).lowercased() == "application/json" else {
            throw NativeAPIError.invalidResponse
        }
        do { return try JSONDecoder().decode(Response.self, from: data) }
        catch { throw NativeAPIError.invalidResponse }
    }

    private func validatedSession(_ response: NativeSession) throws -> NativeSession {
        guard !response.accessToken.isEmpty, response.accessToken.utf8.count <= 2048,
              !response.user.id.isEmpty, !response.user.email.isEmpty,
              let expiry = response.expiryDate, expiry > Date() else { throw NativeAPIError.invalidResponse }
        return response
    }

    private func requestURL(path: String) throws -> URL {
        guard baseURL.scheme == "https", baseURL.host != nil, baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil, ["", "/"].contains(baseURL.path),
              !path.isEmpty, path.utf8.count <= 4096, !path.hasPrefix("/"),
              !path.contains("#"), !path.contains("\\"), !path.contains(where: { $0.isNewline }),
              let parts = URLComponents(string: path), parts.scheme == nil, parts.host == nil,
              let decoded = parts.percentEncodedPath.removingPercentEncoding,
              !decoded.contains("\\"), !decoded.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              !parts.percentEncodedPath.lowercased().contains("%2f"),
              let url = URL(string: "/api/native/" + path, relativeTo: baseURL)?.absoluteURL,
              url.scheme == baseURL.scheme, url.host == baseURL.host, url.port == baseURL.port,
              url.path.hasPrefix("/api/native/") else { throw NativeAPIError.invalidRequest }
        return url
    }
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
