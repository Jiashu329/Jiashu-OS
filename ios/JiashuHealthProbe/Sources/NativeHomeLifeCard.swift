import SwiftUI

/// A bounded recent list, never a monthly aggregate. The collection API sorts
/// known marking dates first and leaves undated records explicitly undated.
@MainActor
final class NativeHomeLifeModel: ObservableObject {
    @Published private(set) var ownerID: String?
    @Published private(set) var items: [NativeLifeItem] = []
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    private var generation = UUID()

    func load(api: NativeAPI, session: NativeSession) async {
        let owner = session.user.id, request = UUID()
        generation = request
        if ownerID != owner { items = []; error = nil }
        ownerID = owner; loading = true
        do {
            let value = try await api.json(path: "life/douban?kind=all&sort=date-desc&hidden=visible&limit=3", token: session.accessToken)
            guard generation == request, ownerID == owner, !Task.isCancelled else { return }
            guard case .array(let records) = value["items"], records.count <= 3 else { throw NativeAPIError.invalidResponse }
            let recent = records.map { NativeLifeItem(raw: $0) }
            guard recent.allSatisfy({ !$0.profile.isEmpty && !$0.subjectID.isEmpty && $0.raw["title"].stringValue?.isEmpty == false && ["screen", "book", "music"].contains($0.domain) && $0.raw["local"]["hidden"].boolValue != true }),
                  Set(recent.map(\.id)).count == recent.count else { throw NativeAPIError.invalidResponse }
            items = recent; error = nil; loading = false
        } catch {
            guard generation == request, ownerID == owner, !Task.isCancelled else { return }
            self.error = error.localizedDescription; loading = false
        }
    }
    func invalidate(clear: Bool = false) {
        generation = UUID(); loading = false
        if clear { ownerID = nil; items = []; error = nil }
    }
}

struct NativeHomeLifeCard: View {
    @ObservedObject var model: NativeAppModel
    @StateObject private var recent = NativeHomeLifeModel()
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if let session = model.session {
            VStack(alignment: .leading, spacing: 14) {
                NavigationLink {
                    NativeLifeRoot(api: model.api, token: session.accessToken, userID: session.user.id)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("书影音").font(.headline.weight(.semibold)).foregroundStyle(NativePalette.ink)
                        Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(NativePalette.muted)
                        Spacer()
                        Text("最近记录").font(.caption).foregroundStyle(NativePalette.muted)
                    }.frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(NativePressStyle()).accessibilityLabel("书影音，查看收藏")

                if recent.ownerID == session.user.id && !recent.items.isEmpty {
                    if typeSize.isAccessibilitySize {
                        VStack(spacing: 14) {
                            ForEach(recent.items) { item in
                                NavigationLink {
                                    NativeLifeDetailDestination(api: model.api, token: session.accessToken, userID: session.user.id, item: item)
                                } label: {
                                    HStack(alignment: .center, spacing: 14) {
                                        artwork(item, session: session).frame(width: 82, height: 110)
                                        VStack(alignment: .leading, spacing: 7) {
                                            Text(item.title).font(.subheadline.weight(.medium)).foregroundStyle(NativePalette.ink)
                                            Text(item.kindLabel + " · " + markingDate(item)).font(.caption).foregroundStyle(NativePalette.muted)
                                        }.frame(maxWidth: .infinity, alignment: .leading)
                                    }.padding(12).nativeGeometricCard(fill: NativePalette.surface, corner: 22, compactCorner: 8)
                                }.buttonStyle(NativePressStyle())
                            }
                        }
                    } else {
                        HStack(alignment: .top, spacing: 10) {
                            ForEach(recent.items) { item in
                                NavigationLink {
                                    NativeLifeDetailDestination(api: model.api, token: session.accessToken, userID: session.user.id, item: item)
                                } label: {
                                    VStack(alignment: .leading, spacing: 7) {
                                        artwork(item, session: session)
                                            .frame(height: item.domain == "book" ? 110 : item.domain == "music" ? 116 : 122)
                                            .padding(.top, item.domain == "book" ? 12 : item.domain == "music" ? 6 : 0)
                                        Text(item.title).font(.caption.weight(.medium)).foregroundStyle(NativePalette.ink).lineLimit(2)
                                            .frame(minHeight: 30, alignment: .topLeading)
                                        Text(item.kindLabel + " · " + markingDate(item)).font(.caption2).foregroundStyle(NativePalette.muted).lineLimit(2)
                                    }.frame(maxWidth: .infinity, alignment: .topLeading).contentShape(Rectangle())
                                }.buttonStyle(NativePressStyle()).accessibilityElement(children: .combine)
                            }
                        }
                    }
                } else if recent.loading || recent.ownerID != session.user.id {
                    HStack(spacing: 10) {
                        ForEach(0..<3, id: \.self) { index in
                            Color.clear.frame(maxWidth: .infinity).frame(height: 116)
                                .nativeGeometricCard(fill: index == 1 ? NativePalette.peach.opacity(0.45) : NativePalette.soft.opacity(0.6), corner: 18, compactCorner: 6)
                        }
                    }.accessibilityLabel("正在读取最近收藏")
                } else if recent.error != nil {
                    HStack {
                        Text("最近记录暂未读取").font(.subheadline).foregroundStyle(NativePalette.muted)
                        Spacer()
                        Button("重试") { Task { await recent.load(api: model.api, session: session) } }.font(.subheadline).foregroundStyle(NativePalette.accent)
                    }.padding(16).nativeGeometricCard(fill: NativePalette.surface, corner: 22, compactCorner: 8)
                } else {
                    Text("暂无最近记录").font(.subheadline).foregroundStyle(NativePalette.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(18)
                        .nativeGeometricCard(fill: NativePalette.surface, corner: 22, compactCorner: 8)
                }
            }
            .task(id: session.user.id) { await recent.load(api: model.api, session: session) }
            .onChange(of: model.overview?.asOf) { _, _ in
                guard let current = model.session else { recent.invalidate(clear: true); return }
                Task { await recent.load(api: model.api, session: current) }
            }
            .onDisappear { recent.invalidate() }
        }
    }
    private func artwork(_ item: NativeLifeItem, session: NativeSession) -> some View {
        NativeLifeCover(api: model.api, token: session.accessToken, item: item)
            .id(session.user.id + ":" + item.id)
            .clipShape(UnevenRoundedRectangle(topLeadingRadius: item.domain == "book" ? 6 : 18,
                                               bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18))
            .accessibilityHidden(true)
    }
    private func markingDate(_ item: NativeLifeItem) -> String {
        guard let value = item.raw["markedDate"].stringValue, let date = NativeChartDates.parse(value) else { return "日期未知" }
        return NativeActionDates.formatted(date, pattern: "M/d")
    }
}
