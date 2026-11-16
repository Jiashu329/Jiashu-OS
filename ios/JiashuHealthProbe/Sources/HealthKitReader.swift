import Foundation
import HealthKit
import CryptoKit

/// Reads only the types supported by the existing Jiashu OS health schema.
/// HealthKit intentionally does not reveal whether read permission was denied:
/// an empty result is left unknown and never turned into a zero measurement.
@MainActor
final class HealthKitReader {
    private let store: HKHealthStore
    private var observers: [HKObserverQuery] = []
    private var observationGeneration = 0
    private let sampleTypes: [HKSampleType] = [
        HKQuantityType(.stepCount), HKQuantityType(.activeEnergyBurned),
        HKQuantityType(.bodyMass), HKQuantityType(.leanBodyMass),
        HKCategoryType(.sleepAnalysis),
    ]

    init(store: HKHealthStore = HKHealthStore()) { self.store = store }

    func authorize() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw NativeHealthError.unavailable }
        // Success means that the sheet finished, not that every read was granted.
        let readTypes = Set(sampleTypes.map { $0 as HKObjectType })
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    func read(days: Int = 30) async throws -> NativeHealthSnapshot {
        guard HKHealthStore.isHealthDataAvailable() else { throw NativeHealthError.unavailable }
        let capturedAt = Date(), windows = try NativeHealthCalendar.windows(days: days, capturedAt: capturedAt)
        guard let first = windows.first else { throw NativeHealthError.noReadableData }
        var measurements: [NativeHealthMeasurement] = []
        for (metric, identifier, unit) in [
            ("steps", HKQuantityTypeIdentifier.stepCount, HKUnit.count()),
            ("active_energy", HKQuantityTypeIdentifier.activeEnergyBurned, HKUnit.kilocalorie()),
        ] {
            try Task.checkCancellation()
            let values = try await dailyTotals(type: HKQuantityType(identifier), unit: unit, windows: windows)
            for window in windows {
                guard let raw = values[window.day] else { continue }
                let value = metric == "steps" ? Double(try StepCalendar.wholeSteps(from: raw)) : raw
                measurements.append(NativeHealthMeasurement(
                    id: "healthkit-merged-" + metric + ":" + window.day, metric: metric,
                    value: value, unit: metric == "steps" ? "count" : "kcal",
                    startDate: NativeHealthCalendar.timestamp(window.start), endDate: NativeHealthCalendar.timestamp(window.end),
                    source: "apple-health-merged", aggregation: "daily"))
            }
        }
        for (metric, identifier) in [("weight", HKQuantityTypeIdentifier.bodyMass), ("lean_body_mass", HKQuantityTypeIdentifier.leanBodyMass)] {
            try Task.checkCancellation()
            let samples = try await quantitySamples(type: HKQuantityType(identifier), from: first.start, to: capturedAt)
            for sample in samples {
                measurements.append(NativeHealthMeasurement(
                    id: "healthkit-" + metric + ":" + sample.uuid.uuidString.lowercased(), metric: metric,
                    value: sample.quantity.doubleValue(for: HKUnit.gramUnit(with: .kilo)), unit: "kg",
                    startDate: NativeHealthCalendar.timestamp(sample.startDate), endDate: nil,
                    source: Self.sourceIdentifier(sample, prefix: "apple-health-mass"), aggregation: "sample"))
            }
        }
        try Task.checkCancellation()
        let sleepWindows = try windows.map { try NativeHealthCalendar.sleepWindow(day: $0.day, capturedAt: capturedAt) }
        if let firstSleep = sleepWindows.first {
            let segments = try await sleepSamples(from: firstSleep.start, to: capturedAt)
            for window in sleepWindows {
                if let measurement = try NativeHealthSleepAggregation.measurement(segments: segments, window: window) {
                    measurements.append(measurement)
                }
            }
        }
        let snapshot = NativeHealthSnapshot(capturedAt: capturedAt, measurements: measurements)
        // Validate before offering any part of a snapshot for upload. Invalid or
        // excessive records do not disappear from a superficially successful sync.
        _ = try snapshot.encodePayload()
        return snapshot
    }

    /// Register at app launch when automatic sync was previously enabled. The
    /// async callback must finish bounded reconciliation before returning; only
    /// then is HealthKit's completion acknowledged. Delivery time is controlled
    /// by iOS and cannot be promised at a fixed interval.
    func startObserving(onChange: @escaping @Sendable () async -> Void) async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw NativeHealthError.unavailable }
        stopObserving()
        let generation = observationGeneration
        for type in sampleTypes {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
                Task { @MainActor in
                    guard let self, self.observationGeneration == generation else { completion(); return }
                    if error == nil { await onChange() }
                    completion()
                }
            }
            observers.append(query)
            store.execute(query)
        }
        var failed = false
        for type in sampleTypes {
            guard observationGeneration == generation else { return }
            do {
                let success: Bool = try await withCheckedThrowingContinuation { continuation in
                    store.enableBackgroundDelivery(for: type, frequency: .immediate) { success, error in
                        if let error { continuation.resume(throwing: error) }
                        else { continuation.resume(returning: success) }
                    }
                }
                if !success { failed = true }
            } catch { failed = true }
            if observationGeneration != generation {
                if observers.isEmpty { store.disableBackgroundDelivery(for: type) { _, _ in } }
                return
            }
        }
        if failed { throw NativeHealthError.backgroundDeliveryUnavailable }
    }

    func stopObserving() {
        observationGeneration += 1
        observers.forEach { store.stop($0) }
        observers.removeAll()
        sampleTypes.forEach { store.disableBackgroundDelivery(for: $0) { _, _ in } }
    }

    private func dailyTotals(type: HKQuantityType, unit: HKUnit, windows: [NativeHealthWindow]) async throws -> [String: Double] {
        // Query explicit Shanghai bounds instead of a calendar-day collection
        // whose bins could follow the phone's timezone while travelling.
        var values: [String: Double] = [:]
        for window in windows {
            try Task.checkCancellation()
            let total: Double? = try await runQuery { finish in
                let predicate = HKQuery.predicateForSamples(withStart: window.start, end: window.end, options: [])
                return HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate,
                                         options: .cumulativeSum) { _, statistic, error in
                    if let error { finish(.failure(error)) }
                    else { finish(.success(statistic?.sumQuantity()?.doubleValue(for: unit))) }
                }
            }
            if let total { values[window.day] = total }
        }
        return values
    }

    private func quantitySamples(type: HKQuantityType, from: Date, to: Date) async throws -> [HKQuantitySample] {
        let samples: [HKQuantitySample] = try await runQuery { finish in
            let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: .strictStartDate)
            return HKSampleQuery(sampleType: type, predicate: predicate, limit: 1_001,
                                 sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]) { _, samples, error in
                if let error { finish(.failure(error)) }
                else { finish(.success((samples ?? []).compactMap { $0 as? HKQuantitySample })) }
            }
        }
        guard samples.count <= 1_000 else { throw NativeHealthError.tooManyRecords }
        return samples.filter { $0.startDate >= from && $0.startDate <= to }
    }

    private func sleepSamples(from: Date, to: Date) async throws -> [NativeHealthSleepSegment] {
        let samples: [NativeHealthSleepSegment] = try await runQuery { finish in
            let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
            return HKSampleQuery(sampleType: HKCategoryType(.sleepAnalysis), predicate: predicate, limit: 20_001,
                                 sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]) { _, samples, error in
                if let error { finish(.failure(error)); return }
                let segments = (samples ?? []).compactMap { raw -> NativeHealthSleepSegment? in
                    guard let sample = raw as? HKCategorySample else { return nil }
                    let product = sample.sourceRevision.productType?.lowercased() ?? ""
                    let model = sample.device?.model?.lowercased() ?? ""
                    return NativeHealthSleepSegment(start: sample.startDate, end: sample.endDate, state: sample.value,
                                              source: Self.sourceIdentifier(sample, prefix: "apple-health-sleep"),
                                              isWatch: product.hasPrefix("watch") || model.contains("watch"))
                }
                finish(.success(segments))
            }
        }
        guard samples.count <= 20_000 else { throw NativeHealthError.tooManyRecords }
        return samples
    }

    private nonisolated static func sourceIdentifier(_ sample: HKSample, prefix: String) -> String {
        // Device/source identity is hashed to a bounded stable string. A source
        // change remains detectable without placing device names in uploads.
        let revision = sample.sourceRevision
        let identity = revision.source.bundleIdentifier + "|" + (sample.device?.localIdentifier ?? revision.productType ?? "")
        let digest = SHA256.hash(data: Data(identity.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        return prefix + ":" + digest
    }

    private func runQuery<Value>(_ make: @escaping (@escaping (Result<Value, Error>) -> Void) -> HKQuery) async throws -> Value {
        let operation = NativeHealthQueryOperation<Value>(store: store)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                operation.begin(continuation, make: make)
            }
        } onCancel: { operation.finish(.failure(CancellationError())) }
    }
}

