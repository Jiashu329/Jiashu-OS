import Foundation

/// Compiled alongside the production Foundation-only exporter on macOS CI.
/// Every payload below is produced by NativeHealthSnapshot.encodePayload();
/// no copied encoder or hand-authored JSON stands in for the app contract.
@main
struct ExportContractFixtures {
    private struct Metadata: Encodable {
        let fixture: String
        let captureEpochMilliseconds: Double
    }

    static func main() throws {
        let morning = try date("2026-11-16T08:00:00+08:00")
        try emit("submillisecond-0004", capture: morning.addingTimeInterval(0.0004), days: 2)
        try emit("submillisecond-0006", capture: morning.addingTimeInterval(0.0006), days: 2)
        try emit("before-midnight-9998", capture: date("2026-11-15T23:59:59+08:00").addingTimeInterval(0.9998), days: 2)
        try emit("after-midnight-0002", capture: date("2026-11-16T00:00:00+08:00").addingTimeInterval(0.0002), days: 2)
        try emit("normal-five-metrics", capture: date("2026-11-16T15:00:00+08:00"), days: 1, normalSleep: true)
    }

    private static func date(_ value: String) throws -> Date {
        guard let date = NativeHealthCalendar.parseTimestamp(value) else {
            throw NSError(domain: "ExportContractFixtures", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Invalid synthetic fixture date"])
        }
        return date
    }

    private static func emit(_ name: String, capture: Date, days: Int, normalSleep: Bool = false) throws {
        let windows = try NativeHealthCalendar.windows(days: days, capturedAt: capture)
        guard let finalWindow = windows.last else {
            throw NSError(domain: "ExportContractFixtures", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Expected at least one elapsed fixture day"])
        }
        var rows: [NativeHealthMeasurement] = []
        for (index, window) in windows.enumerated() {
            for (metric, value, unit) in [("steps", Double(index * 1_000), "count"),
                                          ("active_energy", 123.4 + Double(index), "kcal")] {
                rows.append(NativeHealthMeasurement(
                    id: "fixture-" + metric + ":" + window.day, metric: metric, value: value, unit: unit,
                    startDate: NativeHealthCalendar.timestamp(window.start),
                    endDate: NativeHealthCalendar.timestamp(window.end),
                    source: "apple-health-merged", aggregation: "daily"))
            }
        }
        let sleepWindow = try NativeHealthCalendar.sleepWindow(day: finalWindow.day, capturedAt: capture)
        let segments: [NativeHealthSleepSegment]
        if normalSleep {
            segments = [
                NativeHealthSleepSegment(start: try date("2026-11-15T23:00:00+08:00"),
                                         end: try date("2026-11-16T07:00:00+08:00"),
                                         state: 1, source: "fixture-watch", isWatch: true),
                NativeHealthSleepSegment(start: try date("2026-11-16T01:00:00+08:00"),
                                         end: try date("2026-11-16T03:00:00+08:00"),
                                         state: 4, source: "fixture-watch", isWatch: true),
                NativeHealthSleepSegment(start: try date("2026-11-15T22:00:00+08:00"),
                                         end: try date("2026-11-16T08:00:00+08:00"),
                                         state: 0, source: "fixture-watch", isWatch: true),
            ]
            for (metric, value, hour) in [("weight", 68.2, "08"), ("lean_body_mass", 52.3, "09")] {
                rows.append(NativeHealthMeasurement(
                    id: "fixture-" + metric, metric: metric, value: value, unit: "kg",
                    startDate: NativeHealthCalendar.timestamp(try date("2026-11-16T" + hour + ":00:00+08:00")),
                    endDate: nil, source: "fixture-scale", aggregation: "sample"))
            }
        } else {
            // Cover the entire reporting window and continue past its cutoff.
            // Before the fix, sub-millisecond captures could either become a
            // future endDate or exceed the serialized sleep-stage window.
            segments = [NativeHealthSleepSegment(start: sleepWindow.start.addingTimeInterval(-3_600),
                                                  end: max(capture, sleepWindow.end).addingTimeInterval(3_600),
                                                  state: 1, source: "fixture-watch", isWatch: true)]
        }
        guard let sleep = try NativeHealthSleepAggregation.measurement(segments: segments, window: sleepWindow) else {
            throw NSError(domain: "ExportContractFixtures", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "Expected synthetic sleep measurement"])
        }
        rows.append(sleep)
        let payload = try NativeHealthSnapshot(capturedAt: capture, measurements: rows).encodePayload()
        // Keep the exact JSONEncoder payload bytes inside the NDJSON wrapper.
        var line = try JSONEncoder().encode(Metadata(fixture: name,
                                                     captureEpochMilliseconds: capture.timeIntervalSince1970 * 1_000))
        line.removeLast()
        line.append(Data(",\"payload\":".utf8))
        line.append(payload)
        line.append(Data("}\n".utf8))
        FileHandle.standardOutput.write(line)
    }
}
