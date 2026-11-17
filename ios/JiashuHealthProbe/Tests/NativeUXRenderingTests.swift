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

        try await capture(ContentView(model: model), name: "SYNTHETIC-home-light",
                          waitUntil: { scenario.count("/api/native/notifications") > 0 && scenario.count("/api/native/health/actions") > 0 })
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
        let actionsBefore = scenario.count("/api/native/health/actions")
        try await capture(ContentView(model: model), name: "SYNTHETIC-home-dark-accessibility",
                          size: CGSize(width: 320, height: 874), dark: true, large: true,
                          waitUntil: { scenario.count("/api/native/health/actions") > actionsBefore })

        XCTAssertGreaterThan(scenario.count("/api/native/notifications"), 0)
        XCTAssertGreaterThan(scenario.count("/api/native/health/actions"), 0)
        XCTAssertGreaterThan(scenario.count("/api/native/health/goals"), 0)
        XCTAssertGreaterThan(scenario.count("/api/native/health/nutrition"), 0)
        XCTAssertGreaterThan(scenario.count("/api/native/sync/channel"), 0)
    }

    @MainActor
    private func capture<Screen: View>(_ screen: Screen, name: String,
                                      size: CGSize = CGSize(width: 390, height: 844),
                                      dark: Bool = false, large: Bool = false,
                                      waitUntil: (() -> Bool)? = nil) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.overrideUserInterfaceStyle = dark ? .dark : .light
        let hosting = UIHostingController(rootView: screen
            .tint(.indigo)
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
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(bounds: hosting.view.bounds, format: format)
        var rendered = false
        let image = renderer.image { _ in
            rendered = hosting.view.drawHierarchy(in: hosting.view.bounds, afterScreenUpdates: true)
        }
        XCTAssertTrue(rendered, "The real hosting hierarchy must render")
        XCTAssertGreaterThan(try XCTUnwrap(image.pngData()).count, 1_000)
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
    private let lock = NSLock()
    private var requests: [String: Int] = [:]

    func count(_ path: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return requests[path] ?? 0
    }

    func reply(_ request: URLRequest) throws -> Data {
        let path = request.url?.path ?? ""
        XCTAssertEqual(request.url?.host, host, "Rendering must stay on its synthetic transport")
        lock.lock(); requests[path, default: 0] += 1; lock.unlock()
        let day = NativeActionDates.day(Date())
        let now = NativeActionDates.timestamp(Date())
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
            func metric(_ key: String, _ label: String, _ unit: String, _ value: Any, _ recordedDay: Any) -> [String: Any] {
                ["metric": key, "label": label, "unit": unit, "value": value, "day": recordedDay,
                 "freshness": value is NSNull ? "missing" : "current", "points": [], "average7": null, "observedDays7": 0]
            }
            let finance: [String: Any] = ["status": "ready", "accountCount": 1, "currencies": [],
                                         "staleAccountCount": 1, "uncheckedAccountCount": 1, "pendingBalanceCount": 1]
            result = ["asOf": now, "today": day, "health": ["status": "ready", "lastSync": now, "recordedMetricCount": 2,
                "metrics": [metric("steps", "步数", "步", 6240, day), metric("sleep", "睡眠", "小时", null, null),
                            metric("weight", "体重", "kg", 61.6, day)]],
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
            result = ["summary": ["metrics": ["steps": steps], "measurementCount": 3, "lastMeasurementAt": now],
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
            let nutrients = Dictionary(uniqueKeysWithValues: ["calories", "carbs", "protein", "fat"].map {
                ($0, ["total": $0 == "calories" ? 240 : 12, "knownCount": 1, "unknownCount": 0])
            })
            result = ["date": day, "entries": [["id": "synthetic-oats", "name": "示例燕麦粥", "meal": "breakfast",
                "date": day, "portion": "1碗", "calories": 240, "deleted": false]], "summary": ["nutrients": nutrients],
                "dayStatus": ["complete": false, "meals": ["breakfast": "recorded", "lunch": "unknown", "dinner": "unknown", "snack": "unknown"]]]
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
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { }
}
