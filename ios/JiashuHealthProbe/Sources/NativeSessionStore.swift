import Foundation
import Security

/// Only the revocable session is saved; the user's password is never persisted.
struct NativeSessionStore {
    private let service: String
    private let account = "current-user"

    init(service: String = "asia.treefund.jiashu.native-session") {
        self.service = service
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    func load() throws -> NativeSession? {
        var attributes = query
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NativeSessionStoreError.keychain(status) }
        guard let data = value as? Data else { throw NativeSessionStoreError.invalidSession }
        let session: NativeSession
        do { session = try JSONDecoder().decode(NativeSession.self, from: data) }
        catch { throw NativeSessionStoreError.invalidSession }
        guard !session.accessToken.isEmpty, !session.user.id.isEmpty, session.expiryDate != nil else {
            throw NativeSessionStoreError.invalidSession
        }
        return session
    }

    func save(_ session: NativeSession) throws {
        guard !session.accessToken.isEmpty, !session.user.id.isEmpty, session.expiryDate != nil else {
            throw NativeSessionStoreError.invalidSession
        }
        let data = try JSONEncoder().encode(session)
        // After first unlock allows OS-delivered background HealthKit sync;
        // ThisDeviceOnly prevents migration of this session to another device.
        let updates: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw NativeSessionStoreError.keychain(updated) }
        var attributes = query
        updates.forEach { attributes[$0.key] = $0.value }
        let added = SecItemAdd(attributes as CFDictionary, nil)
        guard added == errSecSuccess else { throw NativeSessionStoreError.keychain(added) }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NativeSessionStoreError.keychain(status)
        }
    }
}

enum NativeSessionStoreError: Error, LocalizedError {
    case keychain(OSStatus)
    case invalidSession

    var errorDescription: String? {
        switch self {
        case .keychain: return "暂时无法访问安全登录信息，请解锁手机后重试。"
        case .invalidSession: return "保存的登录信息无效，请重新登录。"
        }
    }
}


/// This device credential is independent of a login session. Logging out must
/// not destroy it: the same user can sign in again and recover source consent.
struct NativeHealthDeviceCredential: Codable, Equatable, Sendable {
    let deviceToken: String

    var isValid: Bool {
        let prefix = "jso_sync_"
        guard deviceToken.hasPrefix(prefix) else { return false }
        let suffix = String(deviceToken.dropFirst(prefix.count))
        guard suffix.utf8.count == 43,
              suffix.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }),
              let data = Data(base64Encoded: suffix.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="),
              data.count == 32 else { return false }
        return Self.encodeToken(data) == deviceToken
    }

    static func generate() throws -> Self {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw NativeHealthDeviceStoreError.randomGeneration(status) }
        return Self(deviceToken: encodeToken(Data(bytes)))
    }

    private static func encodeToken(_ bytes: Data) -> String {
        "jso_sync_" + bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

/// Per-account and per-server, device-only Keychain storage. Never place this
/// credential in UserDefaults, backups, URLs or diagnostic messages.
struct NativeHealthDeviceStore {
    private let userID: String
    private let service: String

    init(userID: String, service: String = "asia.treefund.jiashu.native-health-device") {
        self.userID = userID
        self.service = service
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: "https://www.treefund.asia|" + userID,
         kSecAttrSynchronizable as String: false]
    }

    private func validateOwner() throws {
        guard !userID.isEmpty, userID.utf8.count <= 800,
              !userID.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
            throw NativeHealthDeviceStoreError.invalidOwner
        }
    }

    func load() throws -> NativeHealthDeviceCredential? {
        try validateOwner()
        var attributes = query
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var raw: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &raw)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NativeHealthDeviceStoreError.keychain(status) }
        guard let data = raw as? Data,
              let credential = try? JSONDecoder().decode(NativeHealthDeviceCredential.self, from: data),
              credential.isValid else { throw NativeHealthDeviceStoreError.invalidCredential }
        return credential
    }

    func save(_ credential: NativeHealthDeviceCredential) throws {
        try validateOwner()
        guard credential.isValid else { throw NativeHealthDeviceStoreError.invalidCredential }
        let updates: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(credential),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw NativeHealthDeviceStoreError.keychain(updated) }
        var attributes = query
        updates.forEach { attributes[$0.key] = $0.value }
        let added = SecItemAdd(attributes as CFDictionary, nil)
        guard added == errSecSuccess else { throw NativeHealthDeviceStoreError.keychain(added) }
    }

    func clear() throws {
        try validateOwner()
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeHealthDeviceStoreError.keychain(status) }
    }
}

enum NativeHealthDeviceStoreError: Error, LocalizedError {
    case keychain(OSStatus)
    case randomGeneration(OSStatus)
    case invalidCredential
    case invalidOwner

    var errorDescription: String? {
        switch self {
        case .keychain: return "暂时无法访问安全同步配置，请解锁手机后重试。"
        case .randomGeneration: return "暂时无法创建安全同步配置，请重试。"
        case .invalidCredential: return "本机同步配置无效，请重新选择此 iPhone 同步。"
        case .invalidOwner: return "请先确认当前登录账号，再设置健康同步。"
        }
    }
}
