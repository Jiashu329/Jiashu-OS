import Foundation

struct NativeLifeItem: Identifiable {
    let raw: NativeJSON
    var id: String { [profile, domain, subjectID].joined(separator: ":") }
    var profile: String { raw["profileId"].stringValue ?? "" }
    var domain: String { raw["domain"].stringValue ?? "" }
    var subjectID: String { raw["subjectId"].stringValue ?? "" }
    var title: String { raw["title"].stringValue ?? "未命名作品" }
    var kind: String { raw["kind"].stringValue ?? domain }
    var revision: Int { raw["local"]["revision"].intValue ?? 0 }
    var updatedAt: String { raw["updatedAt"].stringValue ?? "" }
    var note: String { raw["local"]["note"].stringValue ?? "" }
    var tags: [String] { raw["local"]["tags"].arrayValue.compactMap(\.stringValue) }
    var hidden: Bool { raw["local"]["hidden"].boolValue ?? false }
    var key: [String: NativeJSON] { ["profileId": .string(profile), "domain": .string(domain), "subjectId": .string(subjectID)] }
    var kindLabel: String { NativeLifeContract.kindLabels[kind] ?? kind }

    /// Only the original import schema is sent back; local annotations and provider
    /// caches must never be mixed into the imported source snapshot.
    func personalSnapshot(rating: Int?, date: String?, comment: String?) -> NativeJSON {
        var fields: [String: NativeJSON] = [:]
        for name in ["domain", "subjectId", "title", "url", "kind", "coverUrl", "publishedAt"] { fields[name] = raw[name] }
        fields["rating"] = rating.map { .number(Double($0)) } ?? .null
        fields["markedDate"] = date.map(NativeJSON.string) ?? .null
        fields["comment"] = comment.map(NativeJSON.string) ?? .null
        fields["source"] = .string("import")
        if !raw["details"].objectValue.isEmpty { fields["details"] = raw["details"] }
        return .object(fields)
    }
}

struct NativeLifeFilters: Equatable {
    var kind = "all", query = "", profile = "all", rating = "", year = "", sort = "date-desc", hidden = "visible", tag = ""
    var missing = false
    var activeChips: [(key: String, title: String)] {
        var chips: [(String, String)] = []
        if profile == "current" { chips.append(("profile", "当前来源")) }
        if !rating.isEmpty { chips.append(("rating", rating == "unrated" ? "未评分" : rating + "星")) }
        if !year.isEmpty { chips.append(("year", year + "年")) }
        if !tag.isEmpty { chips.append(("tag", tag)) }
        if hidden != "visible" { chips.append(("hidden", hidden == "hidden" ? "已隐藏" : "包含隐藏")) }
        if missing { chips.append(("missing", "待补全")) }
        if sort != "date-desc" { chips.append(("sort", ["date-asc": "日期从早到晚", "rating-desc": "评分从高到低", "rating-asc": "评分从低到高"][sort] ?? "已排序")) }
        return chips
    }
    mutating func removeChip(_ key: String) {
        switch key {
        case "profile": profile = "all"
        case "rating": rating = ""
        case "year": year = ""
        case "tag": tag = ""
        case "hidden": hidden = "visible"
        case "missing": missing = false
        case "sort": sort = "date-desc"
        default: break
        }
    }
    func path(offset: Int = 0) -> String {
        var components = URLComponents()
        components.path = "life/douban"
        var values = ["kind": kind, "q": query, "profile": profile, "sort": sort, "hidden": hidden, "offset": String(offset), "limit": "24"]
        if !rating.isEmpty { values["rating"] = rating }
        if !year.isEmpty { values["year"] = year }
        if !tag.isEmpty { values["tag"] = tag }
        if missing { values["missing"] = "1" }
        components.queryItems = values.keys.sorted().map { URLQueryItem(name: $0, value: values[$0]) }
        return components.string ?? "life/douban"
    }
}

