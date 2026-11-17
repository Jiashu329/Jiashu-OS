import XCTest
import UIKit
import ImageIO
import AVFoundation
@testable import JiashuHealthProbe

final class NativeNutritionTests: XCTestCase {
    private var today: String { NativeActionDates.day(Date()) }
    private func input(calories: NativeJSON = .null) -> NativeJSON {
        .object(["date": .string(today), "meal": .string("lunch"), "name": .string("测试食物"),
            "portion": .string("一份"), "note": .string(""), "calories": calories,
            "carbs": .null, "protein": .string("0"), "fat": .null])
    }

    func testUnknownNutrientsStayUnknownAndRealZeroStaysZero() throws {
        let result = try NativeNutritionDraft(input(calories: .string("0"))).payload()
        XCTAssertEqual(result["calories"], .string("0"))
        XCTAssertEqual(result["carbs"], .null)
        XCTAssertEqual(result["protein"], .string("0"))
        XCTAssertEqual(result["provenance"]["carbs"]["source"], .string("unknown"))
        XCTAssertEqual(result["provenance"]["protein"]["source"], .string("manual"))
        XCTAssertThrowsError(try NativeNutritionFields.nullable("1.23"))
        XCTAssertThrowsError(try NativeNutritionFields.nullable("-1"))
    }

    func testChangingIdentityInvalidatesAIEstimatesAndCatalogSelection() throws {
        var raw = input(calories: .string("100")).objectValue
        raw["food"] = .object(["id": .string("official:food"), "amount": .number(1), "unit": .string("份"), "catalogRelease": .string("original-release")])
        raw["provenance"] = .object(["calories": .object(["source": .string("ai"), "basis": .string("估算一份")]),
            "protein": .object(["source": .string("catalog")])])
        var draft = NativeNutritionDraft(.object(raw))
        draft.changeIdentity(portion: "另一份量")
        let result = try draft.payload()
        XCTAssertEqual(result["food"], .null)
        XCTAssertEqual(result["calories"], .null)
        XCTAssertEqual(result["protein"], .null)
    }

    func testManualNutrientCorrectionRetainsReferenceEvidence() throws {
        var raw = input(calories: .string("100")).objectValue
        raw["provenance"] = .object(["calories": .object(["source": .string("ai"), "basis": .string("原估算依据"), "originalValue": .string("100")])])
        var draft = NativeNutritionDraft(.object(raw))
        draft.setNutrient("calories", text: "120")
        let result = try draft.payload()
        XCTAssertEqual(result["provenance"]["calories"]["source"], .string("manual"))
        XCTAssertEqual(result["provenance"]["calories"]["basis"], .string("原估算依据"))
        XCTAssertEqual(result["provenance"]["calories"]["originalValue"], .string("100"))
    }

    func testReuseAndTemplateKeepCapturedCatalogRelease() throws {
        var raw = input(calories: .string("100.0")).objectValue
        raw["food"] = .object(["foodId": .string("food-1"), "amount": .number(0.5), "unit": .string("份"), "catalogRelease": .string("historical-release")])
        let reused = try NativeNutritionReuseDraft.make(.object(raw), date: today, meal: "dinner")
        XCTAssertEqual(reused["food"]["catalogRelease"], .string("historical-release"))
        XCTAssertEqual(reused["food"]["amount"], .number(0.5))
        XCTAssertEqual(reused["meal"], .string("dinner"))
        let definition = NativeNutritionReuseDraft.templateDefinition(.array([.object(raw)]), name: "晚餐")
        let component = try XCTUnwrap(definition["components"].arrayValue.first)
        XCTAssertEqual(component["food"]["catalogRelease"], .string("historical-release"))
        XCTAssertEqual(component["carbs"], .null)
    }

