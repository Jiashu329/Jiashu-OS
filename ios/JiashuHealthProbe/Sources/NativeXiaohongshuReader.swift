import SwiftUI
import WebKit

struct NativeXiaohongshuNote: Equatable {
    let title: String?
    let body: String

    static let bodyLimit = 16_000

    init?(title: String?, body: String) {
        let body = Self.cleaned(body)
        guard !body.isEmpty, body.utf16.count <= Self.bodyLimit else { return nil }
        let title = Self.cleaned(title ?? "")
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        self.title = title.isEmpty ? nil : String(title.prefix(200))
        self.body = body
    }

    private static func cleaned(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: #"[\r\u0085\u2028\u2029]"#, with: "\n", options: .regularExpression)
            .replacingOccurrences(of: #"[^\S\n]+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]"#,
                                  with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The short URL may resolve once. Every subsequently observed note URL must
/// refer to that same note, including a redirect between official web hosts.
struct NativeXiaohongshuNavigationGate {
    private enum Page: Equatable {
        case shortLink(String)
        case note(String)

        init?(_ url: URL) {
            guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  parts.scheme?.lowercased() == "https",
                  parts.user == nil, parts.password == nil, parts.port == nil,
                  let host = parts.host?.lowercased() else { return nil }

            let path = parts.percentEncodedPath
            let notePattern: String
            switch host {
            case "xhslink.cn", "www.xhslink.cn", "xhslink.com", "www.xhslink.com":
                guard path.range(of: #"^/(?:[aom]/)?[a-z0-9]{4,64}/?$"#,
                                 options: [.regularExpression, .caseInsensitive]) != nil else { return nil }
                self = .shortLink(String(path.dropLast(path.hasSuffix("/") ? 1 : 0)))
                return
            case "xiaohongshu.com", "www.xiaohongshu.com", "m.xiaohongshu.com":
                notePattern = #"^/(?:explore|discovery/item|user/profile/[a-f0-9]{24})/[a-f0-9]{24}/?$"#
            case "rednote.com", "www.rednote.com":
                notePattern = #"^/(?:(?:zh|en)/)?(?:explore|discovery/item)/[a-f0-9]{24}/?$"#
            default:
                return nil
            }
            guard path.range(of: notePattern, options: [.regularExpression, .caseInsensitive]) != nil,
                  let noteID = path.split(separator: "/").last else { return nil }
            self = .note(noteID.lowercased())
        }
    }

    private let original: Page
    private var noteID: String?

    init?(url: URL) {
        guard let original = Page(url) else { return nil }
        self.original = original
        if case .note(let noteID) = original { self.noteID = noteID }
    }

    mutating func allows(_ url: URL, resolvingShortLink: Bool) -> Bool {
        guard let page = Page(url) else { return false }
        switch page {
        case .shortLink:
            return page == original
        case .note(let candidate):
            if let noteID { return candidate == noteID }
            guard resolvingShortLink, case .shortLink = original else { return false }
            noteID = candidate
            return true
        }
    }

    func permitsReading(_ url: URL) -> Bool {
        guard let noteID, let page = Page(url) else { return false }
        return page == .note(noteID)
    }
}

@MainActor
struct NativeXiaohongshuReader: View {
    let onRead: (NativeXiaohongshuNote) -> Void
    @StateObject private var browser: NativeXiaohongshuBrowser
    @Environment(\.dismiss) private var dismiss

    init(url: URL, onRead: @escaping (NativeXiaohongshuNote) -> Void) {
        self.onRead = onRead
        _browser = StateObject(wrappedValue: NativeXiaohongshuBrowser(url: url))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    if browser.working { ProgressView() }
                    Text(browser.message)
                        .font(.footnote)
                        .foregroundStyle(NativePalette.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                NativeXiaohongshuWebPage(browser: browser)
            }
            .background(NativePalette.canvas)
            .navigationTitle("小红书原文")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("返回") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("读取当前笔记") { browser.readCurrentNote() }
                        .disabled(!browser.canRead)
                }
            }
        }
        .onChange(of: browser.note) { _, note in
            guard let note else { return }
            onRead(note)
            dismiss()
        }
    }
}

