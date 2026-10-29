import LocalAuthentication
import XCTest

@testable import Sickrat

final class CancelledNetwork: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.cancelled)) }
  override func stopLoading() {}
}
final class OfflineNetwork: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
  }
  override func stopLoading() {}
}
@MainActor final class ActivityTests: XCTestCase {
  private func model(using protocolClass: AnyClass) -> VaultModel {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [protocolClass]
    let model = VaultModel(session: URLSession(configuration: config))
    model.endpoint = "https://vault.example"
    return model
  }
  func testCancelledRefreshDoesNotRaiseAlertOrLeaveSpinner() async {
    let model = model(using: CancelledNetwork.self)
    await model.reload()
    XCTAssertNil(model.error)
    XCTAssertNil(model.refreshError)
    XCTAssertFalse(model.refreshing)
    XCTAssertFalse(model.busy)
    XCTAssertNil(model.lastRefresh)
  }
  func testOfflineRefreshIsInlineAndPreservesExistingSnapshot() async {
    let model = model(using: OfflineNetwork.self)
    let previous = Date(timeIntervalSince1970: 100)
    model.lastRefresh = previous
    await model.reload()
    XCTAssertNil(model.error)
    XCTAssertNotNil(model.refreshError)
    XCTAssertFalse(model.refreshing)
    XCTAssertEqual(model.lastRefresh, previous)
  }
  func testActionShowsProgressAndClearsItOnURLCancellation() async {
    let model = VaultModel()
    await model.run("Revealing secret…") {
      XCTAssertTrue(model.busy)
      XCTAssertEqual(model.activity, "Revealing secret…")
      throw URLError(.cancelled)
    }
    XCTAssertFalse(model.busy)
    XCTAssertNil(model.activity)
    XCTAssertNil(model.error)
  }
  func testRealActionFailuresRemainVisible() async {
    let model = VaultModel()
    await model.run("Saving secret…") { throw VaultError("Save failed") }
    XCTAssertEqual(model.error, "Save failed")
    XCTAssertNil(model.activity)
  }
  func testSystemAuthenticationCancellationIsExpected() {
    for code in [LAError.userCancel, LAError.systemCancel, LAError.appCancel] {
      XCTAssertTrue(
        VaultModel.isExpectedCancellation(NSError(domain: LAError.errorDomain, code: code.rawValue))
      )
    }
    XCTAssertFalse(VaultModel.isExpectedCancellation(URLError(.timedOut)))
    XCTAssertFalse(
      VaultModel.isExpectedCancellation(
        NSError(domain: LAError.errorDomain, code: LAError.authenticationFailed.rawValue)))
  }
  func testTaskCancellationIsSilentAndResetsProgress() async {
    let model = VaultModel()
    await model.run("Approving access…") { throw CancellationError() }
    XCTAssertNil(model.error)
    XCTAssertFalse(model.busy)
  }
}
