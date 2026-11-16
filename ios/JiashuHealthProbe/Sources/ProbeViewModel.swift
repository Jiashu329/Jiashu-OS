import Combine
import Foundation

@MainActor
final class ProbeViewModel: ObservableObject {
    @Published var endingOn = Date() {
        didSet { clearSnapshot() }
    }
    @Published var dayCount = 7 {
        didSet { clearSnapshot() }
    }
    @Published private(set) var snapshot: StepSnapshot?
    @Published private(set) var isReading = false
    @Published var errorMessage: String?
    @Published var statusMessage: String?

    private let reader: any StepReading

    init(reader: any StepReading = HealthKitStepReader()) {
        self.reader = reader
    }

    var recordedDays: Int {
        snapshot?.days.filter { $0.steps != nil }.count ?? 0
    }

    var canExport: Bool {
        !isReading && recordedDays > 0
    }

    func readSteps() async {
        guard !isReading else { return }
        isReading = true
        snapshot = nil
        errorMessage = nil
        statusMessage = nil
        // Capture the user's selection before the asynchronous authorization sheet.
        let requestedDay = endingOn
        let requestedCount = dayCount
        defer { isReading = false }

        do {
            try await reader.requestReadAuthorization()
            let result = try await reader.read(
                endingOn: requestedDay,
                dayCount: requestedCount,
                capturedAt: Date()
            )
            // An external selection change must never label old results as a new range.
            guard requestedDay == endingOn && requestedCount == dayCount else { return }
            snapshot = result
            if recordedDays == 0 {
                statusMessage = "没有取得可读取的步数。请检查所选日期是否有记录，以及健康 App 是否允许本 App 读取步数。未取得的数据不会导出为 0。"
            } else {
                statusMessage = "已读取系统合并后的步数，可先与健康 App 核对，再选择导出或前往网站预览。"
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clearSnapshot() {
        snapshot = nil
        errorMessage = nil
        statusMessage = nil
    }
}
