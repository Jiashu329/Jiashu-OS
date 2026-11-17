import Foundation
import Security
import SwiftUI
import UniformTypeIdentifiers
import UIKit

/// Presentation and request contracts only. Totals, progress, liquidity and month
/// calculations always come from the server; monetary values never pass through Double.
enum NativeFinanceContract {
    static let currencies = ["CNY", "HKD", "USD", "EUR", "GBP", "SGD", "AUD", "CAD", "JPY"]
    static let accountTypes = [("cash", "现金"), ("bank", "银行存款"), ("investment", "投资"), ("property", "房产"), ("receivable", "应收款"), ("other_asset", "其他资产"), ("credit_card", "信用卡欠款"), ("loan", "贷款"), ("other_liability", "其他负债")]
    static let liquidityKinds = [("liquid", "可随时动用"), ("restricted", "部分可动用"), ("illiquid", "暂不可动用"), ("unreviewed", "尚未核对")]
    static func typeName(_ value: String) -> String { accountTypes.first { $0.0 == value }?.1 ?? value }
    static func liquidityName(_ value: String) -> String { liquidityKinds.first { $0.0 == value }?.1 ?? "尚未核对" }
    static func roleName(_ value: String) -> String { value == "owner" ? "拥有人" : value == "editor" ? "可编辑" : "只读" }
    static func today(_ date: Date = Date()) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai"); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
    static func day(_ value: String) throws -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard value.count == 10, let date = formatter.date(from: value), formatter.string(from: date) == value,
              value >= "1970-01-01", value <= "2100-12-31" else { throw NativeFinanceInputError("请输入有效的 YYYY-MM-DD 日期。") }
        return value
    }
    static func amount(_ raw: String, currency: String) throws -> String {
        guard currencies.contains(currency), raw.utf8.count <= 128,
              !raw.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw NativeFinanceInputError("请核对金额和币种。") }
        let value = raw.trimmingCharacters(in: .whitespaces)
        let pieces = value.split(separator: ".", omittingEmptySubsequences: false)
        guard !pieces.isEmpty, pieces.count <= 2 else { throw NativeFinanceInputError("金额格式不正确。") }
        let whole = String(pieces[0])
        let plain = whole.range(of: "^[0-9]+$", options: .regularExpression) != nil
        let grouped = whole.range(of: "^[0-9]{1,3}([,，   ])[0-9]{3}(?:\\1[0-9]{3})*$", options: .regularExpression) != nil
        guard plain || grouped else { throw NativeFinanceInputError("金额应为非负数字，千位分组需完整且使用同一种分隔符。") }
        let fraction = pieces.count == 2 ? String(pieces[1]) : ""
        if pieces.count == 2 {
            guard currency != "JPY", fraction.range(of: "^[0-9]{1,2}$", options: .regularExpression) != nil else { throw NativeFinanceInputError(currency == "JPY" ? "日元金额请填整数。" : "金额最多两位小数。") }
        }
        let digits = whole.filter { $0.isASCII && $0.isNumber }.drop(while: { $0 == "0" })
        let integer = digits.isEmpty ? "0" : String(digits)
        let minor = (integer + (currency == "JPY" ? "" : fraction.padding(toLength: 2, withPad: "0", startingAt: 0))).drop(while: { $0 == "0" })
        guard minor.count <= 18 else { throw NativeFinanceInputError("单个账户金额最多支持18位最小货币单位。") }
        return integer + (currency == "JPY" ? "" : "." + fraction.padding(toLength: 2, withPad: "0", startingAt: 0))
    }
    static func money(_ minor: NativeJSON, currency: String) -> String { money(minor.stringValue, currency: currency) }
    static func money(_ minor: String?, currency: String) -> String {
        guard let minor, !minor.isEmpty else { return "暂无记录" }
        let negative = minor.hasPrefix("-"); var digits = negative ? String(minor.dropFirst()) : minor
        guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return "金额暂不可用" }
        if currency != "JPY" {
            if digits.count < 3 { digits = String(repeating: "0", count: 3 - digits.count) + digits }
            digits.insert(".", at: digits.index(digits.endIndex, offsetBy: -2))
        }
        let parts = digits.split(separator: ".", omittingEmptySubsequences: false)
        let whole = String(parts[0])
        var grouped = ""
        for (index, character) in whole.reversed().enumerated() {
            if index > 0 && index % 3 == 0 { grouped.append(",") }
            grouped.append(character)
        }
        let decimal = String(grouped.reversed()) + (parts.count == 2 ? "." + String(parts[1]) : "")
        return currency + " " + (negative ? "-" : "") + decimal
    }
    static func inputAmount(_ raw: String, currency: String, decimalSeparator: String = Locale.current.decimalSeparator ?? ".") throws -> String {
        var value = raw
        if decimalSeparator == ",", !raw.contains("."), raw.filter({ $0 == "," }).count == 1 {
            let pieces = raw.split(separator: ",", omittingEmptySubsequences: false)
            if pieces.count == 2 && (1...2).contains(pieces[1].count) { value = raw.replacingOccurrences(of: ",", with: ".") }
        }
        return try amount(value, currency: currency)
    }
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return calendar
    }
    static func dateValue(_ day: String) -> Date? {
        guard (try? self.day(day)) != nil else { return nil }
        let values = day.split(separator: "-").compactMap { Int($0) }
        return calendar.date(from: DateComponents(year: values[0], month: values[1], day: values[2], hour: 12))
    }
    static func previousMonth(_ date: Date = Date()) -> String {
        let previous = calendar.date(byAdding: .month, value: -1, to: date) ?? date
        return String(today(previous).prefix(7))
    }
    static func checkedThisMonth(_ day: String?, today: String = NativeFinanceContract.today()) -> Bool {
        guard let day, (try? self.day(day)) != nil, day <= today else { return false }
        return day.prefix(7) == today.prefix(7)
    }
    static func basisPoints(_ raw: String) throws -> Int {
        let value = try inputAmount(raw, currency: "CNY")
        guard let ratio = Int(value.replacingOccurrences(of: ".", with: "")), ratio <= 10000 else { throw NativeFinanceInputError("可动用比例应为0至100%，最多两位小数。") }
        return ratio
    }
    static func scoped(_ path: String, ledger: String, book: String, revision: Int, extra: [String: String] = [:]) -> String {
        var components = URLComponents(string: path)!
        var fields = components.queryItems ?? []
        fields.append(URLQueryItem(name: "ledger", value: ledger))
        if ledger == "family" { fields += [URLQueryItem(name: "book", value: book), URLQueryItem(name: "bookRevision", value: String(revision))] }
        fields += extra.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        components.queryItems = fields
        return components.string!
    }
    static func balanceBody(amount: String, currency: String, date: String, note: String) throws -> NativeJSON {
        let date = try day(date)
        guard date <= today() else { throw NativeFinanceInputError("余额日期不能晚于北京时间今天。") }
        return .object(["amount": .string(try inputAmount(amount, currency: currency)), "asOfDate": .string(date), "note": .string(note)])
    }
    static func correctionBody(entry: NativeJSON, account: NativeJSON, action: String, amount: String, date: String, note: String, reason: String) throws -> NativeJSON {
        guard let entryRevision = entry["revision"].intValue, let accountRevision = account["balanceRevision"].intValue,
              !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw NativeFinanceInputError("请读取最新余额并填写修改原因。") }
        var body: [String: NativeJSON] = ["action": .string(action), "expectedRevision": .number(Double(entryRevision)), "expectedAccountRevision": .number(Double(accountRevision)), "reason": .string(reason)]
        if action == "correct" { try balanceBody(amount: amount, currency: account["currency"].stringValue ?? "CNY", date: date, note: note).objectValue.forEach { body[$0.key] = $0.value } }
        return .object(body)
    }
}

struct NativeFinanceInputError: LocalizedError { let message: String; init(_ message: String) { self.message = message }; var errorDescription: String? { message } }

struct NativeFinancePending: Codable {
    let owner: String
    let title: String
    let path: String
    let method: String
    let body: Data
    let operationID: String?
    let createdAt: Date
    var scopeLabel: String? = nil
    var targetName: String? = nil
    var currency: String? = nil
    var requestBody: NativeJSON { (try? JSONDecoder().decode(NativeJSON.self, from: body)) ?? .null }
    var summaryLines: [String] {
        let data = requestBody
        var result: [String] = []
        if let scopeLabel { result.append(scopeLabel) }
        if let targetName, !targetName.isEmpty { result.append(targetName) }
        if let amount = data["amount"].stringValue ?? data["targetAmount"].stringValue ?? data["monthlyExpenseAmount"].stringValue {
            result.append((currency ?? data["currency"].stringValue ?? "CNY") + " " + amount)
        }
        if let date = data["asOfDate"].stringValue ?? data["month"].stringValue ?? data["deadline"].stringValue { result.append(date) }
        if let email = data["email"].stringValue { result.append(email) }
        if let archived = data["archived"].boolValue { result.append(archived ? "归档" : "恢复") }
        if data["action"].stringValue == "void" { result.append("作废余额") }
        if let reason = data["reason"].stringValue, !reason.isEmpty { result.append(reason) }
        return result
    }
    var recoveryPath: String? {
        guard var parts = URLComponents(string: path) else { return nil }
        let segments = parts.path.split(separator: "/").map(String.init)
        if segments.count >= 3 && segments[1] == "accounts" { parts.path = segments.prefix(3).joined(separator: "/") }
        else if segments.count >= 3 && segments[1] == "goals" { parts.path = segments.prefix(3).joined(separator: "/") }
        else if parts.path == "finance/accounts", let operationID { parts.path += "/" + operationID }
        else if parts.path == "finance/goals", let operationID { parts.path += "/" + operationID }
        else if parts.path == "finance/review/close" {
            parts.path = "finance/review"
            var query = parts.queryItems ?? []
            for key in ["month", "currency"] { if let value = requestBody[key].stringValue { query.append(URLQueryItem(name: key, value: value)) } }
            parts.queryItems = query
        } else if parts.path.hasPrefix("finance/books/own/") { parts.path = "finance/books/own/members"; parts.queryItems = nil }
        else if parts.path.hasPrefix("finance/books/invitations/") { parts.path = "finance/books"; parts.queryItems = nil }
        else if parts.path != "finance/runway" { return nil }
        return parts.string
    }
}

/// Financial request bodies are encrypted by Keychain and are never shared with
/// another login. A request is saved BEFORE transmission and retained on ambiguity.
struct NativeFinancePendingStore {
    let owner: String
    var service = "asia.treefund.jiashu.native-finance-pending"
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: owner] }
    func load() throws -> NativeFinancePending? {
        var query = query; query[kSecReturnData as String] = true
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw NativeFinanceInputError("无法读取待确认财务操作，请解锁手机后重试。") }
        let pending = try JSONDecoder().decode(NativeFinancePending.self, from: data)
        guard pending.owner == owner else { throw NativeFinanceInputError("待确认操作的账户不一致。") }; return pending
    }
    func save(_ pending: NativeFinancePending) throws {
        guard pending.owner == owner else { throw NativeFinanceInputError("操作不属于当前账户。") }
        let updates: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(pending), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let result = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
        if result == errSecSuccess { return }
        guard result == errSecItemNotFound else { throw NativeFinanceInputError("无法保留原财务操作，本次未发送。") }
        var insert = query; updates.forEach { insert[$0.key] = $0.value }
        guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw NativeFinanceInputError("无法保留原财务操作，本次未发送。") }
    }
    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeFinanceInputError("无法清理已确认操作，请稍后重试。") }
    }
}

struct NativeFinanceSelection: Codable, Equatable {
    let ledger: String
    let book: String
    let currency: String
    var isValid: Bool {
        ["personal", "family"].contains(ledger) && NativeFinanceContract.currencies.contains(currency)
            && (book == "own" || (ledger == "family" && UUID(uuidString: book) != nil))
    }
    func membership(in books: [NativeJSON]) -> NativeJSON? {
        guard isValid, ledger == "family" else { return nil }
        return books.first { $0.financeID == book }
    }
}

private enum NativeFinanceReadState: Equatable { case loading, ready, failed(String) }