@MainActor
private struct NativeXiaohongshuWebPage: UIViewRepresentable {
    let browser: NativeXiaohongshuBrowser

    func makeCoordinator() -> NativeXiaohongshuBrowser { browser }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.limitsNavigationsToAppBoundDomains = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.start(in: webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: NativeXiaohongshuBrowser) {
        coordinator.stop()
    }
}

@MainActor
private final class NativeXiaohongshuBrowser: NSObject, ObservableObject, WKNavigationDelegate {
    private static let unavailable = "没有读到这篇笔记的正文。返回后仍可保存链接或粘贴笔记文字。"
    private static let reading = "正在读取网页上显示的笔记…"
    private static let automaticAttempts = 26

    @Published private(set) var note: NativeXiaohongshuNote?
    @Published private(set) var message = "正在打开小红书网页…"
    @Published private(set) var working = true
    @Published private(set) var canRead = false

    private let url: URL
    private var gate: NativeXiaohongshuNavigationGate?
    private weak var webView: WKWebView?
    private var currentNavigation: WKNavigation?
    private var readTask: Task<Void, Never>?
    private var generation = UUID()
    private var inspectingNewPage = true
    private var startedAutomaticRead = false

    init(url: URL) {
        self.url = url
        gate = NativeXiaohongshuNavigationGate(url: url)
    }

    func start(in webView: WKWebView) {
        self.webView = webView
        webView.navigationDelegate = self
        guard gate != nil else {
            Task { self.fail() }
            return
        }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
    }

    func stop() {
        invalidateRead()
        webView?.navigationDelegate = nil
        webView?.stopLoading()
        webView = nil
        currentNavigation = nil
    }

