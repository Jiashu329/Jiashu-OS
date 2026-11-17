import Foundation
import XCTest
@testable import JiashuHealthProbe

final class NativeFinanceTests: XCTestCase {
    func testMoneyNeverPassesThroughFloatingPointAndJPYHasNoFractions() throws {
        XCTAssertEqual(try NativeFinanceContract.amount("9999999999999999.99", currency: "CNY"), "9999999999999999.99")
        XCTAssertEqual(try NativeFinanceContract.amount("00012.3", currency: "USD"), "12.30")
        XCTAssertEqual(try NativeFinanceContract.amount("9,007,199,254,740,993.12", currency: "CNY"), "9007199254740993.12")
        XCTAssertThrowsError(try NativeFinanceContract.amount("1,00.00", currency: "CNY"))
        XCTAssertThrowsError(try NativeFinanceContract.amount("1,000 000.00", currency: "CNY"))
        XCTAssertEqual(try NativeFinanceContract.amount("0", currency: "CNY"), "0.00")
        XCTAssertEqual(try NativeFinanceContract.amount("999999999999999999", currency: "JPY"), "999999999999999999")
        XCTAssertEqual(NativeFinanceContract.money("900719925474099312", currency: "CNY"), "CNY 9007199254740993.12")
        XCTAssertEqual(NativeFinanceContract.money("-1", currency: "CNY"), "CNY -0.01")
        XCTAssertEqual(NativeFinanceContract.money("0", currency: "JPY"), "JPY 0")
        XCTAssertEqual(NativeFinanceContract.money(nil, currency: "CNY"), "暂无记录")
        for input in ["-1", "1e3", "1.001", "NaN", "", ".1", "1.", "10000000000000000.00", "1\n", "１"] {
            XCTAssertThrowsError(try NativeFinanceContract.amount(input, currency: "CNY"), input)
        }
        XCTAssertThrowsError(try NativeFinanceContract.amount("1.0", currency: "JPY"))
        XCTAssertThrowsError(try NativeFinanceContract.amount("1", currency: "XXX"))
    }

    func testPercentUsesExactBasisPointsAndDateUsesShanghaiDay() throws {
        XCTAssertEqual(try NativeFinanceContract.basisPoints("12.34"), 1234)
        XCTAssertEqual(try NativeFinanceContract.basisPoints("100"), 10000)
        XCTAssertThrowsError(try NativeFinanceContract.basisPoints("100.01"))
        XCTAssertThrowsError(try NativeFinanceContract.basisPoints("1.234"))
        let time = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-16T16:00:00Z"))
        XCTAssertEqual(NativeFinanceContract.today(time), "2026-11-17")
        XCTAssertEqual(try NativeFinanceContract.day("2024-02-29"), "2024-02-29")
        for invalid in ["2025-02-29", "2026-13-01", "2026-11-31", "2026-1-01", "2026-11-17x"] { XCTAssertThrowsError(try NativeFinanceContract.day(invalid)) }
    }

    func testSharedBookScopeAlwaysCarriesOriginalGrantWithoutChangingCurrency() throws {
        let scoped = NativeFinanceContract.scoped("finance/accounts/record", ledger: "family", book: "synthetic-book", revision: 7, extra: ["currency": "USD"])
        let query = try XCTUnwrap(URLComponents(string: scoped)?.queryItems)
        XCTAssertEqual(query.first { $0.name == "book" }?.value, "synthetic-book")
        XCTAssertEqual(query.first { $0.name == "bookRevision" }?.value, "7")
        XCTAssertEqual(query.first { $0.name == "ledger" }?.value, "family")
        XCTAssertEqual(query.first { $0.name == "currency" }?.value, "USD")
        let personal = NativeFinanceContract.scoped("finance", ledger: "personal", book: "synthetic-book", revision: 7)
        XCTAssertFalse(personal.contains("book="))
        XCTAssertFalse(personal.contains("bookRevision="))
    }

    func testNativeFinanceLinksRejectExternalSchemesAndPreserveGrantAndCurrency() throws {
        let book = "12345678-1234-4123-8123-123456789abc"
        let link = try XCTUnwrap(NativeFinanceNavigation("/finance/activity?ledger=family&book=" + book + "&bookRevision=4&currency=JPY"))
        XCTAssertEqual(NativeFinanceNavigation("/finance?account=" + book)?.destination, "account:" + book)
        XCTAssertEqual(NativeFinanceNavigation("/finance/accounts/" + book)?.destination, "account:" + book)
        XCTAssertEqual(NativeFinanceNavigation("/finance/review?month=2026-10")?.month, "2026-10")
        XCTAssertEqual(link.destination, "activity"); XCTAssertEqual(link.book, book); XCTAssertEqual(link.revision, 4); XCTAssertEqual(link.currency, "JPY")
        for invalid in ["https://different.example/finance", "javascript:finance/goals", "https://www.treefund.asia:444/finance", "/finance?ledger=personal&book=" + book, "/finance?bookRevision=-1", "/finance?ledger=personal&ledger=family", "/finance/unknown"] {
            XCTAssertNil(NativeFinanceNavigation(invalid), invalid)
        }
    }

