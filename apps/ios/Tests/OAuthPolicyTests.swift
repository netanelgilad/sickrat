import XCTest

@testable import Sickrat

final class OAuthPolicyTests: XCTestCase {
  private func account(
    _ id: String = "one", name: String = "personal", scopes: [String] = ["read"],
    revoked: String? = nil
  ) -> Connection {
    Connection(
      id: id, providerId: "google", connectionName: name, accountLabel: "alex@example.com",
      accountSubject: "alex", grantedScopes: scopes, revokedAt: revoked)
  }
  private func resource(name: String? = nil, scopes: [String] = ["read"]) -> Approval.Resource {
    Approval.Resource(
      type: "oauth_token", ref: nil, providerId: "google", connectionName: name, scopes: scopes,
      env: "TOKEN", resourceRef: nil, access: nil)
  }
  func testUnnamedRequestsStayAmbiguousUntilCommandNamesAnAccount() {
    let accounts = [account(), account("two", name: "work")]
    XCTAssertEqual(OAuthPolicy.matches(resource(), accounts).count, 2)
    XCTAssertEqual(OAuthPolicy.matches(resource(name: "work"), accounts).map(\.id), ["two"])
  }
  func testMissingScopesCanBeRepairedWithoutChoosingAnotherAccount() {
    let accounts = [account(), account("two", name: "work", scopes: ["read", "write"])]
    let request = resource(name: "personal", scopes: ["read", "write"])
    XCTAssertTrue(OAuthPolicy.matches(request, accounts).isEmpty)
    XCTAssertEqual(OAuthPolicy.candidates(request, accounts).map(\.id), ["one"])
  }
  func testRevokedConnectionsNeverSatisfyApproval() {
    XCTAssertTrue(OAuthPolicy.matches(resource(), [account(revoked: "2026-01-01")]).isEmpty)
    XCTAssertTrue(OAuthPolicy.candidates(resource(), [account(revoked: "2026-01-01")]).isEmpty)
  }
  func testReauthorizationCannotSilentlySwitchIdentity() {
    XCTAssertNoThrow(try OAuthPolicy.validateIdentity(existing: account(), subject: "alex"))
    XCTAssertThrowsError(try OAuthPolicy.validateIdentity(existing: account(), subject: "other"))
    XCTAssertNoThrow(try OAuthPolicy.validateIdentity(existing: nil, subject: "new-account"))
  }
  func testNamesMatchProtocolBoundaries() {
    for name in ["a", "work-2", String(repeating: "a", count: 64)] {
      XCTAssertTrue(OAuthPolicy.validName(name))
    }
    for name in ["", "Work", "work_2", " work", "-a", "a-", String(repeating: "a", count: 65)] {
      XCTAssertFalse(OAuthPolicy.validName(name))
    }
  }
  func testDecodedAccountRetainsIdentityForReauthorization() throws {
    let data = Data(
      #"{"id":"1","providerId":"google","connectionName":"personal","accountLabel":"Alex","accountSubject":"alex","grantedScopes":[],"revokedAt":null}"#
        .utf8)
    XCTAssertEqual(try JSONDecoder().decode(Connection.self, from: data).accountSubject, "alex")
  }
}
