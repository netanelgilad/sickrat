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