    func testCorrectionPreservesBothCASVersionsAndVoidOmitsBalanceFields() throws {
        let entry: NativeJSON = .object(["revision": .number(4)])
        let account: NativeJSON = .object(["balanceRevision": .number(12), "metadataRevision": .number(9), "currency": .string("CNY")])
        let correction = try NativeFinanceContract.correctionBody(entry: entry, account: account, action: "correct", amount: "9007199254740993.12", date: "2026-01-01", note: "synthetic", reason: "核对银行余额")
        XCTAssertEqual(correction["expectedRevision"].intValue, 4)
        XCTAssertEqual(correction["expectedAccountRevision"].intValue, 12)
        XCTAssertEqual(correction["amount"].stringValue, "9007199254740993.12")
        XCTAssertEqual(correction["asOfDate"].stringValue, "2026-01-01")
        XCTAssertNil(correction.objectValue["metadataRevision"])
        let void = try NativeFinanceContract.correctionBody(entry: entry, account: account, action: "void", amount: "invalid", date: "invalid", note: "ignored", reason: "重复记录")
        XCTAssertEqual(Set(void.objectValue.keys), Set(["action", "expectedRevision", "expectedAccountRevision", "reason"]))
        XCTAssertThrowsError(try NativeFinanceContract.correctionBody(entry: .null, account: account, action: "correct", amount: "1", date: "2026-01-01", note: "", reason: "test"))
        XCTAssertThrowsError(try NativeFinanceContract.correctionBody(entry: entry, account: account, action: "void", amount: "", date: "", note: "", reason: " "))
    }

    func testPendingKeychainIsOwnerScopedAndPreservesBytesAndOperationIdentity() throws {
        let service = "synthetic.finance.pending." + UUID().uuidString
        let first = NativeFinancePendingStore(owner: "synthetic-a", service: service)
        let second = NativeFinancePendingStore(owner: "synthetic-b", service: service)
        defer { try? first.clear(); try? second.clear() }
        let body = Data("{\"amount\":\"9007199254740993.12\",\"asOfDate\":\"2026-01-01\"}".utf8)
        let operation = NativeFinancePending(owner: "synthetic-a", title: "记录余额", path: "finance/accounts/synthetic/balances?ledger=family&book=old-book&bookRevision=7", method: "POST", body: body, operationID: UUID().uuidString.lowercased(), createdAt: Date())
        try first.save(operation)
        XCTAssertNil(try second.load())
        let loaded = try XCTUnwrap(first.load())
        XCTAssertEqual(loaded.body, body)
        XCTAssertEqual(loaded.path, operation.path)
        XCTAssertEqual(loaded.operationID, operation.operationID)
        XCTAssertThrowsError(try second.save(operation))
    }

    @MainActor
    func testUncertainWriteRetriesOriginalBodyKeyAndBookEvenAfterSelectionChanges() async throws {
        let owner = "synthetic-finance-" + UUID().uuidString
        let pending = NativeFinancePendingStore(owner: owner)
        defer { try? pending.clear() }
        let host = "finance-" + UUID().uuidString.lowercased() + ".example"
        let recorder = FinanceRecordedRequests()
        FinanceURLProtocol.register(host: host) { request in
            let body = FinanceURLProtocol.body(request)
            recorder.append((request.url!.absoluteString, request.value(forHTTPHeaderField: "Idempotency-Key"), body))
            if recorder.count == 1 { return (503, Data("{\"error\":\"synthetic unavailable\"}".utf8)) }
            return (201, Data("{\"account\":{\"id\":\"synthetic\"}}".utf8))
        }
        defer { FinanceURLProtocol.remove(host: host) }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FinanceURLProtocol.self]
        let api = NativeAPI(baseURL: URL(string: "https://" + host)!, configuration: config)
        let context = NativeFinanceContext(api: api, token: "synthetic-token", userID: owner)
        context.select(ledger: "family", book: .object(["id": .string("old-book"), "accessRevision": .number(7), "role": .string("editor")]))
        let path = context.path("finance/accounts/synthetic/balances")
        let body = try NativeFinanceContract.balanceBody(amount: "9007199254740993.12", currency: "CNY", date: "2026-01-01", note: "synthetic")
        do { _ = try await context.write(title: "记录余额", path: path, method: "POST", body: body, idempotent: true); XCTFail("503 unexpectedly succeeded") } catch {}
        XCTAssertNotNil(context.pending)
        XCTAssertNotNil(try pending.load())
        context.select(ledger: "personal")
        await context.retryPending()
        XCTAssertNil(context.pending)
        XCTAssertNil(try pending.load())
        let requests = recorder.values
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].0, requests[1].0)
        XCTAssertTrue(requests[1].0.contains("book=old-book"))
        XCTAssertTrue(requests[1].0.contains("bookRevision=7"))
        XCTAssertEqual(requests[0].1, requests[1].1)
        XCTAssertNotNil(requests[0].1)
        XCTAssertEqual(requests[0].2, requests[1].2)
    }
}

private final class FinanceRecordedRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [(String, String?, Data)] = []
    func append(_ request: (String, String?, Data)) { lock.lock(); defer { lock.unlock() }; storage.append(request) }
    var values: [(String, String?, Data)] { lock.lock(); defer { lock.unlock() }; return storage }
    var count: Int { lock.lock(); defer { lock.unlock() }; return storage.count }
}

private final class FinanceURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var handlers: [String: (URLRequest) throws -> (Int, Data)] = [:]
    static func register(host: String, handler: @escaping (URLRequest) throws -> (Int, Data)) { lock.lock(); defer { lock.unlock() }; handlers[host] = handler }
    static func remove(host: String) { lock.lock(); defer { lock.unlock() }; handlers.removeValue(forKey: host) }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".example") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let handler = Self.handlers[request.url?.host ?? ""]; Self.lock.unlock()
        do {
            guard let handler, let url = request.url else { throw URLError(.badURL) }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
    static func body(_ request: URLRequest) -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }; stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
        return data
    }
}