@MainActor
final class NativeFinanceContext: ObservableObject {
    let api: NativeAPI; let token: String; let userID: String
    @Published var ledger = "personal"
    @Published var bookID = "own"
    @Published var accessRevision = 0
    @Published var role = "owner"
    @Published var currency = "CNY" { didSet { if currency != oldValue { persistSelection() } } }
    @Published var bookName = "个人账本"
    @Published var ownerName = ""
    @Published var scopeReady = true
    @Published var books: [NativeJSON] = []
    @Published var bookLoading = true
    @Published var bookError: String?
    @Published var invitations: [NativeJSON] = []
    @Published var pending: NativeFinancePending?
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?
    @Published var blocked = false
    var initialReviewMonth: String?
    @Published var change = 0
    private var valid = true
    private var generation = UUID()
    private var storageReady = true
    private let store: NativeFinancePendingStore
    init(api: NativeAPI, token: String, userID: String) {
        self.api = api; self.token = token; self.userID = userID; self.store = NativeFinancePendingStore(owner: userID)
        do { pending = try store.load() } catch { self.error = error.localizedDescription; blocked = true; storageReady = false }
        do {
            if let selection = try selectionStore.load(NativeFinanceSelection.self), selection.isValid {
                ledger = selection.ledger; bookID = selection.book; currency = selection.currency
                bookName = ledger == "personal" ? "个人账本" : "家庭账本"
                scopeReady = ledger == "personal"; role = ledger == "personal" ? "owner" : "viewer"
            }
        } catch { self.notice = "未恢复上次账本" }
    }
    var canWrite: Bool { role != "viewer" && scopeReady && !blocked && storageReady && pending == nil && !busy }
    private var selectionStore: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: userID, scope: "finance-selection") }
    var scopeLabel: String { ownerName.isEmpty ? bookName : bookName + " · " + ownerName }
    var scopeSummary: String { scopeLabel + " · " + currency }
    private func persistSelection() {
        let selection = NativeFinanceSelection(ledger: ledger, book: bookID, currency: currency)
        guard selection.isValid else { return }
        do { try selectionStore.save(selection) } catch { notice = "未保存账本偏好" }
    }
    private func validateScope() async throws {
        guard !scopeReady else { return }
        let requested = NativeFinanceSelection(ledger: ledger, book: bookID, currency: currency)
        let data = try await api.json(path: "finance/books", token: token)
        try Task.checkCancellation()
        guard valid else { throw CancellationError() }
        guard !scopeReady, requested.ledger == ledger, requested.book == bookID, requested.currency == currency else { return }
        books = data["books"].arrayValue; invitations = data["invitations"].arrayValue
        let selected = NativeFinanceSelection(ledger: ledger, book: bookID, currency: currency)
        guard let book = selected.membership(in: books) else { blocked = true; throw NativeFinanceInputError("请重新选择账本") }
        bookName = book["name"].stringValue ?? "家庭账本"; ownerName = book["ownerName"].stringValue ?? ""
        accessRevision = book["accessRevision"].intValue ?? 0; role = book["role"].stringValue ?? "viewer"
        scopeReady = true
    }
    var scopeID: String { ledger + ":" + bookID + ":" + String(accessRevision) + ":" + currency }
    func path(_ path: String, extra: [String: String] = [:]) -> String { NativeFinanceContract.scoped(path, ledger: ledger, book: bookID, revision: accessRevision, extra: extra) }
    func draftScope(_ form: String) -> String { "finance:" + scopeID + ":" + form }
    var storageUnavailable: Bool { !storageReady }
    func retryPendingStorage() {
        do { pending = try store.load(); storageReady = true; blocked = false; error = nil; change += 1 } catch { storageReady = false; blocked = true; fail(error) }
    }
    func deactivate() { valid = false; generation = UUID() }
    func activate() { valid = true }
    func read(_ path: String) async throws -> NativeJSON {
        let requestedLedger = ledger; let requestedBook = bookID; let requestedCurrency = currency
        try await validateScope()
        guard requestedLedger == ledger, requestedBook == bookID, requestedCurrency == currency else { throw CancellationError() }
        let originalScope = scopeID; let epoch = generation
        var components = URLComponents(string: path)
        if ledger == "family", components?.queryItems?.first(where: { $0.name == "book" })?.value == bookID {
            let updatedQuery: [URLQueryItem]? = components?.queryItems?.map { item in
                item.name == "bookRevision" ? URLQueryItem(name: "bookRevision", value: String(accessRevision)) : item
            }
            components?.queryItems = updatedQuery
        }
        let result = try await api.json(path: components?.string ?? path, token: token)
        try Task.checkCancellation(); guard valid, epoch == generation, originalScope == scopeID else { throw CancellationError() }
        if let currentRole = result["book"]["role"].stringValue { role = currentRole }
        error = nil
        return result
    }
    func readFailed(_ failure: Error) {
        guard let server = failure as? NativeAPIError else { return }
        if ["FINANCE_BOOK_ACCESS_REVOKED", "FINANCE_BOOK_ACCESS_CHANGED", "ACCOUNT_CHANGED"].contains(server.code ?? "") { fail(failure) }
    }
    func fail(_ failure: Error) {
        guard valid, !(failure is CancellationError) else { return }
        error = failure.localizedDescription
        if let failure = failure as? NativeAPIError, ["FINANCE_BOOK_ACCESS_REVOKED", "FINANCE_BOOK_ACCESS_CHANGED", "ACCOUNT_CHANGED"].contains(failure.code ?? "") { blocked = true; books = []; notice = "账本授权已变化，请重新选择；原请求仍保留在原账本。" }
    }
    func loadBooks() async {
        bookLoading = true; defer { bookLoading = false }
        do {
            let epoch = generation
            let result = try await api.json(path: "finance/books", token: token)
            try Task.checkCancellation(); guard valid, generation == epoch else { return }
            guard case .array = result["books"] else { throw NativeAPIError.invalidResponse }
            books = result["books"].arrayValue; invitations = result["invitations"].arrayValue; bookError = nil
        }
        catch is CancellationError {} catch { bookError = error.localizedDescription; readFailed(error) }
    }
    func select(ledger: String, book: NativeJSON? = nil) {
        self.ledger = ledger; bookID = book?["id"].stringValue ?? "own"; accessRevision = book?["accessRevision"].intValue ?? 0
        role = book?["role"].stringValue ?? "owner"; blocked = !storageReady; error = nil
        bookName = ledger == "personal" ? "个人账本" : book?["name"].stringValue ?? "我的家庭账本"
        ownerName = ledger == "family" ? book?["ownerName"].stringValue ?? "" : ""
        scopeReady = true; persistSelection(); change += 1
    }
    @discardableResult func write(title: String, path: String, method: String, body: NativeJSON, idempotent: Bool = false, targetName: String? = nil) async throws -> NativeJSON {
        guard valid, !busy, pending == nil, !blocked, storageReady, scopeReady else { throw NativeFinanceInputError("请先核对待确认的原操作或重新选择账本。") }
        let command = NativeFinancePending(owner: userID, title: title, path: path, method: method, body: try body.encodedData(), operationID: idempotent ? UUID().uuidString.lowercased() : nil, createdAt: Date(), scopeLabel: path.hasPrefix("finance/books/own/") ? "我的家庭账本" : scopeLabel, targetName: targetName ?? body["name"].stringValue, currency: currency)
        try store.save(command); pending = command
        return try await send(command)
    }
    @discardableResult private func send(_ command: NativeFinancePending) async throws -> NativeJSON {
        guard valid, !busy, command.owner == userID else { throw NativeFinanceInputError("当前无法确认此操作。") }
        let epoch = generation
        busy = true; defer { busy = false }
        do {
            let body = try JSONDecoder().decode(NativeJSON.self, from: command.body)
            let response = try await api.json(path: command.path, method: command.method, token: token, body: body, headers: command.operationID.map { ["Idempotency-Key": $0] } ?? [:])
            // Clear receipt even if its screen disappeared; the command is scoped
            // to this immutable context and cannot be delivered to another user.
            try store.clear(); pending = nil
            guard valid, epoch == generation else { throw CancellationError() }; notice = command.title + "已确认。"; change += 1
            return response
        } catch {
            // Definitive validation/permission rejection permits editing. Network,
            // timeout, cancellation and 5xx retain the original bytes and UUID.
            if let server = error as? NativeAPIError, case .server(let status, let code, _, _) = server, [400, 404, 409, 413, 415, 422].contains(status), code != "FINANCE_BOOK_ACCESS_CHANGED" {
                do { try store.clear(); pending = nil } catch { storageReady = false; blocked = true }
            }
            if valid, epoch == generation { fail(error) }; throw error
        }
    }
    func retryPending() async {
        guard let pending, pending.operationID != nil else { return }
        do { _ = try await send(pending) } catch { fail(error) }
    }
    func reconcilePending() {
        do { try store.clear(); pending = nil; notice = "已结束原操作核对；请读取最新资料。"; change += 1 } catch { fail(error) }
    }
}

struct NativeFinanceRoot: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var context: NativeFinanceContext
    private let embedded: Bool
    private let destination: String?
    @State private var showDestination: Bool
    init(api: NativeAPI, token: String, userID: String, initialPath: String? = nil, embedded: Bool = false) {
        self.embedded = embedded
        let context = NativeFinanceContext(api: api, token: token, userID: userID)
        let target = initialPath.flatMap(NativeFinanceNavigation.init)
        if let target {
            context.ledger = target.ledger; context.bookID = target.book; context.accessRevision = target.revision
            context.currency = target.currency; context.role = target.book == "own" ? "owner" : "viewer"; context.initialReviewMonth = target.month
            context.scopeReady = target.ledger == "personal"; context.bookName = target.ledger == "personal" ? "个人账本" : "家庭账本"; context.ownerName = ""
        }
        _context = StateObject(wrappedValue: context)
        destination = target?.destination; _showDestination = State(initialValue: target?.destination != nil)
    }
    var body: some View {
        NavigationStack {
            NativeFinanceDashboard(context: context)
                .nativeGeometricPage().navigationTitle("财务")
                .toolbar { if embedded { ToolbarItem(placement: .topBarLeading) { Button("返回") { dismiss() } } } }
                .navigationDestination(isPresented: $showDestination) {
                    Group {
                    switch destination {
                    case "goals": NativeFinanceGoals(context: context)
                    case "runway": NativeFinanceRunway(context: context)
                    case "review": NativeFinanceReview(context: context)
                    case "balances": NativeFinanceBalanceCheck(context: context)
                    case "activity": NativeFinanceActivity(context: context)
                    default:
                        if let destination, destination.hasPrefix("account:") { NativeFinanceAccountDetail(context: context, accountID: String(destination.dropFirst(8))) } else { EmptyView() }
                    }
                    }
                    .toolbar { if embedded { ToolbarItem(placement: .topBarLeading) { Button("返回") { dismiss() } } } }
                }
        }
        .onAppear { context.activate() }
        .onDisappear { context.deactivate() }
    }
}

struct NativeFinanceNavigation {
    let ledger: String; let book: String; let revision: Int; let currency: String; let destination: String?; let month: String?
    init?(_ href: String) {
        guard let components = URLComponents(string: href), components.fragment == nil,
              (components.scheme == nil && components.host == nil) || (components.scheme == "https" && components.host == NativeAPI.websiteURL.host && (components.port == nil || components.port == 443)),
              components.user == nil, components.password == nil else { return nil }
        let segments = components.path.split(separator: "/").map(String.init)
        guard segments.first == "finance", segments.count <= 3 else { return nil }
        let supported = ["goals", "runway", "review", "balances", "activity"]
        if segments.count == 2 && !supported.contains(segments[1]) { return nil }
        if segments.count == 3 && (segments[1] != "accounts" || UUID(uuidString: segments[2]) == nil) { return nil }
        let query = components.queryItems ?? []
        for key in ["ledger", "book", "bookRevision", "currency", "account", "month"] { if query.filter({ $0.name == key }).count > 1 { return nil } }
        let field: (String) -> String? = { key in query.first { $0.name == key }?.value }
        let book = field("book") ?? "own"
        guard book == "own" || UUID(uuidString: book) != nil else { return nil }
        let ledger = field("ledger") ?? (book == "own" ? "personal" : "family")
        guard ["personal", "family"].contains(ledger), ledger == "family" || book == "own" else { return nil }
        let currency = field("currency") ?? "CNY"
        guard NativeFinanceContract.currencies.contains(currency), let revision = Int(field("bookRevision") ?? "0"), revision >= 0, revision <= 9_007_199_254_740_991 else { return nil }
        self.ledger = ledger; self.book = book; self.revision = revision; self.currency = currency
        let account = segments.count == 3 ? segments[2] : field("account")
        if let account, UUID(uuidString: account) == nil { return nil }
        if let month = field("month"), month.range(of: "^[0-9]{4}-(0[1-9]|1[0-2])$", options: .regularExpression) == nil { return nil }
        self.month = field("month")
        self.destination = account.map { "account:" + $0 } ?? (segments.count == 2 ? segments[1] : nil)
    }
}

private struct NativeFinanceStatus: View {
    @ObservedObject var context: NativeFinanceContext
    var scopeOverride: String? = nil
    @State private var recovery = false
    var body: some View {
        Text(scopeOverride ?? context.scopeSummary).font(.caption.weight(.medium)).foregroundStyle(NativePalette.muted)
        if context.busy { ProgressView("正在保存…") }
        if let error = context.error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
        if context.storageUnavailable { Button("解锁后重试") { context.retryPendingStorage() } }
        if let notice = context.notice { Text(notice).font(.caption).foregroundStyle(NativePalette.muted) }
        if let pending = context.pending { pendingCard(pending) }
    }
    private func pendingCard(_ pending: NativeFinancePending) -> some View {
        Section("保存结果待确认") {
            Text(pending.title).font(.headline)
            ForEach(Array(pending.summaryLines.enumerated()), id: \.offset) { _, line in Text(line).font(.callout) }
            Text(pending.createdAt.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(NativePalette.muted)
            if pending.operationID != nil { Button("继续确认原保存") { Task { await context.retryPending() } }.disabled(context.busy) }
            Button("查看最新结果") { recovery = true }.disabled(context.busy)
        }.listRowBackground(NativePalette.surface).sheet(isPresented: $recovery) { NavigationStack { NativeFinancePendingRecovery(context: context, pending: pending) } }
    }
}

private struct NativeFinancePendingRecovery: View {
    @ObservedObject var context: NativeFinanceContext
    let pending: NativeFinancePending
    @Environment(\.dismiss) private var dismiss
    @State private var result: NativeJSON = .null
    @State private var state: NativeFinanceReadState = .loading
    @State private var finish = false
    private var currency: String { pending.currency ?? pending.requestBody["currency"].stringValue ?? "CNY" }
    var body: some View {
        List {
            Section("原保存内容") {
                Text(pending.title).font(.headline)
                ForEach(Array(pending.summaryLines.enumerated()), id: \.offset) { _, line in Text(line) }
            }.listRowBackground(NativePalette.surface)
            NativeFinanceReadFeedback(state: state) { Task { await load() } }
            if state == .ready { currentResult }
            Section {
                if pending.operationID != nil { Button("继续确认原保存") { Task { await context.retryPending(); if context.pending == nil { dismiss() } } }.disabled(context.busy) }
                DisclosureGroup("已自行核对") {
                    Text("结束核对不会撤销已保存的记录").font(.caption).foregroundStyle(NativePalette.muted)
                    Button("结束此项待确认") { finish = true }.disabled(context.busy || state != .ready)
                }
            }.listRowBackground(NativePalette.surface)
        }
        .nativeGeometricPage().navigationTitle("核对保存结果")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        .task { await load() }
        .confirmationDialog("已核对原保存结果？", isPresented: $finish, titleVisibility: .visible) {
            Button("已核对，结束待确认") { context.reconcilePending(); dismiss() }
        }
    }
    @ViewBuilder private var currentResult: some View {
        if result["account"]["id"].stringValue != nil {
            Section("最新账户记录") {
                Text(result["account"]["name"].stringValue ?? "账户")
                LabeledContent("当前余额", value: NativeFinanceContract.money(result["account"]["balanceMinor"], currency: currency))
                LabeledContent("余额日期", value: result["account"]["asOfDate"].stringValue ?? "")
                DisclosureGroup("账户资料") {
                    LabeledContent("名称", value: result["account"]["name"].stringValue ?? "")
                    LabeledContent("类型", value: NativeFinanceContract.typeName(result["account"]["type"].stringValue ?? ""))
                    LabeledContent("备注", value: result["account"]["note"].stringValue ?? "")
                    LabeledContent("状态", value: result["account"]["archived"].boolValue == true ? "已归档" : "未归档")
                }
            }.listRowBackground(NativePalette.surface)
        } else if result["goal"]["id"].stringValue != nil {
            Section("最新目标") { Text(result["goal"]["name"].stringValue ?? "目标"); LabeledContent("目标金额", value: NativeFinanceContract.money(result["goal"]["targetMinor"], currency: currency)) }.listRowBackground(NativePalette.surface)
        } else if result["month"].stringValue != nil {
            Section("最新月结") { Text(result["month"].stringValue ?? ""); LabeledContent("版本", value: String(result["close"]["latestVersion"].intValue ?? 0)) }.listRowBackground(NativePalette.surface)
        } else if result["revision"].intValue != nil {
            Section("最新应急储备") { LabeledContent("每月开支", value: result["settings"]["monthlyExpenseAmount"].stringValue ?? "尚未设置"); LabeledContent("目标月数", value: String(result["settings"]["targetMonths"].intValue ?? 0)) }.listRowBackground(NativePalette.surface)
        } else {
            Section("最新家庭协作") {
                ForEach(result["members"].arrayValue, id: \.financeID) { member in LabeledContent(member["email"].stringValue ?? "成员", value: member["status"].stringValue ?? "") }
                ForEach(result["books"].arrayValue, id: \.financeID) { book in Text(book["name"].stringValue ?? "家庭账本") }
            }.listRowBackground(NativePalette.surface)
        }
    }
    private func load() async {
        guard let path = pending.recoveryPath else { state = .failed("请返回对应记录核对"); return }
        state = .loading
        do {
            result = try await context.api.json(path: path, token: context.token); try Task.checkCancellation()
            let account: Bool = result["account"]["id"].stringValue != nil
            let goal: Bool = result["goal"]["id"].stringValue != nil
            let report: Bool = result["month"].stringValue != nil
            let settings: Bool = result["revision"].intValue != nil
            let members: Bool = result.objectValue["members"] != nil || result.objectValue["books"] != nil
            guard account || goal || report || settings || members else { throw NativeAPIError.invalidResponse }
            state = .ready
        }
        catch is CancellationError {} catch { result = .null; state = .failed(error.localizedDescription) }
    }
}

private struct NativeFinanceMetric: View {
    let title: String; let value: String; var detail: String? = nil
    var prominent = false
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title).font(.subheadline).foregroundStyle(NativePalette.muted)
            Text(value).font(prominent ? .largeTitle.weight(.semibold) : .title2.weight(.semibold))
                .monospacedDigit().foregroundStyle(NativePalette.ink)
            if let detail { Text(detail).font(.caption).foregroundStyle(NativePalette.muted) }
        }.padding(.vertical, 5)
    }
}

