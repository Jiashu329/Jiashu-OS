import Foundation
import XCTest
@testable import JiashuHealthProbe

final class NativeWorkspaceCoreTests: XCTestCase {
    func testJSONRoundTripPreservesUnknownZeroFalseAndExactMoneyStrings() throws {
        let original: NativeJSON = .object([
            "unknown": .null, "zero": .number(0), "enabled": .bool(false),
            "amountMinor": .string("9007199254740993"), "items": .array([.string("中文"), .number(1.25)])
        ])
        let result = try JSONDecoder().decode(NativeJSON.self, from: original.encodedData())
        XCTAssertEqual(result, original)
        XCTAssertNil(result["unknown"].stringValue)
        XCTAssertEqual(result["zero"].intValue, 0)
        XCTAssertEqual(result["enabled"].boolValue, false)
        XCTAssertEqual(result["amountMinor"].stringValue, "9007199254740993")
        XCTAssertNil(result["amountMinor"].doubleValue)
        XCTAssertEqual(result["missing"], .null)
        XCTAssertEqual(result["items"].arrayValue.count, 2)
    }

    func testJSONTypedAccessNeverCoercesBooleansStringsOrFractionalNumbers() throws {
        let result = try JSONDecoder().decode(NativeJSON.self, from: Data("{\"flag\":true,\"name\":\"0\",\"n\":1.5}".utf8))
        XCTAssertNil(result["flag"].doubleValue)
        XCTAssertNil(result["name"].intValue)
        XCTAssertNil(result["n"].intValue)
        XCTAssertEqual(result["flag"].arrayValue, [])
        XCTAssertEqual(result["name"].objectValue, [:])
        XCTAssertThrowsError(try NativeJSON.number(.infinity).encodedData())
    }

    func testQueriesAndResourceIdentifiersAreEncodedAsValues() {
        let query = NativeWorkspaceFormat.query(["name": "a&b=中文", "book": "own"])
        let fields = URLComponents(string: "?" + query)?.queryItems
        XCTAssertEqual(fields?.first(where: { $0.name == "name" })?.value, "a&b=中文")
        let path = NativeWorkspaceFormat.pathComponent("weight:scale/a+b")
        XCTAssertEqual(path, "weight%3Ascale%2Fa%2Bb")
    }

    @MainActor
    func testAccountResetFencesAnUncooperativeLateOperationAndItsBusyState() async {
        let store = NativeFeatureStore(api: NativeAPI(), token: "old-token", userID: "owner-a")
        var resume: CheckedContinuation<NativeJSON, Never>?
        let old = Task { await store.perform { await withCheckedContinuation { resume = $0 } } }
        while resume == nil { await Task.yield() }
        XCTAssertTrue(store.busy)
        store.reset(token: "new-token", userID: "owner-b")
        let fresh = await store.perform { .object(["owner": .string("owner-b")]) }
        XCTAssertEqual(fresh?["owner"].stringValue, "owner-b")
        resume?.resume(returning: .object(["owner": .string("owner-a")]))
        _ = await old.value
        XCTAssertEqual(store.data["owner"].stringValue, "owner-b")
        XCTAssertNil(store.error)
        XCTAssertFalse(store.busy)
    }
}
