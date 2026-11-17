import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import JiashuHealthProbe

/// Actual SwiftUI rendering evidence using synthetic records and an isolated,
/// in-process transport. This is not device HealthKit or interaction acceptance.
final class NativeUXRenderingTests: XCTestCase {
    @MainActor
    func testSyntheticSignedInScreensAndAccessibleHomepageRender() async throws {
        let scenario = NativeRenderingScenario()
        NativeRenderingProtocol.register(scenario)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NativeRenderingProtocol.self]
        let api = NativeAPI(baseURL: URL(string: "https://" + scenario.host)!, configuration: configuration)
        let store = NativeSessionStore(service: "synthetic.native-rendering." + scenario.userID)
        let model = NativeAppModel(api: api, sessions: store)
        defer {
            api.endSession()
            try? store.clear()
            UserDefaults.standard.removeObject(forKey: "jiashu.native.health-auto-sync." + scenario.userID)
            NativeRenderingProtocol.remove(scenario.host)
        }
        await model.restore()
        await model.login(email: scenario.email, password: "synthetic-rendering-only")
        XCTAssertEqual(model.session?.user.id, scenario.userID)
        XCTAssertNotNil(model.overview)
        XCTAssertNil(model.overviewError)
        let token = try XCTUnwrap(model.session?.accessToken)
        XCTAssertEqual(model.overview?.health.metrics.count, 6)
        let nutrition = try await api.nutritionDay(token: token, date: scenario.day)
        XCTAssertEqual(nutrition.summary.knownCalories, "1280.0")
        let firstMeals = scenario.completed("/api/native/health/nutrition")
        let firstLife = scenario.completed("/api/native/life/douban")

        try await capture(ContentView(model: model), name: "SYNTHETIC-home-light",
                          secondPageName: "SYNTHETIC-home-lower-light",
                          waitUntil: { scenario.completed("/api/native/notifications") > 0
                              && scenario.completed("/api/native/health/nutrition") > firstMeals
                              && scenario.completed("/api/native/life/douban") > firstLife })
        let goalsBefore = scenario.count("/api/native/health/goals")
        try await capture(NavigationStack { NativeHealthRangeWorkspace(api: api, token: token, userID: scenario.userID) },
                          name: "SYNTHETIC-health-light", waitUntil: { scenario.count("/api/native/health/goals") > goalsBefore })
        try await capture(NativeSettingsView(model: model), name: "SYNTHETIC-my-light")
        let channelsBefore = scenario.count("/api/native/sync/channel")
        try await capture(NavigationStack { NativeSyncCenter(model: model) }, name: "SYNTHETIC-sync-center-light",
                          waitUntil: { scenario.count("/api/native/sync/channel") > channelsBefore })
        let mealsBefore = scenario.count("/api/native/health/nutrition")
        try await capture(NavigationStack {
            NativeNutritionRoot(api: api, token: token, userID: scenario.userID)
        }, name: "SYNTHETIC-diet-light", waitUntil: { scenario.count("/api/native/health/nutrition") > mealsBefore })
        let darkMeals = scenario.completed("/api/native/health/nutrition")
        let darkLife = scenario.completed("/api/native/life/douban")
        try await capture(ContentView(model: model), name: "SYNTHETIC-home-dark-accessibility",
                          size: CGSize(width: 320, height: 874), dark: true, large: true,
                          waitUntil: { scenario.completed("/api/native/health/nutrition") > darkMeals
                              && scenario.completed("/api/native/life/douban") > darkLife })

