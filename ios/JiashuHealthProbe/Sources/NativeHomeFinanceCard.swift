import Foundation
import SwiftUI

/// The overview has ledger-wide check counts and per-currency formatted money.
/// These rules only select presentation scope; they never total or parse money.
enum NativeHomeFinanceCardRules {
    static let ledgers = ["personal", "family"]

    static func ledger(preferred: String?, values: [String: NativeOverviewFinance]?) -> String {
        // A previously selected ledger becoming unavailable must not silently
        // replace the money on screen with another household's figures.
        if let preferred, ledgers.contains(preferred) { return preferred }
        return ledgers.first { values?[$0]?.status == "ready" } ?? "personal"
    }

    static func currency(preferred: String?, values: [NativeOverviewCurrency]) -> String? {
        if let preferred { return preferred }
        return values.first { $0.currency == "CNY" }?.currency ?? values.first?.currency
    }

    static func displayValues(currency: String?, values: [NativeOverviewCurrency]) -> NativeOverviewCurrency? {
        guard let currency else { return nil }
        return values.first { $0.currency == currency }
    }

    /// Replace only the known, matching currency prefix. The server's digits,
    /// grouping and decimal places remain strings, including values beyond 2^53.
    static func amountText(_ formatted: String, currency: String, hidden: Bool = false) -> String {
        if hidden { return "••••••" }
        if formatted.isEmpty { return "暂无记录" }
        let symbols = ["CNY": "¥", "JPY": "¥", "USD": "$", "HKD": "HK$", "SGD": "S$",
                       "AUD": "A$", "CAD": "C$", "EUR": "€", "GBP": "£", "RUB": "₽"]
        let prefix = currency + " "
        guard let symbol = symbols[currency], formatted.hasPrefix(prefix) else { return formatted }
        let amount = String(formatted.dropFirst(prefix.count))
        guard !amount.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              amount.range(of: "^-?(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\\.[0-9]+)?$", options: .regularExpression) != nil else { return formatted }
        return amount.hasPrefix("-") ? "-" + symbol + String(amount.dropFirst()) : symbol + amount
    }

    static func balanceDateCaption(_ finance: NativeOverviewFinance, now: Date = Date()) -> String? {
        guard finance.status == "ready", let oldest = balanceDay(finance.oldestBalanceDate),
              let latest = balanceDay(finance.latestBalanceDate), oldest.iso <= latest.iso else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        let currentYear = calendar.component(.year, from: now)
        let shortDates = oldest.year == latest.year && oldest.year == currentYear
        let first = shortDates ? oldest.short : oldest.full
        let last = shortDates ? latest.short : latest.full
        let range = oldest.iso == latest.iso ? first : first + "–" + last
        let scope = finance.currencies.count > 1 ? "账本余额日期（全部币种）" : "账本余额日期"
        return scope + " " + range
    }

    private static func balanceDay(_ value: String?) -> (iso: String, year: Int, short: String, full: String)? {
        guard let value, value.utf8.count == 10, value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { return nil }
        let pieces = value.split(separator: "-").compactMap { Int($0) }
        guard pieces.count == 3, (1970...2100).contains(pieces[0]) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = DateComponents(year: pieces[0], month: pieces[1], day: pieces[2])
        guard let date = calendar.date(from: components) else { return nil }
        let checked = calendar.dateComponents([.year, .month, .day], from: date)
        guard checked.year == pieces[0], checked.month == pieces[1], checked.day == pieces[2] else { return nil }
        let short = "\(pieces[1])/\(pieces[2])"
        return (value, pieces[0], short, "\(pieces[0])/" + short)
    }

    static func checkProgress(_ finance: NativeOverviewFinance) -> (checked: Int, total: Int)? {
        // Only one currency means the denominator also matches the money scope.
        // For a multi-currency ledger the UI instead names the ledger-wide count.
        guard finance.status == "ready", finance.currencies.count == 1,
              finance.accountCount > 0, finance.uncheckedAccountCount >= 0,
              finance.uncheckedAccountCount <= finance.accountCount,
              finance.accountCount <= 9_007_199_254_740_991 else { return nil }
        return (finance.accountCount - finance.uncheckedAccountCount, finance.accountCount)
    }
}

struct NativeHomeFinanceCard: View {
    @ObservedObject var model: NativeAppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var minimumColumnWidth: CGFloat = 132
    @State private var preferredLedger: String?
    @State private var preferredCurrency: String?
    @State private var moneyHidden = false

