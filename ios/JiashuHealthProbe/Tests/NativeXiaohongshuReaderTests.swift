import WebKit
import XCTest
@testable import JiashuHealthProbe

final class NativeXiaohongshuReaderTests: XCTestCase {
    private let note = "0123456789abcdef01234567"
    private let otherNote = "89abcdef0123456789abcdef"

    func testShortLinkPinsOneNoteAcrossOfficialHosts() throws {
        let short = url("https://xhslink.cn/a/ShareCode")
        var gate = try XCTUnwrap(NativeXiaohongshuNavigationGate(url: short))
        let original = url("https://www.xiaohongshu.com/discovery/item/\(note)?xsec_token=example")
        let rednote = url("https://www.rednote.com/zh/discovery/item/\(note)?xsec_token=example")
        XCTAssertTrue(gate.allows(short, resolvingShortLink: true))
        XCTAssertTrue(gate.allows(url("https://www.xhslink.com/a/ShareCode/"), resolvingShortLink: true))
        XCTAssertFalse(gate.permitsReading(short))
        XCTAssertFalse(gate.allows(url("https://xhslink.cn/a/OtherCode"), resolvingShortLink: true))
        XCTAssertFalse(gate.allows(original, resolvingShortLink: false))
        XCTAssertTrue(gate.allows(original, resolvingShortLink: true))
        XCTAssertTrue(gate.allows(rednote, resolvingShortLink: true))
        XCTAssertTrue(gate.permitsReading(rednote))
        XCTAssertFalse(gate.allows(url("https://www.rednote.com/discovery/item/\(otherNote)"), resolvingShortLink: true))
        XCTAssertFalse(gate.permitsReading(url("https://www.xiaohongshu.com/explore/\(otherNote)")))
    }

    func testDirectNoteRejectsUnsupportedOriginsAndPaths() throws {
        let original = url("https://www.rednote.com/en/explore/\(note)")
        var gate = try XCTUnwrap(NativeXiaohongshuNavigationGate(url: original))
        XCTAssertTrue(gate.permitsReading(original))
        XCTAssertTrue(gate.allows(url("https://m.xiaohongshu.com/explore/\(note.uppercased())"), resolvingShortLink: false))
        for address in [
            "http://www.rednote.com/explore/\(note)",
            "https://www.rednote.com.evil.test/explore/\(note)",
            "https://account.rednote.com/explore/\(note)",
            "https://user@www.rednote.com/explore/\(note)",
            "https://www.rednote.com:444/explore/\(note)",
            "https://www.rednote.com/login?redirect=/explore/\(note)",
            "https://www.rednote.com/explore%2F\(note)",
            "https://www.xiaohongshu.com/explore/\(otherNote)",
            "https://xhslink.cn/a/ShareCode",
        ] {
            let target = url(address)
            XCTAssertFalse(gate.allows(target, resolvingShortLink: true), address)
            XCTAssertFalse(gate.permitsReading(target), address)
        }
    }

    func testNotePreservesUsefulLineBreaksAndRejectsBlankOrOversizedContent() throws {
        let note = try XCTUnwrap(NativeXiaohongshuNote(title: "葱油\t拌面", body: "食材：面条\u{2028}做法：煮面\u{0085}沥干\u{2029}拌入葱油"))
        XCTAssertEqual(note.title, "葱油 拌面")
        XCTAssertEqual(note.body, "食材：面条\n做法：煮面\n沥干\n拌入葱油")
        XCTAssertNil(NativeXiaohongshuNote(title: "只有标题", body: " \n\u{2028} "))
        XCTAssertNil(NativeXiaohongshuNote(title: nil, body: String(repeating: "字", count: NativeXiaohongshuNote.bodyLimit + 1)))
    }

    @MainActor
    func testWebKitReadsRenderedNoteWithoutCommentsOrHiddenText() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.limitsNavigationsToAppBoundDomains = true
        let page = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        let loaded = expectation(description: "Synthetic note page loaded")
        let navigation = SyntheticNoteNavigation(loaded: loaded)
        page.navigationDelegate = navigation
        page.loadHTMLString("""
        <!doctype html>
        <meta charset="utf-8">
        <section id="noteContainer">
          <h1 id="detail-title">葱油拌面</h1>
          <div id="detail-desc">食材：面条<span hidden>隐藏文案</span><br>做法：煮面后拌入葱油</div>
          <div id="comments">评论：额外一勺糖</div>
        </section>
        <div id="footer">底部推荐</div>
        """, baseURL: nil)
        await fulfillment(of: [loaded], timeout: 10)
        XCTAssertNil(navigation.error)
        let output = try await page.callAsyncJavaScript(NativeXiaohongshuVisibleText.script,
            arguments: ["bodyLimit": NativeXiaohongshuNote.bodyLimit], in: nil,
            contentWorld: NativeXiaohongshuVisibleText.world)
        let values = try XCTUnwrap(output as? [String: Any])
        XCTAssertEqual(values["title"] as? String, "葱油拌面")
        XCTAssertEqual(values["body"] as? String, "食材：面条\n做法：煮面后拌入葱油")

        _ = try await page.evaluateJavaScript("document.querySelector('#detail-title').hidden = true; document.title = '葱油拌面 - rednote'",
                                              in: nil, contentWorld: .page)
        let withTabTitle = try await page.callAsyncJavaScript(NativeXiaohongshuVisibleText.script,
            arguments: ["bodyLimit": NativeXiaohongshuNote.bodyLimit], in: nil,
            contentWorld: NativeXiaohongshuVisibleText.world)
        XCTAssertEqual((withTabTitle as? [String: Any])?["title"] as? String, "葱油拌面")

        let installObstructions = [
            #"document.body.insertAdjacentHTML('beforeend', '<div id="obstruction" role="dialog" aria-modal="true">请登录</div>')"#,
            #"document.querySelector('#detail-desc').insertAdjacentHTML('beforeend', '<span id="obstruction" style="opacity:0">未展示正文</span>')"#,
        ]
        for install in installObstructions {
            _ = try await page.evaluateJavaScript(install, in: nil, contentWorld: .page)
            let blocked = try await page.callAsyncJavaScript(NativeXiaohongshuVisibleText.script,
                arguments: ["bodyLimit": NativeXiaohongshuNote.bodyLimit], in: nil,
                contentWorld: NativeXiaohongshuVisibleText.world)
            XCTAssertNil(blocked as? [String: Any])
            _ = try await page.evaluateJavaScript("document.querySelector('#obstruction').remove()", in: nil, contentWorld: .page)
        }

        _ = try await page.evaluateJavaScript("document.querySelector('#detail-desc').hidden = true", in: nil, contentWorld: .page)
        let withoutVisibleBody = try await page.callAsyncJavaScript(NativeXiaohongshuVisibleText.script,
            arguments: ["bodyLimit": NativeXiaohongshuNote.bodyLimit], in: nil,
            contentWorld: NativeXiaohongshuVisibleText.world)
        XCTAssertNil(withoutVisibleBody as? [String: Any])
    }

    private func url(_ address: String) -> URL { URL(string: address)! }
}

@MainActor
private final class SyntheticNoteNavigation: NSObject, WKNavigationDelegate {
    let loaded: XCTestExpectation
    private(set) var error: Error?

    init(loaded: XCTestExpectation) { self.loaded = loaded }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded.fulfill() }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.error = error
        loaded.fulfill()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.error = error
        loaded.fulfill()
    }
}
