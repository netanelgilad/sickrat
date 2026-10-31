import XCTest
@testable import Sickrat

final class DesignPresentationTests: XCTestCase {
  func testDatesAcceptWorkerFractionalAndNonfractionalTimestamps() {
    XCTAssertNotNil(VaultDate.parse("2026-10-29T17:24:46.859Z"))
    XCTAssertNotNil(VaultDate.parse("2026-10-29T17:24:46Z"))
    XCTAssertNil(VaultDate.parse("not a timestamp"))
  }
  func testDurationDoesNotDescribeSubminuteAccessAsZeroMinutes() {
    let request = approval(seconds: 30)
    XCTAssertTrue(request.durationTitle.contains("30"))
    XCTAssertFalse(request.durationTitle.contains("0 minutes"))
    XCTAssertEqual(approval(seconds: nil).durationTitle, "One-time access")
  }
  func testResourceSummaryDoesNotCountSecretEnvelopeTwice() {
    let request = approval(seconds: 900)
    XCTAssertEqual(request.resourceCount, 2)
    XCTAssertTrue(request.accessSummary.hasPrefix("2 resources"))
  }
  private func approval(seconds: Int?) -> Approval {
    Approval(id: "request", device: "Mac", command: "test", message: nil,
             secretRefs: ["demo/key", "demo/key"],
             resourceRequests: [
               Approval.Resource(type: "secret", ref: "demo/key", providerId: nil, connectionName: nil, scopes: nil, env: "KEY", resourceRef: nil, access: nil),
               Approval.Resource(type: "oauth_token", ref: nil, providerId: "google", connectionName: nil, scopes: ["openid"], env: "TOKEN", resourceRef: nil, access: nil)
             ], accessDurationSeconds: seconds, status: "pending", expiresAt: "2099-01-01T00:00:00Z", expired: false, ephemeralPublicKey: nil)
  }
}
