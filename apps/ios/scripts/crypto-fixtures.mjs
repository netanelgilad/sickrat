// Generate interoperability fixtures with Web Crypto (the PWA/CLI implementation).
import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const b64 = data => Buffer.from(data).toString('base64url');
const raw = new Uint8Array(32).map((_, i) => i);
const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt']);
const iv = new Uint8Array(12).fill(7);
const ciphertext = b64(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode('interoperability-✓')));
const pair = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
const remote = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
const shared = await crypto.subtle.deriveBits({name:'ECDH',public:remote.publicKey},pair.privateKey,256);
const material = await crypto.subtle.importKey('raw',shared,'HKDF',false,['deriveBits']);
const derived = b64(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode('sickrat:grant-ecdh:v1'),info:new TextEncoder().encode('sickrat:cli-grant:v1')},material,256));
const privateJWK = await crypto.subtle.exportKey('jwk',pair.privateKey);
const publicJWK = await crypto.subtle.exportKey('jwk',remote.publicKey);
writeFileSync(new URL('../Tests/CryptoTests.swift',import.meta.url),`import XCTest
import CryptoKit
@testable import Sickrat

final class CryptoTests: XCTestCase {
    func testDecryptWebCryptoSecret() throws {
        let key = SymmetricKey(data: Data(0..<32))
        let value = try VaultCrypto.open(["ciphertext": "${ciphertext}", "iv": "${b64(iv)}"], key: key)
        XCTAssertEqual(String(decoding: value, as: UTF8.self), "interoperability-✓")
    }
    func testRejectTamperedCiphertext() throws {
        let key = SymmetricKey(data: Data(0..<32))
        var bytes = try Data(base64URL: "${ciphertext}")
        bytes[0] ^= 1
        XCTAssertThrowsError(try VaultCrypto.open(["ciphertext": bytes.base64URL, "iv": "${b64(iv)}"], key: key))
    }
    func testECDHMatchesWebCrypto() throws {
        let privateKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: Data(base64URL: "${privateJWK.d}"))
        let publicKey = try VaultCrypto.publicKey(["kty": "EC", "crv": "P-256", "x": "${publicJWK.x}", "y": "${publicJWK.y}"])
        let key = try VaultCrypto.agreement(privateKey, publicKey: publicKey)
        XCTAssertEqual(key.withUnsafeBytes { Data($0).base64URL }, "${derived}")
        let transfer = try VaultCrypto.agreement(privateKey, publicKey: publicKey, transfer: true)
        XCTAssertNotEqual(transfer.withUnsafeBytes { Data($0).base64URL }, "${derived}")
    }
    func testGrantCanOnlyBeOpenedByRecipient() throws {
        let recipient = P256.KeyAgreement.PrivateKey()
        let grant = try VaultCrypto.grant(["secrets": ["test/key": "value"]], recipient: VaultCrypto.publicJWK(recipient.publicKey))
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
        for address in ["http://example.com", "https://user:pass@example.com", "https://example.com/api", "https://example.com?key=secret"] {
            XCTAssertThrowsError(try model.canonicalEndpoint(address))
        }
        XCTAssertEqual(try model.canonicalEndpoint("https://example.com/"), "https://example.com")
    }
}
`);
