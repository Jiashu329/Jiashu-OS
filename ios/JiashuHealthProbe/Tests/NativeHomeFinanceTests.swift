import Foundation
import XCTest
@testable import JiashuHealthProbe

final class NativeHomeFinanceTests: XCTestCase {
    private let cny = NativeOverviewCurrency(currency: "CNY", netFormatted: "CNY 0.00", assetsFormatted: "CNY 123.45", liabilitiesFormatted: "CNY 123.45")
    private let usd = NativeOverviewCurrency(currency: "USD", netFormatted: "USD 9,007,199,254,740,993.12", assetsFormatted: "USD 9,007,199,254,740,994.13", liabilitiesFormatted: "USD 1.01")

    private func finance(_ currencies: [NativeOverviewCurrency], total: Int = 4, unchecked: Int = 1) -> NativeOverviewFinance {
        NativeOverviewFinance(status: "ready", accountCount: total, currencies: currencies,
                              staleAccountCount: 0, uncheckedAccountCount: unchecked, pendingBalanceCount: unchecked)
    }

    func testCurrencySymbolsPreserveServerPrecisionGroupingAndNegativeAmounts() {
        XCTAssertEqual(NativeHomeFinanceCardRules.amountText("CNY 123,456.70", currency: "CNY"), "¥123,456.70")
        XCTAssertEqual(NativeHomeFinanceCardRules.amountText("USD -9,007,199,254,740,993.12", currency: "USD"), "-$9,007,199,254,740,993.12")
        XCTAssertEqual(NativeHomeFinanceCardRules.amountText("JPY 999,999,999,999,999,999", currency: "JPY"), "¥999,999,999,999,999,999")
        XCTAssertEqual(NativeHomeFinanceCardRules.amountText("EUR 1.2300", currency: "EUR"), "€1.2300")
        for (code, symbol) in [("HKD", "HK$"), ("SGD", "S$"), ("AUD", "A$"), ("CAD", "C$"), ("GBP", "£"), ("RUB", "₽")] {
            XCTAssertEqual(NativeHomeFinanceCardRules.amountText(code + " 0.00", currency: code), symbol + "0.00")
        }
        XCTAssertEqual(usd.currency, "USD", "The picker keeps the code that disambiguates the symbol")
    }

    func testCurrencySymbolFallbacksAndHiddenAmountsDoNotInventOrExposeValues() {
        for (formatted, currency) in [("XYZ 123.00", "XYZ"), ("USD 123.00", "CNY"), ("USD 暂无记录", "USD"), ("USD 1,00.00", "USD"), ("USD 1.00\n", "USD"), ("$1.00", "USD")] {
            XCTAssertEqual(NativeHomeFinanceCardRules.amountText(formatted, currency: currency), formatted)
        }
        XCTAssertEqual(NativeHomeFinanceCardRules.amountText("", currency: "CNY"), "暂无记录")
        XCTAssertEqual(NativeHomeFinanceCardRules.amountText(usd.netFormatted, currency: "USD", hidden: true), "••••••")
        XCTAssertEqual(NativeHomeFinanceCardRules.amountText("XYZ 987654321.00", currency: "XYZ", hidden: true), "••••••")
    }

    func testMultipleCurrenciesNeverPresentLedgerCountsAsCurrencyProgress() {
        let multiCurrency = finance([cny, usd])
        XCTAssertNil(NativeHomeFinanceCardRules.checkProgress(multiCurrency))
        XCTAssertEqual(multiCurrency.uncheckedAccountCount, 1, "The true ledger-wide pending count remains available")
        let singleCurrency = NativeHomeFinanceCardRules.checkProgress(finance([cny]))
        XCTAssertEqual(singleCurrency?.checked, 3)
        XCTAssertEqual(singleCurrency?.total, 4)
    }

    func testSelectedFormattedMoneyRemainsExactAndUnknownScopeDoesNotFallBack() throws {
        let selected = try XCTUnwrap(NativeHomeFinanceCardRules.displayValues(currency: "USD", values: [cny, usd]))
        XCTAssertEqual(selected.netFormatted, "USD 9,007,199,254,740,993.12")
        XCTAssertEqual(selected.assetsFormatted, "USD 9,007,199,254,740,994.13")
        XCTAssertEqual(selected.liabilitiesFormatted, "USD 1.01")
        let currency = NativeHomeFinanceCardRules.currency(preferred: "JPY", values: [cny, usd])
        XCTAssertEqual(currency, "JPY")
        XCTAssertNil(NativeHomeFinanceCardRules.displayValues(currency: currency, values: [cny, usd]), "Missing JPY data cannot be replaced with CNY money")
        XCTAssertEqual(NativeHomeFinanceCardRules.ledger(preferred: "family", values: ["personal": finance([cny])]), "family", "An unavailable selected household must not silently become personal")
    }

