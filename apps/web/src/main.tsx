import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	App as KonstaApp,
	Badge,
	Block,
	BlockTitle,
	Button,
	Card,
	List,
	ListInput,
	ListItem,
	Navbar,
	NavbarBackLink,
	Page,
	Panel,
	Segmented,
	SegmentedButton,
	Toast,
	Toggle,
} from "konsta/react";
import {
	Bell,
	BookOpen,
	Cloud,
	Copy,
	Database,
	ExternalLink,
	Home,
	KeyRound,
	Laptop,
	LockKeyhole,
	Menu,
	Search,
	Settings,
	ShieldCheck,
	Smartphone,
	Sparkles,
} from "lucide-react";
import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useRegisterSW } from "virtual:pwa-register/react";
import "./styles.css";

type Capabilities = {
	ok: true;
	push: {
		supported: boolean;
		configured: boolean;
		vapidPublicKey: string | null;
	};
	database: {
		configured: boolean;
	};
	vault: {
		name: string;
		deployedBy: string;
		version: string;
	};
	ios: {
		requiresHomeScreenInstall: boolean;
	};
};

type LatestReleaseMetadata = {
	version: string;
	notesUrl?: string;
};

type PushRecord = {
	id: string;
	endpoint: string;
	createdAt: string;
};

type ApprovalRequest = {
	id: string;
	deviceId: string | null;
	device: string;
	command: string;
	message: string | null;
	secretRefs: string[];
	accessDurationSeconds: number | null;
	approvalWaitSeconds: number | null;
	status: "pending" | "approved" | "denied";
	createdAt: string;
	expiresAt: string;
	expired: boolean;
	decidedAt: string | null;
	ephemeralPublicKey: JsonWebKey | null;
	grantReadyAt: string | null;
	accessExpiresAt: string | null;
};

type SecretMetadata = {
	id: string;
	ref: string;
	label: string;
	kdf: string;
	createdAt: string;
	updatedAt: string;
};

type SecretCiphertext = SecretMetadata & {
	ciphertext: string;
	iv: string;
	salt: string;
};

type PairingCodeDetails = {
	code: string;
	deviceId: string;
	label: string;
	expiresAt: string;
	approvedAt: string | null;
	expired: boolean;
};

type PendingNotification =
	| {
			type: "approval.requested";
			approval: ApprovalRequest;
			url: string;
	  }
	| {
			type: "pairing.requested";
			pairing: PairingCodeDetails;
			url: string;
	  };

type NotificationToast = {
	url: string;
	title: string;
	body: string;
};

type Device = {
	id: string;
	label: string;
	createdAt: string;
	revokedAt: string | null;
};

type CloudflareOAuthConfig = {
	clientId: string | null;
	authUrl: string;
	tokenUrl: string;
	redirectUri: string;
	scopes: string[];
};

type CloudflareAccount = {
	id: string;
	name: string;
};

type ProvisioningStep = {
	id: "d1" | "secrets-store";
	label: string;
	status: "pending" | "success" | "error";
	detail?: string;
	error?: string;
};

type CloudflareProvisioning = {
	ok: boolean;
	accountId: string;
	steps: ProvisioningStep[];
	resources: Record<string, unknown>;
	next: string;
};

type PasskeyVaultRecord = {
	credentialId: string;
	salt: string;
	iv: string;
	wrappedKey: string;
	createdAt: string;
	kdf: "WebAuthn-PRF-HKDF-SHA256:AES-256-GCM:v1";
};

type PendingSecretOptions = {
	show: boolean;
	symbols: boolean;
	copied: boolean;
};

const primaryNavItems: Array<{ route: AppRoute; href: string; label: string; icon: React.ComponentType<{ size?: number }> }> = [
	{ route: "app", href: "/", label: "Home", icon: Home },
	{ route: "secrets", href: "/secrets", label: "Secrets", icon: KeyRound },
	{ route: "approvals", href: "/approvals", label: "Grants", icon: ShieldCheck },
	{ route: "devices", href: "/devices", label: "Machines", icon: Laptop },
	{ route: "settings", href: "/settings", label: "Settings", icon: Settings },
];

function useSystemColorScheme() {
	useEffect(() => {
		if (!window.matchMedia) return undefined;

		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const themeColor = document.querySelector('meta[name="theme-color"]');

		function applySystemScheme(eventOrQuery: MediaQueryList | MediaQueryListEvent) {
			const dark = eventOrQuery.matches;
			document.documentElement.classList.toggle("dark", dark);
			themeColor?.setAttribute("content", dark ? "#000000" : "#f2f2f7");
		}

		applySystemScheme(mediaQuery);
		mediaQuery.addEventListener("change", applySystemScheme);

		return () => {
			mediaQuery.removeEventListener("change", applySystemScheme);
		};
	}, []);
}

function useTouchBoundaryGuard() {
	const touchStartRef = useRef<{ x: number; y: number } | null>(null);

	useEffect(() => {
		function findScrollContainer(target: EventTarget | null) {
			if (target instanceof Element) {
				const page = target.closest(".k-page");
				if (page instanceof HTMLElement) return page;
			}
			const page = document.querySelector(".k-page");
			return page instanceof HTMLElement ? page : null;
		}

		function handleTouchStart(event: TouchEvent) {
			if (event.touches.length !== 1) {
				touchStartRef.current = null;
				return;
			}
			const touch = event.touches[0];
			touchStartRef.current = { x: touch.clientX, y: touch.clientY };
		}

		function handleTouchMove(event: TouchEvent) {
			if (event.touches.length !== 1 || !touchStartRef.current) return;

			const touch = event.touches[0];
			const deltaX = touch.clientX - touchStartRef.current.x;
			const deltaY = touch.clientY - touchStartRef.current.y;
			if (Math.abs(deltaX) > Math.abs(deltaY)) return;

			const scrollContainer = findScrollContainer(event.target);
			if (!scrollContainer) return;

			const atTop = scrollContainer.scrollTop <= 0;
			const atBottom = Math.ceil(scrollContainer.scrollTop + scrollContainer.clientHeight) >= scrollContainer.scrollHeight;
			const pullingDown = deltaY > 0;
			const pullingUp = deltaY < 0;

			if ((atTop && pullingDown) || (atBottom && pullingUp)) {
				event.preventDefault();
			}
		}

		document.addEventListener("touchstart", handleTouchStart, { passive: true });
		document.addEventListener("touchmove", handleTouchMove, { passive: false });

		return () => {
			document.removeEventListener("touchstart", handleTouchStart);
			document.removeEventListener("touchmove", handleTouchMove);
		};
	}, []);
}

