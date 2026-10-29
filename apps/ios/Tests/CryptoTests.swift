import CryptoKit
import XCTest

@testable import Sickrat

final class CryptoTests: XCTestCase {
  func testDecryptWebCryptoSecret() throws {
    let key = SymmetricKey(data: Data(0..<32))
    let value = try VaultCrypto.open(
      ["ciphertext": "ZgTSOR1gp5G0_HHp7DiA4oy-EeDIXCifKuGcrtxWMrqmrix5", "iv": "BwcHBwcHBwcHBwcH"],
      key: key)
    XCTAssertEqual(String(decoding: value, as: UTF8.self), "interoperability-✓")
  }
  func testRejectTamperedCiphertext() throws {
    let key = SymmetricKey(data: Data(0..<32))
    var bytes = try Data(base64URL: "ZgTSOR1gp5G0_HHp7DiA4oy-EeDIXCifKuGcrtxWMrqmrix5")
    bytes[0] ^= 1
    XCTAssertThrowsError(
      try VaultCrypto.open(["ciphertext": bytes.base64URL, "iv": "BwcHBwcHBwcHBwcH"], key: key))
  }
  func testECDHMatchesWebCrypto() throws {
    let privateKey = try P256.KeyAgreement.PrivateKey(
      rawRepresentation: Data(base64URL: "Gt5Vq1AxGR-a9F9i1Zzpqq4qfp7qIaC0le2SLhhDTk0"))
    let publicKey = try VaultCrypto.publicKey([
      "kty": "EC", "crv": "P-256", "x": "2dkc_veuyjepYnHvRi_SUCom_zNtotS3e4fbXeztDSg",
      "y": "d_fNmV5ma0lFGZX8OBl_LMp0Bppj16Oymte8Yi3XJN4",
    ])
    let key = try VaultCrypto.agreement(privateKey, publicKey: publicKey)
    XCTAssertEqual(
      key.withUnsafeBytes { Data($0).base64URL }, "r3D0OFwbjKC6p1gKVenXihGa7MQyIEe1-A-yh4x2mrI")
    let transfer = try VaultCrypto.agreement(privateKey, publicKey: publicKey, transfer: true)
    XCTAssertNotEqual(
      transfer.withUnsafeBytes { Data($0).base64URL }, "r3D0OFwbjKC6p1gKVenXihGa7MQyIEe1-A-yh4x2mrI"
    )
  }
  func testGrantCanOnlyBeOpenedByRecipient() throws {
    let recipient = P256.KeyAgreement.PrivateKey()
    let grant = try VaultCrypto.grant(
      ["secrets": ["test/key": "value"]], recipient: VaultCrypto.publicJWK(recipient.publicKey))
    let ephemeral = try VaultCrypto.publicKey(grant["ephemeralPublicKey"] as! [String: String])
    let key = try VaultCrypto.agreement(recipient, publicKey: ephemeral)
    let record = ["ciphertext": grant["ciphertext"] as! String, "iv": grant["iv"] as! String]
    let data = try VaultCrypto.open(record, key: key)
    let decoded = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    XCTAssertEqual((decoded["secrets"] as? [String: String])?["test/key"], "value")
    let wrong = try VaultCrypto.agreement(P256.KeyAgreement.PrivateKey(), publicKey: ephemeral)
    XCTAssertThrowsError(try VaultCrypto.open(record, key: wrong))
  }
  @MainActor func testRejectUnsafeVaultAddresses() throws {
    let model = VaultModel()
    for address in [
      "http://example.com", "https://user:pass@example.com", "https://example.com/api",
      "https://example.com?key=secret",
    ] {
      XCTAssertThrowsError(try model.canonicalEndpoint(address))
    }
    XCTAssertEqual(try model.canonicalEndpoint("https://example.com/"), "https://example.com")
  }
}

final class ProtocolDecodingTests: XCTestCase {
  func testWebCryptoJWKIncludesNonStringMetadata() throws {
    let data = Data(#"{"kty":"EC","crv":"P-256","x":"x","y":"y","ext":true,"key_ops":[]}"#.utf8)
    let key = try JSONDecoder().decode(PublicJWK.self, from: data)
    XCTAssertEqual(key.fields["x"], "x")
    let raw = try JSONSerialization.jsonObject(with: data)
    XCTAssertEqual(VaultCrypto.jwkFields(raw)?["kty"], "EC")
  }
}
