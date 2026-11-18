import Foundation
import SwiftUI

struct NativeDietEnergyOverview: View {
    let nutrients: NativeJSON
    let targets: NativeJSON?
    private static let decimalLocale = Locale(identifier: "en_US_POSIX")

    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.locale) private var locale
    @ScaledMetric(relativeTo: .largeTitle) private var intakeSize: CGFloat = 35
    @ScaledMetric(relativeTo: .title2) private var differenceSize: CGFloat = 24
    @ScaledMetric(relativeTo: .body) private var cardHeight: CGFloat = 114

    var body: some View {
        let energy = nutrient("calories", title: "能量", unit: "千卡")
        let macros = [nutrient("carbs", title: "碳水", unit: "克"),
                      nutrient("protein", title: "蛋白质", unit: "克"),
                      nutrient("fat", title: "脂肪", unit: "克")]

        VStack(alignment: .leading, spacing: 9) {
            if let comparison = comparison(for: energy) {
                if typeSize.isAccessibilitySize {
                    VStack(spacing: 8) {
                        intakeCard(energy)
                        comparisonCard(comparison)
                    }
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) {
                            intakeCard(energy)
                            comparisonCard(comparison).frame(idealWidth: 116, maxWidth: 132)
                        }
                        VStack(spacing: 8) {
                            intakeCard(energy)
                            comparisonCard(comparison)
                        }
                    }
                }
            } else {
                intakeCard(energy)
            }

            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
                : AnyLayout(HStackLayout(alignment: .top, spacing: 10))
            layout {
                ForEach(macros) { macro in macroCell(macro) }
            }
            .padding(12)
            .nativeGeometricCard(fill: NativePalette.surface, corner: 20, compactCorner: 10, compactAt: .topLeading)

            if energy.isPartial || macros.contains(where: \.isPartial) {
                Text("≥ 为已知小计").font(.caption).foregroundStyle(NativePalette.muted)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("饮食营养")
    }

    private func nutrient(_ key: String, title: String, unit: String) -> NativeHomeNutrient {
        let value = nutrients[key]
        return NativeHomeNutrient(title, unit: unit, total: value["total"].stringValue,
                                  knownCount: value["knownCount"].intValue ?? 0,
                                  unknownCount: value["unknownCount"].intValue ?? 0,
                                  target: targets?[key].stringValue)
    }

    private func intakeCard(_ energy: NativeHomeNutrient) -> some View {
        let amount = (energy.isPartial ? "≥" : "") + display(energy.current)
        return VStack(alignment: .leading, spacing: 6) {
            Text("已摄入").font(.subheadline.weight(.medium))
            amountLine(amount, unit: "千卡", size: intakeSize)
            if let target = energy.target {
                Text("目标 \(display(target)) 千卡").font(.caption)
            }
            if let fraction = energy.fraction {
                progressTrack(fraction, fill: NativePalette.onAccent, track: NativePalette.onAccent.opacity(0.26))
                    .padding(.top, 2)
            }
        }
        .foregroundStyle(NativePalette.onAccent)
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: typeSize.isAccessibilitySize ? nil : cardHeight, alignment: .leading)
        .nativeGeometricCard(fill: NativePalette.accent, corner: 22, compactCorner: 7, compactAt: .bottomTrailing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("已摄入能量")
        .accessibilityValue(energy.accessibilityValue)
    }

    private struct Comparison {
        let label: String
        let amount: Decimal?
        var explanation: String? = nil
    }

    private func comparison(for energy: NativeHomeNutrient) -> Comparison? {
        guard let target = energy.target, let goal = Decimal(string: target, locale: Self.decimalLocale) else { return nil }
        guard let current = energy.current,
              let intake = Decimal(string: current, locale: Self.decimalLocale) else {
            return Comparison(label: "暂无法比较", amount: nil, explanation: "暂无摄入数值")
        }
        guard nutrients["calories"]["unknownCount"].intValue == 0 else {
            return Comparison(label: "暂无法比较", amount: nil, explanation: "部分摄入未知")
        }
        if intake < goal { return Comparison(label: "距目标", amount: goal - intake) }
        if intake > goal { return Comparison(label: "超出目标", amount: intake - goal) }
        return Comparison(label: "已达目标", amount: nil)
    }

    private func comparisonCard(_ comparison: Comparison) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(comparison.label).font(.subheadline.weight(comparison.amount == nil ? .semibold : .medium))
            if let amount = comparison.amount {
                amountLine(display(amount), unit: "千卡", size: differenceSize)
            }
            if let explanation = comparison.explanation { Text(explanation).font(.caption) }
        }
        .foregroundStyle(NativePalette.ink)
        .padding(.horizontal, 12).padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: typeSize.isAccessibilitySize ? nil : cardHeight, alignment: .leading)
        .nativeGeometricCard(fill: NativePalette.peach, corner: 22, compactCorner: 7, compactAt: .topLeading)
        .accessibilityElement(children: .combine)
    }

    private func amountLine(_ amount: String, unit: String, size: CGFloat) -> some View {
        let value = Text(amount).font(.system(size: size, weight: .semibold, design: .rounded)).monospacedDigit()
        let units = Text(unit).font(.caption)
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 4) { value; units }
            VStack(alignment: .leading, spacing: 1) { value; units }
        }
    }

    private func macroCell(_ macro: NativeHomeNutrient) -> some View {
        let value = (macro.isPartial ? "≥" : "") + display(macro.current)
        let goal = macro.target.map { " / " + display($0) } ?? ""
        return VStack(alignment: .leading, spacing: 5) {
            Text(macro.title).font(.caption).foregroundStyle(NativePalette.muted)
            Text(value + goal + " 克").font(.subheadline.weight(.semibold)).monospacedDigit()
                .foregroundStyle(NativePalette.ink).fixedSize(horizontal: false, vertical: true)
            if let fraction = macro.fraction {
                progressTrack(fraction, fill: NativePalette.accent, track: NativePalette.soft)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(macro.title)
        .accessibilityValue(macro.accessibilityValue)
    }

    private func progressTrack(_ fraction: Double, fill: Color, track: Color) -> some View {
        GeometryReader { geometry in
            Capsule().fill(track).overlay(alignment: .leading) {
                Capsule().fill(fill).frame(width: geometry.size.width * CGFloat(fraction))
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }

    private func display(_ value: String?) -> String {
        guard let value else { return "—" }
        guard let amount = Decimal(string: value, locale: Self.decimalLocale) else { return value }
        return display(amount)
    }

    private func display(_ value: Decimal) -> String {
        value.formatted(.number.locale(locale).precision(.fractionLength(0...1)))
    }
}
