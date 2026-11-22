import SwiftUI
import UIKit

/// Shared colors for the living overview and native workspaces. Every surface
/// remains opaque, and follows the system appearance without forcing a scheme.
enum NativePalette {
    static let canvas = adaptive(0xEEF1FB, 0x171C30)
    static let surface = adaptive(0xFCFDFF, 0x272F48)
    static let ink = adaptive(0x2C3558, 0xEDF0FF)
    static let muted = adaptive(0x5A627F, 0xBDC5DF)
    static let accent = adaptive(0x5660BA, 0xBCC1FF)
    static let onAccent = adaptive(0xFFFEFD, 0x252B58)
    static let soft = adaptive(0xDDE1F7, 0x343E68)
    static let peach = adaptive(0xF6DECE, 0x614C42)

    static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 0xFF) / 255,
                           green: CGFloat((value >> 8) & 0xFF) / 255,
                           blue: CGFloat(value & 0xFF) / 255,
                           alpha: 1)
        })
    }
}

enum NativeCardCorner: Equatable, Sendable {
    case topLeading, topTrailing, bottomLeading, bottomTrailing
}

private struct NativeGeometricCard: ViewModifier {
    let fill: Color
    let corner: CGFloat
    let compactCorner: CGFloat
    let compactAt: NativeCardCorner

    private var shape: UnevenRoundedRectangle {
        let large = max(0, corner)
        let compact = min(large, max(0, compactCorner))
        return UnevenRoundedRectangle(
            topLeadingRadius: compactAt == .topLeading ? compact : large,
            bottomLeadingRadius: compactAt == .bottomLeading ? compact : large,
            bottomTrailingRadius: compactAt == .bottomTrailing ? compact : large,
            topTrailingRadius: compactAt == .topTrailing ? compact : large,
            style: .continuous
        )
    }

    func body(content: Content) -> some View {
        // No clipping, padding or hit-testing changes: the caller retains its
        // layout, native row actions, focus rings and accessible touch target.
        content.background(fill, in: shape)
    }
}

private struct NativeGeometricPage: ViewModifier {
    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .background { NativePalette.canvas.ignoresSafeArea() }
            .tint(NativePalette.accent)
    }
}

extension View {
    func nativeGeometricCard(fill: Color = NativePalette.surface,
                             corner: CGFloat = 28,
                             compactCorner: CGFloat = 10,
                             compactAt: NativeCardCorner = .topTrailing) -> some View {
        modifier(NativeGeometricCard(fill: fill, corner: corner,
                                     compactCorner: compactCorner, compactAt: compactAt))
    }

    /// Place on the List, Form or ScrollView. Native rows, buttons, keyboard
    /// behavior and destructive-action colors are deliberately left intact.
    func nativeGeometricPage() -> some View {
        modifier(NativeGeometricPage())
    }
}

/// Apply only to custom overview cards and actions; native form controls keep
/// their standard styles. Reduced Motion retains immediate, nonmoving feedback.
struct NativePressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(isEnabled && configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .opacity(isEnabled ? (configuration.isPressed ? 0.88 : 1) : 0.48)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: configuration.isPressed)
    }
}
