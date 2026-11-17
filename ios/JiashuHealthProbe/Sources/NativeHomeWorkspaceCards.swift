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
                                .foregroundStyle(.white).background(.indigo, in: Capsule())
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
        if let session = model.session {
            VStack(alignment: .leading, spacing: 24) {
                if let overview = model.overview {
                    let priorities = NativeHomeRouting.priorities(overview.priorities)
                    if !priorities.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("值得留意").font(.headline)
                            ForEach(priorities) { priority in
                                NavigationLink {
                                    NativeWorkspaceDestinationView(api: model.api, token: session.accessToken, userID: session.user.id, href: priority.href)
                                } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: priority.tone == "attention" ? "exclamationmark.circle" : "arrow.up.right.circle").foregroundStyle(.indigo)
                                        Text(priority.title).font(.subheadline)
                                        Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                                    }.padding(16).contentShape(Rectangle())
                                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                    if let nutrition = overview.nutrition {
                        NavigationLink { NativeNutritionRoot(api: model.api, token: session.accessToken, userID: session.user.id) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "fork.knife").foregroundStyle(.indigo)
                                Text("今天的饮食").font(.subheadline)
                                Spacer()
                                if nutrition["status"].stringValue == "ready" {
                                    Text("\(nutrition["entryCount"].intValue ?? 0)条 · " + (nutrition["complete"].boolValue == true ? "已记完" : "记录中"))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                            }.padding(16).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                        }.buttonStyle(.plain)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        Text("财务").font(.headline)
                        ForEach(["personal", "family"], id: \.self) { ledger in
                            NavigationLink {
                                NativeFinanceRoot(api: model.api, token: session.accessToken, userID: session.user.id,
                                                  initialPath: "/finance?ledger=" + ledger, embedded: true)
                            } label: {
                                HStack {
                                    Text(ledger == "family" ? "家庭账本" : "个人账本").font(.subheadline)
                                    Spacer()
                                    if let finance = overview.finance?[ledger], finance.status == "ready" {
                                        Text(finance.uncheckedAccountCount > 0 ? "\(finance.uncheckedAccountCount)个账户待核对" : "\(finance.accountCount)个账户")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                                }.padding(16).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }
}
