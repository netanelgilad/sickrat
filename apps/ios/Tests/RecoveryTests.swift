import CryptoKit
import XCTest
@testable import Sickrat

final class RecoveryTests: XCTestCase {
  let password = "a long unique recovery password"
  func testRoundTripAndWrongPassword() throws {
    let raw = Data(0..<32), origin = "https://vault.example"
    let data = try VaultRecovery.seal(SymmetricKey(data: raw), origin: origin, password: password)
    XCTAssertEqual(try VaultRecovery.open(data, origin: origin, password: password), raw)
    XCTAssertThrowsError(try VaultRecovery.open(data, origin: origin, password: "a different recovery password"))
    XCTAssertThrowsError(try VaultRecovery.open(data, origin: "https://other.example", password: password))
    XCTAssertFalse(String(decoding: data, as: UTF8.self).contains(raw.base64URL))
  }
  func testRejectsTamperingAndUnboundedWork() throws {
    let data = try VaultRecovery.seal(SymmetricKey(size: .bits256), origin: "https://vault.example", password: password)
    var record = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let ciphertext = try Data(base64URL: XCTUnwrap(record["ciphertext"] as? String))
    var changed = ciphertext; changed[0] ^= 1
    record["ciphertext"] = changed.base64URL
    XCTAssertThrowsError(try VaultRecovery.open(JSONSerialization.data(withJSONObject: record), origin: "https://vault.example", password: password))
    record["rounds"] = 4_000_000_000
    XCTAssertThrowsError(try VaultRecovery.open(JSONSerialization.data(withJSONObject: record), origin: "https://vault.example", password: password))
    XCTAssertThrowsError(try VaultRecovery.wrappingKey(password: "short", salt: Data(repeating: 0, count: 32)))
  }
  func testPBKDF2MatchesIndependentVector() throws {
    // Python hashlib.pbkdf2_hmac('sha256', password, bytes(range(32)), 600000).
    let key = try VaultRecovery.wrappingKey(password: password, salt: Data(0..<32))
    XCTAssertEqual(key.withUnsafeBytes { Data($0).base64URL }, "aYJomqj7jkMtXt8eVyP9LPFo8RbsSYxkPbzKDUPIQTc")
  }
}

private final class RecoveryNetwork: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let url = request.url!
    var body: [String: Any] = ["secrets": [], "connections": [], "browserSessions": []]
    let key = url.host!.split(separator: ".")[0]
    if key == "malformed" { body = [:] }
    else { body[key.lowercased() == "browsersessions" ? "browserSessions" : String(key)] = [["id": "existing-encrypted-record"]] }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor final class KeyInitializationTests: XCTestCase {
  func testPopulatedAndMalformedVaultsNeverCreateAKey() async {
    for field in ["secrets", "connections", "browserSessions", "malformed"] {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [RecoveryNetwork.self]
      let model = VaultModel(session: URLSession(configuration: configuration))
      model.endpoint = "https://\(field).example"
      do {
        try await model.initializeKey()
        XCTFail("A non-empty or unreadable vault must not get a new key.")
      } catch {
        XCTAssertTrue(error.localizedDescription.contains("encrypted records"))
        XCTAssertNil(model.key)
      }
    }
  }
}