    func testInvalidOrEmptyCheckCountsNeverProduceAnInventedProgressFraction() {
        for (total, unchecked) in [(4, -1), (4, 5), (0, 0), (-1, 0), (9_007_199_254_740_992, 0)] {
            XCTAssertNil(NativeHomeFinanceCardRules.checkProgress(finance([cny], total: total, unchecked: unchecked)))
        }
        let allChecked = NativeHomeFinanceCardRules.checkProgress(finance([cny], total: 4, unchecked: 0))
        XCTAssertEqual(allChecked?.checked, 4)
        XCTAssertEqual(allChecked?.total, 4)
        XCTAssertNil(NativeHomeFinanceCardRules.checkProgress(finance([])))
    }
    func testBalanceDatesUseValidatedLedgerRangeAndKeepCrossYearContext() throws {
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-17T00:00:00Z"))
        var value = finance([cny, usd])
        value.oldestBalanceDate = "2026-11-01"; value.latestBalanceDate = "2026-11-16"
        XCTAssertEqual(NativeHomeFinanceCardRules.balanceDateCaption(value, now: now), "账本余额日期（全部币种） 11/1–11/16")
        value.oldestBalanceDate = "2025-12-31"; value.latestBalanceDate = "2026-01-01"
        XCTAssertEqual(NativeHomeFinanceCardRules.balanceDateCaption(value, now: now), "账本余额日期（全部币种） 2025/12/31–2026/1/1")
        value.oldestBalanceDate = "2025-11-01"; value.latestBalanceDate = "2025-11-16"
        XCTAssertEqual(NativeHomeFinanceCardRules.balanceDateCaption(value, now: now), "账本余额日期（全部币种） 2025/11/1–2025/11/16")
        value.oldestBalanceDate = "2026-11-16"; value.latestBalanceDate = "2026-11-16"
        XCTAssertEqual(NativeHomeFinanceCardRules.balanceDateCaption(value, now: now), "账本余额日期（全部币种） 11/16")
        for invalid in ["2026-02-29", "2026-13-01", "2026-11-31", "2026-1-01", "2026-11-16T00:00:00Z", "2026-11-16\n"] {
            value.oldestBalanceDate = invalid
            XCTAssertNil(NativeHomeFinanceCardRules.balanceDateCaption(value, now: now), invalid)
        }
        value.oldestBalanceDate = "2026-11-17"; value.latestBalanceDate = "2026-11-16"
        XCTAssertNil(NativeHomeFinanceCardRules.balanceDateCaption(value, now: now))
    }

    func testOlderOverviewWithoutBalanceDateFieldsDoesNotInventDates() throws {
        let json = Data("{\"status\":\"ready\",\"accountCount\":0,\"currencies\":[],\"staleAccountCount\":0,\"uncheckedAccountCount\":0,\"pendingBalanceCount\":0}".utf8)
        let value = try JSONDecoder().decode(NativeOverviewFinance.self, from: json)
        XCTAssertNil(value.oldestBalanceDate); XCTAssertNil(value.latestBalanceDate)
        XCTAssertNil(NativeHomeFinanceCardRules.balanceDateCaption(value))
        var partial = finance([cny]); partial.latestBalanceDate = "2026-11-16"
        XCTAssertNil(NativeHomeFinanceCardRules.balanceDateCaption(partial), "A latest date alone is not an all-account as-of date")
        let datedJSON = Data("{\"status\":\"ready\",\"accountCount\":0,\"currencies\":[],\"staleAccountCount\":0,\"uncheckedAccountCount\":0,\"pendingBalanceCount\":0,\"oldestBalanceDate\":\"2026-11-01\",\"latestBalanceDate\":\"2026-11-16\"}".utf8)
        let dated = try JSONDecoder().decode(NativeOverviewFinance.self, from: datedJSON)
        XCTAssertEqual(dated.oldestBalanceDate, "2026-11-01")
        XCTAssertEqual(dated.latestBalanceDate, "2026-11-16")
    }

}
