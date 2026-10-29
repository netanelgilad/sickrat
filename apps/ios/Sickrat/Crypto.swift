import CryptoKit
import Foundation
import LocalAuthentication
import Security

struct VaultError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
extension Data {
  var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
  }
  init(base64URL: String) throws {
    let string = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(
      of: "_", with: "/")
    guard
      let data = Data(
        base64Encoded: string + String(repeating: "=", count: (4 - string.count % 4) % 4))
    else { throw VaultError("Invalid encrypted data.") }
    self = data
  }
}
enum VaultCrypto {
  static func jwkFields(_ value: Any?) -> [String: String]? {
    (value as? [String: Any])?.compactMapValues { $0 as? String }
  }

  static let format = "AES-256-GCM:local-vault-key:v1"
  static func seal(_ data: Data, key: SymmetricKey) throws -> [String: String] {
    let box = try AES.GCM.seal(data, using: key)
    return ["ciphertext": (box.ciphertext + box.tag).base64URL, "iv": Data(box.nonce).base64URL]
  }
  static func open(_ record: [String: String], key: SymmetricKey) throws -> Data {
    guard let ciphertext = record["ciphertext"], let iv = record["iv"] else {
      throw VaultError("Missing ciphertext.")
    }
    let bytes = try Data(base64URL: ciphertext)
    guard bytes.count >= 16 else { throw VaultError("Invalid ciphertext.") }
    return try AES.GCM.open(
      AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: Data(base64URL: iv)), ciphertext: bytes.dropLast(16),
        tag: bytes.suffix(16)), using: key)
  }
  static func publicJWK(_ key: P256.KeyAgreement.PublicKey) -> [String: String] {
    let raw = key.x963Representation
    return ["kty": "EC", "crv": "P-256", "x": raw[1..<33].base64URL, "y": raw[33..<65].base64URL]
  }
  static func publicKey(_ jwk: [String: String]) throws -> P256.KeyAgreement.PublicKey {
    guard jwk["kty"] == "EC", jwk["crv"] == "P-256", let x = jwk["x"], let y = jwk["y"] else {
      throw VaultError("Unsupported recipient key.")
    }
    return try P256.KeyAgreement.PublicKey(
      x963Representation: Data([4]) + Data(base64URL: x) + Data(base64URL: y))
  }
  static func agreement(
    _ privateKey: P256.KeyAgreement.PrivateKey, publicKey: P256.KeyAgreement.PublicKey,
    transfer: Bool = false
  ) throws -> SymmetricKey {
    try privateKey.sharedSecretFromKeyAgreement(with: publicKey).hkdfDerivedSymmetricKey(
      using: SHA256.self,
      salt: Data((transfer ? "sickrat:ios-transfer-salt:v1" : "sickrat:grant-ecdh:v1").utf8),
      sharedInfo: Data((transfer ? "sickrat:ios-transfer:v1" : "sickrat:cli-grant:v1").utf8),
      outputByteCount: 32)
  }
  static func grant(_ payload: [String: Any], recipient: [String: String]) throws -> [String: Any] {
    let ephemeral = P256.KeyAgreement.PrivateKey()
    let key = try agreement(ephemeral, publicKey: publicKey(recipient))
    var result: [String: Any] = try seal(JSONSerialization.data(withJSONObject: payload), key: key)
    result["alg"] = "ECDH-P256-HKDF-SHA256-AES-256-GCM:v1"
    result["ephemeralPublicKey"] = publicJWK(ephemeral.publicKey)
    return result
  }
  static func secret(_ value: String, key: SymmetricKey) throws -> [String: String] {
    var result = try seal(Data(value.utf8), key: key)
    let raw = key.withUnsafeBytes { Data($0) }.base64URL
    result["salt"] = Data(SHA256.hash(data: Data(raw.utf8))).base64URL
    result["kdf"] = format
    return result
  }
}

enum KeyStore {
  static func query(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.sickrat.vault",
      kSecAttrAccount as String: account,
    ]
  }
  static func save(_ data: Data, account: String) throws {
    let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, nil)!
    var item = query(account)
    item[kSecAttrAccessControl as String] = access
    item[kSecValueData as String] = data
    // Never destroy an existing vault key to replace it.
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw VaultError(
        status == errSecDuplicateItem
          ? "This vault already has a key on this device."
          : "Could not secure the vault key (\(status)). Set a device passcode first.")
    }
  }
  static func read(_ account: String) throws -> Data {
    var item = query(account)
    item[kSecReturnData as String] = true
    let context = LAContext()
    context.localizedReason = "Unlock your Sickrat vault"
    item[kSecUseAuthenticationContext as String] = context
    var result: CFTypeRef?
    let status = SecItemCopyMatching(item as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else {
      throw VaultError("Vault unlock was cancelled or the key is unavailable.")
    }
    return data
  }
}