    private var ledger: String { NativeHomeFinanceCardRules.ledger(preferred: preferredLedger, values: model.overview?.finance) }
    private var ledgerName: String { ledger == "family" ? "家庭账本" : "个人账本" }
    private var finance: NativeOverviewFinance? { model.overview?.finance?[ledger] }
    private var currencies: [NativeOverviewCurrency] { finance?.status == "ready" ? finance?.currencies ?? [] : [] }
    private var currency: String? { NativeHomeFinanceCardRules.currency(preferred: preferredCurrency, values: currencies) }
    private var values: NativeOverviewCurrency? { NativeHomeFinanceCardRules.displayValues(currency: currency, values: currencies) }
    private var ready: Bool { finance?.status == "ready" }
    private var availableLedgers: [String] { NativeHomeFinanceCardRules.ledgers.filter { model.overview?.finance?[$0]?.status == "ready" } }
    private var isInitialLoading: Bool { (!ready && model.overviewLoading) || (model.overview == nil && model.restoring) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            cardContent
            if ready, model.overviewLoading { updatingLabel }
            else if ready, model.overviewError != nil { refreshFailure }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(NativePalette.ink)
        .nativeGeometricCard(fill: NativePalette.surface, corner: 28, compactCorner: 10, compactAt: .bottomTrailing)
        .onAppear { initializeSelection() }
        .onChange(of: model.overview?.asOf) { _, _ in initializeSelection() }
        .onChange(of: ledger) { _, _ in initializeSelection() }
        .onChange(of: model.session?.user.id) { _, _ in
            preferredLedger = nil; preferredCurrency = nil; moneyHidden = false
        }
    }

