import CryptoKit
import XCTest
@testable import Sickrat

final class KeyTransferTests: XCTestCase {
  func request(_ recipient: P256.KeyAgreement.PrivateKey, origin: String = "https://vault.example") throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: [
      "type": "sickrat-ios-transfer-request", "version": 1, "origin": origin,
      "publicKey": VaultCrypto.publicJWK(recipient.publicKey),
    ]), as: UTF8.self)
  }
  func testEnvelopeMatchesExistingImportProtocol() throws {
    let pair = P256.KeyAgreement.PrivateKey()
    let origin = "https://vault.example"
    let recipient = try KeyTransfer.recipient(request(pair), origin: origin)
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let raw = Data(0..<32)
    let data = try KeyTransfer.seal(key: SymmetricKey(data: raw), recipient: recipient, origin: origin, now: now)
    let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(envelope["type"] as? String, "sickrat-ios-transfer")
    XCTAssertEqual(envelope["version"] as? Int, 1)
    let ephemeral = try VaultCrypto.publicKey(XCTUnwrap(VaultCrypto.jwkFields(envelope["ephemeralPublicKey"])))
    let wrapping = try VaultCrypto.agreement(pair, publicKey: ephemeral, transfer: true)
    let encrypted = try ["iv": XCTUnwrap(envelope["iv"] as? String), "ciphertext": XCTUnwrap(envelope["ciphertext"] as? String)]
    let plaintext = try VaultCrypto.open(encrypted, key: wrapping)
    let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: plaintext) as? [String: String])
    XCTAssertEqual(payload["key"], raw.base64URL)
    XCTAssertEqual(payload["origin"], origin)
    XCTAssertEqual(payload["expiresAt"], ISO8601DateFormatter().string(from: now.addingTimeInterval(600)))
    let wrong = try VaultCrypto.agreement(P256.KeyAgreement.PrivateKey(), publicKey: ephemeral, transfer: true)
    XCTAssertThrowsError(try VaultCrypto.open(encrypted, key: wrong))
    XCTAssertNil(envelope["key"])
  }
  func testRejectDifferentVaultMalformedAndOversizedRequest() throws {
    let pair = P256.KeyAgreement.PrivateKey()
    XCTAssertThrowsError(try KeyTransfer.recipient(request(pair), origin: "https://other.example"))
    for text in ["{}", "not json", String(repeating: "x", count: 16_384)] {
      XCTAssertThrowsError(try KeyTransfer.recipient(text, origin: "https://vault.example"))
    }
  }
}
