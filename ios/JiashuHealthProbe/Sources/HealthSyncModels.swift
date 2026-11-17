import Foundation

/// The existing server schema name is retained for compatibility; each record's
/// source identifies native merged statistics or the selected HealthKit source.
struct NativeHealthSnapshot: Sendable {
    let capturedAt: Date
    let measurements: [NativeHealthMeasurement]

    func encodePayload() throws -> Data {
        let capturedAt = try NativeHealthCalendar.cutoff(self.capturedAt)
        guard !measurements.isEmpty else { throw NativeHealthError.noReadableData }
        guard measurements.count <= 1_000 else { throw NativeHealthError.tooManyRecords }
        guard StepCalendar.supportedTimestamp(capturedAt) else { throw NativeHealthError.invalidRecord }
        var ids = Set<String>()
        var dailyKeys = Set<String>()
        for measurement in measurements {
            guard ids.insert(measurement.id).inserted else { throw NativeHealthError.invalidRecord }
            try measurement.validate(capturedAt: capturedAt)
            if measurement.aggregation == "daily" {
                let bound = measurement.metric == "sleep" ? measurement.endDate : measurement.startDate
                guard let text = bound, let date = NativeHealthCalendar.parseTimestamp(text),
                      dailyKeys.insert(measurement.metric + ":" + StepCalendar.dayString(for: date)).inserted else {
                    throw NativeHealthError.invalidRecord
                }
            }
        }
        let envelope = NativeHealthEnvelope(exportedAt: NativeHealthCalendar.timestamp(capturedAt), measurements: measurements)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(envelope)
        guard data.count <= 512 * 1_024 else { throw NativeHealthError.tooManyRecords }
        return data
    }
}

private struct NativeHealthEnvelope: Encodable {
    let version = 1
    let source = "apple-health-shortcuts"
    let timezone = "Asia/Shanghai"
    let exportedAt: String
    let measurements: [NativeHealthMeasurement]
}

struct NativeHealthMeasurement: Encodable, Sendable, Equatable, Identifiable {
    let id: String
    let metric: String
    let value: Double
    let unit: String
    let startDate: String
    let endDate: String?
    let source: String
    let aggregation: String
    var sleepStages: NativeHealthSleepStages? = nil
    var sleepTiming: NativeHealthSleepTiming? = nil

    func validate(capturedAt: Date) throws {
        let limits: [String: (String, ClosedRange<Double>)] = [
            "steps": ("count", 0...200_000), "active_energy": ("kcal", 0...20_000),
            "sleep": ("hours", 0...24), "weight": ("kg", 10...600), "lean_body_mass": ("kg", 1...600),
        ]
        guard let definition = limits[metric], unit == definition.0,
              value.isFinite, definition.1.contains(value), metric != "steps" || value.rounded() == value,
              !id.isEmpty, id.utf8.count <= 160,
              id.range(of: "^[A-Za-z0-9][A-Za-z0-9._:@/+\\-]{0,159}$", options: .regularExpression) != nil,
              !source.isEmpty, source.count <= 120,
              !source.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let start = NativeHealthCalendar.parseTimestamp(startDate), start <= capturedAt,
              StepCalendar.supportedTimestamp(start) else { throw NativeHealthError.invalidRecord }
        if metric == "weight" || metric == "lean_body_mass" {
            guard aggregation == "sample", sleepStages == nil, sleepTiming == nil else { throw NativeHealthError.invalidRecord }
            if let endDate {
                guard let end = NativeHealthCalendar.parseTimestamp(endDate), end >= start, end <= capturedAt else {
                    throw NativeHealthError.invalidRecord
                }
            }
            return
        }
        guard aggregation == "daily", let endDate, let end = NativeHealthCalendar.parseTimestamp(endDate),
              end > start, end <= capturedAt, end.timeIntervalSince(start) <= 48 * 3_600 else {
            throw NativeHealthError.invalidRecord
        }
        if metric != "sleep" {
            guard StepCalendar.dayString(for: start) == StepCalendar.dayString(for: end.addingTimeInterval(-0.001)),
                  sleepStages == nil, sleepTiming == nil else { throw NativeHealthError.invalidRecord }
        } else if let stages = sleepStages {
            let duration = end.timeIntervalSince(start) / 3_600
            guard stages.values.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= duration + 1e-8 }),
                  abs(stages.asleep - value) < 1e-8 else { throw NativeHealthError.invalidRecord }
        }
        if let timing = sleepTiming {
            guard metric == "sleep", value > 0,
                  let onset = NativeHealthCalendar.parseTimestamp(timing.onset),
                  let wake = NativeHealthCalendar.parseTimestamp(timing.wake),
                  onset >= start, wake <= end, wake > onset else { throw NativeHealthError.invalidRecord }
        }
    }
}

