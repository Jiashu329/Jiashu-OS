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

struct NativeHomeMealRecovery {
    let date: Date?
    let meal: String?

    init?(_ command: NativeNutritionCommand) {
        let record: NativeJSON
        switch (command.path, command.method) {
        case ("health/nutrition/batch", "POST"):
            record = command.body["entries"].arrayValue.first ?? .null
        case ("health/nutrition/copy", "POST") where command.body["action"].stringValue == "copy":
            record = .object(["date": command.body["toDate"], "meal": command.body["toMeal"]])
        case ("health/nutrition/status", "PATCH"):
            record = command.body
        default:
            let path = command.path.split(separator: "/")
            guard (3...4).contains(path.count), path[0] == "health", path[1] == "nutrition",
                  UUID(uuidString: String(path[2])) != nil,
                  (path.count == 3 && command.method == "PATCH") ||
                      (path.count == 4 && path[3] == "restore" && command.method == "POST") else { return nil }
            record = command.body
        }
        if let day = record["date"].stringValue, let parsed = NativeChartDates.parse(day),
           day == NativeActionDates.day(parsed), day >= "1970-01-01", day <= NativeActionDates.day(Date()) { date = parsed }
        else { date = nil }
        meal = record["meal"].stringValue.flatMap(QuickEntryMeal.init(rawValue:))?.rawValue
    }
}

struct NativeHomeWeeks: Equatable {
    let current: String
    let previous: String

    init(now: Date) {
        let monday = NativeActionDates.monday(now)
        current = NativeActionDates.day(monday)
        previous = NativeActionDates.day(NativeActionDates.calendar.date(byAdding: .day, value: -7, to: monday) ?? monday)
    }

    func hasPreviousEvidence(_ overview: NativeOverview?) -> Bool {
        if let evidence = overview?.weekly {
            return evidence.weekStart == current && evidence.previousWeekStart == previous && evidence.previousHasRecords
        }
        // Older servers expose the previous week only through a bounded list of priorities.
        return overview?.priorities.contains { priority in
            priority.id == "weekly-review" && NativeWorkspaceLink(priority.href) == .review
                && URLComponents(string: priority.href)?.queryItems == [URLQueryItem(name: "week", value: previous)]
        } ?? false
    }
}

@MainActor
struct NativeHomeFollowThrough: View {
    @ObservedObject var model: NativeAppModel

    var body: some View {
        if let session = model.session {
            NativeHomeFollowThroughContent(model: model, session: session).id(session.user.id)
        }
    }
}

@MainActor
private struct NativeHomeFollowThroughContent: View {
    @ObservedObject var model: NativeAppModel
    let session: NativeSession
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var nutrition: NativeNutritionContext
    @StateObject private var finance: NativeFinanceContext
    @State private var authorizedBalance: NativeFinancePending?
    @State private var balanceRecovery: NativeFinancePending?
    @State private var actionRead: ActionRead?

    private struct ActionRead {
        let week: String
        let entry: NativeWeeklyActionEntry?
    }

    private struct RefreshKey<Value: Equatable>: Equatable {
        let value: Value
        let updatedAt: String?
        let token: String
        let active: Bool
    }