    func testOfficialServingRoundingAndChangedDrinkNeverReuseOfficialValues() throws {
        let food: NativeJSON = .object(["id": .string("luckin-cn:test"), "name": .string("饮品"), "basis": .string("perServing"),
            "catalogRelease": .string("official-release"), "serving": .object(["label": .string("官方杯型"), "kcal": .number(179), "protein": .null, "carbs": .null, "fat": .null])])
        let official = try NativeFoodSelectionDraft.make(food: food, amount: "0.5", unit: "份", date: today, meal: "snack")
        XCTAssertEqual(official["calories"], .string("89.5"))
        XCTAssertEqual(official["protein"], .null)
        XCTAssertEqual(official["food"]["catalogRelease"], .string("official-release"))
        let changed = try NativeFoodSelectionDraft.make(food: food, amount: "1", unit: "份", date: today, meal: "snack", drinkLabel: "不同糖度", officialDrinkMatches: false)
        XCTAssertEqual(changed["food"], .null)
        XCTAssertEqual(changed["calories"], .null)
        XCTAssertEqual(changed["provenance"]["calories"]["source"], .string("unknown"))
        XCTAssertEqual(try NativeFoodSelectionDraft.scaled(1, amount: "0.05"), .string("0.1"))
    }

    func testFrozenCommandRetainsOriginalIDBodyAndCASVersion() throws {
        let operation = NativeNutritionCommand(path: "health/nutrition/entry", method: "PATCH", title: "修改食物",
            body: .object(["expectedRevision": .number(7), "calories": .null]))
        let restored = try JSONDecoder().decode(NativeNutritionCommand.self, from: JSONEncoder().encode(operation))
        XCTAssertEqual(restored, operation)
        XCTAssertEqual(restored.body["expectedRevision"], .number(7))
        XCTAssertEqual(restored.body["calories"], .null)
    }

