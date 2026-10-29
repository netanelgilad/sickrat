import { describe, expect, it } from "vitest";
import { createIOSTransfer } from "../src/ios-transfer";

const decode = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0));

describe("native vault transfer", () => {
    it("seals the root key to the destination and binds the vault and expiry", async () => {
        const destination = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
        const vault = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
        const request = JSON.stringify({ type: "sickrat-ios-transfer-request", version: 1, origin: "https://vault.example", publicKey: await crypto.subtle.exportKey("jwk", destination.publicKey) });
        const transfer = await createIOSTransfer(request, vault, "https://vault.example");
        const ephemeral = await crypto.subtle.importKey("jwk", transfer.ephemeralPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
        const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral }, destination.privateKey, 256);
        const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
        const encoder = new TextEncoder();
        const wrapping = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("sickrat:ios-transfer-salt:v1"), info: encoder.encode("sickrat:ios-transfer:v1") }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(transfer.iv) }, wrapping, decode(transfer.ciphertext));
        const payload = JSON.parse(new TextDecoder().decode(plaintext));
        expect(decode(payload.key)).toEqual(new Uint8Array(await crypto.subtle.exportKey("raw", vault)));
        expect(payload.origin).toBe("https://vault.example");
        expect(Date.parse(payload.expiresAt)).toBeGreaterThan(Date.now());
        expect(Date.parse(payload.expiresAt)).toBeLessThanOrEqual(Date.now() + 600_000);
        await expect(createIOSTransfer(request, vault, "https://different.example")).rejects.toThrow();
        const damaged = decode(transfer.ciphertext); damaged[0] ^= 1;
        await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(transfer.iv) }, wrapping, damaged)).rejects.toThrow();
    });
});
