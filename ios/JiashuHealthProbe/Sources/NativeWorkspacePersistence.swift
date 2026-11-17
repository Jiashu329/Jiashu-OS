import Foundation
import CryptoKit
import Security

/// Per-account drafts and frozen requests are encrypted before touching disk.
/// Device-only keys never leave Keychain; no personal content uses UserDefaults.
struct NativeWorkspacePersistence {
    let userID: String
    let scope: String
    var directory: URL? = nil
    var service = "asia.treefund.jiashu.workspace-protected"
    var maximumBytes = 20 * 1024 * 1024

    private var account: String {
        ["https://www.treefund.asia", userID, scope].map { String($0.utf8.count) + ":" + $0 }.joined()
    }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false]
    }
    private func location() throws -> URL {
        guard !userID.isEmpty, !scope.isEmpty, userID.utf8.count <= 800, scope.utf8.count <= 200,
              !account.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
            throw NativeWorkspacePersistenceError.invalidIdentity
        }
        let root = try directory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                            appropriateFor: nil, create: true)
            .appendingPathComponent("JiashuProtectedWorkspace", isDirectory: true)
        let hash = SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(hash + ".sealed")
    }
    private func key(create: Bool) throws -> SymmetricKey? {
        var attributes = query
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        if status == errSecSuccess {
            guard let bytes = result as? Data, bytes.count == 32 else { throw NativeWorkspacePersistenceError.unavailable }
            return SymmetricKey(data: bytes)
        }
        guard status == errSecItemNotFound else { throw NativeWorkspacePersistenceError.unavailable }
        guard create else { return nil }
        let key = SymmetricKey(size: .bits256)
        var item = query
        item[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let saved = SecItemAdd(item as CFDictionary, nil)
        if saved == errSecDuplicateItem { return try self.key(create: false) }
        guard saved == errSecSuccess else { throw NativeWorkspacePersistenceError.unavailable }
        return key
    }
    func save<T: Encodable>(_ value: T) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        try saveData(encoder.encode(value))
    }
    func load<T: Decodable>(_ type: T.Type) throws -> T? {
        guard let data = try loadData() else { return nil }
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw NativeWorkspacePersistenceError.corrupted }
    }
    func saveData(_ data: Data) throws {
        guard data.count <= maximumBytes else { throw NativeWorkspacePersistenceError.tooLarge }
        let url = try location()
        guard let key = try key(create: true), let encrypted = try AES.GCM.seal(data, using: key).combined else {
            throw NativeWorkspacePersistenceError.unavailable
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try encrypted.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var mutableURL = url; try mutableURL.setResourceValues(values)
    }
    func loadData() throws -> Data? {
        let url = try location()
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
        guard size <= maximumBytes + 64, let key = try key(create: false) else { throw NativeWorkspacePersistenceError.unavailable }
        do {
            let result = try AES.GCM.open(AES.GCM.SealedBox(combined: Data(contentsOf: url)), using: key)
            guard result.count <= maximumBytes else { throw NativeWorkspacePersistenceError.tooLarge }
            return result
        } catch let error as NativeWorkspacePersistenceError { throw error }
        catch { throw NativeWorkspacePersistenceError.corrupted }
    }
    func clear() throws {
        let url = try location()
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeWorkspacePersistenceError.unavailable }
    }
}

enum NativeWorkspacePersistenceError: LocalizedError {
    case invalidIdentity, unavailable, corrupted, tooLarge
    var errorDescription: String? {
        switch self {
        case .invalidIdentity: return "请确认当前账号后再恢复本机草稿。"
        case .unavailable: return "暂时无法读取安全草稿，请解锁手机后重试。"
        case .corrupted: return "本机草稿不完整，未执行任何提交。请核对后重新填写。"
        case .tooLarge: return "本机恢复内容超过容量上限，请缩小范围后重试。"
        }
    }
}
