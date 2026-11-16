import Foundation
import HealthKit

/// Read-only access to the system's merged statistics. No raw sample summation,
/// source predicate, or separateBySource option is used here.
final class HealthKitStepReader: StepReading {
    private let store: HKHealthStore
    private let stepType = HKQuantityType(.stepCount)

    init(store: HKHealthStore = HKHealthStore()) {
        self.store = store
    }

    func requestReadAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw StepDataError.healthDataUnavailable
        }
        // Completion means the permission request completed, not that read
        // access was granted. HealthKit intentionally hides read authorization.
        try await store.requestAuthorization(toShare: [], read: [stepType])
    }

    func read(endingOn: Date, dayCount: Int, capturedAt: Date) async throws -> StepSnapshot {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw StepDataError.healthDataUnavailable
        }
        let windows = try StepCalendar.windows(endingOn: endingOn, dayCount: dayCount, capturedAt: capturedAt)
        var days: [DailySteps] = []
        for window in windows {
            try Task.checkCancellation()
            let value = try await mergedSteps(in: window)
            try Task.checkCancellation()
            days.append(DailySteps(day: window.day, startDate: window.startDate,
                                   endDate: window.endDate, steps: value))
        }
        return StepSnapshot(capturedAt: capturedAt, days: days)
    }

    private func mergedSteps(in window: DailySteps) async throws -> Int? {
        let store = store
        let raw: Double? = try await withCheckedThrowingContinuation { continuation in
            // Include samples overlapping the reporting window and leave the
            // interval/source reconciliation to HealthKit's statistics engine.
            let predicate = HKQuery.predicateForSamples(withStart: window.startDate,
                                                        end: window.endDate, options: [])
            let query = HKStatisticsQuery(quantityType: stepType,
                                          quantitySamplePredicate: predicate,
                                          options: .cumulativeSum) { query, result, error in
                // A statistics query is one-shot; also stop it explicitly once
                // its single completion has arrived. We never subscribe here.
                store.stop(query)
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: result?.sumQuantity()?.doubleValue(for: .count()))
                }
            }
            store.execute(query)
        }
        // nil can mean no readable records or denied read permission. It is
        // intentionally kept separate from a real, recorded zero count.
        return try raw.map(StepCalendar.wholeSteps(from:))
    }
}
