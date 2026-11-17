import SwiftUI

struct NativeHomeWorkspaceCards: View {
    @ObservedObject var model: NativeAppModel
    @State private var unread: Int?
    @State private var notificationError: String?
    var body: some View {
        if let session = model.session {
            VStack(alignment: .leading, spacing: 20) {
                NavigationLink {
                    NativeNotificationsView(api: model.api, token: session.accessToken, userID: session.user.id)
                } label: {
                    HStack {
                        Label("消息与提醒", systemImage: "bell")
                        Spacer()
                        if let unread, unread > 0 { Text(String(unread)).font(.caption.bold()).padding(7).background(.indigo.opacity(0.15), in: Capsule()) }
                        Image(systemName: "chevron.right").font(.caption)
                    }.padding(16).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                }.buttonStyle(.plain)
                if let error = notificationError { Text(error).font(.footnote).foregroundStyle(.secondary) }
                if let overview = model.overview, !overview.priorities.isEmpty {
                    VStack(alignment: .leading, spacing: 15) {
                        Text("今天值得留意").font(.title3.bold())
                        ForEach(overview.priorities) { priority in
                            if priority.id == "health-setup" {
                                Button { Task { await model.connectHealth() } } label: { NativeHomePriorityLabel(priority: priority) }
                                    .buttonStyle(.plain).disabled(model.syncing || model.authorizingHealth || model.configuringChannel)
                            } else {
                                NavigationLink {
                                    NativeWorkspaceDestinationView(api: model.api, token: session.accessToken, userID: session.user.id, href: priority.href)
                                } label: { NativeHomePriorityLabel(priority: priority) }.buttonStyle(.plain)
                            }
                        }
                    }.padding(18).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                }
                VStack(alignment: .leading, spacing: 15) {
                    Text("财务近况").font(.title3.bold())
                    ForEach(["personal", "family"], id: \.self) { ledger in
                        NavigationLink {
                            NativeFinanceRoot(api: model.api, token: session.accessToken, userID: session.user.id,
                                              initialPath: "/finance?ledger=" + ledger, embedded: true)
                        } label: {
                            VStack(alignment: .leading, spacing: 7) {
                                HStack { Text(ledger == "family" ? "家庭账本" : "个人账本").font(.headline); Spacer(); Image(systemName: "chevron.right").font(.caption) }
                                if let finance = model.overview?.finance?[ledger], finance.status == "ready" {
                                    if finance.currencies.isEmpty { Text("暂无账户余额").foregroundStyle(.secondary) }
                                    ForEach(finance.currencies) { value in
                                        HStack { Text(value.currency); Spacer(); Text(value.netFormatted).monospacedDigit().fontWeight(.semibold) }
                                    }
                                    Text("\(finance.accountCount) 个账户 · \(finance.uncheckedAccountCount) 个本月待核对 · \(finance.staleAccountCount) 个余额待更新")
                                        .font(.caption).foregroundStyle(.secondary)
                                } else { Text("暂未取得该账本近况，点击读取最新记录。").font(.subheadline).foregroundStyle(.secondary) }
                            }.padding(.vertical, 5)
                        }.buttonStyle(.plain)
                    }
                }.padding(18).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                if let nutrition = model.overview?.nutrition {
                    NavigationLink { NativeNutritionRoot(api: model.api, token: session.accessToken, userID: session.user.id) } label: {
                        VStack(alignment: .leading, spacing: 9) {
                            HStack { Label("今天的饮食", systemImage: "fork.knife").font(.headline); Spacer(); Image(systemName: "chevron.right").font(.caption) }
                            if nutrition["status"].stringValue == "ready" {
                                Text("\(nutrition["entryCount"].intValue ?? 0) 条记录 · " + (nutrition["complete"].boolValue == true ? "已确认记录完整" : "尚未确认完整"))
                                let calories = nutrition["nutrients"]["calories"]
                                Text("已知热量 " + (calories["total"].stringValue ?? "未知") + " 千卡；\(calories["unknownCount"].intValue ?? 0) 条热量未知")
                                    .font(.caption).foregroundStyle(.secondary)
                            } else { Text("暂未取得饮食小计，点击读取最新记录。").foregroundStyle(.secondary) }
                        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                    }.buttonStyle(.plain)
                }
                NavigationLink { NativeLifeRoot(api: model.api, token: session.accessToken, userID: session.user.id) } label: {
                    HStack { Label("书影音收藏", systemImage: "books.vertical"); Spacer(); Image(systemName: "chevron.right").font(.caption) }
                        .padding(18).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                }.buttonStyle(.plain)
            }
            .task(id: model.overview?.asOf) { await loadUnread(token: session.accessToken, owner: session.user.id) }
        }
    }
    @MainActor private func loadUnread(token: String, owner: String) async {
        do {
            let value = try await model.api.json(path: "notifications?summary=1", token: token)
            guard !Task.isCancelled, model.session?.user.id == owner, model.session?.accessToken == token else { return }
            unread = value["unreadCount"].intValue; notificationError = value["unavailable"].arrayValue.isEmpty ? nil : "部分提醒暂不可用，可进入消息中心重试。"
        } catch {
            guard !Task.isCancelled, model.session?.user.id == owner, model.session?.accessToken == token else { return }
            notificationError = "消息摘要暂未读取，可进入消息中心重试。"
        }
    }
}

private struct NativeHomePriorityLabel: View {
    let priority: NativePriority
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: priority.tone == "attention" ? "exclamationmark.circle" : "arrow.up.right.circle")
                .foregroundStyle(priority.tone == "attention" ? Color.orange : Color.indigo)
            VStack(alignment: .leading, spacing: 5) {
                Text(priority.title).font(.headline)
                Text(priority.detail.replacingOccurrences(of: "运行对应快捷指令更新。", with: "可同步苹果健康，并核对各指标的最新记录。"))
                    .font(.subheadline).foregroundStyle(.secondary)
                Text(priority.actionLabel).font(.caption.weight(.semibold)).foregroundStyle(.indigo)
            }
            Spacer(); Image(systemName: "chevron.right").font(.caption)
        }
    }
}