private struct NativeFinanceDashboard: View {
    @ObservedObject var context: NativeFinanceContext
    @State private var response: NativeJSON = .null
    @State private var state: NativeFinanceReadState = .loading
    @State private var archived = false
    @State private var addAccount = false
    @State private var switchBook = false
    @State private var exportDocument: NativeFinanceDocument?
    @State private var exporting = false
    private var accounts: [NativeJSON] { response["accounts"].arrayValue.filter { $0["currency"].stringValue == context.currency } }
    private var readID: String { context.scopeID + String(archived) + String(context.change) }
    var body: some View {
        dashboard
            .refreshable { await load() }
            .task(id: readID) { await load() }
            .sheet(isPresented: $switchBook) { NavigationStack { NativeFinanceBooksView(context: context) } }
            .sheet(isPresented: $addAccount, onDismiss: { Task { await load() } }) { NavigationStack { NativeFinanceAccountForm(context: context, account: nil) } }
            .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: "jiashu-finance-" + context.ledger) { result in if case .failure(let error) = result { context.fail(error) } }
    }
    private var dashboard: some View {
        List {
            NativeFinanceStatus(context: context)
            Section {
                Button { switchBook = true } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "books.vertical").font(.title3).foregroundStyle(NativePalette.accent)
                            .frame(width: 40, height: 40).background(NativePalette.soft, in: RoundedRectangle(cornerRadius: 14))
                        Text(context.scopeLabel).font(.headline).foregroundStyle(NativePalette.ink)
                        Spacer(); Text("切换").font(.caption).foregroundStyle(NativePalette.accent)
                    }.padding(.vertical, 4)
                }
                Picker("币种", selection: $context.currency) { ForEach(NativeFinanceContract.currencies, id: \.self) { Text($0).tag($0) } }
            }.listRowBackground(NativePalette.surface)
            if context.blocked { Text("请重新选择账本").foregroundStyle(NativePalette.muted) }
            else {
                NativeFinanceReadFeedback(state: state) { Task { await load() } }
                if state == .ready { loadedContent }
            }
        }
    }
    @ViewBuilder private var loadedContent: some View {
        if accounts.isEmpty {
            Section {
                ContentUnavailableView("暂无" + context.currency + "账户", systemImage: "building.columns", description: Text("先添加账户和当前余额"))
                Button("添加账户", systemImage: "plus") { addAccount = true }.disabled(!context.canWrite)
                Toggle("显示归档账户", isOn: $archived)
                if !response["accounts"].arrayValue.isEmpty { Text("可切换币种查看其他账户").font(.caption).foregroundStyle(NativePalette.muted) }
            }.listRowBackground(NativePalette.surface)
        } else {
            summarySection
            Section {
                NavigationLink { NativeFinanceBalanceCheck(context: context) } label: {
                    Label("核对本月余额", systemImage: "checklist")
                }
            }.listRowBackground(NativePalette.surface)
            accountsSection
        }
            Section("规划与复盘") {
                NavigationLink { NativeFinanceGoals(context: context) } label: { Label("资金目标", systemImage: "flag") }
                NavigationLink { NativeFinanceRunway(context: context) } label: { Label("应急储备", systemImage: "umbrella") }
                NavigationLink { NativeFinanceReview(context: context) } label: { Label("月度回顾与月结", systemImage: "calendar") }
                if context.ledger == "family" { NavigationLink("协作动态") { NativeFinanceActivity(context: context) } }
            }.listRowBackground(NativePalette.surface)
        if context.role == "owner" {
            Section { DisclosureGroup("数据管理") { Button("导出账本", systemImage: "square.and.arrow.up") { Task { await export() } } } }.listRowBackground(NativePalette.surface)
        }
    }
    private var summarySection: some View {
        let summary: NativeJSON = response["summary"]["byCurrency"][context.currency]
        return Section("当前资产负债") {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top, spacing: 12) {
                    NativeFinanceMetric(title: "净资产", value: NativeFinanceContract.money(summary["netMinor"], currency: context.currency), prominent: true)
                    Spacer(minLength: 0)
                    Image(systemName: "chart.bar.xaxis").font(.title2).foregroundStyle(NativePalette.accent)
                        .frame(width: 44, height: 44).background(NativePalette.surface.opacity(0.7), in: Circle())
                        .accessibilityHidden(true)
                }
                VStack(spacing: 12) {
                    LabeledContent("资产", value: NativeFinanceContract.money(summary["assetsMinor"], currency: context.currency))
                    LabeledContent("负债", value: NativeFinanceContract.money(summary["liabilitiesMinor"], currency: context.currency))
                }.font(.subheadline).monospacedDigit().foregroundStyle(NativePalette.ink)
            }
            .padding(22).nativeGeometricCard(fill: NativePalette.soft)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
            .listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
    }
    private var accountsSection: some View {
        Section("账户") {
            ForEach(accounts, id: \.financeID) { account in accountRow(account) }
            Button("新增账户", systemImage: "plus") { addAccount = true }.disabled(!context.canWrite)
            Toggle("显示归档账户", isOn: $archived)
        }.listRowBackground(NativePalette.surface)
    }
    private func accountRow(_ account: NativeJSON) -> some View {
        let name: String = account["name"].stringValue ?? "账户"
        let balance: String = NativeFinanceContract.money(account["balanceMinor"], currency: context.currency)
        let date: String = account["asOfDate"].stringValue ?? "未知日期"
        let classification: String = NativeFinanceContract.typeName(account["type"].stringValue ?? "")
        return NavigationLink { NativeFinanceAccountDetail(context: context, accountID: account.financeID) } label: {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "building.columns").font(.headline).foregroundStyle(NativePalette.accent)
                    .frame(width: 40, height: 40).background(NativePalette.soft, in: RoundedRectangle(cornerRadius: 13))
                VStack(alignment: .leading, spacing: 7) {
                    HStack { Text(name).font(.subheadline.weight(.medium)); if account["archived"].boolValue == true { Text("已归档").font(.caption).foregroundStyle(NativePalette.muted) } }
                    Text(balance).font(.title3.weight(.semibold)).monospacedDigit()
                    Text(classification + " · " + date).font(.caption).foregroundStyle(NativePalette.muted)
                }
            }.padding(.vertical, 8).foregroundStyle(NativePalette.ink)
        }
    }
    private func load() async {
        state = .loading; response = .null
        do {
            let data = try await context.read(context.path("finance", extra: archived ? ["includeArchived": "1"] : [:]))
            try Task.checkCancellation(); guard case .array = data["accounts"] else { throw NativeAPIError.invalidResponse }; response = data; state = .ready
        } catch is CancellationError {} catch {
            response = .null; state = .failed(error.localizedDescription); context.readFailed(error)
        }
    }
    private func export() async {
        do { let result = try await context.read(context.path("finance/export")); exportDocument = NativeFinanceDocument(data: try result.encodedData()); exporting = true } catch { context.fail(error) }
    }
}

private extension NativeJSON { var financeID: String { self["id"].stringValue ?? self["accountId"].stringValue ?? "" } }
private struct NativeFinanceDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

private struct NativeFinanceBooksView: View {
    @ObservedObject var context: NativeFinanceContext
    @Environment(\.dismiss) private var dismiss
    private var loaded: Bool { !context.bookLoading && context.bookError == nil }
    var body: some View {
        List {
            NativeFinanceStatus(context: context)
            if context.bookLoading { ProgressView("正在读取账本…") }
            if let error = context.bookError { Text(error).foregroundStyle(NativePalette.muted); Button("重试") { Task { await context.loadBooks() } } }
            selectionSection
            Section { NavigationLink("管理家庭协作者") { NativeFinanceMembers(context: context) } }.listRowBackground(NativePalette.surface)
            if loaded { invitationSection }
        }
        .nativeGeometricPage().navigationTitle("切换账本")
        .task { await context.loadBooks() }
        .refreshable { await context.loadBooks() }
    }
    private var selectionSection: some View {
        Section("账本") {
            Button { context.select(ledger: "personal"); dismiss() } label: { Label("个人账本", systemImage: context.ledger == "personal" ? "checkmark.circle.fill" : "person") }
            if loaded { ForEach(context.books, id: \.financeID) { book in bookButton(book) } }
        }.listRowBackground(NativePalette.surface)
    }
    private func bookButton(_ book: NativeJSON) -> some View {
        let name: String = book["name"].stringValue ?? "家庭账本"
        let owner: String = book["ownerName"].stringValue ?? ""
        let role: String = NativeFinanceContract.roleName(book["role"].stringValue ?? "viewer")
        let selected: Bool = context.ledger == "family" && context.bookID == book.financeID
        return Button { context.select(ledger: "family", book: book); dismiss() } label: {
            VStack(alignment: .leading) { Label(name, systemImage: selected ? "checkmark.circle.fill" : "person.2"); Text(owner + " · " + role).font(.caption) }
        }
    }
    private var invitationSection: some View {
        Section("收到的邀请") {
            if context.invitations.isEmpty { Text("暂无邀请").foregroundStyle(NativePalette.muted) }
            ForEach(context.invitations, id: \.financeID) { invitation in NativeFinanceInvitationRow(context: context, invitation: invitation) }
        }.listRowBackground(NativePalette.surface)
    }
}

private struct NativeFinanceInvitationRow: View {
    @ObservedObject var context: NativeFinanceContext
    let invitation: NativeJSON
    @State private var action: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(invitation["bookName"].stringValue ?? "家庭账本").font(.headline)
            Text((invitation["ownerName"].stringValue ?? "") + "邀请你 · " + NativeFinanceContract.roleName(invitation["role"].stringValue ?? "editor"))
            Text("有效至 " + (invitation["expiresAt"].stringValue ?? "未知")).font(.caption).foregroundStyle(NativePalette.muted)
            HStack { Button("接受") { action = "accept" }; Button("婉拒", role: .destructive) { action = "decline" } }.disabled(context.busy || context.pending != nil)
        }.confirmationDialog(action == "accept" ? "加入此家庭账本？" : "婉拒此邀请？", isPresented: Binding(get: { action != nil }, set: { if !$0 { action = nil } }), titleVisibility: .visible) {
            Button("确认") { let chosen = action ?? "decline"; action = nil; Task { await respond(chosen) } }
        }
    }
    private func respond(_ action: String) async {
        guard let revision = invitation["revision"].intValue else { return }
        do { _ = try await context.write(title: action == "accept" ? "接受邀请" : "婉拒邀请", path: "finance/books/invitations/" + invitation.financeID + "/respond", method: "POST", body: .object(["action": .string(action), "expectedRevision": .number(Double(revision))]), idempotent: true); await context.loadBooks() } catch { context.fail(error) }
    }
}