enum NativeLifeContract {
    static let kindLabels = ["all": "全部收藏", "movie": "电影", "series": "电视剧", "screen": "待分类影视", "book": "书籍", "music": "音乐"]
    static let kinds = ["all", "movie", "series", "book", "music", "screen"]
    static func localBody(item: NativeLifeItem, epoch: Int, note: String, tags: [String], hidden: Bool) throws -> NativeJSON {
        guard note.utf16.count <= 4000, tags.count <= 12, Set(tags).count == tags.count,
              tags.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 30 }) else { throw NativeLifeError.invalid("备注最多4000字，标签最多12个、每个30字且不重复。") }
        var result = item.key
        result["expectedDataEpoch"] = .number(Double(epoch)); result["expectedLocalRevision"] = .number(Double(item.revision))
        result["note"] = .string(note); result["tags"] = .array(tags.map(NativeJSON.string)); result["hidden"] = .bool(hidden)
        return .object(result)
    }
    static func metadataBody(item: NativeLifeItem, epoch: Int, includeCheck: Bool = false) -> NativeJSON {
        var value = item.key
        value["expectedUpdatedAt"] = .string(item.updatedAt); value["expectedDataEpoch"] = .number(Double(epoch)); value["confirmed"] = .bool(true)
        if includeCheck { value["expectedDetailsCheckedAt"] = item.raw["sync"]["detailsCheckedAt"] }
        return .object(value)
    }
    static func ratingsBody(items: [NativeLifeItem], epoch: Int, requestID: String = UUID().uuidString.lowercased()) -> NativeJSON {
        .object(["requestId": .string(requestID), "expectedDataEpoch": .number(Double(epoch)), "confirmed": .bool(true),
                 "items": .array(items.filter { $0.domain == "screen" && $0.raw["details"]["imdbId"].stringValue != nil }.prefix(50).map { item in
                     var value = item.key; value["expectedUpdatedAt"] = .string(item.updatedAt); value["expectedImdbId"] = item.raw["details"]["imdbId"]; return .object(value)
                 })])
    }
    static func resetBody(preview: NativeJSON, requestID: String = UUID().uuidString.lowercased()) -> NativeJSON {
        .object(["action": .string("commit"), "expectedEpoch": preview["epoch"], "expectedPreviewHash": preview["previewHash"], "requestId": .string(requestID), "confirmed": .bool(true)])
    }
    static func importBody(profile: String, items: [NativeJSON], epoch: Int, preview: NativeJSON? = nil, requestID: String = UUID().uuidString.lowercased()) -> NativeJSON {
        var value: [String: NativeJSON] = ["action": .string(preview == nil ? "preview" : "commit"), "profile": .string(profile), "items": .array(items), "expectedDataEpoch": .number(Double(epoch))]
        if let preview { value["expectedSnapshotHash"] = preview["snapshotHash"]; value["requestId"] = .string(requestID); value["confirmed"] = .bool(true) }
        return .object(value)
    }
    static func protectedCoverPath(item: NativeLifeItem) -> String {
        var parts = URLComponents(); parts.path = "life/douban/cover"
        parts.queryItems = [URLQueryItem(name: "profileId", value: item.profile), URLQueryItem(name: "domain", value: item.domain), URLQueryItem(name: "subjectId", value: item.subjectID)]
        return parts.string ?? "life/douban/cover"
    }
    /// This URL is used only in a credential-free image request. Authenticated
    /// original covers always use the owner-scoped same-origin cover endpoint.
    static func publicImageURL(_ value: String?) -> URL? {
        guard let value, value.utf8.count <= 2000, let url = URL(string: value), url.scheme == "https", let host = url.host?.lowercased(),
              url.user == nil, url.password == nil, url.port == nil || url.port == 443,
              !host.isEmpty, host.contains("."), !host.hasSuffix("."), !host.hasPrefix("["),
              !host.allSatisfy({ $0.isNumber || $0 == "." }),
              !["localhost", "local", "internal", "lan", "home", "test", "invalid"].contains(where: { host == $0 || host.hasSuffix("." + $0) }),
              !value.contains(where: { $0.isWhitespace || $0 == "\\" }) else { return nil }
        return url
    }
    static func profileID(_ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        var result = trimmed
        if trimmed.hasPrefix("https://") {
            guard let url = URL(string: trimmed), ["douban.com", "www.douban.com"].contains(url.host ?? ""), url.user == nil, url.password == nil, url.port == nil,
                  url.query == nil, url.fragment == nil, url.path.hasPrefix("/people/") else { throw NativeLifeError.invalid("请填写豆瓣主页链接或主页ID。") }
            let parts = url.path.split(separator: "/")
            guard parts.count == 2, parts[0] == "people" else { throw NativeLifeError.invalid("豆瓣主页链接格式不正确。") }
            result = String(parts[1])
        }
        guard result.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", options: .regularExpression) != nil else { throw NativeLifeError.invalid("豆瓣主页ID格式不正确。") }
        return result
    }
}

enum NativeLifeError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}

struct NativeLifeImportResult {
    var items: [NativeJSON]
    var skipped: Int = 0
    var duplicates: Int = 0
}

struct NativeLifeLocalDraft: Codable {
    var note: String
    var tags: String
    var hidden: Bool
    var kind: String
    var coverURL: String
}

struct NativeLifeImportDraft: Codable {
    var profile: String
    var items: [NativeJSON]
    var preview: NativeJSON
    var skipped: Int
    var duplicates: Int
}

