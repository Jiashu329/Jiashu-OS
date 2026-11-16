import Foundation

struct DailySteps: Identifiable, Equatable, Sendable {
    let day: String
    let startDate: Date
    let endDate: Date
    let steps: Int?

    var id: String { day }
}

struct StepSnapshot: Equatable, Sendable {
    let capturedAt: Date
    let days: [DailySteps]
}

enum StepDataError: LocalizedError {
    case healthDataUnavailable
    case invalidDayCount
    case unsupportedDate
    case futureDate
    case emptyInterval
    case invalidStepCount
    case invalidSnapshot
    case noReadableData
    case previewTooLarge
    case invalidPreviewURL

    var errorDescription: String? {
        switch self {
        case .healthDataUnavailable:
            return "当前设备无法读取苹果健康。请在支持健康数据的 iPhone 上运行。"
        case .invalidDayCount:
            return "请选择 1 至 90 个自然日。"
        case .unsupportedDate:
            return "所选日期超出网站支持的范围，请选择 1970 至 2100 年内的有效日期。"
        case .futureDate:
            return "不能读取尚未开始的日期。"
        case .emptyInterval:
            return "所选日期尚无可读取的时间区间；如果刚过午夜，请稍后重试或选择昨天。"
        case .invalidStepCount:
            return "系统返回的步数不在可导入范围内（0 至 200,000 步），本次不会替换成 0。"
        case .invalidSnapshot:
            return "本次结果的日期或时间区间无效，请重新读取。"
        case .noReadableData:
            return "没有可导出的步数。空白日期不会被当作 0；请检查健康读取权限或选择其他日期。"
        case .previewTooLarge:
            return "本次数据超过网页预览地址的长度限制。请缩短日期范围，或使用“导出 JSON”后在网站导入文件。"
        case .invalidPreviewURL:
            return "无法生成网站预览地址，请改用 JSON 文件导入。"
        }
    }
}

enum StepCalendar {
    static var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return value
    }

    static func dayString(for date: Date) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 0,
                      components.month ?? 0, components.day ?? 0)
    }

    static func windows(endingOn date: Date, dayCount: Int, capturedAt: Date) throws -> [DailySteps] {
        guard (1...90).contains(dayCount) else { throw StepDataError.invalidDayCount }
        guard supportedTimestamp(date), supportedTimestamp(capturedAt) else {
            throw StepDataError.unsupportedDate
        }
        let calendar = calendar
        let lastStart = calendar.startOfDay(for: date)
        let today = calendar.startOfDay(for: capturedAt)
        guard lastStart <= today else { throw StepDataError.futureDate }
        guard let firstStart = calendar.date(byAdding: .day, value: -(dayCount - 1), to: lastStart) else {
            throw StepDataError.unsupportedDate
        }
        return try (0..<dayCount).map { offset in
            guard let start = calendar.date(byAdding: .day, value: offset, to: firstStart),
                  let nextStart = calendar.date(byAdding: .day, value: 1, to: start) else {
                throw StepDataError.unsupportedDate
            }
            let end = min(nextStart, capturedAt)
            guard supportedTimestamp(start), supportedTimestamp(end) else {
                throw StepDataError.unsupportedDate
            }
            guard end > start else { throw StepDataError.emptyInterval }
            return DailySteps(day: dayString(for: start), startDate: start, endDate: end, steps: nil)
        }
    }

    /// HealthKit can allocate a fractional count at a time boundary. Keep its
    /// merged statistic and round once to the nearest whole step for the site's
    /// integer-only contract. The app displays and exports this same number.
    static func wholeSteps(from value: Double) throws -> Int {
        guard value.isFinite, value >= 0, value <= 200_000 else {
            throw StepDataError.invalidStepCount
        }
        return Int(value.rounded(.toNearestOrAwayFromZero))
    }

    static func supportedTimestamp(_ date: Date) -> Bool {
        guard date.timeIntervalSince1970.isFinite else { return false }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        let year = utc.component(.year, from: date)
        return (1970...2100).contains(year)
    }
}

protocol StepReading {
    func requestReadAuthorization() async throws
    func read(endingOn: Date, dayCount: Int, capturedAt: Date) async throws -> StepSnapshot
}