private struct NativeFinanceAccountForm: View {
    @ObservedObject var context: NativeFinanceContext
    let initial: NativeJSON?
    @Environment(\.dismiss) private var dismiss
    @State private var account: NativeJSON?
    @State private var name = ""
    @State private var type = "bank"
    @State private var currency = "CNY"
    @State private var amount = ""
    @State private var date = NativeFinanceContract.today()
    @State private var note = ""
    @State private var liquidity = "liquid"
    @State private var usable = "100"
    @State private var latest: NativeJSON?
    @State private var adopt = false
    @State private var initialized = false
    private var draftScope: String { context.draftScope("account:" + (initial?.financeID ?? "new")) }
    private var draftValues: NativeJSON { .object(["name": .string(name), "type": .string(type), "currency": .string(currency), "amount": .string(amount), "date": .string(date), "note": .string(note), "liquidity": .string(liquidity), "usable": .string(usable)]) }
    private var changed: Bool {
        guard let initial else { return !name.isEmpty || !amount.isEmpty || !note.isEmpty }
        if name != initial["name"].stringValue { return true }
        if type != initial["type"].stringValue { return true }
        if note != initial["note"].stringValue { return true }
        if liquidity != initial["liquidityKind"].stringValue { return true }
        let ratio: Int? = try? NativeFinanceContract.basisPoints(usable)
        return ratio != initial["usableBps"].intValue
    }
    init(context: NativeFinanceContext, account: NativeJSON?) { self.context = context; self.initial = account }
    private var fieldsDisabled: Bool { context.pending != nil || context.busy }
    private var formTitle: String { initial == nil ? "新增账户" : "编辑账户" }
    private var saveTitle: String { initial == nil ? "创建账户" : "保存账户资料" }
    private var draftBasis: NativeJSON { account ?? .null }
    private var confirmationSummary: String {
        let classification: String = NativeFinanceContract.typeName(type)
        return [name, classification, currency].joined(separator: " · ")
    }
    private var latestSummary: String {
        let latestName: String = latest?["name"].stringValue ?? ""
        let latestType: String = latest?["type"].stringValue ?? ""
        let latestNote: String = latest?["note"].stringValue ?? ""
        let classification: String = NativeFinanceContract.typeName(latestType)
        return latestName + " · " + classification + "\n备注：" + latestNote + "\n采用版本后可重新保存；填写不会自动覆盖。"
    }
    var body: some View {
        monitoredForm
            .alert("核对最新账户", isPresented: $adopt) {
                Button("保留我的填写，采用此版本") { account = latest }
                Button("继续查看", role: .cancel) {}
            } message: { Text(latestSummary) }
    }
    private var monitoredForm: some View {
        accountForm
            .nativeGeometricPage().navigationTitle(formTitle)
            .modifier(NativeFinancePrivacy(context: context))
            .onChange(of: context.change) { _, _ in confirmedCreation() }
            .toolbar { ToolbarItem(placement: .cancellationAction) { closeButton } }
            .modifier(NativeFinanceKeyboardDone())
            .interactiveDismissDisabled(changed || fieldsDisabled)
            .task { initializeFields() }
            .onChange(of: liquidity) { _, value in
                if ["unreviewed", "illiquid"].contains(value) { usable = "0" }
            }
            .onChange(of: type) { _, value in updateTypeDefaults(value) }
    }
    private var closeButton: some View {
        NativeFinanceCloseButton(context: context, scope: draftScope, values: draftValues, basis: draftBasis, changed: changed) { dismiss() }
    }
    private var accountForm: some View {
        Form {
            NativeFinanceStatus(context: context)
            draftRecovery
            accountFields
            modeFields
            Section { Button(saveTitle) { Task { await save() } }.disabled(!context.canWrite) }.listRowBackground(NativePalette.surface)
        }
    }
    private var draftRecovery: some View {
        NativeFinanceDraftRecovery(context: context, scope: draftScope, values: draftValues, basis: draftBasis, ready: initialized, restore: restoreFields)
    }
    private var accountFields: some View {
        Section("账户资料") {
            TextField("账户名称", text: $name)
            Picker("账户类型", selection: $type) {
                ForEach(NativeFinanceContract.accountTypes, id: \.0) { option in Text(option.1).tag(option.0) }
            }
            Picker("币种", selection: $currency) {
                ForEach(NativeFinanceContract.currencies, id: \.self) { code in Text(code).tag(code) }
            }.disabled(initial != nil)
            TextField("备注", text: $note, axis: .vertical)
        }.listRowBackground(NativePalette.surface).disabled(fieldsDisabled)
    }
    @ViewBuilder private var modeFields: some View {
        if initial == nil { initialBalanceFields }
        else {
            liquidityFields
            Button("读取最新账户并核对版本") { Task { await readLatest() } }.disabled(context.busy)
        }
    }
    private var initialBalanceFields: some View {
        Section("初始余额或欠款") {
            NativeFinanceAmountField(title: "余额或欠款", currency: currency, value: $amount)
            NativeFinanceDateField(title: "余额日期", value: $date)
        }.listRowBackground(NativePalette.surface).disabled(fieldsDisabled)
    }
    private var liquidityFields: some View {
        Section("应急资金可动用程度") {
            Picker("可动用程度", selection: $liquidity) {
                ForEach(NativeFinanceContract.liquidityKinds, id: \.0) { option in Text(option.1).tag(option.0) }
            }
            TextField("可动用比例 %", text: $usable).keyboardType(.decimalPad)
            Text("类型与归档调整从北京时间今天生效，保留此前月份分类。类型变化后请重新核对可动用程度。")
                .font(.caption).foregroundStyle(NativePalette.muted)
        }.listRowBackground(NativePalette.surface).disabled(fieldsDisabled)
    }
    private func restoreFields(_ values: NativeJSON) {
        name = values["name"].stringValue ?? name
        type = values["type"].stringValue ?? type
        currency = values["currency"].stringValue ?? currency
        amount = values["amount"].stringValue ?? amount
        date = values["date"].stringValue ?? date
        note = values["note"].stringValue ?? note
        liquidity = values["liquidity"].stringValue ?? liquidity
        usable = values["usable"].stringValue ?? usable
    }
    private func initializeFields() {
        guard !initialized else { return }
        initialized = true; account = initial
        currency = initial?["currency"].stringValue ?? context.currency
        name = initial?["name"].stringValue ?? ""
        type = initial?["type"].stringValue ?? "bank"
        note = initial?["note"].stringValue ?? ""
        liquidity = initial?["liquidityKind"].stringValue ?? "liquid"
        let bps: Int = initial?["usableBps"].intValue ?? 10000
        usable = String(bps / 100) + "." + String(format: "%02d", bps % 100)
    }
    private func updateTypeDefaults(_ value: String) {
        guard initial != nil else { return }
        if ["cash", "bank"].contains(value) { liquidity = "liquid"; usable = "100" }
        else if ["property", "credit_card", "loan", "other_liability"].contains(value) { liquidity = "illiquid"; usable = "0" }
        else { liquidity = "unreviewed"; usable = "0" }
    }
    private func confirmedCreation() {
        guard initial == nil, context.notice == "创建账户已确认。" else { return }
        try? NativeWorkspacePersistence(userID: context.userID, scope: draftScope).clear()
        dismiss()
    }
    private func readLatest() async {
        guard let account else { return }
        do { latest = try await context.read(context.path("finance/accounts/" + account.financeID))["account"]; adopt = true } catch { context.fail(error) }
    }
    private func save() async {
        do {
            guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw NativeFinanceInputError("请输入账户名称。") }
            var fields: [String: NativeJSON] = ["name": .string(name), "type": .string(type), "note": .string(note)]
            let path: String; let method: String
            if let account {
                guard let version = account["metadataRevision"].intValue else { throw NativeFinanceInputError("请重新读取账户版本。") }
                let bps = try NativeFinanceContract.basisPoints(usable)
                if ["illiquid", "unreviewed"].contains(liquidity) && bps != 0 { throw NativeFinanceInputError("未核对或暂不可动用的比例应为0。") }
                fields["expectedRevision"] = .number(Double(version)); fields["liquidityKind"] = .string(liquidity); fields["usableBps"] = .number(Double(bps))
                path = context.path("finance/accounts/" + account.financeID); method = "PATCH"
            } else {
                let balance = try NativeFinanceContract.balanceBody(amount: amount, currency: currency, date: date, note: note)
                fields["ledger"] = .string(context.ledger); fields["currency"] = .string(currency)
                balance.objectValue.forEach { fields[$0.key] = $0.value }; path = context.path("finance/accounts"); method = "POST"
            }
            _ = try await context.write(title: account == nil ? "创建账户" : "更新账户资料", path: path, method: method, body: .object(fields), idempotent: account == nil); try NativeWorkspacePersistence(userID: context.userID, scope: draftScope).clear(); dismiss()
        } catch { context.fail(error) }
    }
}

private struct NativeFinanceAccountDetail: View {
    @ObservedObject var context: NativeFinanceContext
    let accountID: String
    @State private var response: NativeJSON = .null
    @State private var editing = false
    @State private var balance = false
    @State private var archive = false
    @State private var loading = false
    @State private var allBalances = false
    private var visibleBalances: [NativeJSON] { allBalances ? response["balances"].arrayValue : Array(response["balances"].arrayValue.prefix(10)) }
    private var account: NativeJSON { response["account"] }
    var body: some View {
        List {
            NativeFinanceStatus(context: context)
            if loading { ProgressView("读取账户与历史…") }
            if !context.blocked, account["id"].stringValue != nil {
                Section("当前账户") {
                    NativeFinanceMetric(title: account["name"].stringValue ?? "账户", value: NativeFinanceContract.money(account["balanceMinor"], currency: account["currency"].stringValue ?? context.currency), detail: account["asOfDate"].stringValue)
                    LabeledContent("账户类型", value: NativeFinanceContract.typeName(account["type"].stringValue ?? ""))
                    LabeledContent("应急资金", value: NativeFinanceContract.liquidityName(account["liquidityKind"].stringValue ?? ""))
                    LabeledContent("可动用比例", value: String(account["usableBps"].intValue.map { $0 / 100 } ?? 0) + "." + String(format: "%02d%%", (account["usableBps"].intValue ?? 0) % 100))
                    if let note = account["note"].stringValue, !note.isEmpty { Text(note) }
                    Button("编辑账户资料") { editing = true }.disabled(!context.canWrite)
                    Button("记录新余额") { balance = true }.disabled(!context.canWrite || account["archived"].boolValue == true)
                    Button(account["archived"].boolValue == true ? "恢复账户" : "归档账户", role: account["archived"].boolValue == true ? nil : .destructive) { archive = true }.disabled(!context.canWrite)
                }.listRowBackground(NativePalette.surface)
                Section("余额历史") {
                    Text("作废记录不参与统计；更正保留原始内容。最后一条有效余额请更正或归档账户。") .font(.caption).foregroundStyle(NativePalette.muted)
                    ForEach(visibleBalances, id: \.financeID) { entry in
                        NavigationLink { NativeFinanceBalanceForm(context: context, account: account, entry: entry) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(NativeFinanceContract.money(entry["amountMinor"], currency: account["currency"].stringValue ?? "CNY"))
                                Text((entry["asOfDate"].stringValue ?? "") + " · " + status(entry["status"].stringValue ?? "active")).font(.caption).foregroundStyle(NativePalette.muted)
                                if let note = entry["note"].stringValue, !note.isEmpty { Text(note).font(.caption) }
                            }
                        }
                    }
                }.listRowBackground(NativePalette.surface)
                if response["balances"].arrayValue.count > 10 { Button(allBalances ? "收起较早余额" : "查看全部余额记录") { allBalances.toggle() } }
                Section { DisclosureGroup("分类与归档历史") {
                    ForEach(Array(response["classifications"].arrayValue.enumerated()), id: \.offset) { _, row in
                        VStack(alignment: .leading) {
                            Text(NativeFinanceContract.typeName(row["type"].stringValue ?? "") + " · " + (row["archived"].intValue == 1 ? "归档" : "未归档"))
                            Text(row["origin"].stringValue == "baseline" ? "旧数据兼容基线；此前状态未知" : (row["effectiveFrom"].stringValue ?? "未知日期") + "起生效").font(.caption).foregroundStyle(NativePalette.muted)
                        }
                    }
                }
                }.listRowBackground(NativePalette.surface)
                Section { DisclosureGroup("修改历史") {
                    ForEach(response["changes"].arrayValue, id: \.financeID) { row in
                        VStack(alignment: .leading) {
                            Text(row["action"].stringValue == "void" ? "作废余额" : "更正余额")
                            Text(row["reason"].stringValue ?? "").font(.callout)
                            Text(row["createdAt"].stringValue ?? "").font(.caption).foregroundStyle(NativePalette.muted)
                        }
                    }
                }
                }.listRowBackground(NativePalette.surface)
            }
        }
        .nativeGeometricPage().navigationTitle(account["name"].stringValue ?? "账户详情")
        .task(id: String(context.change) + context.scopeID) { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $editing, onDismiss: { Task { await load() } }) { NavigationStack { NativeFinanceAccountForm(context: context, account: account) } }
        .sheet(isPresented: $balance, onDismiss: { Task { await load() } }) { NavigationStack { NativeFinanceBalanceForm(context: context, account: account, entry: nil) } }
        .confirmationDialog(account["archived"].boolValue == true ? "恢复此账户？" : "归档此账户？", isPresented: $archive, titleVisibility: .visible) {
            Button(account["archived"].boolValue == true ? "恢复账户" : "归档账户", role: account["archived"].boolValue == true ? nil : .destructive) { Task { await setArchive() } }
        } message: { Text(context.scopeSummary + "\n" + (account["name"].stringValue ?? "账户") + "\n余额历史保留") }
    }
    private func status(_ value: String) -> String { value == "void" ? "已作废" : value == "corrected" ? "已更正" : "原始记录" }
    private func load() async {
        loading = true; defer { loading = false }
        do { response = try await context.read(context.path("finance/accounts/" + accountID)) } catch { response = .null; context.fail(error) }
    }
    private func setArchive() async {
        guard let version = account["metadataRevision"].intValue else { return }
        do { _ = try await context.write(title: "账户归档状态", path: context.path("finance/accounts/" + accountID), method: "PATCH", body: .object(["archived": .bool(account["archived"].boolValue != true), "expectedRevision": .number(Double(version))]), targetName: account["name"].stringValue); await load() } catch { context.fail(error) }
    }
}

