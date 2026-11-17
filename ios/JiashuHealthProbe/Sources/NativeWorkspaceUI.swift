import SwiftUI

struct NativeFeatureFeedback: View {
    let busy: Bool
    let error: String?
    var body: some View {
        if busy { Section { ProgressView("正在处理…") } }
        if let error { Section { NativeInlineNotice(error, tone: .error) } }
    }
}

struct NativeInlineNotice: View {
    enum Tone: Equatable { case neutral, attention, error }
    let message: String
    var tone: Tone = .neutral
    init(_ message: String, tone: Tone = .neutral) { self.message = message; self.tone = tone }
    private var symbol: String { tone == .error ? "exclamationmark.circle" : tone == .attention ? "exclamationmark.triangle" : "info.circle" }
    private var color: Color { tone == .error ? .red : tone == .attention ? .orange : .secondary }
    var body: some View {
        Label(message, systemImage: symbol).font(.subheadline).foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            .accessibilityElement(children: .combine)
    }
}

struct NativeFeatureEmpty: View {
    let title: String
    let detail: String
    var icon = "tray"
    var body: some View {
        ContentUnavailableView(title, systemImage: icon, description: Text(detail))
            .frame(maxWidth: .infinity)
    }
}

struct NativeLabeledField: View {
    let label: String
    @Binding var value: String
    var placeholder = ""
    var body: some View {
        LabeledContent(label) {
            TextField(placeholder.isEmpty ? label : placeholder, text: $value)
                .multilineTextAlignment(.trailing)
        }
    }
}

struct NativeOptionalValue: View {
    let label: String
    let value: String?
    var body: some View { LabeledContent(label, value: value ?? "未知") }
}