/// A preview belongs to one frozen source selection. An old response cannot
/// advance a new import, a different account, or a dismissed editor.
struct NativeLifePreviewGate {
    struct Ticket: Equatable { let id: UUID; let owner: String; let profile: String }
    private var current: Ticket?
    mutating func begin(owner: String, profile: String) -> Ticket {
        let ticket = Ticket(id: UUID(), owner: owner, profile: profile)
        current = ticket
        return ticket
    }
    mutating func invalidate() { current = nil }
    func accepts(_ ticket: Ticket, owner: String, profile: String, visible: Bool) -> Bool {
        visible && current == ticket && ticket.owner == owner && ticket.profile == profile
    }
}

/// Inert local text parsing: no browser, remote reads, or provider credentials.
enum NativeLifeImportParser {
    static func parse(files: [(name: String, data: Data)], profile: String, confirmMissingStatus: Bool) throws -> NativeLifeImportResult {
        guard (1...100).contains(files.count) else { throw NativeLifeError.invalid("请选择1–100个文本导出文件。") }
        let profileID = try NativeLifeContract.profileID(profile)
        var result = NativeLifeImportResult(items: [])
        var seen: [String: NativeJSON] = [:]
        var inputBytes = 0
        var inputRows = 0
        for file in files {
            guard file.data.count <= 8 * 1024 * 1024 - inputBytes,
                  let decoded = String(data: file.data, encoding: .utf8) else { throw NativeLifeError.invalid("请选择合计不超过8MiB的UTF-8文本资料。") }
            inputBytes += file.data.count
            let text = decoded.first == "\u{FEFF}" ? String(decoded.dropFirst()) : decoded
            let ext = (file.name as NSString).pathExtension.lowercased()
            let (rows, explicit) = try readRows(text, ext: ext, bytes: file.data.count, profile: profileID)
            guard rows.count <= 500 - inputRows else { throw NativeLifeError.invalid("一次最多预览500条输入记录。") }
            inputRows += rows.count
            for row in rows {
                try rejectSecrets(row)
                guard case .object = row else { throw NativeLifeError.invalid("导入条目需为有名称和豆瓣链接的对象。") }
                let claimed = try agreed(row, ["profileId", "sourceProfile"])
                guard claimed == .null || claimed == .string(profileID) else { throw NativeLifeError.invalid("文件中的来源主页与本次选择不一致。") }
                let identity = try subject(row)
                let status = try agreed(row, ["state", "status", "myState", "collectionStatus", "状态", "收藏状态"])
                guard try completed(status, domain: identity.domain, confirmed: confirmMissingStatus) else { result.skipped += 1; continue }
                let item = try normalized(row, explicit: explicit, subject: identity)
                let key = identity.domain + ":" + identity.id
                if let existing = seen[key] {
                    guard existing == item else { throw NativeLifeError.invalid("同一作品有冲突的评分、短评或资料，请先保留正确的一份。") }
                    result.duplicates += 1
                } else { seen[key] = item; result.items.append(item) }
            }
        }
        return result
    }