private struct NativeFinanceBalanceForm: View {
    @ObservedObject var context: NativeFinanceContext
    let account: NativeJSON
    let entry: NativeJSON?
    var onSaved: ((NativeJSON) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var action = "correct"
    @State private var amount = ""
    @State private var date = NativeFinanceContract.today()
    @State private var note = ""
    @State private var reason = ""
    @State private var preview: NativeJSON?
    @State private var frozen: NativeJSON?
    @State private var previewing = false
    @State private var initialized = false
    @State private var confirm = false
    @State private var completing = false
    private var currency: String { account["currency"].stringValue ?? "CNY" }
    private var draftScope: String { context.draftScope("balance:" + account.financeID + ":" + (entry?.financeID ?? "new")) }
    private var draftValues: NativeJSON { .object(["action": .string(action), "amount": .string(amount), "date": .string(date), "note": .string(note), "reason": .string(reason)]) }
    private var changed: Bool { !reason.isEmpty || !note.isEmpty || amount != (entry?["amount"].stringValue ?? account["amount"].stringValue ?? "") || date != (entry?["asOfDate"].stringValue ?? NativeFinanceContract.today()) }
    var body: some View {
        Form {
            NativeFinanceStatus(context: context)
            NativeFinanceDraftRecovery(context: context, scope: draftScope, values: draftValues, basis: account, ready: initialized) { values in
                action = values["action"].stringValue ?? action; amount = values["amount"].stringValue ?? amount; date = values["date"].stringValue ?? date
                note = values["note"].stringValue ?? note; reason = values["reason"].stringValue ?? reason; frozen = nil; preview = nil
            }
            Section("账户") { Text(account["name"].stringValue ?? ""); LabeledContent("当前余额", value: NativeFinanceContract.money(account["balanceMinor"], currency: currency)); Text(account["asOfDate"].stringValue ?? "").font(.caption) }.listRowBackground(NativePalette.surface)
            if let entry {
                Section("原始与有效记录") {
                    LabeledContent("记录金额", value: NativeFinanceContract.money(entry["amountMinor"], currency: currency))
                    LabeledContent("日期", value: entry["asOfDate"].stringValue ?? "")
                    if let original = entry["originalAmountMinor"].stringValue { LabeledContent("原始金额", value: NativeFinanceContract.money(original, currency: currency)) }
                    Text(entry["changeReason"].stringValue ?? "").font(.caption)
                }.listRowBackground(NativePalette.surface)
            }
            if entry != nil { Picker("操作", selection: $action) { Text(entry?["status"].stringValue == "void" ? "恢复并更正" : "更正").tag("correct"); if entry?["status"].stringValue != "void" { Text("作废").tag("void") } }.disabled(frozen != nil || context.pending != nil) }
            Section(entry == nil ? "新余额" : "修改内容") {
                if entry == nil || action == "correct" {
                    NativeFinanceAmountField(title: "余额", currency: currency, value: $amount)
                    NativeFinanceDateField(title: "余额日期", value: $date)
                    TextField("说明", text: $note, axis: .vertical)
                }
                if entry != nil { TextField("修改原因（必填）", text: $reason, axis: .vertical) }
            }.listRowBackground(NativePalette.surface).disabled(frozen != nil || context.pending != nil || context.busy)
            if let preview {
                Section("对当前余额的影响") {
                    LabeledContent("修改前", value: NativeFinanceContract.money(preview["currentBefore"]["amountMinor"], currency: currency))
                    LabeledContent("修改后", value: NativeFinanceContract.money(preview["currentAfter"]["amountMinor"], currency: currency))
                    LabeledContent("修改后日期", value: preview["currentAfter"]["asOfDate"].stringValue ?? "")
                    Text(preview["changesCurrentBalance"].boolValue == true ? "此操作将改变账户当前余额。" : "当前余额不变，历史记录将更新。")
                }.listRowBackground(NativePalette.surface)
            }
            Section {
                if entry != nil && frozen == nil { Button("预览影响") { Task { await makePreview() } }.disabled(!context.canWrite || previewing || account["archived"].boolValue == true) }
                else { Button(entry == nil ? (onSaved == nil ? "保存余额" : "保存并核对下一项") : "确认修改") { if entry == nil { Task { await save() } } else { confirm = true } }.disabled(!context.canWrite || completing) }
                if frozen != nil && context.pending == nil { Button("返回修改内容") { preview = nil; frozen = nil } }
                if previewing { ProgressView("核对服务器预览…") }
            }.listRowBackground(NativePalette.surface)
        }
        .nativeGeometricPage().navigationTitle(entry == nil ? "记录余额" : "更正与作废")
        .modifier(NativeFinancePrivacy(context: context))
        .navigationBarBackButtonHidden(changed)
        .onChange(of: context.change) { _, _ in confirmedSave() }
        .toolbar { ToolbarItem(placement: .cancellationAction) { NativeFinanceCloseButton(context: context, scope: draftScope, values: draftValues, basis: account, changed: changed) { dismiss() } } }
        .modifier(NativeFinanceKeyboardDone())
        .interactiveDismissDisabled(changed || context.busy || context.pending != nil)
        .task { if !initialized { initialized = true; amount = entry?["amount"].stringValue ?? account["amount"].stringValue ?? ""; date = entry?["asOfDate"].stringValue ?? NativeFinanceContract.today(); note = entry?["note"].stringValue ?? "" } }
        .confirmationDialog(entry == nil ? "保存这笔余额？" : "确认按预览修改历史？", isPresented: $confirm, titleVisibility: .visible) { Button("确认保存", role: action == "void" && entry != nil ? .destructive : nil) { Task { await save() } } } message: { Text(context.scopeSummary + "\n" + (account["name"].stringValue ?? "账户") + "\n" + (entry?["asOfDate"].stringValue ?? date) + "\n原始记录和修改原因保留") }
    }
    private func confirmedSave() {
        guard context.notice == "记录余额已确认。" || context.notice == "余额历史修改已确认。" else { return }
        try? NativeWorkspacePersistence(userID: context.userID, scope: draftScope).clear()
        if let onSaved {
            guard !completing else { return }; completing = true
            Task {
                do { let current = try await context.read(context.path("finance/accounts/" + account.financeID)); onSaved(current) }
                catch { context.fail(error) }
            }
        } else { dismiss() }
    }
    private func entryPath() -> String { "finance/accounts/" + account.financeID + "/balances/" + (entry?.financeID ?? "").addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)! }
    private func makePreview() async {
        guard let entry else { return }; previewing = true; defer { previewing = false }
        do {
            let body = try NativeFinanceContract.correctionBody(entry: entry, account: account, action: action, amount: amount, date: date, note: note, reason: reason)
            preview = try await context.api.json(path: context.path(entryPath() + "/preview"), method: "POST", token: context.token, body: body)
            try Task.checkCancellation(); frozen = body
        } catch { preview = nil; frozen = nil; context.fail(error) }
    }
    private func save() async {
        guard !completing else { return }
        do {
            let body: NativeJSON
            if entry != nil { guard let frozen else { throw NativeFinanceInputError("请先预览修改影响。") }; body = frozen }
            else { body = try NativeFinanceContract.balanceBody(amount: amount, currency: currency, date: date, note: note) }
            let path = entry == nil ? "finance/accounts/" + account.financeID + "/balances" : entryPath()
            let result = try await context.write(title: entry == nil ? "记录余额" : "余额历史修改", path: context.path(path), method: "POST", body: body, idempotent: true, targetName: account["name"].stringValue)
            try NativeWorkspacePersistence(userID: context.userID, scope: draftScope).clear()
            if let onSaved { completing = true; onSaved(result) } else { dismiss() }
        } catch { context.fail(error) }
    }
}

private struct NativeFinanceBalanceCheck: View {
    @ObservedObject var context: NativeFinanceContext
    @State private var accounts: [NativeJSON] = []
    @State private var state: NativeFinanceReadState = .loading
    @State private var active: NativeJSON?
    @State private var editing = false
    private var unchecked: [NativeJSON] { accounts.filter { !NativeFinanceContract.checkedThisMonth($0["asOfDate"].stringValue) } }
    private var checked: [NativeJSON] { accounts.filter { NativeFinanceContract.checkedThisMonth($0["asOfDate"].stringValue) } }
    var body: some View {
        checkList
            .nativeGeometricPage().navigationTitle("本月余额核对")
            .modifier(NativeFinancePrivacy(context: context))
            .task(id: context.scopeID) { await load() }
            .refreshable { await load() }
            .sheet(isPresented: $editing, onDismiss: { Task { await load() } }) { editor }
    }
    private var checkList: some View {
        List {
            NativeFinanceStatus(context: context)
            NativeFinanceReadFeedback(state: state) { Task { await load() } }
            if state == .ready {
                if accounts.isEmpty { ContentUnavailableView("暂无账户", systemImage: "checklist", description: Text("返回财务添加账户")) }
                else { checkContent }
            }
        }
    }
    @ViewBuilder private var checkContent: some View {
        Section {
            Text("已核对 \(checked.count) / \(accounts.count)").font(.headline)
            ProgressView(value: Double(checked.count), total: Double(accounts.count))
            if let next = unchecked.first {
                Button("核对下一项") { active = next; editing = true }.disabled(!context.canWrite)
            } else { Label("本月余额已记录", systemImage: "checkmark.circle").foregroundStyle(.green) }
            NavigationLink("查看本月回顾") { NativeFinanceReview(context: context, initialMonth: String(NativeFinanceContract.today().prefix(7))) }
        }.listRowBackground(NativePalette.surface)
        if !unchecked.isEmpty { Section("待核对") { ForEach(unchecked, id: \.financeID) { account in accountButton(account) } }.listRowBackground(NativePalette.surface) }
        if !checked.isEmpty { Section { DisclosureGroup("已核对 · \(checked.count)") { ForEach(checked, id: \.financeID) { account in accountButton(account) } } }.listRowBackground(NativePalette.surface) }
    }
    private var editor: some View {
        NavigationStack {
            if let active {
                NativeFinanceBalanceForm(context: context, account: active, entry: nil, onSaved: { result in Task { await advance(result) } })
                    .id(active.financeID)
            }
        }
    }
    private func accountButton(_ account: NativeJSON) -> some View {
        let name: String = account["name"].stringValue ?? "账户"
        let amount: String = NativeFinanceContract.money(account["balanceMinor"], currency: context.currency)
        let date: String = account["asOfDate"].stringValue ?? "未知日期"
        return Button { active = account; editing = true } label: {
            HStack { VStack(alignment: .leading) { Text(name).foregroundStyle(NativePalette.ink); Text(date).font(.caption).foregroundStyle(NativePalette.muted) }; Spacer(); Text(amount).monospacedDigit().foregroundStyle(NativePalette.ink) }
        }.disabled(context.role == "viewer" || context.pending != nil)
    }
    private func load() async {
        state = .loading
        do {
            let response = try await context.read(context.path("finance"))
            guard case .array = response["accounts"] else { throw NativeAPIError.invalidResponse }
            accounts = response["accounts"].arrayValue.filter { $0["currency"].stringValue == context.currency }; state = .ready
        } catch is CancellationError {} catch { accounts = []; state = .failed(error.localizedDescription); context.readFailed(error) }
    }
    private func advance(_ result: NativeJSON) async {
        let savedDate: String? = result["account"]["asOfDate"].stringValue
        await load()
        guard state == .ready else { editing = false; return }
        guard NativeFinanceContract.checkedThisMonth(savedDate) else { editing = false; context.notice = "历史余额已保存，本月仍待核对"; return }
        if let next = unchecked.first { active = next }
        else { editing = false; active = nil }
    }
}

private struct NativeFinanceGoals: View {
    @ObservedObject var context: NativeFinanceContext
    @State private var response: NativeJSON = .null
    @State private var archived = false
    @State private var add = false
    @State private var state: NativeFinanceReadState = .loading
    var body: some View {
        List {
            NativeFinanceStatus(context: context)
            NativeFinanceReadFeedback(state: state) { Task { await load() } }
            if state == .ready {
            Section { Toggle("包括归档目标", isOn: $archived); Text("目标余额是所选账户的视图，不代表资金已预留或转账。") .font(.caption).foregroundStyle(NativePalette.muted) }.listRowBackground(NativePalette.surface)
            if response["goals"].arrayValue.isEmpty { Text("暂无当前币种的资金目标。") .foregroundStyle(NativePalette.muted) }
            ForEach(response["goals"].arrayValue, id: \.financeID) { goal in
                NavigationLink { NativeFinanceGoalDetail(context: context, initial: goal, available: response["accounts"].arrayValue) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack { Text(goal["name"].stringValue ?? "资金目标").font(.headline); Spacer(); Text(goal["archived"].boolValue == true ? "已归档" : goalStatus(goal["status"].stringValue ?? "")) .font(.caption) }
                        Text("当前 " + NativeFinanceContract.money(goal["currentMinor"], currency: context.currency))
                        Text("目标 " + NativeFinanceContract.money(goal["targetMinor"], currency: context.currency)).font(.caption)
                        if let percent = goal["percent"].doubleValue { ProgressView(value: min(100, max(0, percent)), total: 100) }
                        Text("截至 " + (goal["deadline"].stringValue ?? "未知")).font(.caption).foregroundStyle(NativePalette.muted)
                    }
                }
            }
            Button("新增资金目标", systemImage: "plus") { add = true }.disabled(!context.canWrite)
            }
        }
        .nativeGeometricPage().navigationTitle("资金目标")
        .modifier(NativeFinancePrivacy(context: context))
        .task(id: context.scopeID + String(context.change) + String(archived)) { await load() }.refreshable { await load() }
        .sheet(isPresented: $add, onDismiss: { Task { await load() } }) { NavigationStack { NativeFinanceGoalForm(context: context, initial: nil, available: response["accounts"].arrayValue) } }
    }
    private func goalStatus(_ value: String) -> String { value == "achieved" ? "已达成" : value == "overdue" ? "期限已过" : "进行中" }
    private func load() async {
        state = .loading
        do { response = try await context.read(context.path("finance/goals", extra: ["currency": context.currency, "includeArchived": archived ? "1" : "0"])); guard case .array = response["goals"] else { throw NativeAPIError.invalidResponse }; state = .ready }
        catch is CancellationError {} catch { response = .null; state = .failed(error.localizedDescription); context.readFailed(error) }
    }
}

private struct NativeFinanceGoalDetail: View {
    @ObservedObject var context: NativeFinanceContext
    let initial: NativeJSON; let available: [NativeJSON]
    @State private var goal: NativeJSON = .null
    @State private var editing = false
    @State private var archive = false
    @State private var state: NativeFinanceReadState = .loading
    private var title: String { goal["name"].stringValue ?? "资金目标" }
    private var archived: Bool { goal["archived"].boolValue == true }
    private var archiveTitle: String { archived ? "恢复目标" : "归档目标" }
    private var archiveRole: ButtonRole? { archived ? nil : .destructive }
    private var dateRange: String {
        let oldest: String = goal["oldestBalanceDate"].stringValue ?? "未知"
        let latest: String = goal["latestBalanceDate"].stringValue ?? "未知"
        return "余额日期：\(oldest) 至 \(latest)"
    }
    private func money(_ key: String) -> String {
        NativeFinanceContract.money(goal[key], currency: context.currency)
    }
    private func count(_ key: String) -> String { String(goal[key].intValue ?? 0) }
    var body: some View {
        goalList
            .nativeGeometricPage().navigationTitle(title)
            .modifier(NativeFinancePrivacy(context: context))
            .task(id: String(context.change)) { await load() }
            .refreshable { await load() }
            .sheet(isPresented: $editing, onDismiss: { Task { await load() } }) { editor }
            .confirmationDialog("确认调整目标归档状态？", isPresented: $archive, titleVisibility: .visible) {
                Button(archiveTitle, role: archiveRole) { Task { await setArchive() } }
            } message: { Text(context.scopeSummary + "\n" + title + "\n目标记录保留") }
    }
    private var goalList: some View {
        List {
            NativeFinanceStatus(context: context)
            NativeFinanceReadFeedback(state: state) { Task { await load() } }
            if state == .ready {
            progressSection
            basisSection
            NativeFinanceSharing(sharing: goal["sharing"], currency: context.currency)
            actionSection
            }
        }
    }
    private var progressSection: some View {
        Section("目标进度") {
            NativeFinanceMetric(title: "目前余额", value: money("currentMinor"))
            LabeledContent("目标", value: money("targetMinor"))
            LabeledContent("缺口", value: money("gapMinor"))
            LabeledContent("每月参考", value: money("monthlyMinor"))
            LabeledContent("截止日", value: goal["deadline"].stringValue ?? "")
            LabeledContent("剩余天数", value: count("daysRemaining"))
        }.listRowBackground(NativePalette.surface)
    }
    private var basisSection: some View {
        Section("计算依据") {
            LabeledContent("有效关联账户", value: count("matchedAccountCount"))
            LabeledContent("余额超过30天", value: count("staleAccountCount"))
            LabeledContent("缺失或归档", value: count("missingCount"))
            Text(dateRange).font(.caption)
            Text("达成状态依赖当前余额；陈旧、缺失或归档的依据需重新核对。")
                .font(.caption).foregroundStyle(NativePalette.muted)
        }.listRowBackground(NativePalette.surface)
    }
    private var actionSection: some View {
        Section {
            Button("编辑目标") { editing = true }.disabled(!context.canWrite)
            Button(archiveTitle, role: archiveRole) { archive = true }.disabled(!context.canWrite)
        }.listRowBackground(NativePalette.surface)
    }
    private var editor: some View {
        NavigationStack { NativeFinanceGoalForm(context: context, initial: goal, available: available) }
    }
    private func load() async {
        state = .loading
        do { let data = try await context.read(context.path("finance/goals", extra: ["currency": context.currency, "includeArchived": "1"])); guard let found = data["goals"].arrayValue.first(where: { $0.financeID == initial.financeID }) else { throw NativeFinanceInputError("未找到此目标") }; goal = found; state = .ready }
        catch is CancellationError {} catch { goal = .null; state = .failed(error.localizedDescription); context.readFailed(error) }
    }
    private func setArchive() async {
        guard let revision = goal["revision"].intValue else { return }
        do { _ = try await context.write(title: "目标归档状态", path: context.path("finance/goals/" + goal.financeID), method: "PATCH", body: .object(["archived": .bool(goal["archived"].boolValue != true), "expectedRevision": .number(Double(revision))]), targetName: goal["name"].stringValue); await load() } catch { context.fail(error) }
    }
}

