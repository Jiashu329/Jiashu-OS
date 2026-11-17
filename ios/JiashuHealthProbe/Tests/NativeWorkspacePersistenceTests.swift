import Foundation
import Security
import XCTest
@testable import JiashuHealthProbe

final class NativeWorkspacePersistenceTests: XCTestCase {
    private var stores: [NativeWorkspacePersistence] = []
    private var directories: [URL] = []

    override func tearDown() {
        stores.forEach { try? $0.clear() }
        directories.forEach { try? FileManager.default.removeItem(at: $0) }
        super.tearDown()
    }

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("synthetic-protected-tests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        directories.append(url)
        return url
    }

    private func store(user: String = "synthetic-a", scope: String = "finance-balance", directory: URL,
                       service: String = "", limit: Int = 20 * 1024 * 1024) -> NativeWorkspacePersistence {
        let result = NativeWorkspacePersistence(userID: user, scope: scope, directory: directory,
            service: service.isEmpty ? "synthetic.protected-tests." + UUID().uuidString : service, maximumBytes: limit)
        stores.append(result)
        return result
    }

    private func files(in directory: URL) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "sealed" }
    }

    func testFrozenRequestRoundTripsExactBytesAndTypedDraftWithoutPlaintextFiles() throws {
        let folder = try directory()
        let persistence = store(directory: folder)
        let frozen = Data(#"{"operationId":"synthetic-original-operation","amount_minor":"900719925474099312345","note":"合成草稿 / \"quote\"","expectedRevision":4}"#.utf8)
        try persistence.saveData(frozen)
        XCTAssertEqual(try persistence.loadData(), frozen)
        let file = try XCTUnwrap(files(in: folder).first)
        let encrypted = try Data(contentsOf: file)
        XCTAssertNotEqual(encrypted, frozen)
        XCTAssertFalse(String(decoding: encrypted, as: UTF8.self).contains("synthetic-original-operation"))
        XCTAssertEqual(encrypted.count, frozen.count + 28)
        XCTAssertEqual(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        struct Draft: Codable, Equatable { let note: String; let amount: String; let operationID: String }
        let draft = Draft(note: "合成草稿", amount: "900719925474099312345", operationID: "same-operation-after-restart")
        try persistence.save(draft)
        XCTAssertEqual(try persistence.load(Draft.self), draft)
    }

    func testAccountAndScopePartitionsDoNotShareFilesOrKeys() throws {
        let folder = try directory(), service = "synthetic.protected-tests." + UUID().uuidString
        let a = store(user: "synthetic-a", scope: "nutrition", directory: folder, service: service)
        let b = store(user: "synthetic-b", scope: "nutrition", directory: folder, service: service)
        let anotherScope = store(user: "synthetic-a", scope: "finance", directory: folder, service: service)
        try a.saveData(Data("synthetic a nutrition".utf8))
        XCTAssertNil(try b.loadData())
        XCTAssertNil(try anotherScope.loadData())
        try b.saveData(Data("synthetic b nutrition".utf8))
        try anotherScope.saveData(Data("synthetic a finance".utf8))
        XCTAssertEqual(try files(in: folder).count, 3)
        XCTAssertEqual(try a.loadData(), Data("synthetic a nutrition".utf8))
        XCTAssertEqual(try b.loadData(), Data("synthetic b nutrition".utf8))
        XCTAssertEqual(try anotherScope.loadData(), Data("synthetic a finance".utf8))
    }

    func testDelimiterCharactersCannotAliasAnotherAccountScopePair() throws {
        let folder = try directory(), service = "synthetic.protected-tests." + UUID().uuidString
        let a = store(user: "synthetic-a|family", scope: "draft", directory: folder, service: service)
        let b = store(user: "synthetic-a", scope: "family|draft", directory: folder, service: service)
        try a.saveData(Data("first partition".utf8))
        XCTAssertNil(try b.loadData())
        try b.saveData(Data("second partition".utf8))
        XCTAssertEqual(try a.loadData(), Data("first partition".utf8))
        XCTAssertEqual(try b.loadData(), Data("second partition".utf8))
        XCTAssertEqual(try files(in: folder).count, 2)
    }

    func testTamperedCiphertextFailsClosedAndOriginalRequestCanBeRetried() throws {
        let folder = try directory(), persistence = store(directory: folder)
        let original = Data("synthetic frozen request with unchanged operation id".utf8)
        try persistence.saveData(original)
        let file = try XCTUnwrap(files(in: folder).first)
        let pristine = try Data(contentsOf: file)
        var modified = pristine
        modified[modified.count - 1] ^= 1
        try modified.write(to: file)
        XCTAssertThrowsError(try persistence.loadData()) { error in
            guard case NativeWorkspacePersistenceError.corrupted = error else { return XCTFail("Expected authenticated decryption failure") }
        }
        XCTAssertEqual(try Data(contentsOf: file), modified, "A failed read must not overwrite the frozen request")
        try pristine.write(to: file)
        XCTAssertEqual(try persistence.loadData(), original)
    }

    func testCopyingCiphertextBetweenAccountsCannotDecryptIt() throws {
        let folder = try directory(), service = "synthetic.protected-tests." + UUID().uuidString
        let a = store(user: "synthetic-a", directory: folder, service: service)
        let b = store(user: "synthetic-b", directory: folder, service: service)
        try a.saveData(Data("synthetic owner a".utf8))
        let aFile = try XCTUnwrap(files(in: folder).first)
        try b.saveData(Data("synthetic owner b".utf8))
        let bFile = try XCTUnwrap(files(in: folder).first(where: { $0 != aFile }))
        try Data(contentsOf: aFile).write(to: bFile)
        XCTAssertThrowsError(try b.loadData())
        XCTAssertEqual(try a.loadData(), Data("synthetic owner a".utf8))
    }

    func testOversizeSaveLeavesPreviousDraftIntact() throws {
        let folder = try directory(), persistence = store(directory: folder, limit: 64)
        let original = Data(repeating: 7, count: 64)
        try persistence.saveData(original)
        let file = try XCTUnwrap(files(in: folder).first)
        let encrypted = try Data(contentsOf: file)
        XCTAssertThrowsError(try persistence.saveData(Data(repeating: 8, count: 65)))
        XCTAssertEqual(try Data(contentsOf: file), encrypted)
        XCTAssertEqual(try persistence.loadData(), original)
    }

    func testDeviceOnlyKeyMetadataAndInvalidKeyAreNotSilentlyReplaced() throws {
        let folder = try directory(), service = "synthetic.protected-tests." + UUID().uuidString
        let persistence = store(directory: folder, service: service)
        try persistence.saveData(Data("synthetic retry payload".utf8))
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        var matching = query
        matching[kSecReturnData as String] = true
        matching[kSecReturnAttributes as String] = true
        var raw: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(matching as CFDictionary, &raw), errSecSuccess)
        let item = try XCTUnwrap(raw as? [String: Any])
        let key = try XCTUnwrap(item[kSecValueData as String] as? Data)
        XCTAssertEqual(key.count, 32)
        XCTAssertEqual(item[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertNotEqual(item[kSecAttrSynchronizable as String] as? Bool, true)
        XCTAssertEqual(SecItemUpdate(query as CFDictionary, [kSecValueData as String: Data(repeating: 0, count: 31)] as CFDictionary), errSecSuccess)
        XCTAssertThrowsError(try persistence.loadData())
        XCTAssertEqual(SecItemUpdate(query as CFDictionary, [kSecValueData as String: key] as CFDictionary), errSecSuccess)
        XCTAssertEqual(try persistence.loadData(), Data("synthetic retry payload".utf8))
    }

    func testClearingOnePartitionDoesNotDiscardAnotherAndInvalidIdentityIsRejected() throws {
        let folder = try directory(), service = "synthetic.protected-tests." + UUID().uuidString
        let a = store(user: "synthetic-a", directory: folder, service: service)
        let b = store(user: "synthetic-b", directory: folder, service: service)
        try a.saveData(Data("a".utf8)); try b.saveData(Data("b".utf8))
        try a.clear()
        XCTAssertNil(try a.loadData())
        XCTAssertEqual(try b.loadData(), Data("b".utf8))
        XCTAssertThrowsError(try store(user: "", directory: folder).saveData(Data()))
        XCTAssertThrowsError(try store(user: "synthetic-a", scope: "bad\nscope", directory: folder).loadData())
    }
}