    @MainActor
    func testPhotoIsResizedAndConvertedToMetadataFreeJPEG() throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 2000, height: 1000))
        let image = renderer.image { UIColor.orange.setFill(); $0.fill(CGRect(x: 0, y: 0, width: 2000, height: 1000)) }
        let data = try NativeNutritionPhoto.jpeg(XCTUnwrap(image.pngData()))
        XCTAssertLessThanOrEqual(data.count, 2 * 1024 * 1024)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertLessThanOrEqual((properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? .max, 1600)
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary])
    }

    func testCameraAvailabilityNeverTreatsDenialOrMissingHardwareAsReady() {
        XCTAssertEqual(NativeNutritionCameraAccess.resolve(available: false, authorization: .authorized), .unavailable)
        XCTAssertEqual(NativeNutritionCameraAccess.resolve(available: true, authorization: .notDetermined), .needsPermission)
        XCTAssertEqual(NativeNutritionCameraAccess.resolve(available: true, authorization: .denied), .denied)
        XCTAssertEqual(NativeNutritionCameraAccess.resolve(available: true, authorization: .restricted), .restricted)
        XCTAssertEqual(NativeNutritionCameraAccess.resolve(available: true, authorization: .authorized), .ready)
    }

    @MainActor
    func testCameraImageOrientationIsBakedBeforeMetadataIsRemoved() throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2000, height: 1000), format: format).image {
            UIColor.orange.setFill(); $0.fill(CGRect(x: 0, y: 0, width: 2000, height: 1000))
        }
        let pixels = try XCTUnwrap(image.cgImage)
        let portrait = UIImage(cgImage: pixels, scale: 1, orientation: .right)
        let sanitized = try NativeNutritionPhoto.jpeg(image: portrait)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(sanitized as CFData, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertEqual((properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue, 800)
        XCTAssertEqual((properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue, 1600)
        XCTAssertEqual(UIImage(data: sanitized)?.imageOrientation, .up)
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary])
        XCTAssertLessThanOrEqual(sanitized.count, 2 * 1024 * 1024)
    }

    @MainActor
    func testLostBatchResponseRestoresAndRetriesSameOperationExactlyOnce() async throws {
        let host = "nutrition-" + UUID().uuidString.lowercased() + ".example"
        let user = "nutrition-test-" + UUID().uuidString
        let persistence = NativeWorkspacePersistence(userID: user, scope: "nutrition-pending-command")
        defer { NutritionTestProtocol.remove(host); try? persistence.clear() }
        var saved: [String: NativeJSON] = [:]
        var requests = 0
        NutritionTestProtocol.register(host) { request in
            requests += 1
            let key = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
            let body = try JSONDecoder().decode(NativeJSON.self, from: NutritionTestProtocol.body(request))
            if let previous = saved[key] { XCTAssertEqual(previous, body); return (200, .object(["replayed": .bool(true)])) }
            saved[key] = body
            throw URLError(.networkConnectionLost)
        }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [NutritionTestProtocol.self]
        let api = NativeAPI(baseURL: URL(string: "https://" + host)!, configuration: config)
        let context = NativeNutritionContext(api: api, token: "synthetic-token", userID: user)
        let command = NativeNutritionCommand(path: "health/nutrition/batch", title: "保存明细", body: .object(["entries": .array([input()])]))
        _ = await context.write(command)
        XCTAssertEqual(context.pending?.requestID, command.requestID)
        let reopened = NativeNutritionContext(api: api, token: "synthetic-token", userID: user)
        reopened.restorePending()
        XCTAssertEqual(reopened.pending, command)
        await reopened.retry()
        XCTAssertNil(reopened.pending)
        XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(requests, 2)
    }

    @MainActor
    func testCASResponseLossReconcilesServerStateWithoutOverwritingIt() async throws {
        let host = "nutrition-cas-" + UUID().uuidString.lowercased() + ".example"
        let user = "nutrition-cas-" + UUID().uuidString
        let persistence = NativeWorkspacePersistence(userID: user, scope: "nutrition-pending-command")
        defer { NutritionTestProtocol.remove(host); try? persistence.clear() }
        var revision = 1, writes = 0
        NutritionTestProtocol.register(host) { request in
            if request.httpMethod == "GET" { return (200, .object(["goals": .object(["revision": .number(Double(revision)), "calories": .string("1800.0"), "carbs": .null, "protein": .null, "fat": .null])])) }
            if revision == 1 { revision = 2; writes += 1; throw URLError(.networkConnectionLost) }
            return (409, .object(["error": .string("目标已变化"), "code": .string("NUTRITION_CONFLICT")]))
        }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [NutritionTestProtocol.self]
        let api = NativeAPI(baseURL: URL(string: "https://" + host)!, configuration: config)
        let context = NativeNutritionContext(api: api, token: "synthetic-token", userID: user)
        let command = NativeNutritionCommand(path: "health/nutrition/goals", method: "PUT", title: "修改目标",
            body: .object(["expectedRevision": .number(1), "calories": .string("1800"), "carbs": .null, "protein": .null, "fat": .null]))
        _ = await context.write(command); XCTAssertNotNil(context.pending)
        await context.retry()
        XCTAssertNil(context.pending)
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(revision, 2)
        XCTAssertEqual(context.changes, 1)
    }
}

private final class NutritionTestProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = (URLRequest) throws -> (Int, NativeJSON)
    private static let lock = NSLock()
    private static var handlers: [String: Handler] = [:]
    static func register(_ host: String, _ handler: @escaping Handler) { lock.lock(); defer { lock.unlock() }; handlers[host] = handler }
    static func remove(_ host: String) { lock.lock(); defer { lock.unlock() }; handlers.removeValue(forKey: host) }
    override class func canInit(with request: URLRequest) -> Bool { lock.lock(); defer { lock.unlock() }; return handlers[request.url?.host ?? ""] != nil }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let handler = Self.handlers[request.url?.host ?? ""]; Self.lock.unlock()
        do {
            guard let handler else { throw URLError(.badServerResponse) }
            let (status, json) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try json.encodedData()); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
    static func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }; var result = Data(), buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; result.append(buffer, count: count) }
        return result
    }
}