private struct NativeFinanceSharing: View {
    let sharing: NativeJSON; let currency: String
    var body: some View {
        if !sharing["accounts"].arrayValue.isEmpty {
            Section("这些资金也用于其他目标") {
                ForEach(Array(sharing["accounts"].arrayValue.enumerated()), id: \.offset) { _, account in
                    VStack(alignment: .leading) {
                        Text(account["name"].stringValue ?? "关联账户")
                        Text(NativeFinanceContract.money(account["balanceMinor"], currency: currency)).font(.callout)
                        Text(account["goals"].arrayValue.compactMap { $0["name"].stringValue }.joined(separator: "、")).font(.caption)
                        if account["includesRunway"].boolValue == true { Text("也用于应急储备").font(.caption) }
                    }
                }
                Text("同一余额可被多个目标引用，不能将目标进度相加。资金尚未分配或转账。") .font(.caption).foregroundStyle(NativePalette.muted)
            }.listRowBackground(NativePalette.surface)
        }
    }
}

private struct NativeFinanceGoalForm: View {
    @ObservedObject var context: NativeFinanceContext
    let initial: NativeJSON?; let available: [NativeJSON]
    @Environment(\.dismiss) private var dismiss
    @State private var current: NativeJSON?
    @State private var name = ""
    @State private var target = ""
    @State private var deadline = NativeFinanceContract.today()
    @State private var ids: Set<String> = []
    @State private var originalIDs: Set<String> = []
    @State private var initialized = false
    @State private var latest: NativeJSON?
    @State private var adopt = false
    private var accounts: [NativeJSON] { available.filter { $0["currency"].stringValue == context.currency } }
    private var draftScope: String { context.draftScope("goal:" + (initial?.financeID ?? "new")) }
    private var draftValues: NativeJSON { .object(["name": .string(name), "target": .string(target), "deadline": .string(deadline), "ids": .array(ids.sorted().map { .string($0) })]) }
    private var changed: Bool {
        let initialName: String = initial?["name"].stringValue ?? ""
        let initialTarget: String = initial?["targetAmount"].stringValue ?? ""
        let initialDeadline: String = initial?["deadline"].stringValue ?? NativeFinanceContract.today()
        if name != initialName { return true }
        if target != initialTarget { return true }
        if deadline != initialDeadline { return true }
        return ids != originalIDs
    }
    private var formTitle: String { initial == nil ? "新增资金目标" : "编辑资金目标" }
    private var saveTitle: String { initial == nil ? "创建目标" : "保存目标" }
    private var fieldsDisabled: Bool { context.busy || context.pending != nil }
    private var draftBasis: NativeJSON { current ?? .null }
    private var missingIDs: [String] {
        let known: Set<String> = Set(accounts.map { $0.financeID })
        return ids.subtracting(known).sorted()
    }
    private var latestSummary: String {
        let latestName: String = latest?["name"].stringValue ?? ""
        let latestAmount: String = latest?["targetAmount"].stringValue ?? ""
        let latestDeadline: String = latest?["deadline"].stringValue ?? ""
        return [latestName, latestAmount, latestDeadline].joined(separator: " · ")
    }
    private var confirmationSummary: String { "\(name) · \(context.currency) \(target) · \(deadline)" }
    var body: some View {
        monitoredForm
            .alert("核对最新目标", isPresented: $adopt) {
                Button("保留填写，采用此版本") { adoptLatestVersion() }
                Button("取消", role: .cancel) {}
            } message: { Text(latestSummary) }
    }
    private var monitoredForm: some View {
        goalForm
            .nativeGeometricPage().navigationTitle(formTitle)
            .modifier(NativeFinancePrivacy(context: context))
            .onChange(of: context.change) { _, _ in confirmedCreation() }
            .toolbar { ToolbarItem(placement: .cancellationAction) { closeButton } }
            .modifier(NativeFinanceKeyboardDone())
            .interactiveDismissDisabled(changed || fieldsDisabled)
            .task { initializeFields() }
    }
    private var closeButton: some View {
        NativeFinanceCloseButton(context: context, scope: draftScope, values: draftValues, basis: draftBasis, changed: changed) { dismiss() }
    }
    private var goalForm: some View {
        Form {
            NativeFinanceStatus(context: context)
            draftRecovery
            goalFields
            accountFields
            if initial != nil { Button("读取最新目标并核对版本") { Task { await readLatest() } }.disabled(context.busy) }
            Button(saveTitle) { Task { await save() } }.disabled(!context.canWrite)
        }
    }
    private var draftRecovery: some View {
        NativeFinanceDraftRecovery(context: context, scope: draftScope, values: draftValues, basis: draftBasis, ready: initialized, restore: restoreFields)
    }
    private var goalFields: some View {
        Section("目标") {
            TextField("目标名称", text: $name)
            NativeFinanceAmountField(title: "目标金额", currency: context.currency, value: $target, positive: true)
            NativeFinanceDateField(title: "截止日", value: $deadline, allowsFuture: true)
        }.listRowBackground(NativePalette.surface).disabled(fieldsDisabled)
    }
    private var accountFields: some View {
        Section("关联资产账户") {
            ForEach(accounts, id: \.financeID) { account in accountToggle(account) }
            ForEach(missingIDs, id: \.self) { id in missingAccountToggle(id) }
            Text("仅选择同一账本、同币种的资产账户。关联不会预留资金。")
                .font(.caption).foregroundStyle(NativePalette.muted)
        }.listRowBackground(NativePalette.surface).disabled(fieldsDisabled)
    }
    private func accountToggle(_ account: NativeJSON) -> some View {
        let id: String = account.financeID
        let selection = Binding<Bool>(get: { ids.contains(id) }, set: { selected in
            if selected { ids.insert(id) } else { ids.remove(id) }
        })
        let accountName: String = account["name"].stringValue ?? "账户"
        let balance: String = NativeFinanceContract.money(account["balanceMinor"], currency: context.currency)
        return Toggle(isOn: selection) {
            VStack(alignment: .leading) { Text(accountName); Text(balance).font(.caption) }
        }
    }
    private func missingAccountToggle(_ id: String) -> some View {
        let selection = Binding<Bool>(get: { ids.contains(id) }, set: { selected in
            if !selected { ids.remove(id) }
        })
        return Toggle("当前不可用的关联账户", isOn: selection)
    }
    private func restoreFields(_ values: NativeJSON) {
        name = values["name"].stringValue ?? name
        target = values["target"].stringValue ?? target
        deadline = values["deadline"].stringValue ?? deadline
        ids = Set(values["ids"].arrayValue.compactMap(\.stringValue))
    }
    private func initializeFields() {
        guard !initialized else { return }
        initialized = true; current = initial
        name = initial?["name"].stringValue ?? ""
        target = initial?["targetAmount"].stringValue ?? ""
        deadline = initial?["deadline"].stringValue ?? NativeFinanceContract.today()
        let accountIDs: [String] = initial?["accountIds"].arrayValue.compactMap(\.stringValue) ?? []
        ids = Set(accountIDs); originalIDs = ids
    }
    private func adoptLatestVersion() {
        current = latest
        let accountIDs: [String] = latest?["accountIds"].arrayValue.compactMap(\.stringValue) ?? []
        originalIDs = Set(accountIDs)
    }
    private func confirmedCreation() {
        guard initial == nil, context.notice == "创建资金目标已确认。" else { return }
        try? NativeWorkspacePersistence(userID: context.userID, scope: draftScope).clear()
        dismiss()
    }
    private func readLatest() async { guard let current else { return }; do { latest = try await context.read(context.path("finance/goals/" + current.financeID))["goal"]; adopt = true } catch { context.fail(error) } }
    private func save() async {
        do {
            let amount = try NativeFinanceContract.inputAmount(target, currency: context.currency)
            guard amount.contains(where: { $0 >= "1" && $0 <= "9" }), !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !ids.isEmpty else { throw NativeFinanceInputError("请填写名称、正数目标金额，并关联至少一个资产账户。") }
            var body: [String: NativeJSON] = ["name": .string(name), "targetAmount": .string(amount), "deadline": .string(try NativeFinanceContract.day(deadline))]
            let path: String; let method: String
            if let current {
                guard let revision = current["revision"].intValue else { throw NativeFinanceInputError("请读取最新目标版本。") }
                body["expectedRevision"] = .number(Double(revision)); if ids != originalIDs { body["accountIds"] = .array(ids.sorted().map { .string($0) }) }
                path = "finance/goals/" + current.financeID; method = "PATCH"
            } else {
                body["ledger"] = .string(context.ledger); body["currency"] = .string(context.currency); body["accountIds"] = .array(ids.sorted().map { .string($0) })
                path = "finance/goals"; method = "POST"
            }
            _ = try await context.write(title: current == nil ? "创建资金目标" : "更新资金目标", path: context.path(path), method: method, body: .object(body), idempotent: current == nil); try NativeWorkspacePersistence(userID: context.userID, scope: draftScope).clear(); dismiss()
        } catch { context.fail(error) }
    }
}

private struct NativeFinanceRunway: View {
    @ObservedObject var context: NativeFinanceContext
    @Environment(\.dismiss) private var dismiss
    @State private var response: NativeJSON = .null
    @State private var expense = ""
    @State private var months = ""
    @State private var ids: Set<String> = []
    @State private var revision: Int?
    @State private var dirty = false
    @State private var confirm = false
    @State private var latest: NativeJSON?
    @State private var adopt = false
    private var draftScope: String { context.draftScope("runway") }
    private var draftValues: NativeJSON { .object(["expense": .string(expense), "months": .string(months), "ids": .array(ids.sorted().map { .string($0) })]) }
    @State private var state: NativeFinanceReadState = .loading
    @State private var editingSettings = false
    private var accounts: [NativeJSON] { response["accounts"].arrayValue }
    private var missingIDs: [String] { ids.subtracting(Set(accounts.map(\.financeID))).sorted() }
    private var latestSummary: String {
        let amount: String = latest?["settings"]["monthlyExpenseAmount"].stringValue ?? "尚未设置"
        let count: String = String(latest?["settings"]["targetMonths"].intValue ?? 0)
        return "每月开支 " + amount + "，目标 " + count + " 个月"
    }
    var body: some View {
        runwayForm
            .nativeGeometricPage().navigationTitle("应急储备")
            .modifier(NativeFinancePrivacy(context: context))
            .modifier(NativeFinanceKeyboardDone())
            .navigationBarBackButtonHidden(dirty)
            .toolbar { if dirty { ToolbarItem(placement: .cancellationAction) { closeButton } } }
            .task(id: context.scopeID) { await load() }
            .alert("核对最新设置", isPresented: $adopt) {
                Button("采用最新设置") { if let latest { apply(latest) } }
                Button("保留填写，采用最新版本") { revision = latest?["revision"].intValue; if let latest { response = latest } }
                Button("取消", role: .cancel) {}
            } message: { Text(latestSummary) }
    }
    private var closeButton: some View {
        NativeFinanceCloseButton(context: context, scope: draftScope, values: draftValues, basis: response["settings"], changed: dirty) { dismiss() }
    }
    private var runwayForm: some View {
        Form {
            NativeFinanceStatus(context: context)
            NativeFinanceReadFeedback(state: state) { Task { await load() } }
            if state == .ready {
                draftRecovery
                if response["settings"].isNull { Text("设置每月必要开支和储备账户").foregroundStyle(NativePalette.muted) }
                else { summary }
                Section { DisclosureGroup(response["settings"].isNull ? "开始设置" : "调整设置", isExpanded: $editingSettings) { settingsFields } }.listRowBackground(NativePalette.surface)
            }
        }
    }
    private var draftRecovery: some View {
        NativeFinanceDraftRecovery(context: context, scope: draftScope, values: draftValues, basis: response["settings"], ready: revision != nil) { values in
            expense = values["expense"].stringValue ?? expense; months = values["months"].stringValue ?? months
            ids = Set(values["ids"].arrayValue.compactMap(\.stringValue)); dirty = true; editingSettings = true
        }
    }
    private func money(_ key: String) -> String { NativeFinanceContract.money(response["progress"][key], currency: context.currency) }
    private var summary: some View {
        Section("当前储备") {
            NativeFinanceMetric(title: "可支撑月数", value: response["progress"]["runwayMonths"].stringValue ?? "未知")
            LabeledContent("可动用金额", value: money("currentMinor"))
            LabeledContent("目标缺口", value: money("gapMinor"))
            DisclosureGroup("计算依据") {
                LabeledContent("名义余额", value: money("nominalMinor"))
                LabeledContent("未计入金额", value: money("excludedMinor"))
                LabeledContent("尚未核对资产", value: String(response["progress"]["unreviewedAccountCount"].intValue ?? 0))
                LabeledContent("余额超过30天", value: String(response["progress"]["staleAccountCount"].intValue ?? 0))
            }
            if dirty { Text("有未保存调整，上方仍为已保存结果").font(.caption).foregroundStyle(.orange) }
        }.listRowBackground(NativePalette.surface)
    }
    @ViewBuilder private var settingsFields: some View {
        NativeFinanceAmountField(title: "每月必要开支", currency: context.currency, value: $expense, positive: true).onChange(of: expense) { _, _ in dirty = true }
        TextField("目标月数", text: $months).keyboardType(.numberPad).onChange(of: months) { _, _ in dirty = true }
        ForEach(accounts, id: \.financeID) { account in accountToggle(account) }
        ForEach(missingIDs, id: \.self) { id in missingToggle(id) }
        Button("保存设置") { Task { await save() } }.disabled(!context.canWrite || revision == nil)
        Button("读取最新设置") { Task { await readLatest() } }.disabled(context.busy)
    }
    private func accountToggle(_ account: NativeJSON) -> some View {
        let id: String = account.financeID
        let name: String = account["name"].stringValue ?? "账户"
        let amount: String = NativeFinanceContract.money(account["balanceMinor"], currency: context.currency)
        let classification: String = NativeFinanceContract.liquidityName(account["liquidityKind"].stringValue ?? "")
        let date: String = account["asOfDate"].stringValue ?? "未知日期"
        let selected = Binding<Bool>(get: { ids.contains(id) }, set: { value in if value { ids.insert(id) } else { ids.remove(id) }; dirty = true })
        return Toggle(isOn: selected) {
            VStack(alignment: .leading) { Text(name); Text(amount).font(.caption); Text(classification + " · " + date).font(.caption).foregroundStyle(NativePalette.muted) }
        }.disabled(!context.canWrite || revision == nil)
    }
    private func missingToggle(_ id: String) -> some View {
        let selected = Binding<Bool>(get: { ids.contains(id) }, set: { value in if !value { ids.remove(id) }; dirty = true })
        return Toggle("当前不可用的关联账户", isOn: selected).disabled(!context.canWrite)
    }
    private func apply(_ data: NativeJSON) { response = data; revision = data["revision"].intValue; expense = data["settings"]["monthlyExpenseAmount"].stringValue ?? ""; months = data["settings"]["targetMonths"].intValue.map(String.init) ?? ""; ids = Set(data["settings"]["accountIds"].arrayValue.compactMap(\.stringValue)); dirty = false }
    private func load() async {
        state = .loading
        do {
            let data = try await context.read(context.path("finance/runway", extra: ["currency": context.currency]))
            guard data["revision"].intValue != nil else { throw NativeAPIError.invalidResponse }
            apply(data); editingSettings = data["settings"].isNull; state = .ready
        } catch is CancellationError {} catch { response = .null; revision = nil; state = .failed(error.localizedDescription); context.readFailed(error) }
    }
    private func readLatest() async { do { latest = try await context.read(context.path("finance/runway", extra: ["currency": context.currency])); adopt = true } catch { context.fail(error) } }
    private func save() async {
        do {
            guard let revision, let count = Int(months), count > 0, count <= 9_007_199_254_740_991, !ids.isEmpty else { throw NativeFinanceInputError("请填写正整数月数并选择至少一个资产账户。") }
            let amount = try NativeFinanceContract.inputAmount(expense, currency: context.currency)
            guard amount.contains(where: { $0 >= "1" && $0 <= "9" }) else { throw NativeFinanceInputError("每月必要开支应大于0。") }
            let data = try await context.write(title: "更新应急储备", path: context.path("finance/runway", extra: ["currency": context.currency]), method: "PUT", body: .object(["monthlyExpenseAmount": .string(amount), "targetMonths": .number(Double(count)), "accountIds": .array(ids.sorted().map { .string($0) }), "expectedRevision": .number(Double(revision))])); apply(data); editingSettings = false; try NativeWorkspacePersistence(userID: context.userID, scope: draftScope).clear()
        } catch { context.fail(error) }
    }
}

