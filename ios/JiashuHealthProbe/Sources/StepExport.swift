import Foundation

struct HealthSyncPayload: Encodable, Sendable {
    let version = 1
    // Existing website schema identifier; record-level source identifies that
    // these values came from native HealthKit merged statistics, not Shortcuts.
    let source = "apple-health-shortcuts"
    let timezone = "Asia/Shanghai"
    let exportedAt: String
    let measurements: [HealthSyncMeasurement]
}

struct HealthSyncMeasurement: Encodable, Sendable {
    let id: String
    let metric = "steps"
    let value: Int
    let unit = "count"
    let startDate: String
    let endDate: String
    let source = "apple-health-merged"
    let aggregation = "daily"
}

enum StepExport {
    static let websiteURL = URL(string: "https://www.treefund.asia")!

    static func jsonData(for snapshot: StepSnapshot) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(payload(for: snapshot))
    }

    /// Opens the Aliyun service's existing signed-in Safari preview flow, without a device key
    /// or the unrelated single-source configuration marker. It never confirms
    /// an import or reports that data has been saved to the website.
    static func previewURL(for snapshot: StepSnapshot) throws -> URL {
        let data = try jsonData(for: snapshot)
        guard let json = String(data: data, encoding: .utf8) else {
            throw StepDataError.invalidPreviewURL
        }
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        guard let encoded = json.addingPercentEncoding(withAllowedCharacters: unreserved) else {
            throw StepDataError.invalidPreviewURL
        }
        let text = websiteURL.absoluteString + "/sync#payload=" + encoded
        guard text.utf8.count <= 32_768 else { throw StepDataError.previewTooLarge }
        guard let url = URL(string: text) else { throw StepDataError.invalidPreviewURL }
        return url
    }

    private static func payload(for snapshot: StepSnapshot) throws -> HealthSyncPayload {
        guard StepCalendar.supportedTimestamp(snapshot.capturedAt),
              !snapshot.days.isEmpty, snapshot.days.count <= 90 else {
            throw StepDataError.invalidSnapshot
        }
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var seen = Set<String>()
        let measurements = try snapshot.days.sorted { $0.startDate < $1.startDate }.compactMap { day -> HealthSyncMeasurement? in
            let calendar = StepCalendar.calendar
            guard StepCalendar.supportedTimestamp(day.startDate), StepCalendar.supportedTimestamp(day.endDate),
                  day.day == StepCalendar.dayString(for: day.startDate),
                  seen.insert(day.day).inserted,
                  day.startDate == calendar.startOfDay(for: day.startDate),
                  let nextMidnight = calendar.date(byAdding: .day, value: 1, to: day.startDate),
                  day.endDate == min(nextMidnight, snapshot.capturedAt),
                  day.endDate > day.startDate else {
                throw StepDataError.invalidSnapshot
            }
            guard let value = day.steps else { return nil }
            guard (0...200_000).contains(value) else { throw StepDataError.invalidStepCount }
            let start = formatter.string(from: day.startDate)
            let end = formatter.string(from: day.endDate)
            // Formatting has millisecond precision. A sub-millisecond interval
            // at midnight must not be exported as a zero-duration measurement.
            guard start != end else { throw StepDataError.emptyInterval }
            return HealthSyncMeasurement(id: "healthkit-merged-steps:" + day.day, value: value,
                                         startDate: start, endDate: end)
        }
        guard !measurements.isEmpty else { throw StepDataError.noReadableData }
        return HealthSyncPayload(exportedAt: formatter.string(from: snapshot.capturedAt), measurements: measurements)
    }
}
