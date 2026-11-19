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

    func testRecipeLinkFindsSupportedURLInsideShareText() throws {
        let short = try XCTUnwrap(NativeRecipeSource.link("家常菜 https://xhslink.cn/a/Abcd1234，复制这条消息打开小红书"))
        XCTAssertEqual(short.absoluteString, "https://xhslink.cn/a/Abcd1234")
        XCTAssertEqual(NativeRecipeSource.platform(for: short), .xiaohongshu)
        let redNote = try XCTUnwrap(NativeRecipeSource.link("https://www.rednote.com/zh/discovery/item/67abcdef1234567890abcdef"))
        XCTAssertEqual(NativeRecipeSource.platform(for: redNote), .xiaohongshu)
        let recipe = try XCTUnwrap(NativeRecipeSource.link("https://example.com/docs\n〈千层豆腐〉http://www.xiachufang.com/recipe/123456/（下厨房）"))
        XCTAssertEqual(recipe.absoluteString, "https://www.xiachufang.com/recipe/123456/")
        XCTAssertEqual(NativeRecipeSource.platform(for: recipe), .xiachufang)
    }

    func testRecipeLinkRejectsUnsupportedHostsPathsAndUserInfo() {
        XCTAssertNil(NativeRecipeSource.link("https://www.xiachufang.com.example.org/recipe/123456/"))
        XCTAssertNil(NativeRecipeSource.link("https://www.xiachufang.com/category/123456/"))
        XCTAssertNil(NativeRecipeSource.link("https://name@www.xiachufang.com/recipe/123456/"))
        XCTAssertNil(NativeRecipeSource.link("https://www.xiachufang.com:443/recipe/123456/"))
        XCTAssertNil(NativeRecipeSource.link("myapp://www.xiachufang.com/recipe/123456/"))
        XCTAssertNil(NativeRecipeSource.link("https://www.rednote.com/login"))
    }

    func testXiaohongshuShareCopyKeepsAnIncompleteRecipeAsAnExcerpt() throws {
        let pasted = "家常打抛饭教程 准备材料：小米辣... https://xhslink.cn/o/Synthetic123 复制这段话，然后去【小红书】查看。"
        let share = try XCTUnwrap(NativeRecipeSource.sharedText(in: pasted))
        XCTAssertEqual(share.title, "家常打抛饭教程")
        XCTAssertEqual(share.excerpt, "准备材料：小米辣...")
        XCTAssertEqual(NativeRecipeSource.link(pasted)?.absoluteString, "https://xhslink.cn/o/Synthetic123")
        let multiline = "番茄炖牛腩\t家常版\n牛腩炖至软烂再收汁。\nhttps://xhslink.com/a/Synthetic123"
        XCTAssertEqual(NativeRecipeSource.sharedText(in: multiline)?.title, "番茄炖牛腩 家常版")
        XCTAssertEqual(NativeRecipeSource.sharedText(in: multiline)?.excerpt, "牛腩炖至软烂再收汁。")
    }

    func testShareCopyIgnoresPlatformWrappersAndUnrelatedSources() {
        let shortLink = "https://xhslink.cn/o/Synthetic123"
        XCTAssertNil(NativeRecipeSource.sharedText(in: shortLink))
        XCTAssertNil(NativeRecipeSource.sharedText(in: "某用户发布了一篇小红书笔记，快来看吧！ \(shortLink)"))
        XCTAssertNil(NativeRecipeSource.sharedText(in: "蘑菇汤 https://www.xiachufang.com/recipe/123456/"))
        XCTAssertNil(NativeRecipeSource.sharedText(in: "https://example.com/recipe \(shortLink)"))
    }

    func testXiaohongshuCaptionExtractsExplicitIngredientsAndNumberedSteps() {
        let caption = [
            "像在家做的一碗蘑菇饭", "准备材料：米饭一碗、\u{00a0}香菇两朵、青葱少许", "具体步骤：",
            "\u{3000}1️⃣ 切好香菇。", "2️⃣热锅加油。", "3️⃣加入米饭。", "4️⃣调味。", "5️⃣拌匀。#家常菜[话题]#", "",
            "作者：今天也吃得开心。", "6️⃣ 这是想说的话。", "#蘑菇饭[话题]#",
        ].joined(separator: "\r\n")
        let recipe = NativeXiaohongshuRecipeDraft(noteBody: caption)
        XCTAssertEqual(recipe.ingredients, "米饭一碗\n香菇两朵\n青葱少许")
        XCTAssertEqual(recipe.steps, "切好香菇。\n热锅加油。\n加入米饭。\n调味。\n拌匀。")
    }

    func testXiaohongshuCaptionRequiresExplicitSectionsAndStopsAtComments() {
        let plain = NativeXiaohongshuRecipeDraft(noteBody: "香菇、米饭。\n1️⃣ 热锅。\n2️⃣ 调味。")
        XCTAssertNil(plain.ingredients)
        XCTAssertNil(plain.steps)

        let caption = "\u{FEFF}食材：\u{2028}香菇\u{200B} 2 朵\u{2028}米饭一碗\u{2028}做法： １．热锅。\u{2028}2⃣ 炒匀。\u{2028}作者说，欢迎留言。\u{2028}3️⃣ 评论内容"
        let recipe = NativeXiaohongshuRecipeDraft(noteBody: caption)
        XCTAssertEqual(recipe.ingredients, "香菇 2 朵\n米饭一碗")
        XCTAssertEqual(recipe.steps, "热锅。\n炒匀。")

        let empty = NativeXiaohongshuRecipeDraft(noteBody: "做法：\n#笔记[话题]#\n1️⃣ 评论内容")
        XCTAssertNil(empty.steps)

        let separated = NativeXiaohongshuRecipeDraft(noteBody: "步骤：\n1️⃣ 热锅。\n\n2️⃣ 评论内容")
        XCTAssertEqual(separated.steps, "热锅。")

        let inline = NativeXiaohongshuRecipeDraft(noteBody: "食材：面条\n做法：煮面后拌入葱油\n作者：欢迎留言。")
        XCTAssertEqual(inline.ingredients, "面条")
        XCTAssertEqual(inline.steps, "煮面后拌入葱油")
    }

    func testXiaohongshuCaptionBoundsEditableFieldsAtWholeCharacters() throws {
        let grapheme = "👩🏽‍🍳"
        let line = String(repeating: grapheme, count: 1_200)
        let recipe = NativeXiaohongshuRecipeDraft(noteBody: "食材：\(line)\n步骤：\n1️⃣ \(line)")
        let ingredients = try XCTUnwrap(recipe.ingredients)
        let steps = try XCTUnwrap(recipe.steps)
        XCTAssertLessThanOrEqual(ingredients.utf16.count, 3_000)
        XCTAssertLessThanOrEqual(steps.utf16.count, 6_000)
        XCTAssertEqual(ingredients, String(repeating: grapheme, count: 3_000 / grapheme.utf16.count))
        XCTAssertEqual(steps, String(repeating: grapheme, count: 6_000 / grapheme.utf16.count))
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

    func testHomeProgressDistinguishesMissingPartialZeroAndExceededIntake() {
        let missing = NativeHomeNutrient("脂肪", unit: "g", total: nil, knownCount: 0, unknownCount: 2, target: "60.0")
        XCTAssertEqual(missing.quantity, "— / 60 g")
        XCTAssertNil(missing.fraction)
        XCTAssertFalse(missing.isPartial)

        let partial = NativeHomeNutrient("蛋白质", unit: "g", total: "25.5", knownCount: 1, unknownCount: 1, target: "51.0")
        XCTAssertEqual(partial.quantity, "≥25.5 / 51 g")
        XCTAssertEqual(partial.fraction, 0.5)
        XCTAssertTrue(partial.accessibilityValue.contains("已知小计"))

        let zero = NativeHomeNutrient("能量", unit: "千卡", total: "0.0", knownCount: 1, unknownCount: 0, target: "1800.0")
        XCTAssertEqual(zero.quantity, "0 / 1800 千卡")
        XCTAssertEqual(zero.fraction, 0)

        let exceeded = NativeHomeNutrient("碳水", unit: "g", total: "245.0", knownCount: 2, unknownCount: 0, target: "200.0")
        XCTAssertEqual(exceeded.quantity, "245 / 200 g")
        XCTAssertEqual(exceeded.fraction, 1)

        for goal in [nil, "0.0", "invalid"] as [String?] {
            let value = NativeHomeNutrient("脂肪", unit: "g", total: "25.0", knownCount: 1, unknownCount: 0, target: goal)
            XCTAssertNil(value.fraction)
        }
    }

    func testDietMealSubtotalsRespectMissingValuesAndDeletedEntries() {
        let entries: [NativeJSON] = [
            .object(["calories": .string("120.5")]),
            .object(["calories": .string("0.0")]),
            .object(["calories": .null]),
            .object(["calories": .string("500.0"), "deleted": .bool(true)]),
        ]
        XCTAssertEqual(NativeDietMealSubtotal.label(entries: entries, skipped: false), "≥120.5 千卡")
        XCTAssertEqual(NativeDietMealSubtotal.label(entries: [entries[1]], skipped: false), "0 千卡")
        XCTAssertEqual(NativeDietMealSubtotal.label(entries: [entries[2]], skipped: false), "—")
        XCTAssertEqual(NativeDietMealSubtotal.label(entries: [entries[3]], skipped: true), "未进食")
        XCTAssertEqual(NativeDietMealSubtotal.label(entries: [], skipped: false), "未记录")
    }

    func testDietActivityOnlyReadsTheSelectedDayAndPreservesZero() {
        let previous = NativeTrendPoint(day: "2026-11-17", value: 280, measuredAt: "2026-11-17T08:00:00Z",
                                        source: "fixture", sleepStages: nil)
        let zero = NativeTrendPoint(day: "2026-11-18", value: 0, measuredAt: "2026-11-18T08:00:00Z",
                                    source: "fixture", sleepStages: nil)
        let metric = NativeMetricSummary(metric: "active_energy", label: "活动能量", unit: "kcal", latestValue: 280,
                                         latestDate: previous.day, points: [previous, zero])
        let response = NativeHealthResponse(summary: NativeHealthSummary(metrics: ["active_energy": metric], measurementCount: 2,
                                                                          lastMeasurementAt: nil), measurements: [], lastSync: nil)
        XCTAssertEqual(NativeDietActivity.value(in: response, date: zero.day), 0)
        XCTAssertEqual(NativeDietActivity.value(in: response, date: previous.day), 280)
        XCTAssertNil(NativeDietActivity.value(in: response, date: "2026-11-16"))
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

    func testCreationSelectionOverridesOldReuseDateAndMealWithoutChangingNutrients() throws {
        let source = input(calories: .string("0"))
        let selection = NativeNutritionEntrySelection(date: "2026-11-09", meal: "dinner")
        let adopted = selection.applying(to: source)
        let payload = try NativeNutritionDraft(adopted).payload()
        XCTAssertEqual(payload["date"], .string("2026-11-09"))
        XCTAssertEqual(payload["meal"], .string("dinner"))
        XCTAssertEqual(payload["calories"], .string("0"))
        XCTAssertEqual(payload["carbs"], .null)
        XCTAssertEqual(source["date"], .string(today), "Choosing another meal must not mutate the source record")
    }

    func testCatalogAndReuseKeepHistoricalBreakfastContext() throws {
        let date = "2026-11-09", meal = "breakfast"
        let food: NativeJSON = .object(["id": .string("catalog:synthetic"), "name": .string("合成早餐"), "basis": .string("perServing"),
            "catalogRelease": .string("historical-release"), "serving": .object(["label": .string("一份"), "kcal": .number(100), "protein": .null, "carbs": .null, "fat": .null])])
        let row = try NativeFoodSelectionDraft.make(food: food, amount: "1", unit: "份", date: date, meal: meal)
        let repeated = try NativeNutritionReuseDraft.make(row, date: date, meal: meal)
        XCTAssertEqual(repeated["date"], .string(date))
        XCTAssertEqual(repeated["meal"], .string(meal))
        XCTAssertEqual(repeated["food"]["catalogRelease"], .string("historical-release"))
        XCTAssertEqual(repeated["protein"], .null)
    }

    func testSuggestedMealUsesShanghaiTimeInsteadOfHostTimezone() throws {
        func instant(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }
        XCTAssertEqual(NativeNutritionEntrySelection.suggestedMeal(at: instant("2026-11-16T00:30:00Z")), "breakfast")
        XCTAssertEqual(NativeNutritionEntrySelection.suggestedMeal(at: instant("2026-11-16T04:30:00Z")), "lunch")
        XCTAssertEqual(NativeNutritionEntrySelection.suggestedMeal(at: instant("2026-11-16T10:30:00Z")), "dinner")
        XCTAssertEqual(NativeNutritionEntrySelection.suggestedMeal(at: instant("2026-11-16T15:30:00Z")), "snack")
    }

    func testInputIssuesIdentifyFirstFieldAndStableScrollAnchor() throws {
        var draft = NativeNutritionDraft(input())
        draft.name = "  "
        draft.nutrients["calories"] = "1.23"
        let issues = draft.validationIssues()
        XCTAssertEqual(issues.map(\.field), ["name", "calories"])
        XCTAssertEqual(issues.first?.id, draft.id.uuidString + ":name")
        XCTAssertFalse(issues.contains { $0.field == "protein" || $0.field == "carbs" })
        draft.name = "米饭"; draft.setNutrient("calories", text: "0")
        XCTAssertTrue(draft.validationIssues().isEmpty)
        XCTAssertEqual(try draft.payload()["calories"], .string("0"))
    }

    func testNoOpIdentityKeepsReferenceAndChangeExplainsOnlyInvalidatedValues() throws {
        var source = input(calories: .string("100")).objectValue
        source["food"] = .object(["id": .string("catalog:synthetic"), "amount": .number(1), "unit": .string("份"), "catalogRelease": .string("captured-release")])
        source["provenance"] = .object(["calories": .object(["source": .string("ai"), "basis": .string("原参考")]),
            "protein": .object(["source": .string("manual"), "basis": .string("已核对为零")])])
        var draft = NativeNutritionDraft(.object(source))
        draft.changeIdentity(name: draft.name, portion: draft.portion)
        XCTAssertNotEqual(draft.food, .null)
        XCTAssertEqual(draft.nutrients["calories"], "100")
        XCTAssertTrue(draft.warnings.isEmpty)
        draft.changeIdentity(portion: "另一份量")
        XCTAssertEqual(draft.food, .null)
        XCTAssertEqual(draft.nutrients["calories"], "")
        XCTAssertEqual(draft.nutrients["protein"], "0")
        XCTAssertTrue(draft.warnings.contains { $0.contains("热量") && $0.contains("已清空") })
        XCTAssertEqual(try draft.payload()["calories"], .null)
        XCTAssertEqual(try draft.payload()["protein"], .string("0"))
    }

    func testNumericZeroFromCandidateDoesNotBecomeUnknown() throws {
        var source = input().objectValue
        source["calories"] = .number(0)
        let payload = try NativeNutritionDraft(.object(source)).payload()
        XCTAssertNotEqual(payload["calories"], .null)
        XCTAssertEqual(payload["calories"].stringValue.flatMap(Double.init), 0)
        XCTAssertEqual(payload["carbs"], .null)
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
        let command = NativeNutritionCommand(path: "health/nutrition/batch", title: "保存明细", body: .object(["entries": .array([input()])]))
        do {
            let context = NativeNutritionContext(api: api, token: "synthetic-token", userID: user)
            _ = await context.write(command)
            XCTAssertEqual(context.pending?.requestID, command.requestID)
        }
        let reopened = NativeNutritionContext(api: api, token: "synthetic-token", userID: user)
        reopened.restorePending()
        XCTAssertEqual(reopened.pending, command)
        XCTAssertEqual(requests, 1, "Reopening must wait for an explicit retry")
        await reopened.retry(command)
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
        await context.retry(command)
        XCTAssertNil(context.pending)
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(revision, 2)
        XCTAssertEqual(context.changes, 1)
    }

    @MainActor
    func testConcurrentNutritionContextsPreserveAndRetryTheOriginalBatch() async throws {
        let host = "nutrition-overlap-" + UUID().uuidString.lowercased() + ".example"
        let owner = "nutrition-overlap-" + UUID().uuidString
        let persistence = NativeWorkspacePersistence(userID: owner, scope: "nutrition-pending-command")
        let gate = PendingSubmissionReplyGate()
        let requests = RecordedPendingSubmissionRequests()
        defer { PendingSubmissionURLProtocol.remove(host: host); try? persistence.clear() }
        PendingSubmissionURLProtocol.register(host: host, gate: gate) { request in
            if requests.record(request) == 1 { return (503, Data(#"{"error":"synthetic unavailable"}"#.utf8)) }
            return (200, Data(#"{"replayed":true}"#.utf8))
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PendingSubmissionURLProtocol.self]
        let api = NativeAPI(baseURL: URL(string: "https://" + host)!, configuration: config)
        let first = NativeNutritionContext(api: api, token: "synthetic-token", userID: owner)
        let second = NativeNutritionContext(api: api, token: "synthetic-token", userID: owner)
        first.restorePending()
        second.restorePending()
        XCTAssertNil(first.pending)
        XCTAssertNil(second.pending)
        let original = NativeNutritionCommand(path: "health/nutrition/batch", title: "保存明细", body: .object(["entries": .array([input()])]))
        let competitor = NativeNutritionCommand(path: "health/nutrition/goals", method: "PUT", title: "修改目标",
                                                body: .object(["expectedRevision": .integer(3), "calories": .string("1500")]))

        let sending = Task { await first.write(original) }
        defer { gate.release(); sending.cancel() }
        try await gate.waitUntilHeld()
        XCTAssertTrue(second.busy)
        XCTAssertEqual(second.pending, original)
        let competed = await second.write(competitor)
        XCTAssertNil(competed)
        await second.retry(original)
        XCTAssertEqual(requests.values.count, 1)
        XCTAssertEqual(try persistence.load(NativeNutritionCommand.self), original)

        gate.release()
        let uncertain = await sending.value
        XCTAssertNil(uncertain)
        XCTAssertFalse(second.busy)
        XCTAssertEqual(second.pending, original)
        await second.retry(original)
        let replay = requests.values
        XCTAssertEqual(replay.count, 2)
        XCTAssertEqual(replay.first, replay.last)
        XCTAssertEqual(replay.last?.operationID, original.requestID)
        XCTAssertEqual(replay.last?.body, try original.body.encodedData())
        XCTAssertNil(first.pending)
        XCTAssertNil(second.pending)
        XCTAssertNil(try persistence.load(NativeNutritionCommand.self))
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
