import SwiftUI

struct NativeApplicationEntry: Identifiable {
    enum Destination: Equatable {
        case recipes
        case workspace(String)
    }

    let id: String
    let title: String
    let icon: String
    let keywords: String
    let destination: Destination

    fileprivate func matches(_ words: [Substring]) -> Bool {
        let text = title + " " + keywords
        return words.allSatisfy { text.localizedStandardContains(String($0)) }
    }
}

struct NativeApplicationSection: Identifiable {
    let id: String
    let title: String?
    let entries: [NativeApplicationEntry]

    private static let catalog = [
        Self(id: "recipes", title: nil, entries: [
            .init(id: "recipes", title: "我的菜谱", icon: "book.closed", keywords: "收藏 食谱 自制菜 成品照 小红书 下厨房", destination: .recipes),
        ]),
        Self(id: "health-and-diet", title: "健康与饮食", entries: [
            .init(id: "nutrition", title: "饮食", icon: "fork.knife", keywords: "记一餐 饮食记录 营养 食物库", destination: .workspace("/health/nutrition")),
            .init(id: "weekly-review", title: "每周复盘", icon: "calendar", keywords: "回顾 本周行动", destination: .workspace("/health/review")),
            .init(id: "apple-activity", title: "心率、血氧与训练", icon: "heart.text.square", keywords: "静息心率 健身 体能训练", destination: .workspace("/health/apple-activity")),
            .init(id: "health-records", title: "健康记录", icon: "list.bullet.clipboard", keywords: "记录管理 补录 体重 步数 睡眠 活动", destination: .workspace("/health/records")),
            .init(id: "health-goals", title: "健康目标", icon: "target", keywords: "达成 生效历史", destination: .workspace("/health/goals")),
            .init(id: "weight-plan", title: "体重计划", icon: "scalemass", keywords: "体重周期", destination: .workspace("/health/weight-plan")),
            .init(id: "health-assistant", title: "健康助手", icon: "sparkles", keywords: "AI 问答", destination: .workspace("/health/assistant")),
        ]),
        Self(id: "finance", title: "财务", entries: [
            .init(id: "family-ledger", title: "家庭与账本", icon: "person.2", keywords: "家庭账本 财务 协作 邀请 成员", destination: .workspace("/finance?ledger=family")),
        ]),
        Self(id: "settings-and-data", title: "设置与数据", entries: [
            .init(id: "sync-center", title: "同步中心", icon: "arrow.triangle.2.circlepath", keywords: "Apple Health 苹果健康 设备 授权 快捷指令 豆瓣 同步诊断", destination: .workspace("/sync")),
            .init(id: "account-services", title: "账号与服务", icon: "gearshape", keywords: "账户 帐号 设置 管理 密钥 名单", destination: .workspace("/account")),
            .init(id: "notifications", title: "消息与提醒", icon: "bell", keywords: "站内消息 通知 未读", destination: .workspace("/notifications")),
            .init(id: "backup", title: "备份与恢复", icon: "externaldrive", keywords: "导出 导入 数据", destination: .workspace("/data")),
        ]),
    ]

    static func matching(_ query: String) -> [Self] {
        let words = query.split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return catalog }
        return catalog.compactMap { section in
            let entries = section.entries.filter { $0.matches(words) }
            guard !entries.isEmpty else { return nil }
            return Self(id: section.id, title: section.title, entries: entries)
        }
    }
}

@MainActor
struct NativeApplicationDirectory: View {
    @ObservedObject var model: NativeAppModel
    let session: NativeSession
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                let sections = NativeApplicationSection.matching(query)
                if sections.isEmpty {
                    NativeFeatureEmpty(title: "没有找到应用", detail: "试试应用名称或功能关键词。", icon: "magnifyingglass")
                }
                ForEach(sections) { section in
                    if let title = section.title {
                        Section(title) { rows(section.entries) }
                    } else {
                        Section { rows(section.entries) }
                    }
                }
            }
            .nativeGeometricPage()
            .navigationTitle("应用")
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索应用")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        NativeSettingsView(model: model)
                    } label: {
                        Text("我的").frame(minHeight: 44)
                    }
                    .accessibilityIdentifier("application-directory-account")
                }
            }
        }
    }

    @ViewBuilder private func rows(_ entries: [NativeApplicationEntry]) -> some View {
        ForEach(entries) { entry in
            NavigationLink {
                destination(entry.destination)
            } label: {
                Label {
                    Text(entry.title)
                        .fontWeight(entry.destination == .recipes ? .semibold : .regular)
                        .foregroundStyle(NativePalette.ink)
                } icon: {
                    Image(systemName: entry.icon)
                        .foregroundStyle(NativePalette.accent)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 32)
            }
            .listRowBackground(entry.destination == .recipes ? NativePalette.soft : NativePalette.surface)
            .accessibilityIdentifier("application-directory-" + entry.id)
        }
    }

    @ViewBuilder private func destination(_ item: NativeApplicationEntry.Destination) -> some View {
        let userID = session.user.id
        let token = session.accessToken
        switch item {
        case .recipes:
            NativeRecipesRoot(api: model.api, token: token, userID: userID)
        case .workspace(let href):
            NativeWorkspaceDestinationView(api: model.api, token: token, userID: userID, href: href)
        }
    }
}
