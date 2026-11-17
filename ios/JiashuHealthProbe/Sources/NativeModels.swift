import Foundation

struct NativeUser: Codable, Equatable, Sendable {
    let id: String
    let email: String
}

struct NativeSession: Codable, Equatable, Sendable {
    let accessToken: String
    let expiresAt: String
    let user: NativeUser

    var expiryDate: Date? { NativeDates.parse(expiresAt) }
    var isExpired: Bool { expiryDate.map { $0 <= Date() } ?? true }
    var viewIdentity: String {
        user.id
    }
}

enum NativeDates {
    static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

struct NativeOverview: Codable, Sendable {
    let asOf: String
    let today: String
    let health: NativeOverviewHealth
    let priorities: [NativePriority]
    let finance: [String: NativeOverviewFinance]?
    let nutrition: NativeJSON?
    let modules: NativeJSON?
}

struct NativeOverviewFinance: Codable, Sendable {
    let status: String
    let accountCount: Int
    let currencies: [NativeOverviewCurrency]
    let staleAccountCount: Int
    let uncheckedAccountCount: Int
    let pendingBalanceCount: Int
}
struct NativeOverviewCurrency: Codable, Sendable, Identifiable {
    let currency: String
    let netFormatted: String
    let assetsFormatted: String
    let liabilitiesFormatted: String
    var id: String { currency }
}

struct NativeOverviewHealth: Codable, Sendable {
    let status: String
    let lastSync: String?
    let metrics: [NativeHomeMetric]
    let recordedMetricCount: Int
}

struct NativeHomeMetric: Codable, Identifiable, Sendable {
    let metric: String
    let label: String
    let value: Double?
    let unit: String
    let day: String?
    let freshness: String
    let points: [NativeDayPoint]
    let average7: Double?
    let observedDays7: Int
    var id: String { metric }
}

struct NativeDayPoint: Codable, Identifiable, Sendable {
    let day: String
    let value: Double
    var id: String { day }
}

struct NativePriority: Codable, Identifiable, Sendable {
    let id: String
    let tone: String
    let title: String
    let detail: String
    let href: String
    let actionLabel: String
}

struct NativeHealthResponse: Codable, Sendable {
    let summary: NativeHealthSummary
    let measurements: [NativeStoredMeasurement]
    let lastSync: String?
}

struct NativeHealthSummary: Codable, Sendable {
    let metrics: [String: NativeMetricSummary]
    let measurementCount: Int
    let lastMeasurementAt: String?
}

struct NativeMetricSummary: Codable, Identifiable, Sendable {
    let metric: String
    let label: String
    let unit: String
    let latestValue: Double?
    let latestDate: String?
    let points: [NativeTrendPoint]
    var id: String { metric }
}

struct NativeTrendPoint: Codable, Identifiable, Sendable {
    let day: String
    let value: Double
    let measuredAt: String
    let source: String?
    let sleepStages: NativeSleepStages?
    var id: String { day }
}

struct NativeSleepStages: Codable, Sendable {
    let unspecified: Double
    let core: Double
    let deep: Double
    let rem: Double
    let awake: Double
    let inBed: Double
}

struct NativeStoredMeasurement: Codable, Identifiable, Sendable {
    let id: String
    let metric: String
    let value: Double
    let unit: String
    let startDate: String
    let endDate: String?
    let source: String?
    let aggregation: String?
    let sleepStages: NativeSleepStages?
}

/// Server-authoritative daily health source selection. A configured channel
/// may belong to a different phone; it must never be assumed to be this one.
struct NativeHealthChannel: Codable, Equatable, Sendable {
    let revision: Int
    let deviceId: String?
    let label: String?
    let updatedAt: String?
    let isCurrentDevice: Bool
    var hasActiveChannel: Bool { deviceId != nil }
}

struct NativeImportPreview: Codable, Sendable {
    let token: String
    let total: Int
    let added: Int
    let updated: Int
    let skipped: Int
    let sourceChanges: Int
    let manualOverrides: Int
    let from: String?
    let to: String?
    let metrics: [String]
    let examples: [NativeImportExample]
}

struct NativeImportExample: Codable, Identifiable, Sendable {
    let recordKey: String
    let day: String
    let metric: String
    let action: String
    let before: Double?
    let after: Double
    let oldSource: String?
    let newSource: String?
    let reason: String
    let manualOverride: Bool
    var id: String { recordKey }
}

struct NativeSyncReceipt: Codable, Sendable {
    let ok: Bool
    let imported: Int
    let skipped: Int
    let lastSync: String
    let batchId: String?
    let replayed: Bool?
    let reverted: Bool?
    let canRevert: Bool?
}

struct NativeImportHistoryResponse: Codable, Sendable {
    let batches: [NativeImportBatch]
    let checkedAt: String
}

struct NativeImportBatch: Codable, Identifiable, Sendable {
    let batchId: String
    let createdAt: String
    let imported: Int
    let skipped: Int
    let canRevert: Bool
    let revertedAt: String?
    let revertReason: String?
    var id: String { batchId }
}

struct NativeGoalTargets: Codable, Equatable, Sendable {
    var steps: Double?
    var sleep: Double?
    var activeEnergy: Double?
    enum CodingKeys: String, CodingKey {
        case steps, sleep
        case activeEnergy = "active_energy"
    }
    // A complete target replacement must encode unset targets as explicit null.
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(steps, forKey: .steps)
        try values.encode(sleep, forKey: .sleep)
        try values.encode(activeEnergy, forKey: .activeEnergy)
    }
}

struct NativeGoalSettings: Codable, Sendable {
    let targets: NativeGoalTargets
    let updatedAt: String?
    let revision: Int
    let effectiveFrom: String?
}

struct NativeWeeklyReviewResponse: Codable, Sendable {
    let weekStart: String
    let weekEnd: String
    let cutoffDay: String
    let today: String
    let isCurrent: Bool
    let partial: Bool
    let metrics: [NativeWeeklyMetric]
    let focus: NativeWeeklyFocus
}

struct NativeWeeklyMetric: Codable, Identifiable, Sendable {
    let metric: String
    let label: String
    let unit: String
    let currentAverage: Double?
    let previousAverage: Double?
    let delta: Double?
    let currentRecordedDays: Int
    let previousRecordedDays: Int
    let currentPoints: [NativeWeeklyPoint]
    let previousPoints: [NativeWeeklyPoint]
    let target: Double?
    let currentAchievedDays: Int?
    let previousAchievedDays: Int?
    var id: String { metric }
}

struct NativeWeeklyPoint: Codable, Identifiable, Sendable {
    let day: String
    let value: Double?
    let target: Double?
    var id: String { day }
}

struct NativeWeeklyFocus: Codable, Sendable {
    let headline: String
    let summary: String
    let coverageNote: String
    let primary: NativeWeeklyFocusItem?
    let secondary: [NativeWeeklyFocusItem]
    let suggestedAction: NativeSuggestedAction?
}

struct NativeWeeklyFocusItem: Codable, Identifiable, Sendable {
    let id: String
    let kind: String
    let metric: String
    let title: String
    let evidence: String
    let interpretation: String
    let href: String
    let linkLabel: String
}

struct NativeSuggestedAction: Codable, Sendable {
    let text: String
    let label: String
}
