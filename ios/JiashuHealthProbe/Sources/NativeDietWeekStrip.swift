import SwiftUI

/// A week belonging to the selected Shanghai calendar day. The parent keeps
/// the full-date/calendar control for navigating beyond this week.
struct NativeDietWeekStrip: View {
    @Binding var date: Date
    let now: Date
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .subheadline) private var minimumCellWidth: CGFloat = 44
    @ScaledMetric(relativeTo: .subheadline) private var textHeight: CGFloat = 30

    private var calendar: Calendar { NativeActionDates.calendar }
    private var selectedDay: String { NativeActionDates.day(date) }
    private var currentDay: Date { calendar.startOfDay(for: now) }
    private var weekdays: [String] { ["一", "二", "三", "四", "五", "六", "日"] }
    private var days: [Date] {
        let monday = NativeActionDates.monday(date)
        return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: monday) }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 2) {
                    ForEach(Array(days.enumerated()), id: \.offset) { index, day in
                        dayButton(day, weekday: weekdays[index])
                            .containerRelativeFrame(.horizontal) { width, _ in
                                max(minimumCellWidth, (width - 12) / 7)
                            }
                            .id(NativeActionDates.day(day))
                    }
                }
            }
            .scrollIndicators(.hidden)
            .frame(height: max(52, textHeight + 18))
            .task(id: [selectedDay, String(describing: typeSize)]) {
                // The selected day stays reachable when large text requires
                // horizontal scrolling. No animated scroll is introduced.
                await Task.yield()
                guard !Task.isCancelled else { return }
                proxy.scrollTo(selectedDay, anchor: .center)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("选择饮食日期")
    }

    private func dayButton(_ day: Date, weekday: String) -> some View {
        let key = NativeActionDates.day(day)
        let selected = key == selectedDay
        let future = calendar.startOfDay(for: day) > currentDay
        let fullDate = NativeActionDates.formatted(day, pattern: "yyyy年M月d日") + "，星期" + weekday
        return Button {
            guard !future, !selected else { return }
            date = calendar.startOfDay(for: day)
        } label: {
            VStack(spacing: 3) {
                Text(weekday).font(.caption2)
                Text(String(calendar.component(.day, from: day)))
                    .font(.subheadline.weight(selected ? .semibold : .regular)).monospacedDigit()
            }
            .foregroundStyle(selected ? NativePalette.onAccent : NativePalette.ink)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .nativeGeometricCard(fill: selected ? NativePalette.accent : .clear,
                                 corner: 15, compactCorner: 6, compactAt: .bottomTrailing)
            .contentShape(Rectangle())
        }
        .buttonStyle(NativePressStyle())
        .disabled(future)
        .accessibilityLabel(fullDate)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("diet-day-" + key)
    }
}