const api = {
	async getCapabilities() {
		const response = await fetch("/api/capabilities");
		if (!response.ok) throw new Error(await response.text());
		return (await response.json()) as Capabilities;
	},
	async saveSubscription(subscription: PushSubscriptionJSON) {
		const response = await fetch("/api/push/subscribe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ subscription }),
		});
		if (!response.ok) throw new Error(await response.text());
		return (await response.json()) as PushRecord;
	},
	async sendTest(id: string) {
		const response = await fetch("/api/push/test", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
		const text = await response.text();
		const body = text ? ((() => {
			try {
				return JSON.parse(text) as { error?: string };
			} catch {
				return { error: text };
			}
		})()) : {};
		if (!response.ok) throw new Error(body.error ?? text);
		return body;
	},
	async getLatestNotification(endpoint: string) {
		const response = await fetch("/api/notifications/latest", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ endpoint }),
		});
		if (!response.ok) throw new Error(await response.text());
		return ((await response.json()) as { notification: PendingNotification | null }).notification;
	},
	async listApprovals(status?: ApprovalRequest["status"] | "all") {
		const params = new URLSearchParams();
		if (status && status !== "all") params.set("status", status);
		const response = await fetch(`/api/approvals${params.size ? `?${params.toString()}` : ""}`);
		if (!response.ok) throw new Error(await response.text());
		return ((await response.json()) as { approvals: ApprovalRequest[] }).approvals;
	},
	async listDevices() {
		const response = await fetch("/api/devices");
		if (!response.ok) throw new Error(await response.text());
		return ((await response.json()) as { devices: Device[] }).devices;
	},
	async revokeDevice(id: string) {
		const response = await fetch(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: "POST" });
		if (!response.ok) throw new Error(await response.text());
		return ((await response.json()) as { device: Device }).device;
	},
	async listSecrets() {
		const response = await fetch("/api/secrets");
		if (!response.ok) throw new Error(await response.text());
		return ((await response.json()) as { secrets: SecretMetadata[] }).secrets;
	},
	async saveSecret(payload: {
		ref: string;
		label: string;
		ciphertext: string;
		iv: string;
		salt: string;
		kdf: string;
	}) {
		const response = await fetch("/api/secrets", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!response.ok) throw new Error(await response.text());
		return ((await response.json()) as { secret: SecretMetadata }).secret;
	},
	async resolveSecrets(refs: string[]) {
		const response = await fetch("/api/secrets/resolve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ refs }),
		});
		if (!response.ok) throw new Error(await response.text());
		return ((await response.json()) as { secrets: SecretCiphertext[] }).secrets;
	},
	async getCloudflareOAuthConfig() {
		const response = await fetch("/api/cloudflare/oauth-config");
		if (!response.ok) throw new Error(await response.text());
		return (await response.json()) as CloudflareOAuthConfig;
	},
	async exchangeCloudflareCode(code: string, codeVerifier: string, redirectUri: string) {
		const response = await fetch("/api/cloudflare/oauth-token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, codeVerifier, redirectUri }),
		});
		const body = (await response.json()) as { accessToken?: string; error?: string };
		if (!response.ok || !body.accessToken) throw new Error(body.error ?? "Cloudflare token exchange failed.");
		return body.accessToken;
	},
	async getCloudflareAccounts(accessToken: string) {
		const response = await fetch("/api/cloudflare/accounts", {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		if (!response.ok) throw new Error(await response.text());
		return ((await response.json()) as { accounts: CloudflareAccount[] }).accounts;
	},
	async provisionCloudflare(accessToken: string, accountId: string) {
		try {
			const response = await fetch("/api/cloudflare/provision", {
				method: "POST",
				headers: {
					authorization: `Bearer ${accessToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ accountId }),
			});
			const body = (await response.json()) as CloudflareProvisioning | { error?: string };
			if (!response.ok) throw new Error("error" in body && body.error ? body.error : `Vault creation request failed with ${response.status}.`);
			return body as CloudflareProvisioning;
		} catch (error) {
			throw new Error(error instanceof Error ? error.message : "Vault creation request could not reach the Worker.");
		}
	},
	async getApproval(id: string) {
		const response = await fetch(`/api/approvals/${encodeURIComponent(id)}`);
		if (!response.ok) throw new Error(await response.text());
		return ((await response.json()) as { approval: ApprovalRequest }).approval;
	},
	async decideApproval(id: string, action: "approve" | "deny") {
		const response = await fetch(`/api/approvals/${encodeURIComponent(id)}/${action}`, {
			method: "POST",
		});
		if (!response.ok) throw new Error(await response.text());
		return response.json();
	},
	async sendGrant(
		id: string,
		grantCiphertext: unknown,
		createdSecrets: Array<{
			ref: string;
			label: string;
			ciphertext: string;
			iv: string;
			salt: string;
			kdf: string;
		}> = [],
	) {
		const response = await fetch(`/api/approvals/${encodeURIComponent(id)}/grant`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ grantCiphertext, createdSecrets }),
		});
		if (!response.ok) throw new Error(await response.text());
		return response.json();
	},
	async getPairingCode(code: string) {
		const response = await fetch(`/api/devices/pairing-codes/${encodeURIComponent(code)}`);
		if (!response.ok) throw new Error(await response.text());
		return (await response.json()) as PairingCodeDetails;
	},
	async approvePairingCode(code: string) {
		const response = await fetch(`/api/devices/pairing-codes/${encodeURIComponent(code)}/approve`, { method: "POST" });
		if (!response.ok) throw new Error(await response.text());
		return response.json();
	},
};

function base64UrlToUint8Array(value: string) {
	const padding = "=".repeat((4 - (value.length % 4)) % 4);
	const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
	const raw = window.atob(base64);
	const output = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
	return output;
}

function bytesToBase64Url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBase64Url(byteLength: number) {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}

function cryptoRandomInt(maxExclusive: number) {
	if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error("Invalid random range.");
	const range = 0x100000000;
	const limit = range - (range % maxExclusive);
	const bytes = new Uint32Array(1);
	do {
		crypto.getRandomValues(bytes);
	} while (bytes[0] >= limit);
	return bytes[0] % maxExclusive;
}

function pickRandomCharacter(characters: string) {
	return characters[cryptoRandomInt(characters.length)];
}

function shuffleCharacters(characters: string[]) {
	for (let index = characters.length - 1; index > 0; index -= 1) {
		const swapIndex = cryptoRandomInt(index + 1);
		[characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
	}
	return characters.join("");
}

function generateSecurePassword({ length = 22, symbols = false }: { length?: number; symbols?: boolean } = {}) {
	const normalizedLength = Math.max(20, Math.min(length, 80));
	const uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ";
	const lowercase = "abcdefghijkmnopqrstuvwxyz";
	const digits = "23456789";
	const symbolSet = "!@#$%^&*()-_=+[]{};:,.?";
	const requiredSets = symbols ? [uppercase, lowercase, digits, symbolSet] : [uppercase, lowercase, digits];
	const allCharacters = requiredSets.join("");
	const output = requiredSets.map(pickRandomCharacter);
	while (output.length < normalizedLength) output.push(pickRandomCharacter(allCharacters));
	return shuffleCharacters(output);
}

async function sha256Base64Url(value: string) {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return bytesToBase64Url(new Uint8Array(digest));
}

function friendlyError(error: unknown, fallback: string) {
	const raw = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
	try {
		const parsed = JSON.parse(raw) as { error?: string };
		if (parsed.error) return friendlyError(parsed.error, fallback);
	} catch {
		// Plain text error.
	}
	if (/D1|binding|Worker|VAPID|Cloudflare/i.test(raw)) {
		return "This vault is not fully set up yet. Update or recreate the vault from the Sickrat command line, then reopen the app.";
	}
	return raw || fallback;
}

const legacyVaultKeyStorageKey = "sickrat.vault.key";
const passkeyVaultStorageKey = "sickrat.vault.passkey";
const passkeyWrapInfo = new TextEncoder().encode("sickrat:vault-key-wrap:v1");
const passkeyWrapSalt = new TextEncoder().encode("sickrat:webauthn-prf:v1");
const grantWrapInfo = new TextEncoder().encode("sickrat:cli-grant:v1");
const grantWrapSalt = new TextEncoder().encode("sickrat:grant-ecdh:v1");

function migrateStorageKey(storage: Storage, oldKey: string, newKey: string, removeOld = false) {
	const existing = storage.getItem(newKey);
	const legacy = storage.getItem(oldKey);
	if (!existing && legacy) storage.setItem(newKey, legacy);
	if (removeOld && legacy) storage.removeItem(oldKey);
}

migrateStorageKey(localStorage, "my-secret.vault.key", legacyVaultKeyStorageKey);
migrateStorageKey(localStorage, "my-secret.vault.passkey", passkeyVaultStorageKey);
migrateStorageKey(localStorage, "my-secret.cf.accessToken", "sickrat.cf.accessToken");
migrateStorageKey(sessionStorage, "my-secret.cf.state", "sickrat.cf.state", true);
migrateStorageKey(sessionStorage, "my-secret.cf.codeVerifier", "sickrat.cf.codeVerifier", true);

async function createVaultKey() {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

function getPasskeyVaultRecord() {
	const stored = localStorage.getItem(passkeyVaultStorageKey);
	return stored ? (JSON.parse(stored) as PasskeyVaultRecord) : null;
}

async function derivePasskeyWrappingKey(prfOutput: ArrayBuffer) {
	const baseKey = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: passkeyWrapSalt, info: passkeyWrapInfo },
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

function getPrfOutput(credential: PublicKeyCredential) {
	const results = credential.getClientExtensionResults() as {
		prf?: {
			enabled?: boolean;
			results?: {
				first?: ArrayBuffer;
			};
		};
	};
	return results.prf?.results?.first ?? null;
}

async function wrapVaultKey(vaultKey: CryptoKey, wrappingKey: CryptoKey) {
	const iv = new Uint8Array(12);
	crypto.getRandomValues(iv);
	const rawVaultKey = await crypto.subtle.exportKey("raw", vaultKey);
	const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrappingKey, rawVaultKey);
	return { iv: bytesToBase64Url(iv), wrappedKey: bytesToBase64Url(new Uint8Array(wrapped)) };
}

async function unwrapVaultKey(record: PasskeyVaultRecord, wrappingKey: CryptoKey) {
	const raw = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: base64UrlToUint8Array(record.iv) },
		wrappingKey,
		base64UrlToUint8Array(record.wrappedKey),
	);
	return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function createPasskeyWrappedVaultKey(existingKey?: CryptoKey | null) {
	if (!window.PublicKeyCredential) throw new Error("Passkeys are not available in this browser.");

	const salt = new Uint8Array(32);
	const challenge = new Uint8Array(32);
	const userId = new Uint8Array(16);
	crypto.getRandomValues(salt);
	crypto.getRandomValues(challenge);
	crypto.getRandomValues(userId);

	const credential = (await navigator.credentials.create({
		publicKey: {
			challenge,
			rp: { name: "Sickrat" },
			user: {
				id: userId,
				name: "sickrat-vault",
				displayName: "Sickrat Vault",
			},
			pubKeyCredParams: [
				{ type: "public-key", alg: -7 },
				{ type: "public-key", alg: -257 },
			],
			authenticatorSelection: {
				authenticatorAttachment: "platform",
				residentKey: "preferred",
				userVerification: "required",
			},
			timeout: 60_000,
			extensions: {
				prf: {
					eval: { first: salt },
				},
			},
		},
	} as CredentialCreationOptions)) as PublicKeyCredential | null;

	if (!credential) throw new Error("Passkey creation was cancelled.");
	const prfOutput = getPrfOutput(credential);
	if (!prfOutput) {
		throw new Error("This passkey did not return WebAuthn PRF output. Safari 18+ or another PRF-capable browser is required.");
	}

	const vaultKey = existingKey ?? (await createVaultKey());
	const wrappingKey = await derivePasskeyWrappingKey(prfOutput);
	const wrapped = await wrapVaultKey(vaultKey, wrappingKey);
	const record: PasskeyVaultRecord = {
		credentialId: bytesToBase64Url(new Uint8Array(credential.rawId)),
		salt: bytesToBase64Url(salt),
		iv: wrapped.iv,
		wrappedKey: wrapped.wrappedKey,
		createdAt: new Date().toISOString(),
		kdf: "WebAuthn-PRF-HKDF-SHA256:AES-256-GCM:v1",
	};
	localStorage.setItem(passkeyVaultStorageKey, JSON.stringify(record));
	localStorage.removeItem(legacyVaultKeyStorageKey);
	return vaultKey;
}

async function unlockPasskeyVaultKey() {
	const record = getPasskeyVaultRecord();
	if (!record) return null;

	const challenge = new Uint8Array(32);
	crypto.getRandomValues(challenge);
	const credential = (await navigator.credentials.get({
		publicKey: {
			challenge,
			allowCredentials: [
				{
					type: "public-key",
					id: base64UrlToUint8Array(record.credentialId),
				},
			],
			userVerification: "required",
			timeout: 60_000,
			extensions: {
				prf: {
					eval: { first: base64UrlToUint8Array(record.salt) },
				},
			},
		},
	} as CredentialRequestOptions)) as PublicKeyCredential | null;

	if (!credential) throw new Error("Passkey unlock was cancelled.");
	const prfOutput = getPrfOutput(credential);
	if (!prfOutput) throw new Error("This browser did not return WebAuthn PRF output for unlock.");
	const wrappingKey = await derivePasskeyWrappingKey(prfOutput);
	return unwrapVaultKey(record, wrappingKey);
}

async function getVaultKeyFingerprint(key: CryptoKey) {
	const jwk = await crypto.subtle.exportKey("jwk", key);
	return sha256Base64Url(jwk.k ?? "");
}

async function encryptSecretValue(value: string, key: CryptoKey) {
	const iv = new Uint8Array(12);
	crypto.getRandomValues(iv);
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
	return {
		ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
		iv: bytesToBase64Url(iv),
		salt: await getVaultKeyFingerprint(key),
		kdf: "AES-256-GCM:local-vault-key:v1",
	};
}

async function decryptSecretValue(secret: SecretCiphertext, key: CryptoKey) {
	if (secret.kdf !== "AES-256-GCM:local-vault-key:v1") {
		throw new Error(`Unsupported secret encryption format for ${secret.ref}: ${secret.kdf}`);
	}
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: base64UrlToUint8Array(secret.iv) },
		key,
		base64UrlToUint8Array(secret.ciphertext),
	);
	return new TextDecoder().decode(plaintext);
}

async function encryptGrantForCli(payload: { secrets: Record<string, string>; approvedAt: string; accessExpiresAt?: string }, cliPublicKey: JsonWebKey) {
	const cliKey = await crypto.subtle.importKey(
		"jwk",
		cliPublicKey,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const sharedSecret = await crypto.subtle.deriveBits(
		{ name: "ECDH", public: cliKey },
		keyPair.privateKey,
		256,
	);
	const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
	const aesKey = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: grantWrapSalt, info: grantWrapInfo },
		hkdfKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt"],
	);
	const iv = new Uint8Array(12);
	crypto.getRandomValues(iv);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		aesKey,
		new TextEncoder().encode(JSON.stringify(payload)),
	);
	return {
		alg: "ECDH-P256-HKDF-SHA256-AES-256-GCM:v1",
		ephemeralPublicKey: await crypto.subtle.exportKey("jwk", keyPair.publicKey),
		iv: bytesToBase64Url(iv),
		ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
	};
}

function isStandalone() {
	return (
		window.matchMedia("(display-mode: standalone)").matches ||
		("standalone" in window.navigator && Boolean(window.navigator.standalone))
	);
}

function isLocalHost() {
	return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function shouldRequireInstalledPwa() {
	return window.location.protocol === "https:" && !isLocalHost();
}

type BeforeInstallPromptEvent = Event & {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function isIosDevice() {
	const userAgent = navigator.userAgent.toLowerCase();
	return /iphone|ipad|ipod/.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isIosSafari() {
	const userAgent = navigator.userAgent.toLowerCase();
	return isIosDevice() && /safari/.test(userAgent) && !/crios|fxios|edgios/.test(userAgent);
}

function compareVersions(left: string, right: string) {
	const a = left.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	const b = right.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const delta = (a[index] ?? 0) - (b[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

function formatDuration(seconds: number) {
	if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
	if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
	return `${seconds} seconds`;
}

function formatAgo(timestamp: string) {
	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
	if (elapsedSeconds < 60) return `${elapsedSeconds} seconds ago`;
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"} ago`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) return `${elapsedHours} hour${elapsedHours === 1 ? "" : "s"} ago`;
	const elapsedDays = Math.floor(elapsedHours / 24);
	return `${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`;
}

function formatUntil(timestamp: string) {
	const remainingSeconds = Math.max(0, Math.ceil((Date.parse(timestamp) - Date.now()) / 1000));
	if (remainingSeconds < 60) return `${remainingSeconds} seconds`;
	const remainingMinutes = Math.ceil(remainingSeconds / 60);
	if (remainingMinutes < 60) return `${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;
	const remainingHours = Math.ceil(remainingMinutes / 60);
	if (remainingHours < 24) return `${remainingHours} hour${remainingHours === 1 ? "" : "s"}`;
	const remainingDays = Math.ceil(remainingHours / 24);
	return `${remainingDays} day${remainingDays === 1 ? "" : "s"}`;
}

function approvalWaitLabel(approval: Pick<ApprovalRequest, "approvalWaitSeconds">) {
	if (!approval.approvalWaitSeconds) return null;
	return `Approval link stays valid for ${formatDuration(approval.approvalWaitSeconds)}`;
}

function approvalStatusLabel(approval: Pick<ApprovalRequest, "status" | "expired">) {
	return approval.expired ? "expired" : approval.status;
}

function approvalBadgeColor(approval: Pick<ApprovalRequest, "status" | "expired">) {
	if (approval.expired || approval.status === "denied") return "bg-red-500";
	if (approval.status === "approved") return "bg-green-500";
	return "bg-orange-500";
}

function arrayBuffersEqual(left: ArrayBuffer | null, right: Uint8Array) {
	if (!left) return false;
	const leftBytes = new Uint8Array(left);
	if (leftBytes.length !== right.length) return false;
	return leftBytes.every((byte, index) => byte === right[index]);
}

function useStandaloneMode() {
	const [standalone, setStandalone] = useState(isStandalone);

	useEffect(() => {
		const standaloneQuery = window.matchMedia("(display-mode: standalone)");
		const update = () => setStandalone(isStandalone());
		standaloneQuery.addEventListener("change", update);
		window.addEventListener("appinstalled", update);
		window.addEventListener("focus", update);
		return () => {
			standaloneQuery.removeEventListener("change", update);
			window.removeEventListener("appinstalled", update);
			window.removeEventListener("focus", update);
		};
	}, []);

	return standalone;
}

function usePwaInstallPrompt() {
	const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
	const [installStatus, setInstallStatus] = useState("");

	useEffect(() => {
		const handlePrompt = (event: Event) => {
			event.preventDefault();
			setPromptEvent(event as BeforeInstallPromptEvent);
		};
		window.addEventListener("beforeinstallprompt", handlePrompt);
		return () => window.removeEventListener("beforeinstallprompt", handlePrompt);
	}, []);

	async function install() {
		if (!promptEvent) return;
		setInstallStatus("Opening install prompt...");
		await promptEvent.prompt();
		const choice = await promptEvent.userChoice;
		setInstallStatus(choice.outcome === "accepted" ? "Install accepted." : "Install dismissed.");
		setPromptEvent(null);
	}

	return { install, installStatus, promptEvent };
}

function InstallPrompt() {
	const standalone = useStandaloneMode();
	const ios = useMemo(isIosDevice, []);
	const iosSafari = useMemo(isIosSafari, []);
	const { install, installStatus, promptEvent } = usePwaInstallPrompt();

	if (standalone) {
		return (
			<List strong inset>
				<ListItem title="Installed" subtitle="Sickrat is running from the home screen." media={<Smartphone size={22} />} />
			</List>
		);
	}

	if (promptEvent) {
		return (
			<List strong inset>
				<ListItem
					title="Install Sickrat"
					subtitle="Use the installed app for phone approvals and foreground navigation."
					media={<Smartphone size={22} />}
					after={
						<Button small rounded type="button" onClick={install}>
							Install
						</Button>
					}
					footer={installStatus || undefined}
				/>
			</List>
		);
	}

	if (ios) {
		return (
			<List strong inset>
				<ListItem
					title={iosSafari ? "Add to Home Screen" : "Open in Safari"}
					subtitle={
						iosSafari
							? "Tap Share, then Add to Home Screen. Open Sickrat from the new icon to enable phone approvals."
							: "iOS installs web apps from Safari. Open this vault URL in Safari, then use Share, Add to Home Screen."
					}
					media={<Smartphone size={22} />}
				/>
			</List>
		);
	}

	return (
		<List strong inset>
			<ListItem title="Browser session" subtitle="If your browser supports install prompts, the install button will appear here." media={<Smartphone size={22} />} />
		</List>
	);
}

function InstalledPwaGate({ children }: { children: React.ReactNode }) {
	const standalone = useStandaloneMode();
	const requireInstall = useMemo(shouldRequireInstalledPwa, []);
	const ios = useMemo(isIosDevice, []);
	const iosSafari = useMemo(isIosSafari, []);
	const [copied, setCopied] = useState(false);
	const { install, installStatus, promptEvent } = usePwaInstallPrompt();

	if (!requireInstall || standalone) return <>{children}</>;

	async function copyUrl() {
		try {
			await navigator.clipboard.writeText(window.location.href);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2_000);
		} catch {
			setCopied(false);
		}
	}

	return (
		<Page>
			<Navbar title="Sickrat" subtitle="Home-screen app required" />
			<Block strong inset>
				<h1 id="install-gate-title" className="m-0 text-3xl font-bold leading-tight">
					Install Sickrat to approve from this phone.
				</h1>
				<p className="mb-0 text-black/55 dark:text-white/55">
					Phone approvals depend on the installed app so notifications and grant links open in the same trusted place.
				</p>
			</Block>
			{promptEvent ? (
				<Block inset>
					<Button large rounded type="button" onClick={install}>
						Install App
					</Button>
					{installStatus ? <p className="text-center text-sm text-black/45 dark:text-white/45">{installStatus}</p> : null}
				</Block>
			) : ios ? (
				<>
					<BlockTitle>Install Steps</BlockTitle>
					<List strong inset>
						<ListItem title="Open the share menu" subtitle={iosSafari ? "Tap the Share button in Safari." : "In Chrome on iPhone, tap Share from the browser menu."} after="1" />
						<ListItem title="Add to Home Screen" subtitle="Choose Add to Home Screen from the iOS share sheet." after="2" />
						<ListItem title="Open Sickrat" subtitle="Launch the new icon, then enable push approvals." after="3" />
					</List>
				</>
			) : (
				<List strong inset>
					<ListItem title="Use your browser install control" subtitle="Look for Install app in the address bar or browser menu, then open Sickrat from the new icon." />
				</List>
			)}
			<Block inset className="grid grid-cols-2 gap-3">
				<Button rounded type="button" outline onClick={copyUrl}>
					{copied ? "Copied" : "Copy URL"}
				</Button>
				<Button rounded outline component="a" href="https://sickrat.dev">
					Back To Site
				</Button>
			</Block>
		</Page>
	);
}

function PwaUpdatePrompt() {
	const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
	const [updating, setUpdating] = useState(false);
	const {
		offlineReady: [, setOfflineReady],
		needRefresh: [needRefresh, setNeedRefresh],
		updateServiceWorker,
	} = useRegisterSW({
		onRegisteredSW(_swUrl, registration) {
			setRegistration(registration ?? null);
		},
	});

	useEffect(() => {
		if (!registration) return;

		const checkForUpdate = () => {
			if (document.visibilityState === "visible") {
				void registration.update();
			}
		};

		checkForUpdate();
		const interval = window.setInterval(checkForUpdate, 30_000);
		document.addEventListener("visibilitychange", checkForUpdate);

		return () => {
			window.clearInterval(interval);
			document.removeEventListener("visibilitychange", checkForUpdate);
		};
	}, [registration]);

	if (!needRefresh) return null;

	const reloadApp = async () => {
		setUpdating(true);
		setNeedRefresh(false);
		setOfflineReady(false);
		try {
			await updateServiceWorker(true);
		} finally {
			window.setTimeout(() => {
				const url = new URL(window.location.href);
				url.searchParams.set("updated", Date.now().toString());
				window.location.replace(url.toString());
			}, 300);
		}
	};

	return (
		<Toast
			opened={needRefresh}
			position="center"
			button={
				<Button clear small disabled={updating} onClick={reloadApp}>
					{updating ? "Reloading" : "Reload"}
				</Button>
			}
		>
			{updating ? "Updating Sickrat..." : "Update available"}
		</Toast>
	);
}

type AppRoute =
	| "login"
	| "app"
	| "vaults"
	| "secrets"
	| "approvals"
	| "approval-detail"
	| "devices"
	| "settings"
	| "approval"
	| "pair";

function ApprovalRoute() {
	const params = useParams();
	return <AppShell route="approval" requestId={params.requestId} />;
}

function ApprovalDetailRoute() {
	const params = useParams();
	return <AppShell route="approval-detail" requestId={params.requestId} />;
}

function AppShell({
	route,
	requestId,
	isCloudflareCallback = false,
}: {
	route: AppRoute;
	requestId?: string;
	isCloudflareCallback?: boolean;
}) {
	const navigate = useNavigate();
	const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
	const [status, setStatus] = useState("Loading vault status...");
	const [subscription, setSubscription] = useState<PushRecord | null>(null);
	const [approval, setApproval] = useState<ApprovalRequest | null>(null);
	const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
	const [approvalFilter, setApprovalFilter] = useState<ApprovalRequest["status"] | "all">("pending");
	const [devices, setDevices] = useState<Device[]>([]);
	const [secrets, setSecrets] = useState<SecretMetadata[]>([]);
	const [secretQuery, setSecretQuery] = useState("");
	const [vaultKey, setVaultKey] = useState<CryptoKey | null>(null);
	const [secretStatus, setSecretStatus] = useState("Set up a local vault key before adding secrets.");
	const [secretForm, setSecretForm] = useState({
		label: "",
		ref: "",
		value: "",
	});
	const [approvalSecretValues, setApprovalSecretValues] = useState<Record<string, string>>({});
	const [approvalSecretOptions, setApprovalSecretOptions] = useState<Record<string, PendingSecretOptions>>({});
	const [swipedApprovalId, setSwipedApprovalId] = useState<string | null>(null);
	const [approvalTouchStart, setApprovalTouchStart] = useState<{ id: string; x: number } | null>(null);
	const [pairingCode, setPairingCode] = useState("");
	const [pairing, setPairing] = useState<PairingCodeDetails | null>(null);
	const [pairingStatus, setPairingStatus] = useState("Enter the six-digit code shown in your terminal.");
	const [pushSubscriptionChecked, setPushSubscriptionChecked] = useState(false);
	const [cloudflareConfig, setCloudflareConfig] = useState<CloudflareOAuthConfig | null>(null);
	const [cloudflareToken, setCloudflareToken] = useState<string | null>(() => localStorage.getItem("sickrat.cf.accessToken"));
	const [cloudflareAccounts, setCloudflareAccounts] = useState<CloudflareAccount[]>([]);
	const [selectedAccountId, setSelectedAccountId] = useState("");
	const [provisioning, setProvisioning] = useState<CloudflareProvisioning | null>(null);
	const [cloudflareStatus, setCloudflareStatus] = useState(
		cloudflareToken ? "Vault setup session found in this browser." : "Browser setup is not connected.",
	);
	const [notificationToast, setNotificationToast] = useState<NotificationToast | null>(null);
	const [latestRelease, setLatestRelease] = useState<LatestReleaseMetadata | null>(null);
	const [busy, setBusy] = useState(false);
	const [navigationOpen, setNavigationOpen] = useState(false);
	const edgeSwipeRef = useRef<{ x: number; y: number } | null>(null);

	const installed = useMemo(isStandalone, []);
	const vaultName = capabilities?.vault.name ?? "default";
	const updateAvailable = Boolean(
		capabilities?.vault.version &&
			capabilities.vault.version !== "unknown" &&
			latestRelease?.version &&
			compareVersions(capabilities.vault.version, latestRelease.version) < 0,
	);
	const activeDevices = devices.filter((device) => !device.revokedAt);
	const pendingApprovals = approvals.filter((item) => item.status === "pending");
	const filteredSecrets = secrets.filter((secret) => {
		const query = secretQuery.trim().toLowerCase();
		if (!query) return true;
		return secret.ref.toLowerCase().includes(query) || secret.label.toLowerCase().includes(query);
	});
	const missingApprovalRefs = useMemo(() => {
		if (!approval) return [];
		const storedRefs = new Set(secrets.map((secret) => secret.ref));
		return approval.secretRefs.filter((ref) => !storedRefs.has(ref));
	}, [approval, secrets]);

	function getPendingSecretOptions(ref: string) {
		return approvalSecretOptions[ref] ?? { show: false, symbols: false, copied: false };
	}

	function updatePendingSecretOptions(ref: string, next: Partial<PendingSecretOptions>) {
		setApprovalSecretOptions((current) => ({
			...current,
			[ref]: { ...(current[ref] ?? { show: false, symbols: false, copied: false }), ...next },
		}));
	}

	function generateMissingSecret(ref: string) {
		const options = getPendingSecretOptions(ref);
		setApprovalSecretValues((current) => ({ ...current, [ref]: generateSecurePassword({ symbols: options.symbols }) }));
		updatePendingSecretOptions(ref, { show: true, copied: false });
	}

	async function copyMissingSecret(ref: string) {
		const value = approvalSecretValues[ref];
		if (!value) return;
		try {
			await navigator.clipboard.writeText(value);
			updatePendingSecretOptions(ref, { copied: true });
			window.setTimeout(() => {
				setApprovalSecretOptions((current) => ({
					...current,
					[ref]: { ...(current[ref] ?? { show: false, symbols: false, copied: false }), copied: false },
				}));
			}, 1800);
		} catch {
			updatePendingSecretOptions(ref, { copied: false });
		}
	}

	async function refreshSecrets() {
		try {
			setSecrets(await api.listSecrets());
		} catch (error) {
			setSecretStatus(friendlyError(error, "Failed to load secrets."));
		}
	}

	async function refreshApprovals(status: ApprovalRequest["status"] | "all" = approvalFilter) {
		try {
			setApprovals([]);
			setApprovals(await api.listApprovals(status));
		} catch (error) {
			setStatus(friendlyError(error, "Failed to load approvals."));
		}
	}

	async function refreshDevices() {
		try {
			setDevices(await api.listDevices());
		} catch (error) {
			setPairingStatus(friendlyError(error, "Failed to load paired machines."));
		}
	}

	function routeNotification(notification: Pick<PendingNotification, "url">) {
		const target = new URL(notification.url, window.location.origin);
		if (target.origin === window.location.origin) navigate(`${target.pathname}${target.search}${target.hash}`);
	}

	function showNotificationToast(notification: NotificationToast) {
		setNotificationToast(notification);
		window.setTimeout(() => {
			setNotificationToast((current) => (current?.url === notification.url ? null : current));
		}, 10_000);
	}

	function describePendingNotification(notification: PendingNotification): NotificationToast {
		if (notification.type === "approval.requested") {
			const waitLabel = approvalWaitLabel(notification.approval);
			return {
				url: notification.url,
				title: "Secret access requested",
				body: `${notification.approval.device} wants ${notification.approval.secretRefs.length} secrets${waitLabel ? `. ${waitLabel}.` : ""}`,
			};
		}
		return {
			url: notification.url,
			title: "Pairing requested",
			body: `${notification.pairing.label} wants to pair with this vault`,
		};
	}

	function describeRealtimeNotification(message: PendingNotification | { type?: string; url?: string }): NotificationToast | null {
		if (!message.url) return null;
		if (message.type === "approval.requested" && "approval" in message) return describePendingNotification(message);
		if (message.type === "pairing.requested" && "pairing" in message) return describePendingNotification(message);
		return {
			url: message.url,
			title: "Sickrat request",
			body: "Open Sickrat to review the latest request.",
		};
	}


	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		const handleMessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; url?: string; title?: string; body?: string };
			if (data.type === "SICKRAT_NAVIGATE" && data.url) {
				routeNotification({ url: data.url });
			} else if (data.type === "SICKRAT_NOTIFICATION" && data.url) {
				showNotificationToast({
					url: data.url,
					title: data.title ?? "Sickrat request",
					body: data.body ?? "Open Sickrat to review the latest request.",
				});
			}
		};
		navigator.serviceWorker.addEventListener("message", handleMessage);
		return () => navigator.serviceWorker.removeEventListener("message", handleMessage);
	}, [navigate]);

	useEffect(() => {
		api
			.getCapabilities()
			.then((next) => {
				setCapabilities(next);
				setStatus(next.push.configured ? "Notifications are ready to enable." : "This vault needs notification setup from the command line.");
			})
			.catch((error: unknown) => setStatus(friendlyError(error, "Failed to load this vault.")));
	}, []);

	useEffect(() => {
		fetch("https://sickrat.dev/releases/latest.json", { cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) return null;
				const metadata = (await response.json()) as Partial<LatestReleaseMetadata>;
				return typeof metadata.version === "string" ? { version: metadata.version, notesUrl: metadata.notesUrl } : null;
			})
			.then((metadata) => setLatestRelease(metadata))
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		if (getPasskeyVaultRecord()) {
			setSecretStatus("Vault key is protected by passkey. Unlock before adding secrets.");
		} else if (localStorage.getItem(legacyVaultKeyStorageKey)) {
			setSecretStatus("Legacy local vault key found. Create a passkey to protect it.");
		} else {
			setSecretStatus("Create a passkey-protected vault key before adding secrets.");
		}
	}, []);

	useEffect(() => {
		void refreshSecrets();
	}, []);

	useEffect(() => {
		if (route === "approvals" || route === "app") void refreshApprovals(approvalFilter);
	}, [approvalFilter, route]);

	useEffect(() => {
		if (route === "devices" || route === "app") void refreshDevices();
	}, [route]);

	useEffect(() => {
		if (route !== "devices") return;
		const code = new URLSearchParams(window.location.search).get("pairingCode")?.replace(/\D/g, "").slice(0, 6);
		if (!code) return;
		setPairing(null);
		setPairingCode("");
		setPairingStatus("Pairing request opened. Type the six-digit code shown in your terminal to verify this machine.");
		navigate("/devices", { replace: true });
	}, [navigate, route]);

	useEffect(() => {
		api
			.getCloudflareOAuthConfig()
			.then((config) => {
				setCloudflareConfig(config);
				if (!config.clientId) setCloudflareStatus("Vault setup is handled by the Sickrat command line.");
			})
			.catch(() => setCloudflareStatus("Vault setup is handled by the Sickrat command line."));
	}, []);

	useEffect(() => {
		if (!isCloudflareCallback || !cloudflareConfig) return;
		const params = new URLSearchParams(window.location.search);
		const error = params.get("error");
		if (error) {
			setCloudflareStatus(friendlyError(params.get("error_description") ?? error, "Sign-in failed."));
			return;
		}
		const code = params.get("code");
		const state = params.get("state");
		const expectedState = sessionStorage.getItem("sickrat.cf.state");
		const codeVerifier = sessionStorage.getItem("sickrat.cf.codeVerifier");
		if (!code || !state || state !== expectedState || !codeVerifier || !cloudflareConfig.clientId) {
			setCloudflareStatus("Sign-in could not be completed. Try setup again from the command line.");
			return;
		}

		setBusy(true);
		setCloudflareStatus("Completing sign-in...");
		api
			.exchangeCloudflareCode(code, codeVerifier, cloudflareConfig.redirectUri)
			.then((accessToken) => {
				const redirectTo = sessionStorage.getItem("sickrat.cf.redirectTo") || "/";
				localStorage.setItem("sickrat.cf.accessToken", accessToken);
				sessionStorage.removeItem("sickrat.cf.state");
				sessionStorage.removeItem("sickrat.cf.codeVerifier");
				sessionStorage.removeItem("sickrat.cf.redirectTo");
				setCloudflareToken(accessToken);
				setCloudflareStatus("Sign-in complete. Loading vault accounts...");
				navigate(redirectTo, { replace: true });
			})
			.catch((error: unknown) =>
				setCloudflareStatus(friendlyError(error, "Sign-in failed.")),
			)
			.finally(() => setBusy(false));
	}, [cloudflareConfig, isCloudflareCallback, navigate]);

	useEffect(() => {
		if (route === "login" && !isCloudflareCallback) navigate("/", { replace: true });
	}, [isCloudflareCallback, navigate, route]);

	useEffect(() => {
		if (!cloudflareToken) return;
		api
			.getCloudflareAccounts(cloudflareToken)
			.then((accounts) => {
				setCloudflareAccounts(accounts);
				setSelectedAccountId((current) => current || accounts[0]?.id || "");
				setCloudflareStatus(accounts.length > 0 ? "Sign-in complete. Select an account to create a vault." : "Sign-in complete, but no accounts were returned.");
			})
			.catch((error: unknown) => {
				localStorage.removeItem("sickrat.cf.accessToken");
				setCloudflareToken(null);
				setCloudflareAccounts([]);
				setSelectedAccountId("");
				setCloudflareStatus(friendlyError(error, "Setup session expired."));
			});
	}, [cloudflareToken]);

	useEffect(() => {
		if (!capabilities) return;
		if (!capabilities.push.configured || !("serviceWorker" in navigator) || !("PushManager" in window)) {
			setPushSubscriptionChecked(true);
			return;
		}
		if (Notification.permission !== "granted") {
			setPushSubscriptionChecked(true);
			return;
		}

		navigator.serviceWorker.ready
			.then(async (registration) => {
				const applicationServerKey = base64UrlToUint8Array(capabilities.push.vapidPublicKey!);
				const existing = await registration.pushManager.getSubscription();
				if (!existing) return;
				if (!arrayBuffersEqual(existing.options.applicationServerKey, applicationServerKey)) {
					await existing.unsubscribe();
					setStatus("Push subscription key changed. Enable push again to refresh this device.");
					return;
				}
				return api.saveSubscription(existing.toJSON());
			})
			.then((saved) => {
				if (!saved) return;
				setSubscription(saved);
				setStatus("Push is already enabled on this device.");
			})
			.catch((error: unknown) => {
				setStatus(friendlyError(error, "Failed to sync existing notification setup."));
			})
			.finally(() => setPushSubscriptionChecked(true));
	}, [capabilities]);

	useEffect(() => {
		if (!requestId) return;
		api
			.getApproval(requestId)
			.then((next) => {
				setApproval(next);
				setStatus(`Loaded request from ${next.device}.`);
			})
			.catch((error: unknown) => setStatus(friendlyError(error, "Failed to load request.")));
	}, [requestId]);

	useEffect(() => {
		if (requestId || !subscription?.endpoint) return;

		let checking = false;
		const routeToPendingNotification = async () => {
			if (checking || document.visibilityState !== "visible") return;
			checking = true;
			try {
				const latest = await api.getLatestNotification(subscription.endpoint);
				if (latest) showNotificationToast(describePendingNotification(latest));
			} catch {
				// This is only a notification-click fallback; the push setup status should stay stable.
			} finally {
				checking = false;
			}
		};

		const handleVisibility = () => {
			void routeToPendingNotification();
		};
		window.addEventListener("focus", handleVisibility);
		document.addEventListener("visibilitychange", handleVisibility);

		return () => {
			window.removeEventListener("focus", handleVisibility);
			document.removeEventListener("visibilitychange", handleVisibility);
		};
	}, [navigate, requestId, subscription]);

	useEffect(() => {
		if (!subscription?.id) return;

		let socket: WebSocket | null = null;
		let closed = false;
		let reconnectTimer = 0;
		let heartbeatTimer = 0;

		const connect = () => {
			if (closed) return;
			const url = new URL("/api/realtime", window.location.href);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			url.searchParams.set("subscriptionId", subscription.id);
			socket = new WebSocket(url);

			socket.addEventListener("open", () => {
				setStatus("Realtime notification channel connected.");
				heartbeatTimer = window.setInterval(() => {
					if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
				}, 25_000);
			});

			socket.addEventListener("message", (event) => {
				if (typeof event.data !== "string" || event.data === "pong") return;
				try {
					const message = JSON.parse(event.data) as PendingNotification | { type?: string; url?: string };
					const toast = describeRealtimeNotification(message);
					if (toast) showNotificationToast(toast);
				} catch {
					// Ignore non-JSON realtime messages.
				}
			});

			socket.addEventListener("close", () => {
				window.clearInterval(heartbeatTimer);
				if (!closed) reconnectTimer = window.setTimeout(connect, 2_000);
			});

			socket.addEventListener("error", () => {
				socket?.close();
			});
		};

		connect();

		return () => {
			closed = true;
			window.clearTimeout(reconnectTimer);
			window.clearInterval(heartbeatTimer);
			socket?.close();
		};
	}, [navigate, subscription?.id]);

	async function enablePush() {
		if (!capabilities?.push.vapidPublicKey) {
			setStatus("Notifications are not configured for this vault yet.");
			return;
		}
		if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
			setStatus("This browser cannot receive app notifications.");
			return;
		}

		setBusy(true);
		try {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				setStatus(`Notification permission is ${permission}.`);
				return;
			}

			const registration = await navigator.serviceWorker.ready;
			const applicationServerKey = base64UrlToUint8Array(capabilities.push.vapidPublicKey);
			const existing = await registration.pushManager.getSubscription();
			if (existing) {
				await existing.unsubscribe();
			}
			const nextSubscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey,
			});

			const saved = await api.saveSubscription(nextSubscription.toJSON());
			setSubscription(saved);
			setStatus("Notifications are enabled for this phone.");
		} catch (error) {
			setStatus(friendlyError(error, "Could not enable notifications."));
		} finally {
			setBusy(false);
		}
	}

	async function sendTest() {
		if (!subscription) {
			setStatus("Enable push first.");
			return;
		}
		setBusy(true);
		try {
			await api.sendTest(subscription.id);
			await refreshApprovals("pending");
			setStatus("Test push request sent to the browser push endpoint.");
		} catch (error) {
			setStatus(friendlyError(error, "Could not send a test notification."));
		} finally {
			setBusy(false);
		}
	}

	async function loginWithCloudflare(redirectTo = "/") {
		if (!cloudflareConfig?.clientId) {
			setCloudflareStatus("Browser sign-in is not configured for this vault.");
			return;
		}
		const state = randomBase64Url(24);
		const codeVerifier = randomBase64Url(72);
		const codeChallenge = await sha256Base64Url(codeVerifier);
		sessionStorage.setItem("sickrat.cf.state", state);
		sessionStorage.setItem("sickrat.cf.codeVerifier", codeVerifier);
		sessionStorage.setItem("sickrat.cf.redirectTo", redirectTo);

		const params = new URLSearchParams({
			response_type: "code",
			client_id: cloudflareConfig.clientId,
			redirect_uri: cloudflareConfig.redirectUri,
			scope: cloudflareConfig.scopes.join(" "),
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		setCloudflareStatus("Redirecting to sign-in...");
		window.location.href = `${cloudflareConfig.authUrl}?${params.toString()}`;
	}

	function logoutCloudflare() {
		localStorage.removeItem("sickrat.cf.accessToken");
		sessionStorage.removeItem("sickrat.cf.state");
		sessionStorage.removeItem("sickrat.cf.codeVerifier");
		sessionStorage.removeItem("sickrat.cf.redirectTo");
		setCloudflareToken(null);
		setCloudflareAccounts([]);
		setSelectedAccountId("");
		setProvisioning(null);
		setCloudflareStatus("Setup session cleared from this browser.");
		navigate("/", { replace: true });
	}

	async function provisionSelectedAccount() {
		if (!cloudflareToken) {
			setCloudflareStatus("Start browser setup first.");
			return;
		}
		if (!selectedAccountId) {
			setCloudflareStatus("Select an account first.");
			return;
		}

		setBusy(true);
		setProvisioning({
			ok: false,
			accountId: selectedAccountId,
			steps: [
				{ id: "d1", label: "Vault storage", status: "pending", detail: "Preparing encrypted vault records..." },
				{ id: "secrets-store", label: "Secret storage", status: "pending", detail: "Preparing secret metadata..." },
			],
			resources: {},
			next: "",
		});
		setCloudflareStatus("Creating your private vault resources...");
		try {
			const result = await api.provisionCloudflare(cloudflareToken, selectedAccountId);
			setProvisioning(result);
			setCloudflareStatus(
				result.ok
					? "Created or found all account-owned vault resources."
					: "Vault resource creation completed with errors. See step details below.",
			);
		} catch (error) {
			setCloudflareStatus(friendlyError(error, "Vault creation failed."));
		} finally {
			setBusy(false);
		}
	}

	async function approveExistingApprovalRequest(target: ApprovalRequest) {
		const storedRefs = new Set(secrets.map((secret) => secret.ref));
		const missingRefs = target.secretRefs.filter((ref) => !storedRefs.has(ref));
		if (missingRefs.length > 0) {
			navigate(`/approve/${encodeURIComponent(target.id)}`);
			throw new Error("Open the approval screen to create missing secret values before approving.");
		}
			if (!target.ephemeralPublicKey) throw new Error("This approval request cannot receive a sealed machine grant.");

		const approvedAt = new Date();
		const accessExpiresAt = target.accessDurationSeconds
			? new Date(approvedAt.getTime() + target.accessDurationSeconds * 1000).toISOString()
			: undefined;
		let key = vaultKey;
		if (!key) {
			if (getPasskeyVaultRecord()) {
				setStatus("Unlocking vault with passkey...");
				key = await unlockPasskeyVaultKey();
			} else {
				setStatus("Creating a passkey-protected vault key...");
				key = await createPasskeyWrappedVaultKey();
			}
			if (!key) throw new Error("Unlock or create the vault key before approving this machine request.");
			setVaultKey(key);
		}

		setStatus("Preparing the requested secrets...");
		const encryptedSecrets = await api.resolveSecrets(target.secretRefs);
		const plaintextSecrets: Record<string, string> = {};
		for (const secret of encryptedSecrets) {
			plaintextSecrets[secret.ref] = await decryptSecretValue(secret, key);
		}
		setStatus("Sealing a short-lived grant for this machine...");
		const grant = await encryptGrantForCli(
			{ secrets: plaintextSecrets, approvedAt: approvedAt.toISOString(), accessExpiresAt },
			target.ephemeralPublicKey,
		);
		await api.sendGrant(target.id, grant);
	}

	async function decideApprovalRequest(target: ApprovalRequest, action: "approve" | "deny") {
		setBusy(true);
		setSwipedApprovalId(null);
		try {
			if (action === "approve") {
				await approveExistingApprovalRequest(target);
			} else {
				await api.decideApproval(target.id, action);
			}
			if (approval?.id === target.id) setApproval(await api.getApproval(target.id));
			await refreshApprovals(approvalFilter);
			setStatus(action === "approve" ? "Approved. This machine can continue." : "Denied. The request is closed.");
		} catch (error) {
			setStatus(friendlyError(error, "Decision failed."));
		} finally {
			setBusy(false);
		}
	}

	async function decide(action: "approve" | "deny") {
		if (!approval) return;
		setBusy(true);
		try {
			if (action === "approve" && approval.ephemeralPublicKey) {
				const approvedAt = new Date();
				const accessExpiresAt = approval.accessDurationSeconds
					? new Date(approvedAt.getTime() + approval.accessDurationSeconds * 1000).toISOString()
					: undefined;
				let key = vaultKey;
				if (!key) {
					if (getPasskeyVaultRecord()) {
						setStatus("Unlocking vault with passkey...");
						key = await unlockPasskeyVaultKey();
					} else {
						setStatus("Creating a passkey-protected vault key...");
						key = await createPasskeyWrappedVaultKey();
					}
					if (!key) throw new Error("Unlock or create the vault key before approving this machine request.");
					setVaultKey(key);
				}
				if (missingApprovalRefs.length > 0) {
					for (const ref of missingApprovalRefs) {
						const value = approvalSecretValues[ref] ?? "";
						if (!value) throw new Error(`Enter a value for ${ref} before approving.`);
					}
					setStatus("Encrypting new secrets locally...");
					const createdSecrets: Array<{
						ref: string;
						label: string;
						ciphertext: string;
						iv: string;
						salt: string;
						kdf: string;
					}> = [];
					for (const ref of missingApprovalRefs) {
						const encrypted = await encryptSecretValue(approvalSecretValues[ref], key);
						createdSecrets.push({
							ref,
							label: ref,
							...encrypted,
						});
					}
					setStatus("Preparing existing secrets...");
					const existingRefs = approval.secretRefs.filter((ref) => !missingApprovalRefs.includes(ref));
					const encryptedSecrets = existingRefs.length > 0 ? await api.resolveSecrets(existingRefs) : [];
					const plaintextSecrets: Record<string, string> = {};
					for (const secret of encryptedSecrets) {
						plaintextSecrets[secret.ref] = await decryptSecretValue(secret, key);
					}
					for (const ref of missingApprovalRefs) plaintextSecrets[ref] = approvalSecretValues[ref];
					setStatus("Sealing a short-lived grant for this machine...");
					const grant = await encryptGrantForCli(
						{ secrets: plaintextSecrets, approvedAt: approvedAt.toISOString(), accessExpiresAt },
						approval.ephemeralPublicKey,
					);
					await api.sendGrant(approval.id, grant, createdSecrets);
					const createdAt = new Date().toISOString();
					const savedSecrets = createdSecrets.map((secret) => ({
						id: secret.ref,
						ref: secret.ref,
						label: secret.label,
						kdf: secret.kdf,
						createdAt,
						updatedAt: createdAt,
					}));
					setSecrets((current) => [
						...savedSecrets,
						...current.filter((secret) => !savedSecrets.some((saved) => saved.ref === secret.ref)),
					]);
					setApprovalSecretValues((current) => {
						const next = { ...current };
						for (const ref of missingApprovalRefs) delete next[ref];
						return next;
					});
					setApprovalSecretOptions((current) => {
						const next = { ...current };
						for (const ref of missingApprovalRefs) delete next[ref];
						return next;
					});
				} else {
					setStatus("Preparing the requested secrets...");
					const encryptedSecrets = await api.resolveSecrets(approval.secretRefs);
					const plaintextSecrets: Record<string, string> = {};
					for (const secret of encryptedSecrets) {
						plaintextSecrets[secret.ref] = await decryptSecretValue(secret, key);
					}
					setStatus("Sealing a short-lived grant for this machine...");
					const grant = await encryptGrantForCli(
						{ secrets: plaintextSecrets, approvedAt: approvedAt.toISOString(), accessExpiresAt },
						approval.ephemeralPublicKey,
					);
					await api.sendGrant(approval.id, grant);
				}
			} else {
				await api.decideApproval(approval.id, action);
			}
			const next = await api.getApproval(approval.id);
			setApproval(next);
			await refreshApprovals(approvalFilter);
			setStatus(action === "approve" ? "Approved. This machine can continue." : "Denied. The request is closed.");
		} catch (error) {
			setStatus(friendlyError(error, "Decision failed."));
		} finally {
			setBusy(false);
		}
	}

	async function loadPairingCodeValue(code: string) {
		const normalized = code.replace(/\D/g, "");
		if (normalized.length !== 6) {
			setPairingStatus("Enter a six-digit pairing code.");
			return;
		}
		setBusy(true);
		setPairingStatus("Loading pairing request...");
		try {
			const details = await api.getPairingCode(normalized);
			setPairing(details);
			setPairingStatus(details.expired ? "This pairing code has expired." : `Ready to pair ${details.label}.`);
		} catch (error) {
			setPairingStatus(friendlyError(error, "Failed to load pairing code."));
		} finally {
			setBusy(false);
		}
	}

	async function loadPairingCode(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		await loadPairingCodeValue(pairingCode);
	}

	async function approvePairing() {
		if (!pairing) return;
		setBusy(true);
		setPairingStatus("Approving device...");
		try {
			await api.approvePairingCode(pairing.code);
			const details = await api.getPairingCode(pairing.code);
			setPairing(details);
			await refreshDevices();
			setPairingStatus(`${details.label} is paired and can request approvals.`);
		} catch (error) {
			setPairingStatus(friendlyError(error, "Failed to approve pairing."));
		} finally {
			setBusy(false);
		}
	}

	async function setupVaultKey() {
		setBusy(true);
		setSecretStatus("Creating passkey-protected vault key...");
		try {
			let existingKey: CryptoKey | null = null;
			const legacy = localStorage.getItem(legacyVaultKeyStorageKey);
			if (legacy) {
				existingKey = await crypto.subtle.importKey(
					"jwk",
					JSON.parse(legacy) as JsonWebKey,
					{ name: "AES-GCM" },
					true,
					["encrypt", "decrypt"],
				);
			}
			const key = await createPasskeyWrappedVaultKey(existingKey);
			setVaultKey(key);
			setSecretStatus("Vault key is protected by passkey. New secrets will use this key automatically.");
		} catch (error) {
			setSecretStatus(friendlyError(error, "Failed to create passkey-protected vault key."));
		} finally {
			setBusy(false);
		}
	}

	async function unlockVaultKey() {
		setBusy(true);
		setSecretStatus("Unlocking vault with passkey...");
		try {
			const key = await unlockPasskeyVaultKey();
			if (!key) {
				setSecretStatus("No passkey-protected vault key exists on this device.");
				return;
			}
			setVaultKey(key);
			setSecretStatus("Vault unlocked with passkey.");
		} catch (error) {
			setSecretStatus(friendlyError(error, "Failed to unlock vault."));
		} finally {
			setBusy(false);
		}
	}

	function resetVaultKey() {
		localStorage.removeItem(passkeyVaultStorageKey);
		localStorage.removeItem(legacyVaultKeyStorageKey);
		setVaultKey(null);
		setSecretStatus("Vault key removed from this browser. Existing secrets cannot be decrypted here until recovery exists.");
	}

	async function saveSecret(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!vaultKey) {
			setSecretStatus("Create a local vault key first.");
			return;
		}
		if (!secretForm.ref.trim() || secretForm.ref.trim() !== secretForm.ref) {
			setSecretStatus("Secret ref must be a non-empty unique string without leading or trailing spaces.");
			return;
		}
		if (!secretForm.value) {
			setSecretStatus("Secret value is required.");
			return;
		}

		setBusy(true);
		setSecretStatus("Encrypting secret locally...");
		try {
			const encrypted = await encryptSecretValue(secretForm.value, vaultKey);
			setSecretStatus("Saving encrypted value to your vault...");
			const saved = await api.saveSecret({
				ref: secretForm.ref,
				label: secretForm.label || secretForm.ref,
				...encrypted,
			});
			setSecrets((current) => [saved, ...current.filter((secret) => secret.ref !== saved.ref)]);
			setSecretForm({ label: "", ref: "", value: "" });
			setSecretStatus("Secret saved. Only encrypted data left this phone.");
		} catch (error) {
			setSecretStatus(friendlyError(error, "Failed to save secret."));
		} finally {
			setBusy(false);
		}
	}

	async function revokeDevice(id: string) {
		setBusy(true);
		setPairingStatus("Revoking paired device...");
		try {
			const device = await api.revokeDevice(id);
			setDevices((current) => current.map((item) => (item.id === device.id ? device : item)));
			setPairingStatus(`${device.label} is revoked.`);
		} catch (error) {
			setPairingStatus(friendlyError(error, "Failed to revoke machine."));
		} finally {
			setBusy(false);
		}
	}

	function handleApprovalTouchStart(item: ApprovalRequest, event: React.TouchEvent<HTMLLIElement>) {
		setApprovalTouchStart({ id: item.id, x: event.touches[0]?.clientX ?? 0 });
	}

	function handleApprovalTouchEnd(item: ApprovalRequest, event: React.TouchEvent<HTMLLIElement>) {
		if (!approvalTouchStart || approvalTouchStart.id !== item.id) return;
		const endX = event.changedTouches[0]?.clientX ?? approvalTouchStart.x;
		const delta = endX - approvalTouchStart.x;
		if (Math.abs(delta) > 44) {
			setSwipedApprovalId((current) => (current === item.id ? null : item.id));
		}
		setApprovalTouchStart(null);
	}

	function hideApprovalRow(id: string) {
		setApprovals((current) => current.filter((item) => item.id !== id));
		setSwipedApprovalId(null);
	}

	function handleShellTouchStart(event: React.TouchEvent<HTMLDivElement>) {
		const touch = event.touches[0];
		if (!touch) return;
		edgeSwipeRef.current = touch.clientX <= 24 ? { x: touch.clientX, y: touch.clientY } : null;
	}

	function handleShellTouchEnd(event: React.TouchEvent<HTMLDivElement>) {
		if (!edgeSwipeRef.current) return;
		const touch = event.changedTouches[0];
		if (!touch) return;
		const deltaX = touch.clientX - edgeSwipeRef.current.x;
		const deltaY = Math.abs(touch.clientY - edgeSwipeRef.current.y);
		if (deltaX > 72 && deltaY < 72) setNavigationOpen(true);
		edgeSwipeRef.current = null;
	}

	if (route === "approval" && requestId) {
		const timedAccess = approval?.accessDurationSeconds ? approval.accessDurationSeconds : null;
		const waitLabel = approval ? approvalWaitLabel(approval) : null;
		return (
			<Page>
				<Navbar title={timedAccess ? "Trust Window" : "Release Grant"} left={<NavbarBackLink onClick={() => navigate("/")}>App</NavbarBackLink>} />
				{approval ? (
					<>
						<Block strong inset>
							<div className="flex items-start justify-between gap-4">
								<div>
									<div className="text-sm text-black/45 dark:text-white/45">{timedAccess ? "Timed access request" : "Quarantine event"}</div>
									<h1 className="m-0 mt-1 text-3xl font-bold leading-tight">{timedAccess ? "Trust window" : "Release grant"}</h1>
								</div>
								<Badge colors={{ bg: approvalBadgeColor(approval) }}>
									{approvalStatusLabel(approval)}
								</Badge>
							</div>
						</Block>
						{timedAccess ? (
							<Card outline header="Auto-approve window" footer="Use this only while you expect the agent to keep working.">
								<div className="text-2xl font-semibold">{formatDuration(timedAccess)}</div>
								<p className="mb-0 text-black/55 dark:text-white/55">
									Approving grants this paired machine local reuse of these refs until the window expires.
								</p>
							</Card>
						) : null}
						{waitLabel ? (
							<Card outline header="Approval wait">
								<div className="text-xl font-semibold">{waitLabel}</div>
								<p className="mb-0 text-black/55 dark:text-white/55">
									Expires {new Date(approval.expiresAt).toLocaleString()}. Longer waits usually mean the agent expects you may not see the notification immediately.
								</p>
							</Card>
						) : null}
						<BlockTitle>Request</BlockTitle>
						<List strong inset>
							<ListItem title="Device" after={approval.device} media={<Laptop size={22} />} />
							<ListItem title="Command" subtitle={approval.command} media={<Sparkles size={22} />} />
							{approval.message ? <ListItem title="Message" subtitle={approval.message} /> : null}
							<ListItem title="Created" after={formatAgo(approval.createdAt)} footer={new Date(approval.createdAt).toLocaleString()} />
							<ListItem title="Approval expires" after={approval.expired ? "Expired" : `In ${formatUntil(approval.expiresAt)}`} footer={new Date(approval.expiresAt).toLocaleString()} />
							<ListItem
								title={timedAccess ? "Access mode" : "Grant TTL"}
								subtitle={
									timedAccess
										? approval.accessExpiresAt
											? `Reusable until ${new Date(approval.accessExpiresAt).toLocaleString()}`
											: `Reusable for ${formatDuration(timedAccess)} after approval`
										: approval.grantReadyAt
											? "Grant sealed for machine retrieval"
											: "Short-lived grant minted only after approval"
								}
							/>
						</List>
						<BlockTitle>Requested Refs</BlockTitle>
						<List strong inset>
							{approval.secretRefs.map((ref) => (
								<ListItem
									key={ref}
									title={ref}
										media={<KeyRound size={22} />}
										after={missingApprovalRefs.includes(ref) ? "Missing" : undefined}
										subtitle={
											missingApprovalRefs.includes(ref)
												? "Needs value. This approval will create and grant it."
												: timedAccess
													? "Stored in vault. Reusable during the approved window."
													: "Stored in vault"
										}
									/>
							))}
						</List>
						{missingApprovalRefs.length > 0 ? (
							<>
								<BlockTitle>Create Missing Secrets</BlockTitle>
								<Block strong inset>
									The agent requested references that are not in this vault yet. Values entered here stay on this device until you approve.
								</Block>
								<List strong inset>
									<ListItem
										title={vaultKey ? "Vault unlocked" : getPasskeyVaultRecord() ? "Vault locked" : "No passkey vault on this device"}
										subtitle={
											vaultKey
												? "New values will be encrypted before upload."
												: getPasskeyVaultRecord()
													? "Approving will ask you to unlock with your passkey."
													: "Approving will first create a passkey-protected vault key."
										}
										media={<LockKeyhole size={22} />}
									/>
								</List>
								{missingApprovalRefs.map((ref) => {
									const options = getPendingSecretOptions(ref);
									return (
										<React.Fragment key={ref}>
											<BlockTitle>{ref}</BlockTitle>
											<List strong inset>
												<ListInput
													label="Secret value"
													type={options.show ? "text" : "password"}
													autoCapitalize="none"
													autoComplete="new-password"
													spellCheck="false"
													value={approvalSecretValues[ref] ?? ""}
													onChange={(event) =>
														setApprovalSecretValues((current) => ({ ...current, [ref]: event.target.value }))
													}
													placeholder="Type, paste, or generate"
												/>
												<ListItem
													title="Allow symbols"
													after={<Toggle checked={options.symbols} onChange={(event) => updatePendingSecretOptions(ref, { symbols: event.target.checked })} />}
												/>
												<ListItem
													title="Generate secure password"
													link
													media={<Sparkles size={22} />}
													onClick={() => generateMissingSecret(ref)}
												/>
												<ListItem
													title={options.show ? "Hide value" : "Show value"}
													link
													onClick={() => updatePendingSecretOptions(ref, { show: !options.show })}
												/>
												<ListItem
													title={options.copied ? "Copied" : "Copy value"}
													link
													media={<Copy size={22} />}
													onClick={() => void copyMissingSecret(ref)}
													footer="Default generation uses 22 characters with uppercase, lowercase, and digits."
												/>
											</List>
										</React.Fragment>
									);
								})}
							</>
						) : null}
						<Block inset className="grid grid-cols-2 gap-3">
							<Button rounded outline disabled={busy || approval.status !== "pending" || approval.expired} onClick={() => decide("deny")}>
								Deny
							</Button>
							<Button rounded disabled={busy || approval.status !== "pending" || approval.expired} onClick={() => decide("approve")}>
								Approve
							</Button>
						</Block>
						<Block inset className="text-center text-sm text-black/45 dark:text-white/45">{status}</Block>
					</>
				) : (
					<Block strong inset>
						<h1 className="m-0 text-2xl font-semibold">Loading request</h1>
						<p className="mb-0 text-black/55 dark:text-white/55">{status}</p>
					</Block>
				)}
			</Page>
		);
	}

	if (isCloudflareCallback && !cloudflareToken) {
		return (
			<Page>
				<Navbar title="Sickrat" subtitle="Vault setup" />
				<Block strong inset>
					<h1 className="m-0 text-3xl font-bold">Completing login</h1>
					<p className="mb-0 text-black/55 dark:text-white/55">Finishing sign-in and returning you to the app.</p>
				</Block>
				<Block inset className="text-center text-sm text-black/45 dark:text-white/45">{cloudflareStatus}</Block>
			</Page>
		);
	}

	if (route === "login") {
		return (
			<Page>
				<Navbar title="Sickrat" subtitle="Private vault" />
				<Block strong inset>
					<h1 className="m-0 text-3xl font-bold">Open your vault</h1>
					<p className="mb-0 text-black/55 dark:text-white/55">This private vault is ready for approvals from your phone.</p>
				</Block>
				<Block inset className="grid grid-cols-2 gap-3">
					<Button rounded onClick={() => navigate("/")}>Open Console</Button>
					<Button rounded outline component="a" href="https://sickrat.dev">Back Home</Button>
				</Block>
				<Block inset className="text-center text-sm text-black/45 dark:text-white/45">Vault setup is handled by the Sickrat command line.</Block>
			</Page>
		);
	}

	if (
		installed &&
		capabilities?.push.configured &&
		pushSubscriptionChecked &&
		!subscription &&
		route !== "approval" &&
		!isCloudflareCallback
	) {
		return (
			<Page>
				<Navbar title="Sickrat" subtitle="First launch" />
				<Block strong inset>
					<h1 className="m-0 text-3xl font-bold">Enable push approvals.</h1>
					<p className="mb-0 text-black/55 dark:text-white/55">
						Sickrat uses push notifications for pairing requests and agent approval prompts. Enable push on this installed app before pairing an agent machine.
					</p>
				</Block>
				<Block inset className="grid grid-cols-2 gap-3">
					<Button rounded disabled={busy} onClick={enablePush}>{busy ? "Enabling" : "Enable Push"}</Button>
					<Button rounded outline component="a" href="https://sickrat.dev/skills/sickrat.md">Agent Skill</Button>
				</Block>
				<Block inset className="text-center text-sm text-black/45 dark:text-white/45">{status}</Block>
			</Page>
		);
	}

	{
		const renderCloudflareControls = () => (
			<>
				<BlockTitle>Vault Health</BlockTitle>
				<List strong inset>
					<ListItem title="Vault" after={capabilities?.vault.name ?? "default"} media={<Cloud size={22} />} />
					<ListItem title="Origin" subtitle={window.location.origin} media={<ExternalLink size={22} />} />
					<ListItem title="Storage" after={capabilities?.database.configured ? "Ready" : "Needs setup"} media={<Database size={22} />} />
					<ListItem link title="Agent Skill" subtitle="Open Sickrat setup instructions" media={<BookOpen size={22} />} component="a" href="https://sickrat.dev/skills/sickrat.md" />
				</List>
			</>
		);

		const renderVaultKeyPanel = () => (
			<>
				<BlockTitle>Vault Key</BlockTitle>
				<List strong inset>
					<ListItem
						title={vaultKey ? "Vault unlocked" : getPasskeyVaultRecord() ? "Vault locked" : "No passkey vault on this device"}
						subtitle={
							vaultKey
								? "This browser can encrypt new refs until the app reloads."
								: getPasskeyVaultRecord()
									? "Unlock with your platform passkey to add secrets."
									: "Create a passkey-protected vault key before adding secrets."
						}
						footer={secretStatus}
						media={<LockKeyhole size={22} />}
					/>
				</List>
				<Block inset>
					{vaultKey ? (
						<Button rounded outline type="button" disabled={busy} onClick={resetVaultKey}>
							Reset Key
						</Button>
					) : getPasskeyVaultRecord() ? (
						<Button rounded type="button" disabled={busy} onClick={unlockVaultKey}>
							Unlock
						</Button>
					) : (
						<Button rounded type="button" disabled={busy} onClick={setupVaultKey}>
							Create Passkey
						</Button>
					)}
				</Block>
			</>
		);

		const renderSecretForm = () => (
			<form onSubmit={saveSecret}>
				<List strong inset>
					<ListInput
						label="Label"
						type="text"
						autoComplete="off"
						value={secretForm.label}
						onChange={(event) => setSecretForm((current) => ({ ...current, label: event.target.value }))}
						placeholder="OpenAI API key"
					/>
					<ListInput
						label="Reference"
						type="text"
						autoCapitalize="none"
						autoComplete="off"
						value={secretForm.ref}
						onChange={(event) => setSecretForm((current) => ({ ...current, ref: event.target.value }))}
						placeholder="openai/api-key or prod/database/url"
					/>
					<ListInput
						label="Secret value"
						type="textarea"
						autoCapitalize="none"
						autoComplete="off"
						value={secretForm.value}
						onChange={(event) => setSecretForm((current) => ({ ...current, value: event.target.value }))}
						placeholder="Paste secret value"
					/>
				</List>
				<Block inset>
					<Button rounded type="submit" disabled={busy || !vaultKey}>{busy ? "Saving" : "Encrypt And Save"}</Button>
				</Block>
			</form>
		);

		const renderPairForm = () => (
			<>
				<form onSubmit={loadPairingCode}>
					<List strong inset>
						<ListInput
							label="Pairing code"
							type="text"
							inputMode="numeric"
							autoComplete="one-time-code"
							value={pairingCode}
							onChange={(event) => setPairingCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
							placeholder="482913"
						/>
					</List>
					<Block inset>
						<Button rounded type="submit" disabled={busy}>{busy ? "Loading" : "Load Device"}</Button>
					</Block>
				</form>
				{pairing ? (
					<>
						<List strong inset>
							<ListItem title="Device" after={pairing.label} media={<Laptop size={22} />} />
							<ListItem title="Device ID" subtitle={pairing.deviceId} />
							<ListItem title="Expires" after={new Date(pairing.expiresAt).toLocaleString()} />
						</List>
						<Block inset className="grid grid-cols-2 gap-3">
							<Button rounded outline type="button" onClick={() => setPairing(null)}>
								Cancel
							</Button>
							<Button rounded disabled={busy || pairing.expired || Boolean(pairing.approvedAt)} onClick={approvePairing}>
								{pairing.approvedAt ? "Paired" : "Approve Device"}
							</Button>
						</Block>
					</>
				) : null}
				<Block inset className="text-center text-sm text-black/45 dark:text-white/45">{pairingStatus}</Block>
			</>
		);

		const currentPageTitle =
			route === "app"
				? "Dashboard"
				: route === "approval-detail"
					? "Request detail"
					: route === "devices"
						? "Machines"
						: route === "settings"
							? "Settings"
							: route.charAt(0).toUpperCase() + route.slice(1);
		let routeContent: React.ReactNode;
		if (route === "app") {
			const hasPasskeyVault = Boolean(getPasskeyVaultRecord());
			const vaultKeyTitle = vaultKey ? "Vault key open" : hasPasskeyVault ? "Vault key locked" : "Vault key not created";
			const vaultKeySubtitle = vaultKey
				? "New refs can be encrypted until the app reloads."
				: hasPasskeyVault
					? "Unlock before adding or releasing secret values."
					: "Create a passkey-protected key before storing refs.";
			const vaultKeyAction = vaultKey ? "Reset Key" : hasPasskeyVault ? "Unlock" : "Create Passkey";
			const vaultKeyActionHandler = vaultKey ? resetVaultKey : hasPasskeyVault ? unlockVaultKey : setupVaultKey;

			routeContent = (
				<>
					<Card outline header="Private vault" footer="Approve exact secret refs from paired machines without sending plaintext through chat.">
						<div className="flex items-start justify-between gap-4">
							<div className="text-3xl font-bold leading-tight">Ready when agents ask</div>
							<div
								className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${
									vaultKey ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"
								}`}
								aria-label={vaultKeyTitle}
								title={vaultKeyTitle}
							>
								<LockKeyhole size={24} />
							</div>
						</div>
					</Card>
					<Card outline>
						<div className="flex items-center justify-between gap-4">
							<div className="flex min-w-0 items-center gap-3">
								<div
									className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
										vaultKey ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" : "bg-black/5 text-black/55 dark:bg-white/10 dark:text-white/60"
									}`}
								>
									<LockKeyhole size={20} />
								</div>
								<div className="min-w-0">
									<div className="font-semibold">{vaultKeyTitle}</div>
									<div className="text-sm text-black/55 dark:text-white/55">{vaultKeySubtitle}</div>
								</div>
							</div>
							<Button rounded small outline={Boolean(vaultKey)} type="button" disabled={busy} onClick={vaultKeyActionHandler}>
								{vaultKeyAction}
							</Button>
						</div>
					</Card>
					{!subscription ? (
						<Card outline>
							<div className="flex items-center justify-between gap-4">
								<div className="flex min-w-0 items-center gap-3">
									<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
										<Bell size={20} />
									</div>
									<div className="min-w-0">
										<div className="font-semibold">Push approvals are off</div>
										<div className="text-sm text-black/55 dark:text-white/55">{status}</div>
									</div>
								</div>
								<Button rounded small disabled={busy} onClick={enablePush}>
									Enable
								</Button>
							</div>
						</Card>
					) : null}
					<BlockTitle>Overview</BlockTitle>
					<List strong inset>
						<ListItem link onClick={() => navigate("/vaults")} title="Vault" after={vaultName} subtitle={capabilities?.database.configured ? "Private deployment healthy" : "Vault storage needs setup"} media={<Cloud size={22} />} />
						<ListItem link onClick={() => navigate("/secrets")} title="Secrets" after={String(secrets.length)} subtitle="Encrypted refs saved in your vault" media={<KeyRound size={22} />} />
						<ListItem link onClick={() => navigate("/approvals")} title="Pending grants" after={String(pendingApprovals.length)} subtitle="Release only what the command needs" media={<ShieldCheck size={22} />} />
						<ListItem link onClick={() => navigate("/devices")} title="Active devices" after={String(activeDevices.length)} subtitle="Paired machines that can request access" media={<Laptop size={22} />} />
					</List>
					</>
				);
		} else if (route === "vaults") {
			routeContent = (
				<>
					<Block strong inset>
						<h1 className="m-0 text-3xl font-bold">Vault</h1>
						<p className="mb-0 text-black/55 dark:text-white/55">This phone app controls your private vault. Keep it installed for approvals.</p>
					</Block>
					<BlockTitle>Current Vault</BlockTitle>
					<List strong inset>
						<ListItem title="Name" after={vaultName} media={<Cloud size={22} />} />
						<ListItem title="Origin" subtitle={window.location.origin} media={<ExternalLink size={22} />} />
						<ListItem title="Storage" after={capabilities?.database.configured ? "Ready" : "Needs setup"} media={<Database size={22} />} />
						<ListItem title="Realtime" after={subscription ? "Connected" : "Enable push"} media={<Bell size={22} />} />
					</List>
					{renderCloudflareControls()}
				</>
			);
		} else if (route === "secrets") {
			routeContent = (
				<>
					<Block strong inset>
						<h1 className="m-0 text-3xl font-bold">Secrets</h1>
						<p className="mb-0 text-black/55 dark:text-white/55">Values are encrypted on this device. Agents ask for refs; you decide what gets released.</p>
					</Block>
					{renderVaultKeyPanel()}
					<BlockTitle>Add Or Update Ref</BlockTitle>
					{renderSecretForm()}
					<Block inset className="text-center text-sm text-black/45 dark:text-white/45">{secretStatus}</Block>
					<BlockTitle>Stored References</BlockTitle>
					<List strong inset>
						<ListInput
							label="Search"
							type="text"
							autoCapitalize="none"
							autoComplete="off"
							value={secretQuery}
							onChange={(event) => setSecretQuery(event.target.value)}
							placeholder="Filter refs"
							media={<Search size={22} />}
						/>
						{filteredSecrets.length > 0 ? (
							filteredSecrets.map((secret) => (
								<ListItem key={secret.id} title={secret.label} subtitle={secret.ref} media={<KeyRound size={22} />} />
							))
						) : (
							<ListItem title="No matching encrypted refs" />
						)}
					</List>
				</>
			);
		} else if (route === "approvals") {
			routeContent = (
				<>
					<Block strong inset>
						<h1 className="m-0 text-3xl font-bold">Grants</h1>
						<p className="mb-0 text-black/55 dark:text-white/55">Review requests from paired machines. Pending grants can be approved or denied.</p>
					</Block>
					<Block inset>
						<Segmented strong>
							{(["pending", "approved", "denied", "all"] as const).map((statusOption) => (
								<SegmentedButton key={statusOption} active={approvalFilter === statusOption} onClick={() => setApprovalFilter(statusOption)}>
									{statusOption}
								</SegmentedButton>
							))}
						</Segmented>
					</Block>
					<List strong inset>
						{approvals.map((item) => (
							<ListItem
								key={item.id}
								link
								title={item.command}
								subtitle={item.message ?? `${item.secretRefs.length} refs requested`}
								after={formatAgo(item.createdAt)}
								footer={approvalWaitLabel(item) ?? undefined}
								media={<ShieldCheck size={22} />}
								onClick={() => {
									setSwipedApprovalId(null);
									navigate(`/approvals/${encodeURIComponent(item.id)}`);
								}}
							/>
						))}
						{approvals.length === 0 ? <ListItem title="No approvals in this view" /> : null}
					</List>
				</>
			);
		} else if (route === "approval-detail") {
			routeContent = (
				<>
					<Block strong inset>
						<h1 className="m-0 text-3xl font-bold">Request detail</h1>
						<p className="mb-0 text-black/55 dark:text-white/55">Inspect the command, device, message, and requested refs.</p>
					</Block>
					{approval ? (
						<>
							<BlockTitle>{approval.device}</BlockTitle>
							<List strong inset>
								<ListItem title="Status" after={approvalStatusLabel(approval)} media={<ShieldCheck size={22} />} />
								<ListItem title="Command" subtitle={approval.command} />
								{approval.message ? <ListItem title="Message" subtitle={approval.message} /> : null}
								<ListItem title="Created" after={formatAgo(approval.createdAt)} footer={new Date(approval.createdAt).toLocaleString()} />
								{approvalWaitLabel(approval) ? <ListItem title="Approval wait" after={approvalWaitLabel(approval) ?? undefined} /> : null}
								<ListItem title="Approval expires" after={approval.expired ? "Expired" : `In ${formatUntil(approval.expiresAt)}`} footer={new Date(approval.expiresAt).toLocaleString()} />
								<ListItem title="Decided" after={approval.decidedAt ? new Date(approval.decidedAt).toLocaleString() : "Pending"} />
							</List>
							<BlockTitle>Requested Refs</BlockTitle>
							<List strong inset>
								{approval.secretRefs.map((ref) => (
									<ListItem key={ref} title={ref} subtitle="Requested ref" media={<KeyRound size={22} />} />
								))}
							</List>
							<Block inset className="grid grid-cols-2 gap-3">
								{approval.status === "pending" ? (
									<Button rounded onClick={() => navigate(`/approve/${encodeURIComponent(approval.id)}`)}>Open Approval</Button>
								) : null}
								<Button rounded outline onClick={() => navigate("/approvals")}>Approvals</Button>
							</Block>
						</>
					) : (
						<Block strong inset>{status}</Block>
					)}
				</>
			);
		} else if (route === "devices") {
			routeContent = (
				<>
					<Block strong inset>
						<h1 className="m-0 text-3xl font-bold">Machines</h1>
						<p className="mb-0 text-black/55 dark:text-white/55">Only paired machines can ask this phone to release grants.</p>
					</Block>
					<BlockTitle>Pair A Machine</BlockTitle>
					<Block strong inset>
						Run <code>sickrat pair {window.location.origin}</code>, then enter the six-digit code here.
					</Block>
					{renderPairForm()}
					<BlockTitle>Paired Devices</BlockTitle>
					<List strong inset>
						{devices.length > 0 ? (
							devices.map((device) => (
								<ListItem
									key={device.id}
									title={device.label}
									subtitle={device.id}
									footer={device.revokedAt ? `Revoked ${new Date(device.revokedAt).toLocaleString()}` : `Paired ${new Date(device.createdAt).toLocaleString()}`}
									media={<Laptop size={22} />}
									after={
										device.revokedAt ? (
											<Badge colors={{ bg: "bg-red-500" }}>revoked</Badge>
										) : (
											<Button small rounded outline disabled={busy} onClick={() => revokeDevice(device.id)}>Revoke</Button>
										)
									}
								/>
							))
						) : (
							<ListItem title="No paired devices yet" />
						)}
					</List>
				</>
			);
		} else {
			routeContent = (
				<>
					<Block strong inset>
						<h1 className="m-0 text-3xl font-bold">Settings</h1>
						<p className="mb-0 text-black/55 dark:text-white/55">Manage install state, push approvals, and the passkey-protected vault key.</p>
					</Block>
					{renderCloudflareControls()}
					<BlockTitle>App Install</BlockTitle>
					<InstallPrompt />
					<BlockTitle>Push Approvals</BlockTitle>
					<List strong inset>
						<ListItem title={subscription ? "Notifications enabled" : "Notifications"} subtitle={subscription ? "Notifications are enabled for new agent requests." : status} media={<Bell size={22} />} />
					</List>
					<Block inset className="grid grid-cols-2 gap-3">
						<Button rounded disabled={busy || Boolean(subscription)} onClick={enablePush}>{subscription ? "Push Enabled" : "Enable Push"}</Button>
						<Button rounded outline disabled={busy || !subscription} onClick={sendTest}>Send Test</Button>
					</Block>
					{renderVaultKeyPanel()}
				</>
			);
		}

		return (
			<Page>
				<div onTouchStart={handleShellTouchStart} onTouchEnd={handleShellTouchEnd}>
					<Navbar
						title={currentPageTitle}
						subtitle={`${vaultName} vault`}
						className="top-0 sticky"
						left={
							<Button clear small rounded onClick={() => setNavigationOpen(true)} aria-label="Open navigation">
								<Menu size={24} />
							</Button>
						}
						right={
							<Button clear small rounded onClick={() => navigate("/settings")} aria-label="Settings">
								<Settings size={22} />
							</Button>
						}
					/>
					<main className="app-scroll-content">
						{updateAvailable ? (
							<Card outline header="Vault update available" footer={`Run: sickrat vault update ${vaultName}`}>
								This vault is running {capabilities?.vault.version}. Latest is {latestRelease?.version}.
							</Card>
						) : null}
						{routeContent}
					</main>
					<Panel side="left" opened={navigationOpen} onBackdropClick={() => setNavigationOpen(false)}>
						<Page>
								<Navbar
									title="Sickrat"
									right={
										<Button clear small rounded onClick={() => setNavigationOpen(false)} aria-label="Close navigation">
											<Menu size={24} />
										</Button>
									}
								/>
							<BlockTitle>Navigation</BlockTitle>
							<List strong inset>
								{primaryNavItems.map((item) => {
									const ItemIcon = item.icon;
									const active =
										item.route === "app"
											? route === "app"
											: route === item.route || (item.route === "approvals" && route === "approval-detail");
									return (
										<ListItem
											key={item.route}
											link
											title={item.label}
											after={active ? "Current" : undefined}
											media={<ItemIcon size={22} />}
											onClick={() => {
												setNavigationOpen(false);
												navigate(item.href);
											}}
										/>
									);
								})}
							</List>
						</Page>
					</Panel>
					<Toast
						opened={Boolean(notificationToast)}
						position="center"
						button={
							<Button
								clear
								small
								onClick={() => {
									if (!notificationToast) return;
									const next = notificationToast;
									setNotificationToast(null);
									routeNotification(next);
								}}
							>
								Open
							</Button>
						}
					>
						{notificationToast ? `${notificationToast.title}: ${notificationToast.body}` : ""}
					</Toast>
				</div>
			</Page>
		);
	}

}

function App() {
	useSystemColorScheme();
	useTouchBoundaryGuard();

	return (
		<KonstaApp theme="ios" safeAreas>
			<InstalledPwaGate>
				<PwaUpdatePrompt />
				<Routes>
					<Route path="/" element={<AppShell route="app" />} />
					<Route path="/login" element={<AppShell route="login" />} />
					<Route path="/vaults" element={<AppShell route="vaults" />} />
					<Route path="/secrets" element={<AppShell route="secrets" />} />
					<Route path="/approvals" element={<AppShell route="approvals" />} />
					<Route path="/approvals/:requestId" element={<ApprovalDetailRoute />} />
					<Route path="/devices" element={<AppShell route="devices" />} />
					<Route path="/settings" element={<AppShell route="settings" />} />
					<Route path="/cf/callback" element={<AppShell route="settings" isCloudflareCallback />} />
					<Route path="/approve/:requestId" element={<ApprovalRoute />} />
					<Route path="/app" element={<Navigate to="/" replace />} />
					<Route path="/app/vaults" element={<Navigate to="/vaults" replace />} />
					<Route path="/app/secrets" element={<Navigate to="/secrets" replace />} />
					<Route path="/app/approvals" element={<Navigate to="/approvals" replace />} />
					<Route path="/app/approvals/:requestId" element={<ApprovalDetailRoute />} />
					<Route path="/app/devices" element={<Navigate to="/devices" replace />} />
					<Route path="/app/settings" element={<Navigate to="/settings" replace />} />
					<Route path="/pair" element={<Navigate to="/devices" replace />} />
					<Route path="*" element={<Navigate to="/" replace />} />
				</Routes>
			</InstalledPwaGate>
		</KonstaApp>
	);
}

createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</React.StrictMode>,
);
