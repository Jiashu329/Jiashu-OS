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