private struct NativeFinanceReview: View {
    @ObservedObject var context: NativeFinanceContext
    @State private var month = String(NativeFinanceContract.today().prefix(7))
    @State private var requestedMonth = String(NativeFinanceContract.today().prefix(7))
    @State private var draft = false
    @State private var response: NativeJSON = .null
    @State private var reason = ""
    @State private var confirm = false
    @State private var loading = false
    private var draftScope: String { context.draftScope("close:" + requestedMonth) }
    private var draftValues: NativeJSON { .object(["reason": .string(reason)]) }
    init(context: NativeFinanceContext, initialMonth: String? = nil) {
        self.context = context
        let month = initialMonth ?? context.initialReviewMonth ?? NativeFinanceContract.previousMonth()
        _month = State(initialValue: month); _requestedMonth = State(initialValue: month)
    }
    var body: some View {
        List {
            NativeFinanceStatus(context: context)
            NativeFinanceDraftRecovery(context: context, scope: draftScope, values: draftValues, basis: response["close"], ready: response["month"].stringValue != nil) { values in reason = values["reason"].stringValue ?? reason }.id(draftScope)
            Section("回顾范围") {
                NativeFinanceMonthField(value: $month)
                if response["close"]["state"].stringValue == "closed", !draft {
                    Label("已月结", systemImage: "checkmark.seal").foregroundStyle(.green)
                    Button("重新核对并月结") { draft = true }.disabled(!context.canWrite)
                }
            }.listRowBackground(NativePalette.surface)
            if loading { ProgressView("读取月度报表…") }
            if !context.blocked, !loading, response["month"].stringValue != nil {
                closeSection
                NativeFinanceReport(report: response, currency: context.currency)
                DisclosureGroup("月结历史") {
                    ForEach(Array(response["close"]["versions"].arrayValue.enumerated()), id: \.offset) { _, version in
                        NavigationLink {
                            NativeFinanceClosedReport(context: context, month: requestedMonth, version: version["version"].intValue ?? 0)
                        } label: {
                            VStack(alignment: .leading) { Text("版本 " + String(version["version"].intValue ?? 0)); Text(version["closedAt"].stringValue ?? "").font(.caption); if let reason = version["reason"].stringValue { Text(reason).font(.caption) } }
                        }
                    }
                }
                if response["decisions"]["basis"].stringValue == "current" {
                    Section("当前规划（不属于历史月结）") {
                        Text("截至 " + (response["decisions"]["asOfDate"].stringValue ?? "今天"))
                        ForEach(response["decisions"]["goals"].arrayValue, id: \.financeID) { goal in
                            VStack(alignment: .leading) { Text(goal["name"].stringValue ?? "目标"); Text("目前缺口 " + NativeFinanceContract.money(goal["gapMinor"], currency: context.currency)).font(.caption) }
                        }
                        LabeledContent("当前应急月数", value: response["decisions"]["runway"]["runwayMonths"].stringValue ?? "尚未设置")
                    }.listRowBackground(NativePalette.surface)
                }
            }
        }.nativeGeometricPage().navigationTitle("月度回顾与月结").modifier(NativeFinancePrivacy(context: context))
        .task(id: context.scopeID + String(draft) + String(context.change)) { await load() }
        .onChange(of: month) { _, value in requestedMonth = value; draft = false; reason = ""; Task { await load() } }
        .refreshable { await load() }
        .confirmationDialog("确认冻结此月报表？", isPresented: $confirm, titleVisibility: .visible) { Button("确认月结") { Task { await close() } } } message: { Text(context.scopeSummary + "\n" + requestedMonth + "\n保存此月快照，保留旧版本") }
    }
    private var closeSection: some View {
        Section("月结") {
                    LabeledContent("当前版本", value: response["close"]["state"].stringValue == "closed" ? "已确认 · v" + String(response["close"]["version"].intValue ?? 0) : "未结报表")
                    if let time = response["close"]["closedAt"].stringValue { Text("确认时间：" + time).font(.caption) }
                    if let explanation = response["close"]["reason"].stringValue, !explanation.isEmpty { Text(explanation) }
                    if response["close"]["canClose"].boolValue == true && response["close"]["previewHash"].stringValue != nil {
                        TextField((response["close"]["latestVersion"].intValue ?? 0) > 0 ? "重新月结原因（必填）" : "月结说明（可选）", text: $reason, axis: .vertical)
                        Button((response["close"]["latestVersion"].intValue ?? 0) > 0 ? "确认重新月结" : "确认月结") { confirm = true }.disabled(!context.canWrite)
                    } else { Text(requestedMonth == String(NativeFinanceContract.today().prefix(7)) ? "本月结束后可月结" : "已保存的月结可在历史版本查看") .font(.caption).foregroundStyle(NativePalette.muted) }
                }.listRowBackground(NativePalette.surface)
    }
    private func load() async {
        loading = true; response = .null; defer { loading = false }
        do { response = try await context.read(context.path("finance/review", extra: ["currency": context.currency, "month": requestedMonth, "draft": draft ? "1" : "0"])) }
        catch { response = .null; context.fail(error) }
    }
    private func close() async {
        do {
            guard response["month"].stringValue == requestedMonth, let hash = response["close"]["previewHash"].stringValue, let version = response["close"]["latestVersion"].intValue else { throw NativeFinanceInputError("请先读取未结报表。") }
            if version > 0 && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw NativeFinanceInputError("重新月结需填写原因。") }
            _ = try await context.write(title: "确认月结", path: context.path("finance/review/close"), method: "POST", body: .object(["ledger": .string(context.ledger), "currency": .string(context.currency), "month": .string(requestedMonth), "expectedVersion": .number(Double(version)), "previewHash": .string(hash), "reason": .string(reason)]), idempotent: true)
            try NativeWorkspacePersistence(userID: context.userID, scope: draftScope).clear(); draft = false; reason = ""; await load()
        } catch { context.fail(error) }
    }
}

private struct NativeFinanceClosedReport: View {
    @ObservedObject var context: NativeFinanceContext
    let month: String; let version: Int
    @State private var report: NativeJSON = .null
    var body: some View {
        List {
            NativeFinanceStatus(context: context)
            NativeFinanceReport(report: report, currency: context.currency)
            Section("月结依据") { LabeledContent("版本", value: String(version)); Text(report["close"]["closedAt"].stringValue ?? ""); Text(report["close"]["reason"].stringValue ?? "") }.listRowBackground(NativePalette.surface)
        }.nativeGeometricPage().navigationTitle(month + " · v" + String(version)).modifier(NativeFinancePrivacy(context: context)).task {
            do { report = try await context.read(context.path("finance/review", extra: ["currency": context.currency, "month": month, "version": String(version)])) } catch { report = .null; context.fail(error) }
        }
    }
}

private struct NativeFinanceReport: View {
    let report: NativeJSON; let currency: String
    private var month: String? { report["month"].stringValue }
    private var title: String { (month ?? "") + "资产负债" }
    private var dateRange: String {
        let oldest: String = report["snapshot"]["oldestBalanceDate"].stringValue ?? "未知"
        let latest: String = report["snapshot"]["latestBalanceDate"].stringValue ?? "未知"
        return "余额日期：\(oldest) 至 \(latest)"
    }
    private func money(_ section: String, _ key: String) -> String {
        NativeFinanceContract.money(report[section][key], currency: currency)
    }
    var body: some View {
        if month != nil {
            snapshotSection
            changeSection
            trendSection
            accountsSection
        }
    }
    private var snapshotSection: some View {
        Section(title) {
            NativeFinanceMetric(title: "净资产", value: money("snapshot", "netMinor"))
            LabeledContent("资产", value: money("snapshot", "assetsMinor"))
            LabeledContent("负债", value: money("snapshot", "liabilitiesMinor"))
            LabeledContent("上月净资产", value: money("previous", "netMinor"))
            LabeledContent("净资产变化", value: money("change", "netMinor"))
            LabeledContent("沿用此前余额的账户", value: String(report["snapshot"]["carriedAccountCount"].intValue ?? 0))
            Text(dateRange).font(.caption)
        }.listRowBackground(NativePalette.surface)
    }
    private var changeSection: some View {
        Section { DisclosureGroup("变化来源") {
            LabeledContent("已有账户余额变化", value: money("change", "comparableNetMinor"))
            LabeledContent("首次计入账户", value: money("change", "newNetMinor"))
            LabeledContent("分类变更影响", value: money("change", "reclassificationNetMinor"))
            LabeledContent("归档/恢复影响", value: money("change", "membershipNetMinor"))
            Text("各项由服务器按历史生效口径计算，不代表投资收益。")
                .font(.caption).foregroundStyle(NativePalette.muted)
        }
    }.listRowBackground(NativePalette.surface)
    }
    private var trendSection: some View {
        let trend: [NativeJSON] = report["trend"].arrayValue
        return Section { DisclosureGroup("近月精确明细") {
            ForEach(Array(trend.enumerated()), id: \.offset) { _, point in trendRow(point) }
        }
    }.listRowBackground(NativePalette.surface)
    }
    private func trendRow(_ point: NativeJSON) -> some View {
        let month: String = point["month"].stringValue ?? "月份未知"
        let amount: String = NativeFinanceContract.money(point["netMinor"], currency: currency)
        return LabeledContent(month, value: amount)
    }
    private var accountsSection: some View {
        let accounts: [NativeJSON] = report["accounts"].arrayValue
        return Section { DisclosureGroup("账户变化") {
            ForEach(accounts, id: \.financeID) { account in NativeFinanceReportAccountRow(account: account, currency: currency) }
        }
        }.listRowBackground(NativePalette.surface)
    }
}

private struct NativeFinanceReportAccountRow: View {
    let account: NativeJSON; let currency: String
    private var name: String { account["name"].stringValue ?? "账户" }
    private var current: String { "本月 " + NativeFinanceContract.money(account["currentMinor"], currency: currency) }
    private var previous: String { "上月 " + NativeFinanceContract.money(account["previousMinor"], currency: currency) }
    private var change: String { "变化 " + NativeFinanceContract.money(account["netChangeMinor"], currency: currency) }
    private var carriedDate: String { "沿用此前余额 · " + (account["currentAsOfDate"].stringValue ?? "") }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(name).font(.headline)
            Text(current)
            Text(previous).font(.caption)
            Text(change).font(.caption)
            if account["carried"].boolValue == true { Text(carriedDate).font(.caption).foregroundStyle(NativePalette.muted) }
        }
    }
}

