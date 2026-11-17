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
        XCTAssertEqual(NativeFinanceContract.money("900719925474099312", currency: "CNY"), "CNY 9,007,199,254,740,993.12")
        XCTAssertEqual(NativeFinanceContract.money("-1", currency: "CNY"), "CNY -0.01")
        XCTAssertEqual(NativeFinanceContract.money("0", currency: "JPY"), "JPY 0")
        XCTAssertEqual(NativeFinanceContract.money(nil, currency: "CNY"), "暂无记录")
        for input in ["-1", "1e3", "1.001", "NaN", "", ".1", "1.", "10000000000000000.00", "1\n", "１"] {
            XCTAssertThrowsError(try NativeFinanceContract.amount(input, currency: "CNY"), input)
        }
        XCTAssertThrowsError(try NativeFinanceContract.amount("1.0", currency: "JPY"))
        XCTAssertThrowsError(try NativeFinanceContract.amount("1", currency: "XXX"))
    }

    func testNativeInputNormalizesDecimalKeyboardWithoutLosingLargeMoney() throws {
        XCTAssertEqual(try NativeFinanceContract.inputAmount("12,34", currency: "EUR", decimalSeparator: ","), "12.34")
        XCTAssertEqual(try NativeFinanceContract.inputAmount("9,007,199,254,740,993.12", currency: "CNY", decimalSeparator: ","), "9007199254740993.12")
        XCTAssertEqual(try NativeFinanceContract.inputAmount("1,234", currency: "JPY", decimalSeparator: ","), "1234")
        XCTAssertThrowsError(try NativeFinanceContract.inputAmount("1,5", currency: "JPY", decimalSeparator: ","))
        XCTAssertThrowsError(try NativeFinanceContract.inputAmount("12,34", currency: "EUR", decimalSeparator: "."))
        XCTAssertEqual(NativeFinanceContract.money("999999999999999999", currency: "JPY"), "JPY 999,999,999,999,999,999")
        XCTAssertEqual(NativeFinanceContract.money("-900719925474099312", currency: "USD"), "USD -9,007,199,254,740,993.12")
    }

    func testNativeCalendarRoundTripsAndMonthlyChecklistRejectsFutureDates() throws {
        for day in ["1970-01-01", "2024-02-29", "2026-11-17", "2100-12-31"] {
            XCTAssertEqual(NativeFinanceContract.today(try XCTUnwrap(NativeFinanceContract.dateValue(day))), day)
        }
        let newYear = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-01-01T00:00:00Z"))
        XCTAssertEqual(NativeFinanceContract.previousMonth(newYear), "2025-12")
        XCTAssertTrue(NativeFinanceContract.checkedThisMonth("2026-11-01", today: "2026-11-17"))
        XCTAssertFalse(NativeFinanceContract.checkedThisMonth("2026-11-18", today: "2026-11-17"))
        XCTAssertFalse(NativeFinanceContract.checkedThisMonth("2026-10-31", today: "2026-11-17"))
        XCTAssertFalse(NativeFinanceContract.checkedThisMonth(nil, today: "2026-11-17"))
    }

    func testPersistedScopeRequiresAnExactCurrentMembership() throws {
        let book = "12345678-1234-4123-8123-123456789abc"
        let selection = NativeFinanceSelection(ledger: "family", book: book, currency: "USD")
        XCTAssertTrue(selection.isValid)
        XCTAssertNil(selection.membership(in: [.object(["id": .string("own"), "role": .string("owner")])]))
        let current: NativeJSON = .object(["id": .string(book), "accessRevision": .number(8), "role": .string("viewer")])
        XCTAssertEqual(selection.membership(in: [current])?["role"].stringValue, "viewer")
        XCTAssertFalse(NativeFinanceSelection(ledger: "personal", book: book, currency: "USD").isValid)
        XCTAssertFalse(NativeFinanceSelection(ledger: "family", book: "foreign-book", currency: "CNY").isValid)
        XCTAssertFalse(NativeFinanceSelection(ledger: "personal", book: "own", currency: "XXX").isValid)
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
        XCTAssertTrue(try XCTUnwrap(loaded.recoveryPath).contains("book=old-book"))
        XCTAssertTrue(try XCTUnwrap(loaded.recoveryPath).contains("bookRevision=7"))
        XCTAssertThrowsError(try second.save(operation))
    }

    @MainActor
    func testRemovedSharedMembershipNeverFallsBackToPersonalBalances() async throws {
        let owner = "synthetic-finance-removed-" + UUID().uuidString
        let preference = NativeWorkspacePersistence(userID: owner, scope: "finance-selection")
        defer { try? preference.clear(); try? NativeFinancePendingStore(owner: owner).clear() }
        try preference.save(NativeFinanceSelection(ledger: "family", book: "12345678-1234-4123-8123-123456789abc", currency: "CNY"))
        let host = "finance-removed-" + UUID().uuidString.lowercased() + ".example"
        FinanceURLProtocol.register(host: host) { request in
            XCTAssertTrue(request.url!.path.hasSuffix("/books"), "A removed scope must not read a different ledger")
            return (200, Data("{\"books\":[{\"id\":\"own\",\"name\":\"我的家庭账本\",\"role\":\"owner\",\"accessRevision\":0}],\"invitations\":[]}".utf8))
        }
        defer { FinanceURLProtocol.remove(host: host) }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [FinanceURLProtocol.self]
        let context = NativeFinanceContext(api: NativeAPI(baseURL: URL(string: "https://" + host)!, configuration: configuration), token: "synthetic-token", userID: owner)
        do { _ = try await context.read(context.path("finance")); XCTFail("Removed membership was accepted") } catch {}
        XCTAssertTrue(context.blocked); XCTAssertFalse(context.canWrite)
        XCTAssertEqual(context.ledger, "family")
        await context.loadBooks()
        XCTAssertEqual(context.books.first?["id"].stringValue, "own", "The book selector must remain recoverable")
    }

    @MainActor
    func testRestoredSharedScopeRechecksCurrentRoleAndGrantBeforeReadingBalances() async throws {
        let owner = "synthetic-finance-scope-" + UUID().uuidString
        let book = "12345678-1234-4123-8123-123456789abc"
        let preference = NativeWorkspacePersistence(userID: owner, scope: "finance-selection")
        defer { try? preference.clear(); try? NativeFinancePendingStore(owner: owner).clear() }
        try preference.save(NativeFinanceSelection(ledger: "family", book: book, currency: "JPY"))
        let host = "finance-scope-" + UUID().uuidString.lowercased() + ".example"
        FinanceURLProtocol.register(host: host) { request in
            if request.url?.path.hasSuffix("/books") == true {
                return (200, Data(("{\"books\":[{\"id\":\"" + book + "\",\"name\":\"家用\",\"ownerName\":\"家人\",\"role\":\"viewer\",\"accessRevision\":8}],\"invitations\":[]}").utf8))
            }
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            XCTAssertEqual(query.first { $0.name == "bookRevision" }?.value, "8")
            XCTAssertEqual(query.first { $0.name == "book" }?.value, book)
            return (200, Data("{\"accounts\":[],\"summary\":{\"byCurrency\":{}}}".utf8))
        }
        defer { FinanceURLProtocol.remove(host: host) }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [FinanceURLProtocol.self]
        let context = NativeFinanceContext(api: NativeAPI(baseURL: URL(string: "https://" + host)!, configuration: configuration), token: "synthetic-token", userID: owner)
        XCTAssertFalse(context.canWrite)
        _ = try await context.read(context.path("finance"))
        XCTAssertEqual(context.role, "viewer"); XCTAssertEqual(context.accessRevision, 8)
        XCTAssertEqual(context.scopeSummary, "家用 · 家人 · JPY")
        XCTAssertFalse(context.canWrite)
        let other = NativeFinanceContext(api: context.api, token: "synthetic-token", userID: owner + "-other")
        XCTAssertEqual(other.ledger, "personal"); XCTAssertEqual(other.currency, "CNY")
    }

    @MainActor
    func testUncertainWriteRetriesOriginalBodyKeyAndBookEvenAfterSelectionChanges() async throws {
        let owner = "synthetic-finance-" + UUID().uuidString
        let pending = NativeFinancePendingStore(owner: owner)
        defer { try? pending.clear(); try? NativeWorkspacePersistence(userID: owner, scope: "finance-selection").clear() }
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
