import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct ContentView: View {
    @ObservedObject var model: ProbeViewModel
    @Environment(\.openURL) private var openURL
    @State private var exportDocument: StepsJSONDocument?
    @State private var showFileExporter = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("苹果健康步数")
                                .font(.title3.bold())
                            Text("读取系统合并结果，与健康 App 核对")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "heart.fill")
                            .font(.title)
                            .foregroundStyle(.pink)
                    }
                    .padding(.vertical, 7)
                }

                Section {
                    LabeledContent("同步网站", value: StepExport.websiteURL.host ?? "www.treefund.asia")
                    Link(destination: StepExport.websiteURL) {
                        Label("打开阿里云网站并登录", systemImage: "person.crop.circle")
                    }
                } header: {
                    Text("阿里云同步服务")
                } footer: {
                    Text("先在 Safari 中使用阿里云站点的邮箱和密码登录，再回到 App 读取并预览导入。此入口不会携带健康数据。")
                }

                Section {
                    DatePicker("截止日期", selection: $model.endingOn,
                               in: ...Date(), displayedComponents: .date)
                    Picker("连续天数", selection: $model.dayCount) {
                        ForEach([1, 7, 30, 90], id: \.self) { days in
                            Text("\(days) 天").tag(days)
                        }
                    }
                    Button {
                        Task { await model.readSteps() }
                    } label: {
                        HStack {
                            if model.isReading { ProgressView() }
                            Text(model.isReading ? "正在读取…" : "授权并读取步数")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity, minHeight: 28)
                    }
                    .disabled(model.isReading)
                } header: {
                    Text("读取范围")
                } footer: {
                    Text("按北京时间统计。只请求步数读取权限，不修改苹果健康数据。首次核对可选择具体日期、连续 1 天。")
                }
                .disabled(model.isReading)

                if let error = model.errorMessage {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                }

                if let snapshot = model.snapshot {
                    Section {
                        LabeledContent("有可读数据", value: "\(model.recordedDays) / \(snapshot.days.count) 天")
                        LabeledContent("读取时间", value: timestampText(snapshot.capturedAt))
                        if let message = model.statusMessage {
                            Text(message)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        Text("本次结果")
                    }

                    Section {
                        ForEach(snapshot.days.reversed()) { day in
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(day.day)
                                        .monospacedDigit()
                                    if isPartial(day) {
                                        Text("截至本次读取")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer(minLength: 12)
                                if let steps = day.steps {
                                    Text(steps.formatted())
                                        .fontWeight(.semibold)
                                        .monospacedDigit()
                                    Text("步").foregroundStyle(.secondary)
                                } else {
                                    Text("未取得数据")
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .accessibilityElement(children: .combine)
                        }
                    } header: {
                        Text("每日步数")
                    } footer: {
                        Text("请在手机、手表完成同步后，与健康 App 的同一天比较。今天只统计到读取时刻；未取得数据的日期不会补 0。")
                    }

                    Section {
                        Button("在阿里云网站预览导入", systemImage: "safari") {
                            previewOnWebsite(snapshot)
                        }
                        Button("导出 JSON 文件", systemImage: "square.and.arrow.up") {
                            exportFile(snapshot)
                        }
                    } header: {
                        Text("同步到阿里云 Jiashu OS")
                    } footer: {
                        Text("点击后在阿里云网站预览并确认导入；首次从旧设备来源切换时，还需确认来源变化。如果首次登录后没有出现本次数据，请回到 App 再点一次预览，或改用 JSON 文件导入。")
                    }
                    .disabled(!model.canExport)
                }
            }
            .navigationTitle("步数核对")
            .fileExporter(
                isPresented: $showFileExporter,
                document: exportDocument,
                contentType: .json,
                defaultFilename: exportFilename
            ) { result in
                switch result {
                case .success:
                    model.statusMessage = "JSON 文件已保存。请到阿里云网站的“导入 JSON”选择文件，预览后确认。"
                case .failure(let error):
                    let cocoa = error as NSError
                    if cocoa.domain != NSCocoaErrorDomain || cocoa.code != NSUserCancelledError {
                        model.errorMessage = error.localizedDescription
                    }
                }
            }
        }
    }

    private var exportFilename: String {
        let last = model.snapshot?.days.last?.day ?? "steps"
        return "jiashu-healthkit-steps-\(last).json"
    }

    private func timestampText(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
        formatter.dateFormat = "MM-dd HH:mm:ss"
        return formatter.string(from: date)
    }

    private func isPartial(_ day: DailySteps) -> Bool {
        guard let next = StepCalendar.calendar.date(byAdding: .day, value: 1, to: day.startDate) else { return false }
        return day.endDate < next
    }

    private func exportFile(_ snapshot: StepSnapshot) {
        do {
            exportDocument = StepsJSONDocument(data: try StepExport.jsonData(for: snapshot))
            model.errorMessage = nil
            showFileExporter = true
        } catch {
            model.errorMessage = error.localizedDescription
        }
    }

    private func previewOnWebsite(_ snapshot: StepSnapshot) {
        do {
            let url = try StepExport.previewURL(for: snapshot)
            model.errorMessage = nil
            openURL(url) { accepted in
                if accepted {
                    model.statusMessage = "已请求打开阿里云网站，请在 Safari 中预览并确认导入。如登录后没有出现本次数据，请回到 App 再点一次预览。本 App 无法确认网站是否保存成功。"
                } else {
                    model.errorMessage = "无法打开 Safari，请改用“导出 JSON 文件”，再到网站导入。"
                }
            }
        } catch {
            model.errorMessage = error.localizedDescription
        }
    }
}

struct StepsJSONDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        self.data = data
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
