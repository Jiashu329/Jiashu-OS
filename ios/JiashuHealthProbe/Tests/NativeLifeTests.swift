import Foundation
import XCTest
@testable import JiashuHealthProbe

final class NativeLifeTests: XCTestCase {
    private func parse(_ text: String, name: String = "synthetic.json", confirm: Bool = false, profile: String = "synthetic_owner") throws -> NativeLifeImportResult {
        try NativeLifeImportParser.parse(data: Data(text.utf8), filename: name, profile: profile, confirmMissingStatus: confirm)
    }
    private var item: NativeLifeItem {
        NativeLifeItem(raw: .object(["profileId": .string("synthetic_owner"), "domain": .string("book"), "subjectId": .string("2345678"), "title": .string("合成书籍"), "kind": .string("book"), "url": .string("https://book.douban.com/subject/2345678/"), "updatedAt": .string("2026-11-17T00:00:00.000Z"), "local": .object(["revision": .number(7), "note": .string("旧备注"), "tags": .array([.string("旧标签")]), "hidden": .bool(false)])]))
    }
    func testGenericRatingIsNotPersonalAndSourceScoreStaysSeparate() throws {
        let result = try parse(#"[{"title":"合成电影","url":"https://movie.douban.com/subject/1234567/","state":"看过","rating":9,"score":8.8,"myRating":4,"director":"合成导演","desc":"来源简介"}]"#)
        XCTAssertEqual(result.items[0]["rating"].intValue, 4)
        XCTAssertEqual(result.items[0]["details"]["doubanRating"].doubleValue, 8.8)
        XCTAssertEqual(result.items[0]["details"]["summary"].stringValue, "来源简介")
        XCTAssertEqual(result.items[0]["details"]["directors"].arrayValue, [.string("合成导演")])
        XCTAssertEqual(result.items[0]["source"].stringValue, "import")
    }
    func testCanonicalPersonalRatingRequiresExplicitManifest() throws {
        let ordinary = try parse(#"[{"title":"合成电影","url":"https://movie.douban.com/subject/1234567/","state":"collect","rating":5}]"#)
        XCTAssertEqual(ordinary.items[0]["rating"], .null)
        let canonical = try parse(#"{"format":"jiashu-douban-import-v1","items":[{"title":"合成电影","url":"https://movie.douban.com/subject/1234567/","state":"collect","rating":5}]}"#)
        XCTAssertEqual(canonical.items[0]["rating"].intValue, 5)
    }
    func testMissingStatusNeedsConfirmationAndDoesNotPromoteWish() throws {
        let text = #"[{"title":"已核对作品","url":"https://book.douban.com/subject/2345678/"},{"title":"想读作品","url":"https://book.douban.com/subject/2345679/","state":"想读"}]"#
        XCTAssertThrowsError(try parse(text))
        let result = try parse(text, confirm: true)
        XCTAssertEqual(result.items.count, 1)
        XCTAssertEqual(result.skipped, 1)
    }
    func testMalformedRatingAndDateRejectWholeImport() {
        XCTAssertThrowsError(try parse(#"[{"title":"合成作品","url":"https://book.douban.com/subject/2345678/","state":"collect","myRating":"five"}]"#))
        XCTAssertThrowsError(try parse(#"[{"title":"合成作品","url":"https://book.douban.com/subject/2345678/","state":"collect","collectionDate":"2026-02-30"}]"#))
    }
    func testCredentialsAndForeignProfileCannotEnterNormalizedPayload() {
        XCTAssertThrowsError(try parse(#"[{"title":"合成作品","url":"https://book.douban.com/subject/2345678/","state":"collect","details":{"cookie":"synthetic-cookie"}}]"#))
        XCTAssertThrowsError(try parse(#"[{"title":"合成作品","url":"https://book.douban.com/subject/2345678/","state":"collect","profileId":"other_owner"}]"#))
    }
    func testDetailsUnknownFieldsAndExecutableMarkupAreRejectedLocally() {
        XCTAssertThrowsError(try parse(#"[{"title":"合成作品","url":"https://book.douban.com/subject/2345678/","state":"collect","details":{"unknown":"value"}}]"#))
        XCTAssertThrowsError(try parse(#"[{"title":"合成作品","url":"https://book.douban.com/subject/2345678/","state":"collect","details":{"summary":"<script>window.x=1</script>"}}]"#))
    }
    func testCSVQuotedCommentAndMetadataRemainDistinct() throws {
        let csv = "title,url,state,myRating,myComment,author,score\n\"合成,书名\",https://book.douban.com/subject/2345678/,读过,5,\"自己的,短评\",合成作者,8.6\n"
        let result = try parse(csv, name: "synthetic.csv")
        XCTAssertEqual(result.items[0]["title"].stringValue, "合成,书名")
        XCTAssertEqual(result.items[0]["comment"].stringValue, "自己的,短评")
        XCTAssertEqual(result.items[0]["details"]["authors"].arrayValue, [.string("合成作者")])
        XCTAssertEqual(result.items[0]["details"]["doubanRating"].doubleValue, 8.6)
    }
    func testObsidianIDTypeAndCommentImportWithoutRemoteReads() throws {
        let markdown = "---\ntitle: 合成书籍\ndoubanId: 2345678\ntype: book\nstate: 读过\nmyRating: 4\ncollectionDate: 2026-11-15\nauthor: 合成作者\n---\nComment: 自己的阅读短评"
        let result = try parse(markdown, name: "synthetic.md")
        XCTAssertEqual(result.items[0]["subjectId"].stringValue, "2345678")
        XCTAssertEqual(result.items[0]["comment"].stringValue, "自己的阅读短评")
        XCTAssertEqual(result.items[0]["markedDate"].stringValue, "2026-11-15")
    }
    func testSavedHTMLRequiresOwnerCompletedListAndNormalizesInertText() throws {
        let html = #"<html><link rel="canonical" href="https://book.douban.com/people/synthetic_owner/collect"><h1>合成用户读过的书</h1><div class="item"><a href="https://book.douban.com/subject/2345678/"><span>合成书籍</span></a><span class="rating4-t"></span><span class="date">2026-11-15</span><span class="comment">自己的短评</span><span itemprop="author">合成作者</span></div></html>"#
        let result = try parse(html, name: "synthetic.html")
        XCTAssertEqual(result.items[0]["title"].stringValue, "合成书籍")
        XCTAssertEqual(result.items[0]["rating"].intValue, 4)
        XCTAssertEqual(result.items[0]["details"]["authors"].arrayValue, [.string("合成作者")])
        XCTAssertThrowsError(try parse(html, name: "synthetic.html", profile: "different_owner"))
    }
    func testDuplicateContentsMergeButConflictingRecordsFail() throws {
        let same = #"{"title":"合成书籍","url":"https://book.douban.com/subject/2345678/","state":"collect","myRating":4}"#
        let result = try parse("[" + same + "," + same + "]")
        XCTAssertEqual(result.items.count, 1)
        XCTAssertEqual(result.duplicates, 1)
        let changed = same.replacingOccurrences(of: "\"myRating\":4", with: "\"myRating\":3")
        XCTAssertThrowsError(try parse("[" + same + "," + changed + "]"))
    }
    func testFiltersEncodeChineseAndSeparatorsWithoutChangingRoute() throws {
        var filters = NativeLifeFilters(); filters.query = "作者 & 书名"; filters.tag = "a/b"; filters.hidden = "all"; filters.rating = "unrated"; filters.missing = true
        let path = filters.path(offset: 24)
        let components = try XCTUnwrap(URLComponents(string: path))
        XCTAssertEqual(components.path, "life/douban")
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "q" })?.value, "作者 & 书名")
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "offset" })?.value, "24")
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "missing" })?.value, "1")
    }
    func testLocalUpdateIncludesOwnerKeyEpochAndCASWithoutImportedFields() throws {
        let body = try NativeLifeContract.localBody(item: item, epoch: 3, note: "新备注", tags: ["新标签"], hidden: true)
        XCTAssertEqual(body["expectedLocalRevision"].intValue, 7)
        XCTAssertEqual(body["expectedDataEpoch"].intValue, 3)
        XCTAssertEqual(body["profileId"].stringValue, "synthetic_owner")
        XCTAssertEqual(body["rating"], .null)
        XCTAssertThrowsError(try NativeLifeContract.localBody(item: item, epoch: 3, note: "", tags: ["重复", "重复"], hidden: false))
    }
    func testRemovingVisibleFilterChipKeepsSearchAndCollectionScope() throws {
        var filters = NativeLifeFilters()
        filters.kind = "book"; filters.query = "合成作者"; filters.rating = "5"; filters.tag = "重读"; filters.year = "2026"
        XCTAssertEqual(Set(filters.activeChips.map(\.key)), Set(["rating", "tag", "year"]))
        filters.removeChip("rating")
        let path = try XCTUnwrap(URLComponents(string: filters.path()))
        let query = Dictionary(uniqueKeysWithValues: (path.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertNil(query["rating"])
        XCTAssertEqual(query["kind"], "book")
        XCTAssertEqual(query["q"], "合成作者")
        XCTAssertEqual(query["tag"], "重读")
        XCTAssertEqual(query["year"], "2026")
    }
    func testHiddenAndMissingChipsRestoreDefaultFilterWithoutDroppingOtherConditions() {
        var filters = NativeLifeFilters()
        filters.hidden = "hidden"; filters.missing = true; filters.sort = "rating-desc"; filters.profile = "current"
        filters.removeChip("hidden"); filters.removeChip("missing")
        XCTAssertEqual(filters.hidden, "visible")
        XCTAssertFalse(filters.missing)
        XCTAssertEqual(filters.sort, "rating-desc")
        XCTAssertEqual(filters.profile, "current")
        let prior = filters; filters.removeChip("unrecognized")
        XCTAssertEqual(filters, prior)
    }
    func testImportPreviewRejectsDelayedReplyAfterChangingSourceLeavingOrSwitchingAccount() {
        var gate = NativeLifePreviewGate()
        let original = gate.begin(owner: "account-a", profile: "profile-a")
        XCTAssertTrue(gate.accepts(original, owner: "account-a", profile: "profile-a", visible: true))
        gate.invalidate()
        XCTAssertFalse(gate.accepts(original, owner: "account-a", profile: "profile-a", visible: true))
        let replacement = gate.begin(owner: "account-a", profile: "profile-b")
        XCTAssertFalse(gate.accepts(original, owner: "account-a", profile: "profile-b", visible: true))
        XCTAssertFalse(gate.accepts(replacement, owner: "account-b", profile: "profile-b", visible: true))
        XCTAssertFalse(gate.accepts(replacement, owner: "account-a", profile: "profile-b", visible: false))
        XCTAssertTrue(gate.accepts(replacement, owner: "account-a", profile: "profile-b", visible: true))
    }
    func testImportAndResetFrozenRequestsRetainSameOperationIdentity() throws {
        let preview = NativeJSON.object(["snapshotHash": .string(String(repeating: "a", count: 64)), "dataEpoch": .number(4)])
        let request = NativeLifeContract.importBody(profile: "synthetic_owner", items: [item.personalSnapshot(rating: 4, date: "2026-11-15", comment: "自己的短评")], epoch: 4, preview: preview, requestID: "12345678-1234-4234-8234-123456789abc")
        let pending = NativeLifePending(owner: "synthetic-account", label: "导入", path: "life/douban/import", method: "POST", body: request)
        let decoded = try JSONDecoder().decode(NativeLifePending.self, from: JSONEncoder().encode(pending))
        XCTAssertEqual(decoded.body, request)
        XCTAssertEqual(decoded.owner, "synthetic-account")
        XCTAssertEqual(decoded.body["expectedSnapshotHash"], preview["snapshotHash"])
        let reset = NativeLifeContract.resetBody(preview: .object(["epoch": .number(4), "previewHash": .string(String(repeating: "b", count: 64))]), requestID: "12345678-1234-4234-8234-123456789abc")
        XCTAssertEqual(reset["expectedEpoch"].intValue, 4)
        XCTAssertEqual(reset["confirmed"].boolValue, true)
    }
    func testCoverAddressRejectsPrivateDestinationsAndProxyUsesRecordKey() throws {
        XCTAssertNil(NativeLifeContract.publicImageURL("http://images.example.org/cover.jpg"))
        XCTAssertNil(NativeLifeContract.publicImageURL("https://127.0.0.1/cover.jpg"))
        XCTAssertNil(NativeLifeContract.publicImageURL("https://server.internal/cover.jpg"))
        XCTAssertNil(NativeLifeContract.publicImageURL("https://user:secret@images.example.org/cover.jpg"))
        XCTAssertNotNil(NativeLifeContract.publicImageURL("https://image.tmdb.org/t/p/w500/synthetic.jpg"))
        let path = NativeLifeContract.protectedCoverPath(item: item)
        XCTAssertTrue(path.hasPrefix("life/douban/cover?"))
        XCTAssertFalse(path.contains("Authorization"))
        XCTAssertFalse(path.contains("token"))
    }
}