struct NativeHealthSleepStages: Encodable, Sendable, Equatable {
    var unspecified = 0.0
    var core = 0.0
    var deep = 0.0
    var rem = 0.0
    var awake = 0.0
    var inBed = 0.0
    var asleep: Double { unspecified + core + deep + rem }
    var values: [Double] { [unspecified, core, deep, rem, awake, inBed] }
}

struct NativeHealthSleepTiming: Encodable, Sendable, Equatable {
    let onset: String
    let wake: String
    let clipped: Bool
    let method = "longest-sleep-group-v1"
}

struct NativeHealthWindow: Sendable, Equatable {
    let day: String
    let start: Date
    let end: Date
}

enum NativeHealthCalendar {
    /// Match the millisecond precision of the payload, never moving the query
    /// cutoff into the future or across a midnight that has not arrived yet.
    /// Round-trip through the actual formatter so binary Date precision cannot
    /// leave an exported boundary a fraction later than its validation bound.
    static func cutoff(_ date: Date) throws -> Date {
        guard StepCalendar.supportedTimestamp(date),
              let rounded = parseTimestamp(timestamp(date)) else { throw NativeHealthError.invalidRecord }
        if rounded <= date { return rounded }
        guard let earlier = parseTimestamp(timestamp(rounded.addingTimeInterval(-0.001))),
              earlier <= date, StepCalendar.supportedTimestamp(earlier) else { throw NativeHealthError.invalidRecord }
        return earlier
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func parseTimestamp(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    static func windows(days: Int, capturedAt: Date) throws -> [NativeHealthWindow] {
        guard (1...90).contains(days), StepCalendar.supportedTimestamp(capturedAt) else {
            throw NativeHealthError.invalidRange
        }
        let capturedAt = try cutoff(capturedAt)
        let calendar = StepCalendar.calendar, today = calendar.startOfDay(for: capturedAt)
        guard let first = calendar.date(byAdding: .day, value: -(days - 1), to: today) else {
            throw NativeHealthError.invalidRange
        }
        return try (0..<days).compactMap { index in
            guard let start = calendar.date(byAdding: .day, value: index, to: first),
                  let next = calendar.date(byAdding: .day, value: 1, to: start),
                  StepCalendar.supportedTimestamp(start) else { throw NativeHealthError.invalidRange }
            let end = min(next, capturedAt)
            guard end > start else { return nil }
            return NativeHealthWindow(day: StepCalendar.dayString(for: start), start: start, end: end)
        }
    }

    /// Sleep has its own noon-to-noon report window. Before today's noon only
    /// the elapsed part is reported; it is refreshed on the next sync.
    static func sleepWindow(day: String, capturedAt: Date) throws -> NativeHealthWindow {
        let capturedAt = try cutoff(capturedAt)
        guard let midnight = parseTimestamp(day + "T00:00:00+08:00"),
              StepCalendar.dayString(for: midnight) == day,
              let noon = StepCalendar.calendar.date(bySettingHour: 12, minute: 0, second: 0, of: midnight),
              let start = StepCalendar.calendar.date(byAdding: .day, value: -1, to: noon),
              StepCalendar.supportedTimestamp(start) else { throw NativeHealthError.invalidRange }
        let end = min(noon, capturedAt)
        guard end > start, StepCalendar.dayString(for: end) == day else { throw NativeHealthError.invalidRange }
        return NativeHealthWindow(day: day, start: start, end: end)
    }
}

/// Raw sleep values remain within one selected source. Generic asleep and
/// detailed stages may overlap within that source and are unioned below.
struct NativeHealthSleepSegment: Sendable, Equatable {
    let start: Date
    let end: Date
    let state: Int
    let source: String
    let isWatch: Bool
}

enum NativeHealthSleepAggregation {
    static func measurement(segments: [NativeHealthSleepSegment], window: NativeHealthWindow) throws -> NativeHealthMeasurement? {
        let window = NativeHealthWindow(day: window.day, start: try NativeHealthCalendar.cutoff(window.start),
                                        end: try NativeHealthCalendar.cutoff(window.end))
        guard window.end > window.start, window.end.timeIntervalSince(window.start) <= 25 * 3_600 else {
            throw NativeHealthError.invalidRange
        }
        let relevant = segments.filter { $0.end > window.start && $0.start < window.end }
        guard relevant.allSatisfy({ (0...5).contains($0.state) && $0.end > $0.start }) else {
            throw NativeHealthError.invalidRecord
        }
        let bySource = Dictionary(grouping: relevant, by: \.source)
        let ranked = bySource.compactMap { source, values -> (String, Bool, Double)? in
            let asleep = values.filter { [1, 3, 4, 5].contains($0.state) }
            let duration = union(asleep.map { (max($0.start, window.start), min($0.end, window.end)) })
                .reduce(0) { $0 + $1.1.timeIntervalSince($1.0) }
            guard duration > 0 else { return nil }
            return (source, values.contains(where: \.isWatch), duration)
        }.sorted {
            if $0.1 != $1.1 { return $0.1 && !$1.1 }
            if $0.2 != $1.2 { return $0.2 > $1.2 }
            return $0.0 < $1.0
        }
        guard let selected = ranked.first else { return nil }
        let values = bySource[selected.0] ?? []
        struct Event { let at: Date; let state: Int; let delta: Int }
        let events = values.flatMap { value -> [Event] in
            let start = max(value.start, window.start), end = min(value.end, window.end)
            guard end > start else { return [] }
            return [Event(at: start, state: value.state, delta: 1), Event(at: end, state: value.state, delta: -1)]
        }.sorted { $0.at < $1.at }
        var active = Array(repeating: 0, count: 6), seconds = Array(repeating: 0.0, count: 6)
        var previous = window.start
        for event in events {
            let duration = event.at.timeIntervalSince(previous)
            if duration > 0 {
                if active[0] > 0 { seconds[0] += duration }
                if active[2] > 0 { seconds[2] += duration }
                let detailed = [3, 4, 5].filter { active[$0] > 0 }
                if detailed.count == 1 { seconds[detailed[0]] += duration }
                else if detailed.count > 1 || active[1] > 0 { seconds[1] += duration }
            }
            active[event.state] += event.delta
            previous = event.at
        }
        let stages = NativeHealthSleepStages(unspecified: seconds[1] / 3_600, core: seconds[3] / 3_600,
                                       deep: seconds[4] / 3_600, rem: seconds[5] / 3_600,
                                       awake: seconds[2] / 3_600, inBed: seconds[0] / 3_600)
        guard stages.asleep > 0 else { return nil }
        let originalUnion = union(values.filter { [1, 3, 4, 5].contains($0.state) }.map { ($0.start, $0.end) })
        var groups: [[(Date, Date)]] = []
        for interval in originalUnion {
            if let last = groups.last?.last, interval.0.timeIntervalSince(last.1) <= 3_600 {
                groups[groups.count - 1].append(interval)
            } else { groups.append([interval]) }
        }
        let main = groups.map { group in
            (group, group.reduce(0.0) { $0 + max(0, min($1.1, window.end).timeIntervalSince(max($1.0, window.start))) })
        }.filter { $0.1 > 0 }.sorted {
            if $0.1 != $1.1 { return $0.1 > $1.1 }
            return ($0.0.last?.1 ?? .distantPast) > ($1.0.last?.1 ?? .distantPast)
        }.first?.0
        var timing: NativeHealthSleepTiming?
        if let onset = main?.first?.0, let wake = main?.last?.1 {
            let startText = NativeHealthCalendar.timestamp(max(onset, window.start))
            let endText = NativeHealthCalendar.timestamp(min(wake, window.end))
            // A sub-millisecond bout can have a duration without representable
            // distinct timing bounds. Keep its sleep value; timing is optional.
            if let start = NativeHealthCalendar.parseTimestamp(startText),
               let end = NativeHealthCalendar.parseTimestamp(endText), end > start {
                timing = NativeHealthSleepTiming(onset: startText, wake: endText,
                                           clipped: onset < window.start || wake > window.end)
            }
        }
        return NativeHealthMeasurement(id: "healthkit-sleep:" + window.day, metric: "sleep", value: stages.asleep,
                                       unit: "hours", startDate: NativeHealthCalendar.timestamp(window.start),
                                       endDate: NativeHealthCalendar.timestamp(window.end), source: selected.0,
                                       aggregation: "daily", sleepStages: stages, sleepTiming: timing)
    }

    private static func union(_ intervals: [(Date, Date)]) -> [(Date, Date)] {
        let sorted = intervals.filter { $0.1 > $0.0 }.sorted { $0.0 < $1.0 || ($0.0 == $1.0 && $0.1 < $1.1) }
        var result: [(Date, Date)] = []
        for interval in sorted {
            if let last = result.last, interval.0 <= last.1 { result[result.count - 1].1 = max(last.1, interval.1) }
            else { result.append(interval) }
        }
        return result
    }
}

enum NativeHealthError: LocalizedError {
    case unavailable, invalidRange, invalidRecord, tooManyRecords, noReadableData, queryTimedOut, backgroundDeliveryUnavailable
    var errorDescription: String? {
        switch self {
        case .unavailable: return "此设备无法读取苹果健康，请在支持健康数据的 iPhone 上运行。"
        case .invalidRange: return "请选择最近 1 至 90 天的有效日期范围。"
        case .invalidRecord: return "本次健康记录的数值或时间未通过校验，尚未上传。请稍后重试；若持续出现，请检查苹果健康中的异常记录。"
        case .tooManyRecords: return "本次超过 1,000 条记录或 512 KB，请缩短同步天数后重试；数据未被截断。"
        case .noReadableData: return "没有可同步的健康记录。请检查健康读取权限或日期范围；缺失不会作为零值上传。"
        case .queryTimedOut: return "读取苹果健康超时，请稍后重试。"
        case .backgroundDeliveryUnavailable: return "此设备暂未启用后台健康通知；打开 App 时仍会同步，也可以手动重试。"
        }
    }
}
