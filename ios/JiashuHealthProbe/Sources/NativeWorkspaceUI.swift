import SwiftUI

struct NativeFeatureFeedback: View {
    let busy: Bool
    let error: String?
    var body: some View {
        if busy { Section { ProgressView("正在处理…") } }
        if let error { Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red).textSelection(.enabled) } }
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