    private static func readRows(_ text: String, ext: String, bytes: Int, profile: String) throws -> (rows: [NativeJSON], explicit: Bool) {
        if ext == "csv" {
            let table = try csv(text)
            guard let names = table.first, !names.isEmpty, names.count <= 100, names.allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty && $0.utf16.count <= 100 }), Set(names.map(keyName)).count == names.count else { throw NativeLifeError.invalid("CSV列名重复或缺失。") }
            let rows = try table.dropFirst().filter { !$0.allSatisfy { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }.map { line -> NativeJSON in
                guard line.count == names.count else { throw NativeLifeError.invalid("CSV列数不一致，请核对引号和分隔符。") }
                var values: [String: NativeJSON] = [:]
                for (name, value) in zip(names, line) {
                    if name == "details", !value.isEmpty { values[name] = try JSONDecoder().decode(NativeJSON.self, from: Data(value.utf8)) }
                    else { values[name] = .string(value) }
                }
                return .object(values)
            }
            return (rows, false)
        }
        if ["md", "markdown"].contains(ext) { return ([try markdown(text)], false) }
        if ["html", "htm"].contains(ext) {
            guard bytes <= 2 * 1024 * 1024 else { throw NativeLifeError.invalid("单份HTML不能超过2MiB。") }
            return (try html(text, profile: profile), false)
        }
        let parsed = try JSONDecoder().decode(NativeJSON.self, from: Data(text.utf8))
        try rejectSecrets(parsed)
        if case .array(let rows) = parsed { return (rows, false) }
        let fields = parsed.objectValue
        let format = NativeJSON.string("jiashu-douban-import-v1")
        if fields["items"] != nil || fields["format"] == format {
            guard fields.keys.allSatisfy({ ["format", "items", "profileId"].contains($0) }),
                  fields["format"] == nil || fields["format"] == format,
                  let items = fields["items"], case .array(let rows) = items else { throw NativeLifeError.invalid("JSON导入清单格式不正确。") }
            guard fields["profileId"] == nil || fields["profileId"] == .string(profile) else { throw NativeLifeError.invalid("JSON中的来源主页与本次选择不一致。") }
            return (rows, fields["format"] == format)
        }
        return ([parsed], false)
    }

    private static func agreed(_ row: NativeJSON, _ aliases: [String]) throws -> NativeJSON {
        let keys = Set(aliases.map(keyName))
        let values = row.objectValue.filter { keys.contains(keyName($0.key)) }.map(\.value).filter {
            if $0 == .null { return false }
            guard let value = $0.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) else { return true }
            return !value.isEmpty && value.range(of: "^(?:null|~|\\{\\{[^{}]+\\}\\})$", options: [.regularExpression, .caseInsensitive]) == nil
        }
        guard let value = values.first else { return .null }
        guard values.allSatisfy({ $0 == value }) else { throw NativeLifeError.invalid("同一条目含有相互冲突的来源或状态字段。") }
        return value
    }

    private static func completed(_ status: NativeJSON, domain: String, confirmed: Bool) throws -> Bool {
        if status == .null { return confirmed }
        guard let value = status.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else { throw NativeLifeError.invalid("收藏状态需为文字。") }
        if ["collect", "collected", "completed", "complete", "done", "完成", "已完成"].contains(value) { return true }
        switch domain {
        case "screen": return ["看过", "已看", "watched"].contains(value)
        case "book": return ["读过", "已读", "read"].contains(value)
        default: return ["听过", "已听", "listened"].contains(value)
        }
    }

    static func normalize(_ row: NativeJSON, explicit: Bool) throws -> NativeJSON {
        try normalized(row, explicit: explicit, subject: subject(row))
    }

    private struct Subject {
        let domain: String
        let id: String
        let kind: String
        let url: String
    }

    private static func subject(_ row: NativeJSON) throws -> Subject {
        var rawURL = first(row, ["url", "subjectUrl", "doubanUrl", "link", "豆瓣链接", "条目链接", "链接"]).stringValue ?? ""
        let rawKind = first(row, ["kind", "type", "类型", "分类"]).stringValue?.lowercased() ?? ""
        let kinds = ["movie": "movie", "film": "movie", "电影": "movie", "series": "series", "tv": "series", "tvseries": "series", "teleplay": "series", "电视剧": "series", "剧集": "series", "screen": "screen", "影视": "screen", "待分类影视": "screen", "book": "book", "books": "book", "书": "book", "书籍": "book", "图书": "book", "music": "music", "album": "music", "音乐": "music", "专辑": "music"]
        let idValue = first(row, ["subjectId", "doubanId", "条目ID"])
        let explicitID = idValue.stringValue ?? idValue.intValue.map(String.init) ?? ""
        if rawURL.isEmpty, let kind = kinds[rawKind], !explicitID.isEmpty {
            let host = ["movie": "movie.douban.com", "series": "movie.douban.com", "screen": "movie.douban.com", "book": "book.douban.com", "music": "music.douban.com"][kind] ?? ""
            rawURL = "https://" + host + "/subject/" + explicitID + "/"
        }
        guard !rawURL.contains("%"), !rawURL.contains("\\") else { throw NativeLifeError.invalid("作品链接不能包含转义路径或反斜线。") }
        guard let url = URL(string: rawURL), ["https", "http"].contains(url.scheme ?? ""), url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              let domain = ["movie.douban.com": "screen", "book.douban.com": "book", "music.douban.com": "music"][url.host ?? ""],
              url.path.range(of: "^/subject/[1-9][0-9]{0,15}/?$", options: .regularExpression) != nil else { throw NativeLifeError.invalid("请使用无额外参数的豆瓣作品完整链接。") }
        let subject = String(url.path.split(separator: "/").last ?? "")
        let claimedDomain = try agreed(row, ["domain"])
        guard explicitID.isEmpty || explicitID == subject, claimedDomain == .null || claimedDomain == .string(domain) else { throw NativeLifeError.invalid("作品ID或来源分类与链接不一致。") }
        guard let kind = rawKind.isEmpty ? domain : kinds[rawKind], domain == "screen" ? ["movie", "series", "screen"].contains(kind) : kind == domain else { throw NativeLifeError.invalid("作品类型与豆瓣来源不一致。") }
        return Subject(domain: domain, id: subject, kind: kind, url: "https://" + (url.host ?? "") + "/subject/" + subject + "/")
    }

    private static func normalized(_ row: NativeJSON, explicit: Bool, subject: Subject) throws -> NativeJSON {
        let title = first(row, ["title", "name", "名称", "标题"]).stringValue ?? ""
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.utf16.count <= 500 else { throw NativeLifeError.invalid("作品名称需为1–500字。") }
        let ratingValue = first(row, explicit ? ["rating", "myRating", "personalRating", "userRating", "个人评分"] : ["myRating", "personalRating", "userRating", "个人评分"])
        let ratingText = ratingValue.stringValue ?? ""
        let rating = ratingValue.doubleValue ?? Double(ratingText)
        if !ratingText.trimmingCharacters(in: .whitespaces).isEmpty && rating == nil { throw NativeLifeError.invalid("个人评分需为1–5星的数字。") }
        if let rating, rating < 1 || rating > 5 || rating.rounded() != rating { throw NativeLifeError.invalid("个人评分为1–5星，未评分请留空。") }
        let dateText = first(row, ["markedDate", "myCollectionDate", "collectionDate", "标记日期"]).stringValue ?? ""
        if !dateText.isEmpty {
            let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
            guard let day = formatter.date(from: dateText), formatter.string(from: day) == dateText, dateText >= "1970-01-01", dateText <= "2100-12-31" else { throw NativeLifeError.invalid("标记日期需为1970–2100年真实的YYYY-MM-DD日期。") }
        }
        let comment = first(row, ["myComment", "comment", "personalComment", "个人短评", "短评"]).stringValue ?? ""
        guard comment.utf16.count <= 2000 else { throw NativeLifeError.invalid("个人短评最多2000字。") }
        var result: [String: NativeJSON] = ["domain": .string(subject.domain), "subjectId": .string(subject.id), "title": .string(title), "url": .string(subject.url), "kind": .string(subject.kind), "coverUrl": .null, "rating": rating.map(NativeJSON.number) ?? .null, "markedDate": dateText.isEmpty ? .null : .string(dateText), "comment": comment.isEmpty ? .null : .string(comment), "publishedAt": .null, "source": .string("import")]
        if let cover = first(row, ["coverUrl", "image", "cover", "封面"]).stringValue, let coverURL = URL(string: cover), coverURL.host?.range(of: "^img[0-9]{1,2}\\.doubanio\\.com$", options: .regularExpression) != nil, ["https", "http"].contains(coverURL.scheme ?? ""), coverURL.user == nil, coverURL.password == nil, coverURL.port == nil, coverURL.query == nil, coverURL.fragment == nil { result["coverUrl"] = .string(cover.replacingOccurrences(of: "http://", with: "https://")) }
        let details = try mappedDetails(row, domain: subject.domain)
        if !details.objectValue.isEmpty { result["details"] = details }
        return .object(result)
    }
    static func first(_ row: NativeJSON, _ keys: [String]) -> NativeJSON {
        for key in keys { for (candidate, value) in row.objectValue where keyName(candidate) == keyName(key) { if value != .null, value.stringValue != "" { return value } } }
        return .null
    }
    static func keyName(_ value: String) -> String { value.lowercased().filter { !$0.isWhitespace && $0 != "_" && $0 != "-" } }
    static func mappedDetails(_ row: NativeJSON, domain: String) throws -> NativeJSON {
        var fields = row["details"].objectValue
        if let text = row["details"].stringValue, !text.isEmpty { fields = try JSONDecoder().decode(NativeJSON.self, from: Data(text.utf8)).objectValue }
        if row.objectValue["details"] == nil {
            var definitions: [(String, [String], String)] = [("summary", ["summary", "desc", "简介"], "text"), ("alternateTitles", ["alternateTitles", "originalTitle", "aliases"], "list"), ("genres", ["genres", "genre", "类型标签"], "list"), ("countries", ["countries", "country", "国家"], "list"), ("languages", ["languages", "language", "语言"], "list"), ("year", ["year", "年份"], "number"), ("doubanRating", ["doubanRating", "doubanScore", "score", "豆瓣评分"], "number"), ("ratingCount", ["ratingCount", "评分人数"], "number")]
            if domain == "screen" { definitions += [("imdbId", ["imdbId", "IMDb"], "text"), ("directors", ["directors", "director", "导演"], "list"), ("writers", ["writers", "author", "编剧"], "list"), ("cast", ["cast", "actor", "actors", "主演", "演员"], "list"), ("releaseDates", ["releaseDates", "datePublished", "上映日期"], "list"), ("duration", ["duration", "time", "片长"], "text"), ("episodes", ["episodes", "episode", "集数"], "number"), ("seasons", ["seasons", "季数"], "number"), ("episodeDuration", ["episodeDuration", "单集片长"], "text")] }
            else if domain == "book" { definitions += [("authors", ["authors", "author", "作者"], "list"), ("translators", ["translators", "translator", "译者"], "list"), ("publisher", ["publisher", "出版社"], "text"), ("publicationDate", ["publicationDate", "datePublished", "出版日期"], "text"), ("isbn", ["isbn"], "text"), ("binding", ["binding", "装帧"], "text"), ("price", ["price", "定价"], "text"), ("seriesTitle", ["seriesTitle", "series", "丛书"], "text"), ("pages", ["pages", "totalPage", "页数"], "number")] }
            else { definitions += [("artists", ["artists", "artist", "actor", "表演者"], "list"), ("albumType", ["albumType", "专辑类型"], "text"), ("medium", ["medium", "介质"], "text"), ("label", ["label", "publisher", "唱片公司"], "text"), ("releaseDate", ["releaseDate", "datePublished", "发行日期"], "text"), ("tracks", ["tracks", "曲目"], "list")] }
            for (key, aliases, mode) in definitions {
                let value = first(row, aliases); if value == .null { continue }
                if mode == "number" { fields[key] = value.doubleValue.map(NativeJSON.number) ?? value.stringValue.flatMap(Double.init).map(NativeJSON.number) ?? value }
                else if mode == "list" {
                    if !value.arrayValue.isEmpty { fields[key] = value }
                    else if let text = value.stringValue {
                        if text.hasPrefix("[") {
                            if let list = try? JSONDecoder().decode(NativeJSON.self, from: Data(text.utf8)), !list.arrayValue.isEmpty { fields[key] = list }
                            else { let inner = String(text.dropFirst().dropLast()); guard !inner.contains(where: { "[]{}!&*\"'".contains($0) }), text.hasSuffix("]") else { throw NativeLifeError.invalid("作品详情列表格式不正确。") }; fields[key] = .array(inner.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) }) }
                        } else { fields[key] = .array(text.components(separatedBy: " / ").flatMap { $0.components(separatedBy: "、") }.filter { !$0.isEmpty }.map(NativeJSON.string)) }
                    } else { fields[key] = value }
                } else { fields[key] = value }
            }
        }
        let textLimits = ["summary": 12000, "duration": 100, "episodeDuration": 100, "publisher": 500, "publicationDate": 100, "isbn": 64, "binding": 500, "price": 100, "seriesTitle": 500, "albumType": 500, "medium": 500, "label": 500, "releaseDate": 100]
        let listLimits = ["alternateTitles": (50, 500), "genres": (100, 200), "countries": (100, 200), "languages": (100, 200), "directors": (100, 200), "writers": (100, 200), "cast": (100, 200), "releaseDates": (50, 300), "authors": (100, 200), "translators": (100, 200), "artists": (100, 200), "tracks": (300, 500)]
        let numberLimits: [String: (Double, Double, Bool)] = ["year": (1, 2100, true), "doubanRating": (0, 10, false), "ratingCount": (0, 1_000_000_000, true), "episodes": (1, 100_000, true), "seasons": (1, 10_000, true), "pages": (1, 1_000_000, true)]
        for (key, value) in fields where value != .null {
            if let limit = textLimits[key] { guard let text = value.stringValue, text.utf16.count <= limit, text.range(of: "</?[A-Za-z][^>]*>|<!--", options: .regularExpression) == nil else { throw NativeLifeError.invalid("作品详情文字格式或长度不正确。") } }
            else if let (count, length) = listLimits[key] { guard value.arrayValue.count <= count, case .array = value, value.arrayValue.allSatisfy({ $0.stringValue.map { $0.utf16.count <= length && !$0.isEmpty && !$0.contains("<") } ?? false }) else { throw NativeLifeError.invalid("作品详情列表格式或长度不正确。") } }
            else if let (lower, upper, integer) = numberLimits[key] { guard let number = value.doubleValue, number >= lower, number <= upper, !integer || number.rounded() == number else { throw NativeLifeError.invalid("作品详情数值超出范围。") } }
            else if key == "imdbId" { guard value.stringValue?.range(of: "^tt[0-9]{7,10}$", options: .regularExpression) != nil else { throw NativeLifeError.invalid("IMDb编号不正确。") } }
            else { throw NativeLifeError.invalid("作品详情包含不支持的字段。") }
        }
        let result = NativeJSON.object(fields)
        guard try result.encodedData().count <= 16 * 1024 else { throw NativeLifeError.invalid("单部作品详情不能超过16KiB。") }
        return result
    }
    static func rejectSecrets(_ value: NativeJSON, depth: Int = 0) throws {
        guard depth <= 12 else { throw NativeLifeError.invalid("资料嵌套过深。") }
        let secret = ["cookie", "cookies", "password", "passwd", "authorization", "token", "session", "accesstoken", "refreshtoken", "authtoken", "sessiontoken", "dbcl2", "apikey", "secret", "__proto__", "prototype", "constructor"]
        for (key, nested) in value.objectValue {
            let normalized = key.lowercased().filter { !$0.isWhitespace && $0 != "_" && $0 != "-" }
            guard !secret.contains(normalized), !["__proto__", "prototype", "constructor"].contains(key) else { throw NativeLifeError.invalid("资料含登录凭据字段，请移除密码、Cookie或令牌。") }
            try rejectSecrets(nested, depth: depth + 1)
        }
        for nested in value.arrayValue { try rejectSecrets(nested, depth: depth + 1) }
    }
    static func csv(_ text: String) throws -> [[String]] {
        var rows: [[String]] = [], row: [String] = [], field = "", quoted = false, afterQuote = false
        let chars = Array(text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")); var index = 0
        while index < chars.count {
            let c = chars[index]
            if quoted {
                if c == "\"" { if index + 1 < chars.count && chars[index + 1] == "\"" { field.append("\""); index += 1 } else { quoted = false; afterQuote = true } }
                else { field.append(c) }
            } else if c == "," { row.append(field); field = ""; afterQuote = false }
            else if c == "\n" { row.append(field); rows.append(row); row = []; field = ""; afterQuote = false }
            else if c == "\"" && field.isEmpty && !afterQuote { quoted = true }
            else { guard !afterQuote else { throw NativeLifeError.invalid("CSV引号之后只能有逗号或换行。") }; field.append(c) }
            index += 1
        }
        guard !quoted else { throw NativeLifeError.invalid("CSV引号未闭合。") }
        if !field.isEmpty || !row.isEmpty { row.append(field); rows.append(row) }
        return rows
    }
    static func markdown(_ text: String) throws -> NativeJSON {
        guard !text.contains("<script"), text.hasPrefix("---"), let close = text.dropFirst(3).range(of: "\n---") else { throw NativeLifeError.invalid("请选择包含简单顶部字段的豆瓣Markdown笔记。") }
        let header = String(text[text.index(text.startIndex, offsetBy: 3)..<close.lowerBound]); var row: [String: NativeJSON] = [:]
        for line in header.split(separator: "\n") {
            guard !line.hasPrefix(" "), !line.contains("&"), !line.contains("*"), let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces), raw = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            if !key.isEmpty { row[key] = .string(raw.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))) }
        }
        if let range = text.range(of: "Comment:") { row["myComment"] = .string(String(text[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)) }
        return .object(row)
    }
    static func html(_ text: String, profile: String) throws -> [NativeJSON] {
        // Parse only inert saved completed list records. No WebView/DOM/network is used.
        guard !text.localizedCaseInsensitiveContains("<!ENTITY"), text.components(separatedBy: "<").count <= 30_001 else { throw NativeLifeError.invalid("HTML文档声明或结构不受支持。") }
        let inert = text.replacingOccurrences(of: "(?is)<script\\b[^>]*>.*?</script>|<style\\b[^>]*>.*?</style>", with: "", options: .regularExpression)
        let heading = plain(matches("(?is)<h1[^>]*>(.*?)</h1>", inert).first?[1] ?? matches("(?is)<title[^>]*>(.*?)</title>", inert).first?[1] ?? "")
        let inferred: String
        if heading.range(of: "看过的(?:电影|电视剧|影视)", options: .regularExpression) != nil { inferred = "screen" }
        else if heading.contains("读过的书") { inferred = "book" }
        else if heading.contains("听过的音乐") { inferred = "music" }
        else { throw NativeLifeError.invalid("HTML需为看过、读过或听过的收藏列表，不能是登录、验证或作品详情页。") }
        let hosts = ["screen": "movie.douban.com", "book": "book.douban.com", "music": "music.douban.com"]
        for tag in matches("(?is)<(?:link|meta)\\b[^>]*>", inert).map({ $0[0] }) {
            let canonical = attribute(tag, "rel") == "canonical" ? attribute(tag, "href") : attribute(tag, "property") == "og:url" ? attribute(tag, "content") : nil
            if let canonical {
                guard let url = URL(string: canonical), ["http", "https"].contains(url.scheme ?? ""), url.host == hosts[inferred], url.user == nil, url.password == nil, url.port == nil,
                      url.path == "/people/" + profile + "/collect" || url.path == "/people/" + profile + "/collect/" else { throw NativeLifeError.invalid("HTML来源主页与本次导入不一致。") }
            }
        }
        let opening = "<(?:div|li)\\b[^>]*class=[\"'][^\"']*(?<![A-Za-z0-9_-])(?:item-show|subject-item|item)(?![A-Za-z0-9_-])[^\"']*[\"'][^>]*>"
        let pattern = "(?is)" + opening + "(.*?)(?=" + opening + "|$)"
        let chunks = matches(pattern, inert).map { $0[1] }
        guard !chunks.isEmpty, chunks.count <= 30 else { throw NativeLifeError.invalid("单份HTML需为最多30条的豆瓣已完成收藏列表。") }
        return try chunks.map { chunk in
            let links = matches("(?is)<a\\b[^>]*href=[\"'](https?://(?:movie|book|music)\\.douban\\.com/subject/[0-9]+/)[\"'][^>]*>(.*?)</a>", chunk)
            guard let link = links.first(where: { !plain($0[2]).isEmpty }) else { throw NativeLifeError.invalid("无法核对HTML中的作品名称与链接。") }
            guard URL(string: link[1])?.host == hosts[inferred] else { throw NativeLifeError.invalid("HTML作品链接与收藏类型不一致。") }
            var row: [String: NativeJSON] = ["title": .string(plain(link[2])), "url": .string(link[1]), "state": .string("collect")]
            if let rating = matches("rating([1-5])-t", chunk).first?[1] { row["myRating"] = .string(rating) }
            if let date = matches("class=[\"'][^\"']*date[^\"']*[\"'][^>]*>\\s*([0-9]{4}-[0-9]{2}-[0-9]{2})", chunk).first?[1] { row["collectionDate"] = .string(date) }
            if let comment = matches("(?is)<span[^>]*class=[\"'][^\"']*comment[^\"']*[\"'][^>]*>(.*?)</span>", chunk).first?[1] { row["myComment"] = .string(plain(comment)) }
            if let image = matches("(?is)<img\\b[^>]*>", chunk).first?[0], let source = attribute(image, "src") { row["coverUrl"] = .string(source) }
            var definitions: [(String, [String], Bool)] = [("summary", ["v:summary", "description"], false), ("doubanRating", ["v:average", "ratingValue"], false), ("ratingCount", ["v:votes", "ratingCount"], false)]
            if inferred == "screen" { definitions += [("directors", ["v:directedBy", "director"], true), ("cast", ["v:starring", "actor"], true)] }
            else if inferred == "book" { definitions += [("authors", ["author"], true), ("publisher", ["publisher"], false), ("isbn", ["isbn"], false)] }
            else { definitions += [("artists", ["byArtist"], true)] }
            for (key, properties, list) in definitions {
                var values: [String] = []
                for property in properties {
                    let pattern = "(?is)<([A-Za-z][A-Za-z0-9:-]*)\\b([^>]*\\b(?:itemprop|property|rel)=[\"']" + NSRegularExpression.escapedPattern(for: property) + "[\"'][^>]*)>(.*?)</\\1>"
                    for match in matches(pattern, chunk) { let value = attribute(match[2], "content") ?? plain(match[3]); if !value.isEmpty { values.append(value) } }
                    for match in matches("(?is)<meta\\b[^>]*(?:itemprop|property|rel)=[\"']" + NSRegularExpression.escapedPattern(for: property) + "[\"'][^>]*>", chunk) { if let value = attribute(match[0], "content"), !value.isEmpty { values.append(value) } }
                }
                if !values.isEmpty { row[key] = list ? .array(values.map(NativeJSON.string)) : .string(values[0]) }
            }
            return .object(row)
        }
    }
    static func attribute(_ tag: String, _ name: String) -> String? {
        matches("(?is)(?:^|\\s)" + NSRegularExpression.escapedPattern(for: name) + "\\s*=\\s*[\"']([^\"']*)[\"']", tag).first.map { plain($0[1]) }
    }
    static func matches(_ pattern: String, _ text: String) -> [[String]] {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
        let source = text as NSString
        return expression.matches(in: text, range: NSRange(location: 0, length: source.length)).map { match in
            (0..<match.numberOfRanges).map { index in let range = match.range(at: index); return range.location == NSNotFound ? "" : source.substring(with: range) }
        }
    }
    static func plain(_ html: String) -> String {
        html.replacingOccurrences(of: "(?is)<script\\b[^>]*>.*?</script>|<style\\b[^>]*>.*?</style>|<[^>]+>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&#39;", with: "'").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
