import Foundation

private enum BackupContractFailure: Error { case usage, mismatch }

@main
struct BackupContractFixtures {
    static func main() throws {
        guard CommandLine.arguments.count == 3 else { throw BackupContractFailure.usage }
        let input = URL(fileURLWithPath: CommandLine.arguments[1])
        let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let original = try Data(contentsOf: input)
        let summary = try NativeBackupCodec.inspect(original)
        guard summary.rows == 20_001, summary.files == 3 else { throw BackupContractFailure.mismatch }
        let files = try NativeBackupCodec.split(original)
        guard files.count == 3, files[0].data == (try NativeBackupCodec.value("manifest", in: original)) else {
            throw BackupContractFailure.mismatch
        }
        for (index, file) in files.enumerated() {
            try file.data.write(to: output.appendingPathComponent(index == 0 ? "manifest.json" : "part-\(index).json"))
        }
        let assembled = try NativeBackupCodec.assemble(Array(files.reversed()))
        try assembled.write(to: output.appendingPathComponent("assembled.json"))
        let preview = try NativeBackupCodec.request(action: "preview", backup: assembled)
        let restore = try NativeBackupCodec.request(action: "restore", backup: assembled, previewHash: String(repeating: "f", count: 64))
        guard try NativeBackupCodec.value("backup", in: preview) == assembled,
              try NativeBackupCodec.value("backup", in: restore) == assembled else { throw BackupContractFailure.mismatch }
        try preview.write(to: output.appendingPathComponent("preview-request.json"))
        try restore.write(to: output.appendingPathComponent("restore-request.json"))
        print("Swift lossless backup split/assemble/request wrapping completed.")
    }
}
