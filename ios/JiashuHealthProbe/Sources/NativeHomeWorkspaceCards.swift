import SwiftUI

struct NativeHomeInboxButton: View {
    @ObservedObject var model: NativeAppModel
    @State private var unread = 0
    var body: some View {
        if let session = model.session {
            NavigationLink { NativeNotificationsView(api: model.api, token: session.accessToken, userID: session.user.id) } label: {
                Image(systemName: "bell").frame(width: 44, height: 44)
                    .overlay(alignment: .topTrailing) {
                        if unread > 0 {
                            Text(unread > 99 ? "99+" : String(unread)).font(.caption2.bold())
                                .padding(.horizontal, 5).padding(.vertical, 2)
                                .foregroundStyle(NativePalette.onAccent).background(NativePalette.accent, in: Capsule())
                        }
                    }
            }.accessibilityLabel(unread > 0 ? "消息，\(unread)条未读" : "消息")
                .task(id: model.overview?.asOf) {
                    let owner = session.user.id
                    do {
                        let value = try await model.api.json(path: "notifications?summary=1", token: session.accessToken)
                        guard !Task.isCancelled, model.session?.user.id == owner else { return }
                        unread = value["unreadCount"].intValue ?? 0
                    } catch { /* The inbox itself offers retry; background badge failure stays quiet. */ }
                }
        }
    }
}

enum NativeHomeRouting {
    static func priorities(_ values: [NativePriority]) -> [NativePriority] {
        Array(values.filter { NativeWorkspaceLink($0.href) != NativeWorkspaceLink.sync }.prefix(2))
    }
}

struct NativeHomeWorkspaceCards: View {
    @ObservedObject var model: NativeAppModel
    var body: some View {
        if model.session != nil {
            VStack(alignment: .leading, spacing: 18) {
                NativeHomeNutritionCard(model: model)
                NativeHomeFinanceCard(model: model)
                NativeHomeLifeCard(model: model)
            }
        }
    }
}
