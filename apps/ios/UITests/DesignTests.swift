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
    XCTAssertEqual(app.activityIndicators.allElementsBoundByIndex.filter { $0.isHittable && $0.descendants(matching: .activityIndicator).count == 0 }.count, 0)
    app.terminate()
    _ = launch("automatic")
    XCTAssertEqual(app.activityIndicators.allElementsBoundByIndex.filter { $0.isHittable && $0.descendants(matching: .activityIndicator).count == 0 }.count, 0)
    XCTAssertEqual(app.staticTexts["Mac Studio"].frame.minY, idlePosition, accuracy: 1)
    XCTAssertFalse(app.staticTexts["Updating vault…"].exists)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "Requests — silent automatic refresh"
    screenshot.lifetime = .keepAlways
    add(screenshot)
  }
  func testInitialLoadHasOneIndicatorAndNoFalseEmptyState() {
    let app = launch("initial")
    XCTAssertEqual(app.activityIndicators.allElementsBoundByIndex.filter { $0.isHittable && $0.descendants(matching: .activityIndicator).count == 0 }.count, 1)
    XCTAssertFalse(app.staticTexts["No pending requests"].exists)
  }
  func testUnlockProgressStaysInToolbar() {
    let app = launch("unlock")
    XCTAssertEqual(app.activityIndicators.allElementsBoundByIndex.filter { $0.isHittable && $0.descendants(matching: .activityIndicator).count == 0 }.count, 1)
    XCTAssertTrue(app.navigationBars.activityIndicators.firstMatch.exists)
    XCTAssertTrue(app.staticTexts["Mac Studio"].exists)
  }
}