    func readCurrentNote() {
        inspect(attempts: 1)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame?.isMainFrame == true,
              (navigationAction.request.httpMethod ?? "GET") == "GET", let target = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let resolving = navigationAction.navigationType == .other && navigationAction.sourceFrame.isMainFrame
        let allowed = gate?.allows(target, resolvingShortLink: resolving) == true
        decisionHandler(allowed ? .allow : .cancel)
        if !allowed && resolving { fail() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame else {
            decisionHandler(.cancel)
            return
        }
        guard let response = navigationResponse.response as? HTTPURLResponse, let target = response.url,
              navigationResponse.canShowMIMEType, (200..<300).contains(response.statusCode),
              response.mimeType == "text/html" || response.mimeType == "application/xhtml+xml",
              gate?.allows(target, resolvingShortLink: inspectingNewPage) == true else {
            decisionHandler(.cancel)
            fail()
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        currentNavigation = navigation
        inspectingNewPage = true
        startedAutomaticRead = false
        invalidateRead()
        message = "正在打开小红书网页…"
        working = true
        canRead = false
    }

    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        guard navigation === currentNavigation, let target = webView.url else { return }
        guard gate?.allows(target, resolvingShortLink: inspectingNewPage) == true else {
            webView.stopLoading()
            fail()
            return
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard navigation === currentNavigation, let target = webView.url else { return }
        guard gate?.permitsReading(target) == true else { return }
        inspectingNewPage = false
        startedAutomaticRead = true
        inspect(attempts: Self.automaticAttempts)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard navigation === currentNavigation, readTask == nil, note == nil else { return }
        if let target = webView.url, gate?.permitsReading(target) == true {
            inspectingNewPage = false
            inspect(attempts: startedAutomaticRead ? 1 : Self.automaticAttempts)
        } else {
            fail()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if navigation === currentNavigation { fail() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if navigation === currentNavigation { fail() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fail()
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    private func inspect(attempts: Int) {
        guard readTask == nil, note == nil, let webView, let target = webView.url,
              gate?.permitsReading(target) == true else { return }
        let generation = generation
        working = true
        canRead = false
        message = Self.reading
        readTask = Task { [weak self, weak webView] in
            guard let self, let webView else { return }
            defer {
                if self.generation == generation { self.readTask = nil }
            }
            for attempt in 0..<attempts {
                guard !Task.isCancelled, self.generation == generation else { return }
                if attempt > 0 {
                    do { try await Task.sleep(for: .milliseconds(400)) }
                    catch { return }
                }
                let value = try? await webView.callAsyncJavaScript(NativeXiaohongshuVisibleText.script,
                    arguments: ["bodyLimit": NativeXiaohongshuNote.bodyLimit], in: nil,
                    contentWorld: NativeXiaohongshuVisibleText.world)
                guard !Task.isCancelled, self.generation == generation else { return }
                guard let values = value as? [String: Any],
                      let href = values["url"] as? String, let documentURL = URL(string: href),
                      let activeURL = webView.url,
                      self.gate?.permitsReading(documentURL) == true,
                      self.gate?.permitsReading(activeURL) == true,
                      let body = values["body"] as? String,
                      let note = NativeXiaohongshuNote(title: values["title"] as? String, body: body) else { continue }
                self.working = false
                self.note = note
                return
            }
            self.message = Self.unavailable
            self.working = false
            self.canRead = true
        }
    }

    private func invalidateRead() {
        generation = UUID()
        readTask?.cancel()
        readTask = nil
    }

    private func fail() {
        inspectingNewPage = false
        invalidateRead()
        message = Self.unavailable
        working = false
        canRead = webView?.url.map { gate?.permitsReading($0) == true } ?? false
    }
}

/// Only inspect public text rendered into the visible note DOM. The
/// isolated world neither reads page JavaScript state nor makes requests.
@MainActor
enum NativeXiaohongshuVisibleText {
    static let world = WKContentWorld.world(name: "JiashuRecipeReader")
    static let script = """
    const note = document.querySelector("#noteContainer");
    if (!note) return null;

    function isDisplayed(element) {
      if (!element || !element.isConnected || element.closest("[hidden], [aria-hidden='true']")) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.contentVisibility === "hidden" || style.visibility === "hidden" ||
            style.visibility === "collapse" || Number(style.opacity) === 0) return false;
      }
      return Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
    }

    const dialogs = document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]');
    if (Array.from(dialogs).some(dialog => !dialog.contains(note) && isDisplayed(dialog))) return null;

    const caption = note.querySelector("#detail-desc");
    if (!isDisplayed(caption)) return null;
    for (let node = caption; note.contains(node); node = node.parentElement) {
      const style = getComputedStyle(node);
      const clipped = node === caption && (style.overflowY === "hidden" || style.overflowY === "clip");
      if ((clipped || parseInt(style.webkitLineClamp, 10) > 0) && node.scrollHeight > node.clientHeight + 1) return null;
    }
    // innerText excludes display:none, but can include text under opacity:0.
    for (const element of caption.querySelectorAll("*")) {
      if (element.getClientRects().length && element.textContent.trim() &&
          (Number(getComputedStyle(element).opacity) === 0 || element.getAttribute("aria-hidden") === "true")) return null;
    }
    const body = caption.innerText.trim();
    if (!body || body.length > bodyLimit) return null;
    const platformSuffix = /\\s+[-|·]\\s+(?:小红书|rednote)$/i;
    const pageTitle = document.title.trim();
    const tabTitle = platformSuffix.test(pageTitle) ? pageTitle.replace(platformSuffix, "").trim() : "";
    const heading = note.querySelector("#detail-title");
    const title = (isDisplayed(heading) ? heading.innerText.trim() || tabTitle : tabTitle).slice(0, 400);
    return {url: location.href, title, body};
    """
}
