import Foundation
import HealthKit
import CryptoKit

@MainActor
protocol NativeHealthReading {
    func authorize() async throws
    func read(days: Int) async throws -> NativeHealthSnapshot
    func readAppleActivity(days: Int) async throws -> NativeAppleActivitySnapshot?
    func startObserving(includingAppleActivity: Bool, onChange: @escaping @Sendable () async -> Void) async throws -> Bool
    func stopObserving()
}

/// HealthKit intentionally does not reveal whether read permission was denied:
/// an empty result is left unknown and never turned into a zero measurement.
@MainActor
final class HealthKitReader: NativeHealthReading {
    private let store: HKHealthStore
    private var observers: [HKObserverQuery] = []
    private var observationGeneration = 0
    // Every enable/disable waits for the preceding HealthKit callback. A rapid
    // off/on sequence must not let an old disable finish after the new enable.
    private var deliveryQueue: Task<(existing: Bool, activity: Bool), Never>?
    private let sampleTypes: [HKSampleType] = [
        HKQuantityType(.stepCount), HKQuantityType(.activeEnergyBurned),
        HKQuantityType(.bodyMass), HKQuantityType(.leanBodyMass),
        HKCategoryType(.sleepAnalysis),
    ]
    private let heartRate = HKQuantityType(.heartRate)
    private let restingHeartRate = HKQuantityType(.restingHeartRate)
    private let oxygenSaturation = HKQuantityType(.oxygenSaturation)
    private let workoutType = HKObjectType.workoutType()

    private var activityTypes: [HKSampleType] { [heartRate, restingHeartRate, oxygenSaturation, workoutType] }

    init(store: HKHealthStore = HKHealthStore()) { self.store = store }