        XCTAssertGreaterThan(scenario.count("/api/native/notifications"), 0)
        XCTAssertGreaterThan(scenario.completed("/api/native/life/douban"), 0)
        XCTAssertGreaterThan(scenario.count("/api/native/health/goals"), 0)
        XCTAssertGreaterThan(scenario.count("/api/native/health/nutrition"), 0)
        XCTAssertGreaterThan(scenario.count("/api/native/sync/channel"), 0)
    }

    @MainActor
    private func capture<Screen: View>(_ screen: Screen, name: String,
                                      size: CGSize = CGSize(width: 390, height: 844),
                                      dark: Bool = false, large: Bool = false,
                                      secondPageName: String? = nil,
                                      waitUntil: (() -> Bool)? = nil) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.overrideUserInterfaceStyle = dark ? .dark : .light
        let hosting = UIHostingController(rootView: screen
            .tint(NativePalette.accent)
            .environment(\.locale, Locale(identifier: "zh-Hans"))
            .environment(\.calendar, NativeActionDates.calendar)
            .environment(\.timeZone, NativeActionDates.timeZone)
            .environment(\.colorScheme, dark ? .dark : .light)
            .environment(\.dynamicTypeSize, large ? .accessibility3 : .large))
        window.rootViewController = hosting
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKey() }
        // A newly mounted page must finish starting its own synthetic reads;
        // using a previous screen's count would hide a cancelled appearance.
        if let waitUntil {
            let deadline = Date().addingTimeInterval(5)
            while !waitUntil() && Date() < deadline {
                hosting.view.setNeedsLayout()
                hosting.view.layoutIfNeeded()
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            XCTAssertTrue(waitUntil(), "Synthetic page reads did not arrive before capture: " + name)
        }
        // Allow the corresponding state transaction to render after the local
        // response; no production endpoint is involved.
        try await Task.sleep(nanoseconds: 250_000_000)
        hosting.view.setNeedsLayout()
        hosting.view.layoutIfNeeded()
        attach(hosting.view, name: name)
        if let secondPageName {
            let scroll = try XCTUnwrap(verticalScrollViews(in: hosting.view).max(by: {
                $0.contentSize.height - $0.bounds.height < $1.contentSize.height - $1.bounds.height
            }), "Expected a visible, vertically scrollable home")
            let maximum = scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom
            let before = scroll.contentOffset.y
            let target = min(maximum, before + scroll.bounds.height * 0.85)
            XCTAssertGreaterThan(target - before, 80, "Lower-home evidence must move the actual scroll view")
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: target), animated: false)
            try await Task.sleep(nanoseconds: 150_000_000)
            hosting.view.layoutIfNeeded()
            XCTAssertGreaterThan(scroll.contentOffset.y - before, 80)
            attach(hosting.view, name: secondPageName)
        }
    }

    @MainActor
    private func verticalScrollViews(in view: UIView) -> [UIScrollView] {
        guard !view.isHidden, view.alpha > 0.01 else { return [] }
        var result: [UIScrollView] = []
        if let scroll = view as? UIScrollView, scroll.isScrollEnabled,
           scroll.bounds.height > 100, scroll.contentSize.height > scroll.bounds.height + 80 {
            result.append(scroll)
        }
        return result + view.subviews.flatMap { verticalScrollViews(in: $0) }
    }

    @MainActor
    private func attach(_ view: UIView, name: String) {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(bounds: view.bounds, format: format)
        var rendered = false
        let image = renderer.image { _ in
            rendered = view.drawHierarchy(in: view.bounds, afterScreenUpdates: true)
        }
        XCTAssertTrue(rendered, "The real hosting hierarchy must render")
        XCTAssertGreaterThan(image.pngData()?.count ?? 0, 1_000)
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

private final class NativeRenderingScenario: @unchecked Sendable {
    let userID = "synthetic-render-" + UUID().uuidString.lowercased()
    let token = "synthetic-render-token-" + UUID().uuidString.lowercased()
    let host = "synthetic-render-" + UUID().uuidString.lowercased() + ".invalid"
    let email = "synthetic-preview@example.invalid"
    private let referenceDate = Date()
    private let lock = NSLock()
    private var requests: [String: Int] = [:]
    private var responses: [String: Int] = [:]

    var day: String { NativeActionDates.day(referenceDate) }

    func count(_ path: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return requests[path] ?? 0
    }

    func completed(_ path: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return responses[path] ?? 0
    }

    func didComplete(_ path: String) {
        lock.lock(); defer { lock.unlock() }
        responses[path, default: 0] += 1
    }

    private func day(offset: Int) -> String {
        NativeActionDates.day(NativeActionDates.calendar.date(byAdding: .day, value: offset, to: referenceDate)!)
    }

    private func overviewMetrics() -> [[String: Any]] {
        func metric(_ key: String, _ label: String, _ unit: String, _ value: Double,
                    offset: Int = 0, points: [[String: Any]]) -> [String: Any] {
            ["metric": key, "label": label, "unit": unit, "value": value, "day": day(offset: offset),
             "freshness": offset == 0 ? "current" : "stale", "points": points,
             "average7": NSNull(), "observedDays7": points.count]
        }
        let steps: [[String: Any]] = (-6...0).map { ["day": day(offset: $0), "value": 6240 + $0 * 120] }
        let weight: [[String: Any]] = [-6,-5,-3,-2,-1,0].map { ["day": day(offset: $0), "value": 61.6 - Double($0) * 0.05] }
        let sleep: [[String: Any]] = (-5...0).map { ["day": day(offset: $0), "value": 7.25] }
        return [metric("steps", "步数", "count", 6240, points: steps),
                metric("active_energy", "活动能量", "kcal", 285, points: [["day": day, "value": 285]]),
                metric("sleep", "睡眠", "hours", 7.25, points: sleep),
                metric("weight", "体重", "kg", 61.6, points: weight),
                metric("lean_body_mass", "去脂体重", "kg", 46.2, offset: -1, points: [["day": day(offset: -1), "value": 46.2]]),
                metric("body_fat", "估算体脂", "%", 25, offset: -2, points: [["day": day(offset: -2), "value": 25]])]
    }

    func reply(_ request: URLRequest) throws -> Data {
        let path = request.url?.path ?? ""
        XCTAssertEqual(request.url?.host, host, "Rendering must stay on its synthetic transport")
        lock.lock(); requests[path, default: 0] += 1; lock.unlock()
        let day = self.day
        let now = NativeActionDates.timestamp(referenceDate)
        let null = NSNull()
        let session: [String: Any] = ["accessToken": token, "expiresAt": "2099-01-01T00:00:00Z",
                                     "user": ["id": userID, "email": email]]
        if path == "/api/native/auth/login" || path == "/api/native/auth/refresh" {
            XCTAssertEqual(request.httpMethod, "POST")
            return try JSONSerialization.data(withJSONObject: session)
        }
        XCTAssertEqual(request.httpMethod, "GET", "Mounting a page must not submit a mutation")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + token)
        let result: [String: Any]
        switch path {
        case "/api/native/overview":
            let currency: [String: Any] = ["currency": "CNY", "netFormatted": "CNY 338,600.00",
                                          "assetsFormatted": "CNY 386,800.00", "liabilitiesFormatted": "CNY 48,200.00"]
            let finance: [String: Any] = ["status": "ready", "accountCount": 4, "currencies": [currency],
                                         "oldestBalanceDate": self.day(offset: -45), "latestBalanceDate": day,
                                         "staleAccountCount": 1, "uncheckedAccountCount": 1, "pendingBalanceCount": 1]
            result = ["asOf": now, "today": day, "health": ["status": "ready", "lastSync": now, "recordedMetricCount": 6,
                "metrics": overviewMetrics()],
                "priorities": [], "finance": ["personal": finance, "family": finance],
                "nutrition": ["status": "ready", "entryCount": 1, "complete": false]]
        case "/api/native/health":
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let from = query.first(where: { $0.name == "from" })?.value ?? NativeActionDates.day(NativeActionDates.calendar.date(byAdding: .day, value: -29, to: Date())!)
            let to = query.first(where: { $0.name == "to" })?.value ?? day
            let points: [[String: Any]] = (0..<3).map { offset in
                let date = NativeActionDates.calendar.date(byAdding: .day, value: -offset, to: Date())!
                let recordedDay = NativeActionDates.day(date)
                return ["day": recordedDay, "value": 6240 - offset * 700, "source": "manual", "measuredAt": recordedDay + "T00:00:00Z"]
            }
            let steps: [String: Any] = ["metric": "steps", "label": "步数", "unit": "步", "latestValue": 6240, "latestDate": day, "points": points]
            let stages: [String: Any] = ["unspecified": 0, "core": 4, "deep": 1.5, "rem": 1.75, "awake": 0.25, "inBed": 8]
            let sleep: [String: Any] = ["metric": "sleep", "label": "睡眠", "unit": "hours", "latestValue": 7.25,
                "latestDate": day, "points": [["day": day, "value": 7.25, "source": "synthetic-watch", "measuredAt": now, "sleepStages": stages]]]
            result = ["summary": ["metrics": ["steps": steps, "sleep": sleep], "measurementCount": 4, "lastMeasurementAt": now],
                      "measurements": [], "lastSync": null, "range": ["from": from, "to": to]]
        case "/api/native/health/goals":
            result = ["targets": ["steps": 8000, "sleep": 8, "active_energy": 300], "revision": 0, "updatedAt": null, "effectiveFrom": null]
        case "/api/native/health/actions":
            let week = NativeActionDates.day(NativeActionDates.monday(Date()))
            result = ["action": ["weekStart": week, "text": "晚饭后散步15分钟", "status": "planned", "feedback": "", "revision": 1]]
        case "/api/native/notifications": result = ["unreadCount": 3]
        case "/api/native/session": result = ["email": email, "isOwner": false]
        case "/api/native/sync/channel":
            result = ["revision": 0, "deviceId": null, "label": null, "updatedAt": null, "isCurrentDevice": false]
        case "/api/native/health/nutrition":
            let totals = ["calories": "1280.0", "carbs": "147.0", "protein": "74.0", "fat": "44.0"]
            let nutrients: [String: [String: Any]] = totals.mapValues { ["total": $0, "knownCount": 2, "unknownCount": 0] }
            let entries: [[String: Any]] = [
                ["id": "synthetic-oats", "name": "示例燕麦粥", "meal": "breakfast", "date": day,
                 "portion": "1碗", "note": "", "calories": "400.0", "carbs": "47.0", "protein": "24.0", "fat": "14.0", "deleted": false],
                ["id": "synthetic-rice", "name": "示例午餐", "meal": "lunch", "date": day,
                 "portion": "1份", "note": "", "calories": "880.0", "carbs": "100.0", "protein": "50.0", "fat": "30.0", "deleted": false]
            ]
            result = ["date": day, "entries": entries, "summary": ["entryCount": 2, "knownCount": 2, "unknownCount": 0,
                "knownCalories": "1280.0", "nutrients": nutrients],
                "dayStatus": ["complete": false, "meals": ["breakfast": "recorded", "lunch": "recorded", "dinner": "unrecorded", "snack": "unrecorded"]]]
        case "/api/native/life/douban":
            func item(_ domain: String, _ id: String, _ title: String, _ kind: String, _ offset: Int) -> [String: Any] {
                let host = domain == "screen" ? "movie.douban.com" : domain == "book" ? "book.douban.com" : "music.douban.com"
                return ["profileId": userID, "domain": domain, "subjectId": id, "title": title, "kind": kind,
                        "url": "https://" + host + "/subject/" + id + "/", "coverUrl": null, "rating": 4,
                        "markedDate": self.day(offset: offset), "source": "import", "updatedAt": now,
                        "local": ["note": "", "tags": [], "hidden": false, "revision": 0]]
            }
            result = ["items": [item("screen", "100001", "示例电影", "movie", 0),
                                item("book", "100002", "示例阅读", "book", -2),
                                item("music", "100003", "示例原声", "music", -4)]]
        default:
            XCTFail("Missing synthetic rendering response: " + path)
            throw URLError(.unsupportedURL)
        }
        return try JSONSerialization.data(withJSONObject: result)
    }
}

private final class NativeRenderingProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var scenarios: [String: NativeRenderingScenario] = [:]
    static func register(_ value: NativeRenderingScenario) {
        lock.lock(); defer { lock.unlock() }; scenarios[value.host] = value
    }
    static func remove(_ host: String) { lock.lock(); defer { lock.unlock() }; scenarios.removeValue(forKey: host) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let scenario = request.url?.host.flatMap { Self.scenarios[$0] }; Self.lock.unlock()
        do {
            guard let scenario, let url = request.url else { throw URLError(.unsupportedURL) }
            let data = try scenario.reply(request)
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
            scenario.didComplete(url.path)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { }
}