/// One-shot query lifetime shared by HealthKit callbacks, cancellation and a
/// timeout. A continuation is resumed exactly once and its query is stopped.
private final class NativeHealthQueryOperation<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private let store: HKHealthStore
    private var continuation: CheckedContinuation<Value, Error>?
    private var query: HKQuery?
    private var timeout: DispatchWorkItem?
    private var completed = false

    init(store: HKHealthStore) { self.store = store }

    func begin(_ continuation: CheckedContinuation<Value, Error>, make: (@escaping (Result<Value, Error>) -> Void) -> HKQuery) {
        lock.lock()
        if completed { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
        self.continuation = continuation
        let query = make { [self] result in finish(result) }
        self.query = query
        let timeout = DispatchWorkItem { [weak self] in self?.finish(.failure(NativeHealthError.queryTimedOut)) }
        self.timeout = timeout
        // Execute while holding the lock so a cancellation cannot stop a query
        // immediately before another thread starts it. Callbacks are async.
        store.execute(query)
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 15, execute: timeout)
        lock.unlock()
    }

    func finish(_ result: Result<Value, Error>) {
        lock.lock()
        guard !completed else { lock.unlock(); return }
        completed = true
        let continuation = self.continuation, query = self.query, timeout = self.timeout
        self.continuation = nil; self.query = nil; self.timeout = nil
        lock.unlock()
        timeout?.cancel()
        if let query { store.stop(query) }
        continuation?.resume(with: result)
    }
}
