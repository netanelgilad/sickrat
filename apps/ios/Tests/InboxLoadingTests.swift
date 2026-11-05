import Foundation
import XCTest
@testable import Sickrat

final class InboxNetwork: URLProtocol, @unchecked Sendable {
  private let stateLock = NSLock()
  private var stopped = false
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  static func approval(_ id: String, status: String) -> [String: Any] {
    ["id": id, "device": "Test Mac", "command": "test", "secretRefs": [], "resourceRequests": [],
     "status": status, "expiresAt": "2099-01-01T00:00:00Z", "expired": false]
  }
  override func startLoading() {
    let url = request.url!
    let catalog = !url.path.hasPrefix("/api/approvals")
    DispatchQueue.global().asyncAfter(deadline: .now() + (catalog ? 0.6 : 0.01)) { [self] in
      stateLock.withLock {
        guard !stopped else { return }
        if catalog && url.host == "offline-catalog.example" {
          client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
          return
        }
        let body: [String: Any]
        switch url.path {
        case "/api/approvals":
          let query = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems ?? []
          if query.contains(where: { $0.name == "status" && $0.value == "pending" }) {
            body = ["approvals": [Self.approval("pending", status: "pending")], "pendingCount": 7]
          } else if query.contains(where: { $0.name == "limit" && $0.value == "3" }) {
            body = ["approvals": [Self.approval("recent", status: "approved")]]
          } else {
            body = ["approvals": [Self.approval("older", status: "denied")]]
          }
        case "/api/approvals/older": body = ["approval": Self.approval("older", status: "denied")]
        case "/api/secrets": body = ["secrets": []]
        case "/api/devices": body = ["devices": []]
        case "/api/oauth/connections": body = ["connections": []]
        default: body = ["browserSessions": []]
        }
        let data = try! JSONSerialization.data(withJSONObject: body)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
      }
    }
  }
  override func stopLoading() { stateLock.withLock { stopped = true } }
}

@MainActor final class InboxLoadingTests: XCTestCase {
  private func model(_ host: String = "vault.example") -> VaultModel {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [InboxNetwork.self]
    let model = VaultModel(session: URLSession(configuration: config))
    model.endpoint = "https://" + host
    return model
  }
  func testInboxBecomesReadyBeforeCatalogAndHistoryLoadsOnDemand() async throws {
    let model = model()
    let refresh = Task { try await model.refresh() }
    let deadline = Date().addingTimeInterval(0.4)
    while model.lastRequestRefresh == nil && Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
    XCTAssertNotNil(model.lastRequestRefresh)
    XCTAssertEqual(model.pendingBadgeCount, 7)
    XCTAssertNil(model.lastRefresh)
    XCTAssertEqual(model.approvals.map(\.id), ["pending", "recent"])
    XCTAssertFalse(model.historyLoaded)
    XCTAssertTrue(model.requestHistory.isEmpty)
    try await refresh.value
    XCTAssertNotNil(model.lastRefresh)
    await model.loadHistory()
    XCTAssertEqual(model.requestHistory.map(\.id), ["older"])
    XCTAssertEqual(model.approvals.map(\.id), ["pending", "recent"])
  }
  func testCatalogFailureDoesNotHidePendingDecisions() async {
    let model = model("offline-catalog.example")
    await model.reload()
    XCTAssertNotNil(model.lastRequestRefresh)
    XCTAssertEqual(model.pending.map(\.id), ["pending"])
    XCTAssertNil(model.lastRefresh)
    XCTAssertNotNil(model.refreshError)
  }
  func testNotificationCanOpenRequestOutsideRecentPreview() async {
    let model = model()
    await model.loadNotificationRequest("older")
    XCTAssertEqual(model.approvals.first?.id, "older")
    XCTAssertTrue(model.requestHistory.isEmpty)
  }
  func testChangingVaultDiscardsInFlightSnapshot() async throws {
    let model = model()
    let refresh = Task { try await model.refresh() }
    try await Task.sleep(for: .milliseconds(2))
    model.endpoint = "https://other.example"
    do { try await refresh.value; XCTFail("Expected cancellation of the old vault snapshot") }
    catch { XCTAssertTrue(VaultModel.isExpectedCancellation(error)) }
    XCTAssertTrue(model.approvals.isEmpty)
    XCTAssertNil(model.lastRequestRefresh)
  }
}