    @ViewBuilder private var header: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) { ledgerMenu; HStack { Spacer(minLength: 0); tools } }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 8) { ledgerMenu; Spacer(minLength: 4); tools }
                VStack(alignment: .leading, spacing: 4) { ledgerMenu; HStack { Spacer(minLength: 0); tools } }
            }
        }
    }

    @ViewBuilder private var ledgerMenu: some View {
        if availableLedgers.count > 1 { ledgerChoices }
        else if ready, let session = model.session {
            NavigationLink {
                NativeFinanceRoot(api: model.api, token: session.accessToken, userID: session.user.id, initialPath: destination(), embedded: true)
            } label: { ledgerTitle(symbol: "arrow.up.right") }
                .buttonStyle(NativePressStyle())
                .accessibilityLabel("查看" + ledgerName)
        } else if let alternative = availableLedgers.first {
            Button { preferredLedger = alternative; preferredCurrency = nil } label: { ledgerTitle(symbol: "arrow.left.arrow.right") }
                .buttonStyle(NativePressStyle())
                .accessibilityLabel("当前" + ledgerName + "不可用，切换到" + (alternative == "family" ? "家庭账本" : "个人账本"))
        } else { ledgerTitle(symbol: nil) }
    }

    private func ledgerTitle(symbol: String?) -> some View {
        HStack(spacing: 6) {
            Text(ledgerName).font(.headline)
            if let symbol { Image(systemName: symbol).font(.caption2.weight(.semibold)) }
        }.fixedSize(horizontal: false, vertical: true).frame(minHeight: 44, alignment: .leading).contentShape(Rectangle())
    }

    private var ledgerChoices: some View {
        Menu {
            ForEach(NativeHomeFinanceCardRules.ledgers, id: \.self) { item in
                Button {
                    preferredLedger = item; preferredCurrency = nil
                } label: {
                    let name: String = item == "family" ? "家庭账本" : "个人账本"
                    Label(name, systemImage: ledger == item ? "checkmark" : "book.closed")
                }.disabled(!availableLedgers.contains(item))
            }
        } label: {
            HStack(spacing: 6) {
                Text(ledgerName).font(.headline)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .disabled(availableLedgers.isEmpty)
        .buttonStyle(NativePressStyle())
        .accessibilityLabel("选择账本，当前" + ledgerName)
    }

    private var tools: some View {
        HStack(spacing: 2) {
            currencyMenu
            Button { moneyHidden.toggle() } label: {
                Image(systemName: moneyHidden ? "eye.slash" : "eye")
                    .font(.subheadline).frame(width: 44, height: 44)
            }
            .buttonStyle(NativePressStyle())
            .foregroundStyle(NativePalette.muted)
            .accessibilityLabel(moneyHidden ? "显示金额" : "隐藏金额")
            .accessibilityValue(moneyHidden ? "金额已隐藏" : "金额已显示")
        }
    }

    @ViewBuilder private var currencyMenu: some View {
        if currencies.count > 1 { currencyChoices }
        else if let sole = currencies.first, sole.currency != currency {
            Button(sole.currency) { preferredCurrency = sole.currency }
                .font(.caption.weight(.medium)).foregroundStyle(NativePalette.muted)
                .frame(minWidth: 44, minHeight: 44).buttonStyle(NativePressStyle())
                .accessibilityLabel("切换到" + sole.currency)
        } else {
            Text(currency ?? "币种").font(.caption.weight(.medium)).foregroundStyle(NativePalette.muted)
                .frame(minWidth: 44, minHeight: 44)
                .accessibilityLabel("币种" + (currency ?? "尚未读取"))
        }
    }

    private var currencyChoices: some View {
        Menu {
            ForEach(currencies) { item in
                Button { preferredCurrency = item.currency } label: {
                    Label(item.currency, systemImage: currency == item.currency ? "checkmark" : "banknote")
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(currency ?? "币种").font(.caption.weight(.medium))
                Image(systemName: "chevron.down").font(.caption2)
            }.frame(minWidth: 48, minHeight: 44).contentShape(Rectangle())
        }
        .disabled(currencies.isEmpty)
        .foregroundStyle(NativePalette.muted)
        .buttonStyle(NativePressStyle())
        .accessibilityLabel("选择币种，当前" + (currency ?? "尚未读取"))
    }

    @ViewBuilder private var cardContent: some View {
        if isInitialLoading {
            ProgressView("正在读取账本…").font(.callout).tint(NativePalette.accent)
                .frame(maxWidth: .infinity, minHeight: 90, alignment: .leading)
        } else if !ready {
            unavailable
        } else if let finance, finance.accountCount == 0, currencies.isEmpty {
            emptyLedger
        } else if let values {
            moneyContent(values)
            if let finance { balanceAge(finance); checkRow(finance) }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("暂无" + (currency ?? "当前币种") + "金额").font(.callout).foregroundStyle(NativePalette.muted)
                ledgerLink(title: "查看账本")
            }
        }
    }

    private func moneyContent(_ values: NativeOverviewCurrency) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            netLink(values)
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 14) { assetValue(values); liabilityValue(values) }
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: minimumColumnWidth), spacing: 12, alignment: .leading)], alignment: .leading, spacing: 12) {
                    assetValue(values)
                    liabilityValue(values)
                }
            }
        }
    }

    private func netLink(_ values: NativeOverviewCurrency) -> some View {
        Group {
            if let session = model.session {
                NavigationLink {
                    NativeFinanceRoot(api: model.api, token: session.accessToken, userID: session.user.id, initialPath: destination(), embedded: true)
                } label: { netValue(values) }
                .buttonStyle(NativePressStyle())
                .accessibilityHint("查看" + ledgerName + "，" + values.currency)
            } else { netValue(values) }
        }
    }

    private func netValue(_ values: NativeOverviewCurrency) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("净资产").font(.caption).foregroundStyle(NativePalette.muted)
                Image(systemName: "arrow.up.right").font(.caption2).foregroundStyle(NativePalette.muted)
            }
            moneyText(values.netFormatted, currency: values.currency, title: "净资产", prominent: true)
        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }

    private func assetValue(_ values: NativeOverviewCurrency) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("资产").font(.caption).foregroundStyle(NativePalette.muted)
            moneyText(values.assetsFormatted, currency: values.currency, title: "资产")
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func liabilityValue(_ values: NativeOverviewCurrency) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("负债").font(.caption).foregroundStyle(NativePalette.muted)
            moneyText(values.liabilitiesFormatted, currency: values.currency, title: "负债")
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func moneyText(_ formatted: String, currency: String, title: String, prominent: Bool = false) -> some View {
        let shown = NativeHomeFinanceCardRules.amountText(formatted, currency: currency, hidden: moneyHidden)
        return Text(shown)
            .font(prominent ? .largeTitle.weight(.semibold) : .body.weight(.medium))
            .monospacedDigit()
            .foregroundStyle(NativePalette.ink)
            .fixedSize(horizontal: false, vertical: true)
            .privacySensitive()
            .accessibilityLabel(title + "，" + (moneyHidden ? "金额已隐藏" : currency + " " + shown))
    }

    private func balanceAge(_ finance: NativeOverviewFinance) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let caption = NativeHomeFinanceCardRules.balanceDateCaption(finance) { Text(caption) }
            if finance.staleAccountCount > 0 {
                Text((finance.currencies.count > 1 ? "全账本" : "") + "\(finance.staleAccountCount)个余额超过30天")
            }
        }.font(.caption).foregroundStyle(NativePalette.muted)
    }

    private func checkRow(_ finance: NativeOverviewFinance) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().overlay(NativePalette.muted.opacity(0.15))
            if let session = model.session {
                NavigationLink {
                    NativeFinanceRoot(api: model.api, token: session.accessToken, userID: session.user.id, initialPath: destination(balances: true), embedded: true)
                } label: { checkLabel(finance) }
                    .buttonStyle(NativePressStyle())
            } else { checkLabel(finance) }
        }
    }

    private func checkLabel(_ finance: NativeOverviewFinance) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    Text("本月余额核对").font(.caption)
                    Spacer(minLength: 8)
                    checkCount(finance)
                    Image(systemName: "chevron.right").font(.caption2)
                }
                VStack(alignment: .leading, spacing: 4) { Text("本月余额核对").font(.caption); checkCount(finance) }
            }
            if let progress = NativeHomeFinanceCardRules.checkProgress(finance) {
                ProgressView(value: Double(progress.checked), total: Double(progress.total))
                    .tint(NativePalette.accent)
                    .accessibilityLabel("本月余额核对")
                    .accessibilityValue("已核对\(progress.checked)个，共\(progress.total)个账户")
            }
        }
        .foregroundStyle(NativePalette.muted)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder private func checkCount(_ finance: NativeOverviewFinance) -> some View {
        if let progress = NativeHomeFinanceCardRules.checkProgress(finance) {
            Text("\(progress.checked)/\(progress.total)").font(.caption.monospacedDigit())
        } else if finance.uncheckedAccountCount >= 0 {
            Text("全部币种 · \(finance.uncheckedAccountCount)个待核对").font(.caption)
        } else { Text("进入核对").font(.caption) }
    }

    private var unavailable: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("暂时无法读取账本", systemImage: "exclamationmark.circle")
                .font(.callout).foregroundStyle(NativePalette.muted)
            Button("重试") { Task { await model.reloadOverview(presentError: false) } }
                .font(.callout.weight(.medium)).foregroundStyle(NativePalette.accent)
                .frame(minHeight: 44).buttonStyle(NativePressStyle())
                .disabled(model.overviewLoading || model.session == nil)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var emptyLedger: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("还没有账户").font(.callout).foregroundStyle(NativePalette.muted)
            ledgerLink(title: "建立" + ledgerName)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func ledgerLink(title: String) -> some View {
        if let session = model.session {
            NavigationLink {
                NativeFinanceRoot(api: model.api, token: session.accessToken, userID: session.user.id, initialPath: destination(), embedded: true)
            } label: { Label(title, systemImage: "arrow.up.right").font(.callout.weight(.medium)).foregroundStyle(NativePalette.accent).frame(minHeight: 44) }
                .buttonStyle(NativePressStyle())
        }
    }

    private var updatingLabel: some View {
        HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("正在更新").font(.caption) }
            .foregroundStyle(NativePalette.muted)
    }

    private var refreshFailure: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("更新失败，当前为上次读取结果").font(.caption).foregroundStyle(NativePalette.muted)
            Spacer(minLength: 0)
            Button("重试") { Task { await model.reloadOverview(presentError: false) } }
                .font(.caption.weight(.medium)).foregroundStyle(NativePalette.accent)
                .frame(minHeight: 44).buttonStyle(NativePressStyle())
        }
    }

    private func initializeSelection() {
        if preferredLedger == nil, !availableLedgers.isEmpty {
            preferredLedger = NativeHomeFinanceCardRules.ledger(preferred: nil, values: model.overview?.finance)
        }
        if preferredCurrency == nil, !currencies.isEmpty {
            preferredCurrency = NativeHomeFinanceCardRules.currency(preferred: nil, values: currencies)
        }
    }

    private func destination(balances: Bool = false) -> String {
        var parts = URLComponents()
        parts.path = balances ? "/finance/balances" : "/finance"
        var query = [URLQueryItem(name: "ledger", value: ledger)]
        if ledger == "family" { query.append(URLQueryItem(name: "book", value: "own")) }
        if let currency { query.append(URLQueryItem(name: "currency", value: currency)) }
        parts.queryItems = query
        return parts.string ?? "/finance"
    }
}
