import SwiftUI

@main
@MainActor
struct JiashuHealthProbeApp: App {
    @StateObject private var model = ProbeViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .environment(\.locale, Locale(identifier: "zh_CN"))
                .environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
        }
    }
}