private struct NativeFinanceMembers: View {
    @ObservedObject var context: NativeFinanceContext
    @State private var response: NativeJSON = .null
    @State private var email = ""
    @State private var role = "editor"
    @State private var invite = false
    @State private var selected: NativeJSON?
    @State private var action = "revoke"
    @State private var nextRole = "viewer"
    @State private var confirmMember = false
    private var draftScope: String { "finance:own:invite" }
    private var draftValues: NativeJSON { .object(["email": .string(email), "role": .string(role)]) }
    var body: some View {
        List {
            NativeFinanceStatus(context: context, scopeOverride: "我的家庭账本")
            Section("我的家庭账本") {
                Text(response["book"]["name"].stringValue ?? "我的家庭账本").font(.headline)
                Text("只有拥有人可管理此处协作者；邀请不发送邮件，有效期为30天。网站准入与账本协作分别授权。") .font(.caption).foregroundStyle(NativePalette.muted)
            }.listRowBackground(NativePalette.surface)
            NativeFinanceDraftRecovery(context: context, scope: draftScope, values: draftValues, basis: .null, ready: true) { values in email = values["email"].stringValue ?? email; role = values["role"].stringValue ?? role }
            Section("邀请协作者") {
                TextField("对方登录邮箱", text: $email).textInputAutocapitalization(.never).keyboardType(.emailAddress).autocorrectionDisabled()
                Picker("邀请权限", selection: $role) { Text("可编辑").tag("editor"); Text("只读").tag("viewer") }
                Button("创建站内邀请") { invite = true }.disabled(context.pending != nil || context.busy || email.isEmpty || context.blocked)
            }.listRowBackground(NativePalette.surface)
            Section("成员与邀请") {
                ForEach(response["members"].arrayValue, id: \.financeID) { member in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(member["email"].stringValue ?? "成员").font(.headline)
                        Text(NativeFinanceContract.roleName(member["role"].stringValue ?? "viewer") + " · " + memberStatus(member["status"].stringValue ?? ""))
                        if member["status"].stringValue == "pending" { Text("有效至 " + (member["expiresAt"].stringValue ?? "")).font(.caption) }
                        if ["pending", "active"].contains(member["status"].stringValue ?? "") {
                            HStack {
                                Button(member["role"].stringValue == "editor" ? "改为只读" : "改为可编辑") { selected = member; action = "role"; nextRole = member["role"].stringValue == "editor" ? "viewer" : "editor"; confirmMember = true }
                                Button(member["status"].stringValue == "pending" ? "撤销邀请" : "移除成员", role: .destructive) { selected = member; action = "revoke"; confirmMember = true }
                            }.buttonStyle(.borderless).disabled(context.pending != nil || context.busy || context.blocked)
                        }
                    }
                }
            }.listRowBackground(NativePalette.surface)
        }.nativeGeometricPage().navigationTitle("家庭协作者").modifier(NativeFinancePrivacy(context: context))
        .task(id: String(context.change)) { await load() }.refreshable { await load() }
        .confirmationDialog("邀请此邮箱加入我的家庭账本？", isPresented: $invite, titleVisibility: .visible) { Button("确认邀请") { Task { await sendInvite() } } } message: { Text(email + " · " + NativeFinanceContract.roleName(role)) }
        .confirmationDialog(action == "revoke" ? "撤销此成员的访问？" : "更改此成员的角色？", isPresented: $confirmMember, titleVisibility: .visible) {
            Button("确认", role: action == "revoke" ? .destructive : nil) { Task { await changeMember() } }
        } message: { Text((selected?["email"].stringValue ?? "") + (action == "role" ? " → " + NativeFinanceContract.roleName(nextRole) : "；原记录保留，旧授权将失效。")) }
    }
    private func memberStatus(_ value: String) -> String { ["pending": "待接受", "active": "已加入", "revoked": "已撤销", "declined": "已婉拒"][value] ?? value }
    private func load() async { do { response = try await context.read("finance/books/own/members") } catch { response = .null; context.fail(error) } }
    private func sendInvite() async {
        do { _ = try await context.write(title: "邀请家庭协作者", path: "finance/books/own/invitations", method: "POST", body: .object(["email": .string(email.trimmingCharacters(in: .whitespacesAndNewlines)), "role": .string(role)]), idempotent: true); try NativeWorkspacePersistence(userID: context.userID, scope: draftScope).clear(); email = ""; await load(); await context.loadBooks() } catch { context.fail(error) }
    }
    private func changeMember() async {
        guard let selected, let revision = selected["revision"].intValue else { return }
        var body: [String: NativeJSON] = ["action": .string(action), "expectedRevision": .number(Double(revision))]
        if action == "role" { body["role"] = .string(nextRole) }
        do { _ = try await context.write(title: "调整家庭协作者", path: "finance/books/own/members/" + selected.financeID, method: "POST", body: .object(body), idempotent: true, targetName: selected["email"].stringValue); await load() } catch { context.fail(error) }
    }
}

private struct NativeFinanceActivity: View {
    @ObservedObject var context: NativeFinanceContext
    @State private var items: [NativeJSON] = []
    @State private var hasMore = false
    @State private var loading = false
    @State private var state: NativeFinanceReadState = .loading
    var body: some View {
        List {
            NativeFinanceStatus(context: context)
            NativeFinanceReadFeedback(state: state) { Task { await load(reset: true) } }
            if items.isEmpty && !loading && state == .ready { Text("暂无当前家庭账本的协作动态。") .foregroundStyle(NativePalette.muted) }
            ForEach(items, id: \.financeID) { item in
                VStack(alignment: .leading, spacing: 5) {
                    Text((item["actorName"].stringValue ?? "成员") + (item["summary"].stringValue ?? "更新了账本"))
                    if let target = item["targetName"].stringValue { Text(target).font(.callout) }
                    Text(item["createdAt"].stringValue ?? "").font(.caption).foregroundStyle(NativePalette.muted)
                }
            }
            if loading { ProgressView("读取协作动态…") }
            if hasMore { Button("更早动态") { Task { await load(reset: false) } }.disabled(loading) }
        }.nativeGeometricPage().navigationTitle("协作动态").modifier(NativeFinancePrivacy(context: context)).task(id: context.scopeID) { await load(reset: true) }.refreshable { await load(reset: true) }
    }
    private func load(reset: Bool) async {
        guard !loading else { return }; loading = true; defer { loading = false }
        if reset { items = []; state = .loading }
        var components = URLComponents(); components.path = "finance/books/" + context.bookID + "/activity"
        components.queryItems = [URLQueryItem(name: "bookRevision", value: String(context.accessRevision)), URLQueryItem(name: "offset", value: String(items.count)), URLQueryItem(name: "limit", value: "30")]
        do { let response = try await context.read(components.string!); items += response["items"].arrayValue; hasMore = response["hasMore"].boolValue ?? false; state = .ready } catch is CancellationError {} catch { state = .failed(error.localizedDescription); context.readFailed(error) }
    }
}

private struct NativeFinanceDraft: Codable {
    let values: NativeJSON
    let basis: NativeJSON
    let savedAt: Date
}

/// Restoring is always explicit. A stale draft never updates a CAS version or
/// reuses a prior preview; the user sees that the source record has changed.
private struct NativeFinanceDraftRecovery: View {
    @ObservedObject var context: NativeFinanceContext
    let scope: String; let values: NativeJSON; let basis: NativeJSON; let ready: Bool
    let restore: (NativeJSON) -> Void
    @State private var candidate: NativeFinanceDraft?
    @State private var baseline: NativeJSON?
    @State private var restoreConfirm = false
    private var store: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: context.userID, scope: scope) }
    var body: some View {
        if let candidate {
            Section("本机未完成填写") {
                Text("保存于 " + candidate.savedAt.formatted(date: .abbreviated, time: .shortened)).font(.caption)
                if candidate.basis != basis { Text("原记录已变化。恢复仅填入草稿，请重新核对当前记录与版本后保存。") .foregroundStyle(.orange) }
                Button("核对并恢复填写") { restoreConfirm = true }.disabled(context.pending != nil || context.busy)
                Button("放弃此草稿", role: .destructive) { discard() }.disabled(context.pending != nil || context.busy)
            }.listRowBackground(NativePalette.surface)
            .confirmationDialog("恢复本机填写？", isPresented: $restoreConfirm, titleVisibility: .visible) {
                Button("恢复填写，不提交") { restore(candidate.values); self.candidate = nil }
            } message: { Text("恢复不会自动提交，也不会恢复旧的余额预览或修改当前记录版本。") }
            .task(id: ready) { await prepare() }
            .onChange(of: values) { _, value in persist(value) }
        } else {
            Text("未完成填写仅保存在当前手机；换设备不能恢复。") .font(.caption).foregroundStyle(NativePalette.muted)
                .task(id: ready) { await prepare() }
                .onChange(of: values) { _, value in persist(value) }
        }
    }
    private func prepare() async {
        guard ready, baseline == nil else { return }
        baseline = values
        do {
            if let draft = try store.load(NativeFinanceDraft.self), Date().timeIntervalSince(draft.savedAt) <= 30 * 86400 { candidate = draft }
            else { try store.clear() }
        } catch { context.fail(error) }
    }
    private func persist(_ value: NativeJSON) {
        guard ready, let baseline, value != baseline, candidate == nil, context.pending == nil, !context.busy else { return }
        do { try store.save(NativeFinanceDraft(values: value, basis: basis, savedAt: Date())) } catch { context.fail(error) }
    }
    private func discard() { do { try store.clear(); candidate = nil } catch { context.fail(error) } }
}

private struct NativeFinanceCloseButton: View {
    @ObservedObject var context: NativeFinanceContext
    let scope: String; let values: NativeJSON; let basis: NativeJSON; let changed: Bool; let close: () -> Void
    @State private var confirm = false
    private var store: NativeWorkspacePersistence { NativeWorkspacePersistence(userID: context.userID, scope: scope) }
    var body: some View {
        Button("关闭") { if changed && context.pending == nil { confirm = true } else { close() } }.disabled(context.busy)
            .confirmationDialog("有尚未提交的填写", isPresented: $confirm, titleVisibility: .visible) {
                Button("保存草稿并关闭") { do { try store.save(NativeFinanceDraft(values: values, basis: basis, savedAt: Date())); close() } catch { context.fail(error) } }
                Button("放弃填写并关闭", role: .destructive) { do { try store.clear(); close() } catch { context.fail(error) } }
                Button("继续编辑", role: .cancel) {}
            }
    }
}

private struct NativeFinancePrivacy: ViewModifier {
    @ObservedObject var context: NativeFinanceContext
    func body(content: Content) -> some View {
        content.accessibilityHidden(context.blocked)
            .overlay {
                if context.blocked {
                    VStack(spacing: 16) {
                        Image(systemName: "lock.shield").font(.largeTitle)
                        Text("账本授权需要重新核对").font(.headline)
                        Text("请返回账本列表重新选择。原草稿及待确认操作仍属于原账户、原账本和原授权版本。") .multilineTextAlignment(.center)
                    }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity).background(NativePalette.surface)
                }
            }
    }
}

private struct NativeFinanceKeyboardDone: ViewModifier {
    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("完成") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
            }
        }
    }
}

private struct NativeFinanceAmountField: View {
    let title: String
    let currency: String
    @Binding var value: String
    var positive = false
    @State private var edited = false
    private var validation: String? {
        guard edited else { return nil }
        if value.isEmpty { return "请输入金额" }
        do {
            let parsed = try NativeFinanceContract.inputAmount(value, currency: currency)
            if positive && !parsed.contains(where: { $0 >= "1" && $0 <= "9" }) { return "金额需大于0" }
            return nil
        } catch { return error.localizedDescription }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                Spacer()
                Text(currency).foregroundStyle(NativePalette.muted)
                TextField("0", text: $value).keyboardType(currency == "JPY" ? .numberPad : .decimalPad)
                    .multilineTextAlignment(.trailing).monospacedDigit()
                    .accessibilityLabel(title + "，" + currency)
            }
            if let validation { Text(validation).font(.caption).foregroundStyle(.red) }
        }.onChange(of: value) { _, _ in edited = true }
    }
}

private struct NativeFinanceDateField: View {
    let title: String
    @Binding var value: String
    var allowsFuture = false
    private var date: Binding<Date> {
        Binding(get: { NativeFinanceContract.dateValue(value) ?? Date() }, set: { value = NativeFinanceContract.today($0) })
    }
    private var minimum: Date { NativeFinanceContract.dateValue("1970-01-01")! }
    private var maximum: Date { allowsFuture ? NativeFinanceContract.dateValue("2100-12-31")! : NativeFinanceContract.calendar.startOfDay(for: Date()).addingTimeInterval(86399) }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            DatePicker(title, selection: date, in: minimum...maximum, displayedComponents: .date)
                .environment(\.timeZone, NativeFinanceContract.calendar.timeZone)
                .environment(\.calendar, NativeFinanceContract.calendar)
            if NativeFinanceContract.dateValue(value) == nil { Text("请重新选择日期").font(.caption).foregroundStyle(.red) }
        }
    }
}

private struct NativeFinanceMonthField: View {
    @Binding var value: String
    private var selectedYear: Int { Int(value.prefix(4)) ?? NativeFinanceContract.calendar.component(.year, from: Date()) }
    private var selectedMonth: Int { Int(value.suffix(2)) ?? 1 }
    private var currentYear: Int { NativeFinanceContract.calendar.component(.year, from: Date()) }
    private var year: Binding<Int> {
        Binding(get: { selectedYear }, set: { year in
            let limit = year == currentYear ? NativeFinanceContract.calendar.component(.month, from: Date()) : 12
            value = String(format: "%04d-%02d", year, min(selectedMonth, limit))
        })
    }
    private var month: Binding<Int> {
        Binding(get: { selectedMonth }, set: { value = String(format: "%04d-%02d", selectedYear, $0) })
    }
    private var monthLimit: Int { selectedYear == currentYear ? NativeFinanceContract.calendar.component(.month, from: Date()) : 12 }
    var body: some View {
        HStack {
            Text("月份")
            Spacer()
            Picker("年份", selection: year) { ForEach(Array(1970...currentYear).reversed(), id: \.self) { Text(String($0)).tag($0) } }
                .labelsHidden().pickerStyle(.menu)
            Picker("月份", selection: month) { ForEach(1...monthLimit, id: \.self) { Text("\($0)月").tag($0) } }
                .labelsHidden().pickerStyle(.menu)
        }
    }
}

private struct NativeFinanceReadFeedback: View {
    let state: NativeFinanceReadState
    let retry: () -> Void
    var body: some View {
        switch state {
        case .loading: Section { ProgressView("正在读取…") }.listRowBackground(NativePalette.surface)
        case .failed(let message):
            Section {
                Label("暂时无法读取", systemImage: "wifi.exclamationmark").font(.headline)
                Text(message).font(.callout).foregroundStyle(NativePalette.muted)
                Button("重试", action: retry)
            }.listRowBackground(NativePalette.surface)
        case .ready: EmptyView()
        }
    }
}