    init(model: NativeAppModel, session: NativeSession) {
        self.model = model
        self.session = session
        _nutrition = StateObject(wrappedValue: NativeNutritionContext(api: model.api, token: session.accessToken, userID: session.user.id))
        _finance = StateObject(wrappedValue: NativeFinanceContext(api: model.api, token: session.accessToken, userID: session.user.id))
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let weeks = NativeHomeWeeks(now: context.date)
            VStack(alignment: .leading, spacing: 10) {
                recoveryRows
                weeklyRow(weeks)
            }
            .task(id: refreshKey(weeks.current)) { await loadAction(weeks.current) }
            .onChange(of: weeks.current) { _, _ in Task { await model.reloadOverview(presentError: false) } }
        }
        .task { nutrition.restorePending() }
        .task(id: refreshKey(finance.pending)) { await authorizeBalance(finance.pending) }
        .onChange(of: finance.change) { _, _ in Task { await model.reloadOverview(presentError: false) } }
        .sheet(item: $balanceRecovery) { command in
            NavigationStack {
                NativeFinancePendingRecovery(context: finance, pending: command, requiresCurrentBalanceGrant: true)
            }
        }
    }

    private var eligibleBalance: NativeFinancePending? {
        guard scenePhase == .active, let command = finance.pending, !finance.blocked, !finance.busy,
              let scope = NativeBalanceRecoveryScope(command, owner: session.user.id),
              scope.book == "own" || command == authorizedBalance else { return nil }
        return command
    }

    @ViewBuilder private var recoveryRows: some View {
        let meal = nutrition.busy ? nil : nutrition.pending.flatMap(NativeHomeMealRecovery.init)
        let balance = eligibleBalance
        if meal != nil || balance != nil {
            VStack(alignment: .leading, spacing: 2) {
                Text("保存待确认").font(.headline)
                if let meal {
                    NavigationLink {
                        NativeNutritionRoot(api: model.api, token: session.accessToken, userID: session.user.id,
                                            initialDate: meal.date ?? Date(), initialMeal: meal.meal,
                                            onMutation: { await model.reloadOverview(presentError: false) })
                    } label: {
                        row("继续核对饮食记录", icon: "fork.knife")
                    }.buttonStyle(NativePressStyle())
                }
                if let balance {
                    Button { balanceRecovery = balance } label: {
                        row("继续核对余额", icon: "creditcard")
                    }.buttonStyle(NativePressStyle())
                }
            }
            .foregroundStyle(NativePalette.ink)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .nativeGeometricCard(corner: 18, compactCorner: 7)
        }
    }

    @ViewBuilder private func weeklyRow(_ weeks: NativeHomeWeeks) -> some View {
        if let actionRead, actionRead.week == weeks.current {
            if let action = actionRead.entry {
                NavigationLink {
                    HealthWeeklyReviewView(api: model.api, token: session.accessToken, userID: session.user.id,
                                           initialWeek: weeks.current)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        row("本周行动", icon: "calendar", detail: action.status.title)
                        Text(action.text).font(.subheadline).lineLimit(3)
                    }
                    .padding(.horizontal, 14).padding(.bottom, 10)
                    .nativeGeometricCard(corner: 18, compactCorner: 7)
                }.buttonStyle(NativePressStyle()).foregroundStyle(NativePalette.ink)
            } else if weeks.hasPreviousEvidence(model.overview) {
                NavigationLink {
                    HealthWeeklyReviewView(api: model.api, token: session.accessToken, userID: session.user.id,
                                           initialWeek: weeks.previous, initialActionWeek: weeks.current)
                } label: {
                    row("回顾上周，安排本周行动", icon: "calendar")
                        .padding(.horizontal, 14).nativeGeometricCard(corner: 18, compactCorner: 7)
                }.buttonStyle(NativePressStyle()).foregroundStyle(NativePalette.ink)
            }
        }
    }

    private func row(_ title: String, icon: String, detail: String? = nil) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(NativePalette.accent).accessibilityHidden(true)
            Text(title).frame(maxWidth: .infinity, alignment: .leading)
            if let detail { Text(detail).font(.caption).foregroundStyle(NativePalette.muted) }
            Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                .foregroundStyle(NativePalette.muted).accessibilityHidden(true)
        }
        .font(.subheadline.weight(.medium)).frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }

    private func refreshKey<Value: Equatable>(_ value: Value) -> RefreshKey<Value> {
        .init(value: value, updatedAt: model.overview?.asOf, token: session.accessToken, active: scenePhase == .active)
    }

    private func authorizeBalance(_ command: NativeFinancePending?) async {
        authorizedBalance = nil
        guard scenePhase == .active, let command,
              (try? await finance.canRecoverBalance(command)) == true, !Task.isCancelled,
              scenePhase == .active, model.session?.user.id == session.user.id else { return }
        authorizedBalance = command
    }

    private func loadAction(_ week: String) async {
        guard scenePhase == .active else { return }
        do {
            let entry = try await model.api.weeklyAction(token: session.accessToken, week: week)
            try Task.checkCancellation()
            guard model.session?.user.id == session.user.id, entry == nil || entry?.weekStart == week else { return }
            actionRead = ActionRead(week: week, entry: entry)
        } catch is CancellationError {} catch {
            if !Task.isCancelled && model.session?.user.id == session.user.id { actionRead = nil }
        }
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