    func authorize() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw NativeHealthError.unavailable }
        // Success means that the sheet finished, not that every read was granted.
        let readTypes = Set((sampleTypes + activityTypes).map { $0 as HKObjectType })
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    func read(days: Int = 30) async throws -> NativeHealthSnapshot {
        guard HKHealthStore.isHealthDataAvailable() else { throw NativeHealthError.unavailable }
        // Query and export one representable cutoff. Rounding a raw Date only
        // while serializing could place today's end after the captured instant.
        let capturedAt = try NativeHealthCalendar.cutoff(Date())
        let windows = try NativeHealthCalendar.windows(days: days, capturedAt: capturedAt)
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

    func readAppleActivity(days: Int) async throws -> NativeAppleActivitySnapshot? {
        guard HKHealthStore.isHealthDataAvailable() else { throw NativeHealthError.unavailable }
        let capturedAt = try NativeHealthCalendar.cutoff(Date())
        let windows = try NativeHealthCalendar.windows(days: days, capturedAt: capturedAt)
        guard let first = windows.first else { return nil }

        let beatsPerMinute = HKUnit.count().unitDivided(by: .minute())
        async let heartResult = try? dailyHeartRate(windows: windows, unit: beatsPerMinute)
        async let restingResult = try? activityQuantitySamples(type: restingHeartRate, unit: beatsPerMinute,
                                                                from: first.start, to: capturedAt, maximum: 500)
        async let oxygenResult = try? activityQuantitySamples(type: oxygenSaturation, unit: .percent(),
                                                               from: first.start, to: capturedAt, maximum: 100, scale: 100)
        async let workoutResult = try? workoutSamples(from: first.start, to: capturedAt)
        let (heartDays, restingDays, oxygenDays, workouts) = await (heartResult, restingResult, oxygenResult, workoutResult)
        try Task.checkCancellation()

        let vitals = windows.compactMap { window -> NativeAppleActivityDay? in
            let heart = heartDays?[window.day]
            let resting = restingDays?[window.day]?.last.map {
                NativeAppleActivityDay.RestingHeartRate(value: $0.value, measuredAt: NativeHealthCalendar.timestamp($0.measuredAt))
            }
            let oxygen = oxygenDays?[window.day].flatMap { readings -> NativeAppleActivityDay.OxygenSaturation? in
                let values = readings.map(\.value)
                guard let latest = readings.last, let minimum = values.min(), let maximum = values.max() else { return nil }
                let average = values.reduce(0, +) / Double(values.count)
                return .init(latest: latest.value, average: min(max(average, minimum), maximum), min: minimum,
                             max: maximum, count: values.count, measuredAt: NativeHealthCalendar.timestamp(latest.measuredAt))
            }
            guard heart != nil || resting != nil || oxygen != nil else { return nil }
            return .init(day: window.day, heartRate: heart, restingHeartRate: resting, oxygenSaturation: oxygen)
        }

        var unavailableTypes: [String] = []
        if heartDays == nil { unavailableTypes.append("心率") }
        if restingDays == nil { unavailableTypes.append("静息心率") }
        if oxygenDays == nil { unavailableTypes.append("血氧") }
        if workouts == nil { unavailableTypes.append("训练记录") }
        return NativeAppleActivitySnapshot(capturedAt: capturedAt, vitals: vitals, workouts: workouts ?? [],
                                           unavailableTypes: unavailableTypes)
    }

    private func dailyHeartRate(windows: [NativeHealthWindow], unit: HKUnit) async throws -> [String: NativeAppleActivityDay.HeartRate] {
        var values: [String: NativeAppleActivityDay.HeartRate] = [:]
        for window in windows {
            try Task.checkCancellation()
            let summary: NativeAppleActivityDay.HeartRate? = try await runQuery { finish in
                let predicate = NSPredicate(format: "%K >= %@ AND %K < %@", HKPredicateKeyPathStartDate,
                                            window.start as NSDate, HKPredicateKeyPathStartDate, window.end as NSDate)
                return HKStatisticsQuery(quantityType: self.heartRate, quantitySamplePredicate: predicate,
                                         options: [.discreteAverage, .discreteMin, .discreteMax]) { _, statistics, error in
                    NativeHealthQueryCompletion.complete(error: error, emptyValue: nil, value: {
                        guard let average = statistics?.averageQuantity()?.doubleValue(for: unit),
                              let minimum = statistics?.minimumQuantity()?.doubleValue(for: unit),
                              let maximum = statistics?.maximumQuantity()?.doubleValue(for: unit),
                              average.isFinite, minimum > 0, maximum <= 500, minimum <= maximum else { return nil }
                        return .init(average: min(max(average, minimum), maximum), min: minimum, max: maximum)
                    }, finish: finish)
                }
            }
            if let summary { values[window.day] = summary }
        }
        return values
    }

    private struct ActivityReading: Sendable {
        let measuredAt: Date
        let value: Double
    }

    private func activityQuantitySamples(type: HKQuantityType, unit: HKUnit, from: Date, to: Date,
                                         maximum: Double, scale: Double = 1) async throws -> [String: [ActivityReading]] {
        let samples = try await quantitySamples(type: type, from: from, to: to, maximumCount: 20_000)
        var days: [String: [ActivityReading]] = [:]
        for sample in samples {
            try Task.checkCancellation()
            let value = sample.quantity.doubleValue(for: unit) * scale
            guard value.isFinite, value > 0, value <= maximum,
                  let measuredAt = try? NativeHealthCalendar.cutoff(sample.startDate) else { continue }
            days[StepCalendar.dayString(for: measuredAt), default: []].append(.init(measuredAt: measuredAt, value: value))
        }
        return days
    }

    private func workoutSamples(from: Date, to: Date) async throws -> [NativeAppleActivityWorkout] {
        let workouts: [HKWorkout] = try await runQuery { finish in
            let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: [.strictStartDate, .strictEndDate])
            return HKSampleQuery(sampleType: self.workoutType, predicate: predicate, limit: 10_001,
                                 sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]) { _, samples, error in
                NativeHealthQueryCompletion.complete(error: error, emptyValue: [], value: {
                    (samples ?? []).compactMap { $0 as? HKWorkout }
                }, finish: finish)
            }
        }
        guard workouts.count <= 10_000 else { throw NativeHealthError.tooManyRecords }
        return try workouts.compactMap { workout in
            try Task.checkCancellation()
            guard workout.startDate >= from, workout.endDate <= to, workout.endDate >= workout.startDate,
                  workout.duration.isFinite, workout.duration >= 0, workout.workoutActivityType.rawValue > 0,
                  let start = try? NativeHealthCalendar.cutoff(workout.startDate),
                  let end = try? NativeHealthCalendar.cutoff(workout.endDate) else { return nil }
            let duration = min(workout.duration, end.timeIntervalSince(start) + 0.000_5)
            let energy = workout.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()
                ?? workout.totalEnergyBurned
            var distances: [HKQuantityTypeIdentifier] = [.distanceWalkingRunning, .distanceCycling, .distanceSwimming,
                                                          .distanceWheelchair, .distanceDownhillSnowSports]
            if #available(iOS 18.0, *) {
                distances += [.distanceRowing, .distancePaddleSports, .distanceSkatingSports, .distanceCrossCountrySkiing]
            }
            let recordedDistances = distances.compactMap { identifier in
                workout.statistics(for: HKQuantityType(identifier))?.sumQuantity()?.doubleValue(for: .meter())
            }
            let distance = workout.totalDistance?.doubleValue(for: .meter())
                ?? (recordedDistances.isEmpty ? nil : recordedDistances.reduce(0, +))
            return NativeAppleActivityWorkout(id: workout.uuid.uuidString.lowercased(),
                activityType: workout.workoutActivityType.rawValue, startDate: NativeHealthCalendar.timestamp(start),
                endDate: NativeHealthCalendar.timestamp(end), durationSeconds: duration,
                energyKcal: Self.nonnegative(energy?.doubleValue(for: .kilocalorie())), distanceMeters: Self.nonnegative(distance))
        }
    }

    private static func nonnegative(_ value: Double?) -> Double? {
        guard let value, value.isFinite, value >= 0 else { return nil }
        return value
    }

    /// Register at app launch when automatic sync was previously enabled. The
    /// async callback must finish bounded reconciliation before returning; only
    /// then is HealthKit's completion acknowledged. Delivery time is controlled
    /// by iOS and cannot be promised at a fixed interval.
    func startObserving(includingAppleActivity: Bool, onChange: @escaping @Sendable () async -> Void) async throws -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else { throw NativeHealthError.unavailable }
        tearDownQueries()
        let generation = observationGeneration
        let preceding = deliveryQueue
        let operation = Task { @MainActor [weak self] () -> (existing: Bool, activity: Bool) in
            let previous = await preceding?.value
            guard let self, self.observationGeneration == generation else { return (false, false) }
            let observationTypes = self.sampleTypes + (includingAppleActivity ? self.activityTypes : [])
            // Reset uncertain legacy delivery before a fresh enable. Optional
            // types are allowed to be unavailable without blocking this reset.
            if previous?.existing == false {
                var resetSucceeded = true
                for type in self.sampleTypes {
                    let success = await self.changeBackgroundDelivery(for: type, enabled: false)
                    if !success { resetSucceeded = false }
                }
                guard resetSucceeded, self.observationGeneration == generation else { return (false, false) }
            }
            if previous?.activity == false {
                for type in self.activityTypes {
                    _ = await self.changeBackgroundDelivery(for: type, enabled: false)
                }
            }
            guard self.observationGeneration == generation else { return (false, false) }
            for type in observationTypes {
                let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
                    Task { @MainActor in
                        guard let self, self.observationGeneration == generation else { completion(); return }
                        if error == nil { await onChange() }
                        completion()
                    }
                }
                self.observers.append(query)
                self.store.execute(query)
            }
            var existingSucceeded = true
            for type in self.sampleTypes {
                guard self.observationGeneration == generation else { return (false, false) }
                let success = await self.changeBackgroundDelivery(for: type, enabled: true)
                if !success { existingSucceeded = false }
            }
            var activitySucceeded = true
            for type in includingAppleActivity ? self.activityTypes : [] {
                guard self.observationGeneration == generation else { return (false, false) }
                let frequency: HKUpdateFrequency = type == self.heartRate || type == self.oxygenSaturation ? .hourly : .immediate
                let success = await self.changeBackgroundDelivery(for: type, enabled: true, frequency: frequency)
                if !success { activitySucceeded = false }
            }
            return (existingSucceeded, activitySucceeded)
        }
        deliveryQueue = operation
        let result = await operation.value
        guard observationGeneration == generation else { return true }
        if !result.existing { throw NativeHealthError.backgroundDeliveryUnavailable }
        return result.activity
    }

    /// Explicit user pause/logout stops callbacks immediately and then queues
    /// the delivery disable behind any still-pending enable operation.
    func stopObserving() {
        tearDownQueries()
        let preceding = deliveryQueue
        deliveryQueue = Task { @MainActor [weak self] () -> (existing: Bool, activity: Bool) in
            _ = await preceding?.value
            guard let self else { return (false, false) }
            var existingSucceeded = true
            for type in self.sampleTypes {
                let success = await self.changeBackgroundDelivery(for: type, enabled: false)
                if !success { existingSucceeded = false }
            }
            var activitySucceeded = true
            for type in self.activityTypes {
                let success = await self.changeBackgroundDelivery(for: type, enabled: false)
                if !success { activitySucceeded = false }
            }
            return (existingSucceeded, activitySucceeded)
        }
    }

    /// Restarting observers does not itself disable background delivery.
    private func tearDownQueries() {
        observationGeneration += 1
        observers.forEach { store.stop($0) }
        observers.removeAll()
    }

    private func changeBackgroundDelivery(for type: HKSampleType, enabled: Bool, frequency: HKUpdateFrequency = .immediate) async -> Bool {
        await withCheckedContinuation { continuation in
            if enabled {
                store.enableBackgroundDelivery(for: type, frequency: frequency) { success, error in
                    continuation.resume(returning: success && error == nil)
                }
            } else {
                store.disableBackgroundDelivery(for: type) { success, error in
                    continuation.resume(returning: success && error == nil)
                }
            }
        }
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
                    NativeHealthQueryCompletion.complete(error: error, emptyValue: nil, value: {
                        statistic?.sumQuantity()?.doubleValue(for: unit)
                    }, finish: finish)
                }
            }
            if let total { values[window.day] = total }
        }
        return values
    }

    private func quantitySamples(type: HKQuantityType, from: Date, to: Date, maximumCount: Int = 1_000) async throws -> [HKQuantitySample] {
        let samples: [HKQuantitySample] = try await runQuery { finish in
            let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: .strictStartDate)
            return HKSampleQuery(sampleType: type, predicate: predicate, limit: maximumCount + 1,
                                 sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]) { _, samples, error in
                NativeHealthQueryCompletion.complete(error: error, emptyValue: [], value: {
                    (samples ?? []).compactMap { $0 as? HKQuantitySample }
                }, finish: finish)
            }
        }
        guard samples.count <= maximumCount else { throw NativeHealthError.tooManyRecords }
        return samples.filter { $0.startDate >= from && $0.startDate <= to }
    }

    private func sleepSamples(from: Date, to: Date) async throws -> [NativeHealthSleepSegment] {
        let samples: [NativeHealthSleepSegment] = try await runQuery { finish in
            let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
            return HKSampleQuery(sampleType: HKCategoryType(.sleepAnalysis), predicate: predicate, limit: 20_001,
                                 sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]) { _, samples, error in
                NativeHealthQueryCompletion.complete(error: error, emptyValue: [], value: {
                    (samples ?? []).compactMap { raw -> NativeHealthSleepSegment? in
                        guard let sample = raw as? HKCategorySample else { return nil }
                        let product = sample.sourceRevision.productType?.lowercased() ?? ""
                        let model = sample.device?.model?.lowercased() ?? ""
                        return NativeHealthSleepSegment(start: sample.startDate, end: sample.endDate, state: sample.value,
                                                  source: Self.sourceIdentifier(sample, prefix: "apple-health-sleep"),
                                                  isWatch: product.hasPrefix("watch") || model.contains("watch"))
                    }
                }, finish: finish)
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

/// HealthKit can report an empty predicate as errorNoData rather than as an
/// empty result. This is absence, not a failed read or a recorded zero. Other
/// errors must still stop the batch so a locked/failed query is never uploaded
/// as if it were a complete successful snapshot.
enum NativeHealthQueryCompletion {
    static func complete<Value>(error: Error?, emptyValue: Value, value: () -> Value,
                                finish: (Result<Value, Error>) -> Void) {
        if let error {
            let healthError = error as NSError
            if healthError.domain == HKErrorDomain && healthError.code == HKError.Code.errorNoData.rawValue {
                finish(.success(emptyValue))
            } else {
                finish(.failure(error))
            }
        } else {
            finish(.success(value()))
        }
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
