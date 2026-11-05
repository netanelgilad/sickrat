import XCTest

@MainActor final class DesignTests: XCTestCase {
  private func launch(_ scenario: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--design-preview"]
    app.launchEnvironment["SICKRAT_DESIGN_STATE"] = scenario
    app.launch()
    XCTAssertTrue(app.navigationBars["Requests"].waitForExistence(timeout: 5))
    return app
  }
  func testAutomaticRefreshDoesNotAddIndicatorOrMoveContent() {
    let app = launch("idle")
    let idlePosition = app.staticTexts["Mac Studio"].frame.minY
    XCTAssertEqual(
      app.activityIndicators.allElementsBoundByIndex.filter {
        $0.isHittable && $0.descendants(matching: .activityIndicator).count == 0
      }.count, 0)
    app.terminate()
    _ = launch("automatic")
    XCTAssertEqual(
      app.activityIndicators.allElementsBoundByIndex.filter {
        $0.isHittable && $0.descendants(matching: .activityIndicator).count == 0
      }.count, 0)
    XCTAssertEqual(app.staticTexts["Mac Studio"].frame.minY, idlePosition, accuracy: 1)
    XCTAssertFalse(app.staticTexts["Updating vault…"].exists)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "Requests — silent automatic refresh"
    screenshot.lifetime = .keepAlways
    add(screenshot)
  }
  func testInitialLoadHasOneIndicatorAndNoFalseEmptyState() {
    let app = launch("initial")
    XCTAssertEqual(
      app.activityIndicators.allElementsBoundByIndex.filter {
        $0.isHittable && $0.descendants(matching: .activityIndicator).count == 0
      }.count, 1)
    XCTAssertFalse(app.staticTexts["No pending requests"].exists)
  }
  func testOAuthRepairReturnsToOriginalRequest() {
    let app = launch("oauth")
    app.staticTexts["Research agent"].tap()
    XCTAssertTrue(app.staticTexts["Additional permissions required"].waitForExistence(timeout: 3))
    app.buttons["Update permissions for personal"].tap()
    XCTAssertTrue(app.navigationBars["Reconnect account"].waitForExistence(timeout: 3))
    XCTAssertEqual(app.textFields["Connection name"].value as? String, "personal")
    XCTAssertFalse(app.textFields["Connection name"].isEnabled)
    XCTAssertTrue(app.staticTexts["Sign in as alex@example.com."].exists)
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "OAuth permission repair"
    shot.lifetime = .keepAlways
    add(shot)
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.navigationBars["Review request"].waitForExistence(timeout: 3))
    for _ in 0..<5 where !app.buttons["Approve access"].exists { app.swipeUp() }
    XCTAssertFalse(app.buttons["Approve access"].isEnabled)
  }
  func testTransferScreenExplainsAccessAndRequiresRequest() {
    let app = launch("idle")
    app.tabBars.buttons["Settings"].tap()
    app.buttons["Transfer vault key"].tap()
    for _ in 0..<6 where !app.buttons["Send to another iPhone"].isHittable { app.swipeUp() }
    app.buttons["Send to another iPhone"].tap()
    XCTAssertTrue(app.navigationBars["Send to another iPhone"].waitForExistence(timeout: 3))
    for _ in 0..<6 where !app.buttons["Authenticate and save transfer"].exists { app.swipeUp() }
    XCTAssertFalse(app.buttons["Authenticate and save transfer"].isEnabled)
    XCTAssertTrue(app.staticTexts["Only use a request from a device you own. Transferring the key gives that device full access to this vault."].exists)
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "Native key transfer"
    shot.lifetime = .keepAlways
    add(shot)
  }
  func testNotificationOpensMatchingApproval() {
    let app = XCUIApplication()
    app.launchArguments = ["--design-preview"]
    app.launchEnvironment["SICKRAT_DESIGN_STATE"] = "notification"
    app.launch()
    XCTAssertTrue(app.navigationBars["Review request"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Test Mac"].exists)
    for _ in 0..<8 where !app.buttons["Command details"].isHittable { scrollDetails(app) }
    let disclosure = app.buttons["Command details"]
    if disclosure.buttons.firstMatch.exists { disclosure.buttons.firstMatch.tap() }
    else { disclosure.tap() }
    for _ in 0..<8 where !app.staticTexts["Test request"].exists { scrollDetails(app) }
    XCTAssertTrue(app.staticTexts["Test request"].waitForExistence(timeout: 3))
  }
  func testNotificationSettingsExplainsApprovalAlerts() {
    let app = launch("idle")
    app.tabBars.buttons["Settings"].tap()
    for _ in 0..<5 where !app.buttons["Notifications"].isHittable { app.swipeUp() }
    app.buttons["Notifications"].tap()
    XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 3))
    XCTAssertTrue(app.buttons["Enable notifications"].exists)
    XCTAssertTrue(app.staticTexts["Approve this iPhone from your Mac."].exists)
    XCTAssertFalse(app.buttons["Import setup file"].exists)
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "Notification settings"
    shot.lifetime = .keepAlways
    add(shot)
  }
  private func scrollDetails(_ app: XCUIApplication) {
    // Stay inside the scrollable content, above the persistent decision area.
    let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.42))
    start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.18)))
  }
  private func capture(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }
  func testPendingRequestKeepsDecisionVisibleAndDisclosesCommand() {
    let app = launch("pending")
    capture(app, "Requests — pending")
    app.staticTexts["Mac Studio"].tap()
    XCTAssertTrue(app.navigationBars["Review request"].waitForExistence(timeout: 3))
    XCTAssertTrue(app.buttons["Approve access"].isHittable)
    XCTAssertTrue(app.buttons["Deny request"].isHittable)
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "15 minutes")).firstMatch.exists)
    XCTAssertFalse(app.staticTexts["npm run deploy -- --production"].isHittable)
    capture(app, "Review — scope and decision")
    // SwiftUI can report a Form row beneath the sticky actions as hittable.
    // Bring the disclosure above those controls before tapping it.
    for _ in 0..<8 {
      let command = app.buttons["Command details"]
      if command.isHittable && command.frame.maxY < app.buttons["Approve access"].frame.minY - 8 { break }
      scrollDetails(app)
    }
    let disclosure = app.buttons["Command details"]
    if disclosure.buttons.firstMatch.exists { disclosure.buttons.firstMatch.tap() }
    else { disclosure.tap() }
    XCTAssertTrue(app.staticTexts["npm run deploy -- --production"].waitForExistence(timeout: 3))
    XCTAssertTrue(app.buttons["Approve access"].isHittable)
  }
  func testApproveStartsAfterOneTap() {
    let app = launch("pending")
    app.staticTexts["Mac Studio"].tap()
    app.buttons["Approve access"].tap()
    // The fixture refuses networking. Reaching that error proves the first tap
    // started the action without a second confirmation or a real vault grant.
    XCTAssertTrue(app.alerts.staticTexts["Sample previews do not contact a vault."].waitForExistence(timeout: 4))
    XCTAssertFalse(app.sheets.firstMatch.exists)
  }
  func testVaultSearchHasUsefulEmptyStateAndKeepsCategoriesReachable() {
    let app = launch("idle")
    app.tabBars.buttons["Vault"].tap()
    XCTAssertTrue(app.buttons["Connected accounts"].exists || app.staticTexts["Connected accounts"].exists)
    capture(app, "Vault — categories and secrets")
    app.searchFields.firstMatch.tap()
    app.searchFields.firstMatch.typeText("no-such-secret")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "No Results")).firstMatch.waitForExistence(timeout: 3))
    capture(app, "Vault — no search results")
  }
  func testDesignScreenshots() {
    let app = launch("idle")
    capture(app, "Requests — recent activity")
    app.tabBars.buttons["Vault"].tap()
    app.staticTexts["Example API key"].tap()
    XCTAssertTrue(app.buttons["Reveal value"].waitForExistence(timeout: 3))
    capture(app, "Secret — protected value")
    app.tabBars.buttons["Settings"].tap()
    capture(app, "Settings — security and access")
    app.buttons["Notifications"].tap()
    capture(app, "Notifications — explanation and setup")
  }
  func testPairingKeepsSharingAndNavigationAvailableAcrossAppSwitching() {
    let app = launch("pairing")
    app.tabBars.buttons["Settings"].tap()
    app.buttons["Notifications"].tap()
    for _ in 0..<12 where !app.buttons["Share pairing code"].isHittable { scrollDetails(app) }
    XCTAssertTrue(app.buttons["Share pairing code"].waitForExistence(timeout: 3))
    XCTAssertTrue(app.buttons["Share pairing code"].isEnabled)
    capture(app, "Notifications — waiting for Mac")
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(app.buttons["Share pairing code"].isEnabled)
    XCTAssertFalse(app.alerts.firstMatch.exists)
    XCTAssertTrue(app.tabBars.buttons["Vault"].isEnabled)
    app.tabBars.buttons["Vault"].tap()
    XCTAssertTrue(app.navigationBars["Vault"].waitForExistence(timeout: 3))
  }
  func testHomeLimitsHistoryAndOlderItemsRemainReachable() {
    let app = launch("history")
    XCTAssertTrue(app.staticTexts["Mac Studio"].exists)
    XCTAssertFalse(app.staticTexts["Older Mac 1"].exists)
    capture(app, "Home — three recent requests")
    for _ in 0..<8 where !app.buttons["Request history"].isHittable { scrollDetails(app) }
    XCTAssertTrue(app.buttons["Request history"].isHittable)
    app.buttons["Request history"].tap()
    XCTAssertTrue(app.navigationBars["Request history"].waitForExistence(timeout: 3))
    for _ in 0..<8 where !app.staticTexts["Older Mac 1"].isHittable { app.swipeUp() }
    XCTAssertTrue(app.staticTexts["Older Mac 1"].isHittable)
    capture(app, "History — older requests on demand")
  }
  func testApprovalReceipt() {
    let app = XCUIApplication()
    app.launchArguments = ["--design-preview"]
    app.launchEnvironment["SICKRAT_DESIGN_STATE"] = "receipt"
    app.launch()
    XCTAssertTrue(app.staticTexts["Access approved"].waitForExistence(timeout: 4))
    XCTAssertTrue(app.buttons["Done"].isHittable)
    capture(app, "Approval — completion receipt")
  }
  func testUnlockProgressStaysInToolbar() {
    let app = launch("unlock")
    XCTAssertEqual(
      app.activityIndicators.allElementsBoundByIndex.filter {
        $0.isHittable && $0.descendants(matching: .activityIndicator).count == 0
      }.count, 1)
    XCTAssertTrue(app.navigationBars.activityIndicators.firstMatch.exists)
    XCTAssertTrue(app.staticTexts["Mac Studio"].exists)
  }
}
