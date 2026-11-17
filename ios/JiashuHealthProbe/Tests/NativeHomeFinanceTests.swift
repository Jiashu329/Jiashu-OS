import XCTest
@testable import JiashuHealthProbe

final class NativeHomeFinanceTests: XCTestCase {
    private let cny = NativeOverviewCurrency(currency: "CNY", netFormatted: "CNY 0.00", assetsFormatted: "CNY 123.45", liabilitiesFormatted: "CNY 123.45")
    private let usd = NativeOverviewCurrency(currency: "USD", netFormatted: "USD 9,007,199,254,740,993.12", assetsFormatted: "USD 9,007,199,254,740,994.13", liabilitiesFormatted: "USD 1.01")

    private func finance(_ currencies: [NativeOverviewCurrency], total: Int = 4, unchecked: Int = 1) -> NativeOverviewFinance {
        NativeOverviewFinance(status: "ready", accountCount: total, currencies: currencies,
                              staleAccountCount: 0, uncheckedAccountCount: unchecked, pendingBalanceCount: unchecked)
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
}
