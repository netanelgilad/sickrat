import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;

export async function loadEncryptedBundle(filePath, secret) {
	assertSecret(secret);
	let serialized;
	try {
		serialized = await readFile(filePath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}

	const envelope = JSON.parse(serialized);
	validateEnvelope(envelope);
	const aad = metadataAad(envelope.metadata);
	const salt = Buffer.from(envelope.kdf.salt, "base64url");
	const iv = Buffer.from(envelope.cipher.iv, "base64url");
	const tag = Buffer.from(envelope.cipher.tag, "base64url");
	const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
	const key = scryptSync(secret, salt, KEY_BYTES);
	let plaintext;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAAD(aad);
		decipher.setAuthTag(tag);
		plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		const bundle = JSON.parse(plaintext.toString("utf8"));
		assertMetadataMatchesBundle(envelope.metadata, bundle);
		return bundle;
	} finally {
		key.fill(0);
		plaintext?.fill(0);
	}
}

export async function saveEncryptedBundle(filePath, bundle, secret) {
	assertSecret(secret);
	const metadata = bundleMetadata(bundle);
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = scryptSync(secret, salt, KEY_BYTES);
	const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
	let ciphertext;
	let tag;
	try {
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(metadataAad(metadata));
		ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		tag = cipher.getAuthTag();
	} finally {
		key.fill(0);
		plaintext.fill(0);
	}

	const envelope = {
		formatVersion: ENVELOPE_VERSION,
		kdf: {
			name: "scrypt",
			salt: salt.toString("base64url"),
		},
		cipher: {
			name: "aes-256-gcm",
			iv: iv.toString("base64url"),
			tag: tag.toString("base64url"),
		},
		metadata,
		ciphertext: ciphertext.toString("base64url"),
	};
	const directory = path.dirname(filePath);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
	await rename(temporaryPath, filePath);
}

function bundleMetadata(bundle) {
	if (!bundle || typeof bundle !== "object") throw new TypeError("A browser-session bundle is required.");
	if (typeof bundle.providerId !== "string" || typeof bundle.accountLabel !== "string") {
		throw new TypeError("The browser-session identity is required.");
	}
	if (!Array.isArray(bundle.allowedOrigins) || typeof bundle.capturedAt !== "string") {
		throw new TypeError("Browser-session origins and capture time are required.");
	}
	return {
		providerId: bundle.providerId,
		accountLabel: bundle.accountLabel,
		allowedOrigins: [...bundle.allowedOrigins],
		capturedAt: bundle.capturedAt,
	};
}

function metadataAad(metadata) {
	return Buffer.from(JSON.stringify({
		formatVersion: ENVELOPE_VERSION,
		metadata,
	}), "utf8");
}

function assertMetadataMatchesBundle(metadata, bundle) {
	const actual = bundleMetadata(bundle);
	if (JSON.stringify(actual) !== JSON.stringify(metadata)) {
		throw new Error("Encrypted browser-session metadata does not match its bundle.");
	}
}

function assertSecret(secret) {
	if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 16) {
		throw new TypeError("The browser-session encryption secret must contain at least 16 bytes.");
	}
}

function validateEnvelope(envelope) {
	if (
		!envelope
		|| envelope.formatVersion !== ENVELOPE_VERSION
		|| envelope.kdf?.name !== "scrypt"
		|| envelope.cipher?.name !== "aes-256-gcm"
		|| typeof envelope.kdf.salt !== "string"
		|| typeof envelope.cipher.iv !== "string"
		|| typeof envelope.cipher.tag !== "string"
		|| typeof envelope.ciphertext !== "string"
		|| !envelope.metadata
	) {
		throw new Error("Encrypted browser-session envelope is malformed or unsupported.");
	}
}
