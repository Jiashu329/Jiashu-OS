import Foundation

/// Extracts explicitly labeled recipe sections from a note caption.
struct NativeXiaohongshuRecipeDraft: Equatable {
    let ingredients: String?
    let steps: String?

    private enum Section: Equatable {
        case ingredients, steps

        var heading: String {
            switch self {
            case .ingredients: #"^(?:准备材料|食材|用料|材料)(?:\s*[：:]|$)"#
            case .steps: #"^(?:具体步骤|制作步骤|烹饪步骤|做法|步骤)(?:\s*[：:]|$)"#
            }
        }
    }

    private static let numberedStep = try? NSRegularExpression(
        pattern: #"^([0-9０-９]{1,2})(?:\uFE0F?\u20E3|[.．、)）：:])\s*"#
    )

    init(noteBody: String) {
        let text = Self.prefix(noteBody, utf16Limit: 24_000)
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: #"[\r\u0085\u2028\u2029]"#, with: "\n", options: .regularExpression)
            .replacingOccurrences(of: #"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2060\u2066-\u2069\uFEFF]"#,
                                  with: "", options: .regularExpression)
        var section: Section?
        var ingredientLines: [String] = []
        var stepLines: [String] = []
        var sawIngredients = false
        var sawSteps = false
        var lastStep = 0

        for rawLine in text.components(separatedBy: "\n") {
            var line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("#") {
                section = nil
                continue
            }
            if line.isEmpty {
                if section == .ingredients && !ingredientLines.isEmpty {
                    section = nil
                }
                continue
            }
            if let heading = Self.heading(in: line) {
                switch heading.section {
                case .ingredients where !sawIngredients:
                    section = .ingredients
                    sawIngredients = true
                case .steps where !sawSteps:
                    section = .steps
                    sawSteps = true
                default:
                    section = nil
                }
                line = heading.remainder
                if line.isEmpty { continue }
                if section == .steps, Self.step(in: line) == nil {
                    let content = Self.beforeTopics(line)
                    if !content.isEmpty { stepLines.append(content) }
                    section = nil
                    continue
                }
            }

            let content = Self.beforeTopics(line)
            switch section {
            case .ingredients:
                ingredientLines += content.components(separatedBy: "、").map {
                    $0.trimmingCharacters(in: .whitespacesAndNewlines)
                }.filter { !$0.isEmpty }
            case .steps:
                guard let step = Self.step(in: content), step.number > lastStep else {
                    section = nil
                    continue
                }
                lastStep = step.number
                stepLines.append(step.text)
            case nil:
                continue
            }
        }

        ingredients = Self.join(ingredientLines, utf16Limit: 3_000)
        steps = Self.join(stepLines, utf16Limit: 6_000)
    }

    private static func heading(in line: String) -> (section: Section, remainder: String)? {
        for section in [Section.ingredients, .steps] {
            if let match = line.range(of: section.heading, options: .regularExpression) {
                return (section, String(line[match.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
        return nil
    }

    private static func step(in line: String) -> (number: Int, text: String)? {
        let source = line as NSString
        guard let match = numberedStep?.firstMatch(in: line, range: NSRange(location: 0, length: source.length)) else { return nil }
        // A keycap's captured digit ends inside the full grapheme. Match the regex's UTF-16 coordinates here.
        let number = source.substring(with: match.range(at: 1)).reduce(0) { $0 * 10 + ($1.wholeNumberValue ?? 0) }
        let text = source.substring(from: NSMaxRange(match.range)).trimmingCharacters(in: .whitespacesAndNewlines)
        return number > 0 && !text.isEmpty ? (number, text) : nil
    }

    private static func beforeTopics(_ line: String) -> String {
        let topic = line.range(of: #"#[^#]{1,80}\[话题\]#|(?:^|\s)#[^\s#]+"#, options: .regularExpression)
        return String(line[..<(topic?.lowerBound ?? line.endIndex)]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func join(_ lines: [String], utf16Limit: Int) -> String? {
        let text = prefix(lines.joined(separator: "\n"), utf16Limit: utf16Limit)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private static func prefix(_ text: String, utf16Limit: Int) -> String {
        var available = utf16Limit
        return String(text.prefix { character in
            available -= String(character).utf16.count
            return available >= 0
        })
    }
}
