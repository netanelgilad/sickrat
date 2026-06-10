import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from "react-router-dom";
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
	};
	ios: {
		requiresHomeScreenInstall: boolean;
	};
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
	status: "pending" | "approved" | "denied";
	createdAt: string;
	decidedAt: string | null;
	ephemeralPublicKey: JsonWebKey | null;
	grantReadyAt: string | null;
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
		if (!response.ok) throw new Error(await response.text());
		return response.json();
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
	async sendGrant(id: string, grantCiphertext: unknown) {
		const response = await fetch(`/api/approvals/${encodeURIComponent(id)}/grant`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ grantCiphertext }),
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

async function sha256Base64Url(value: string) {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return bytesToBase64Url(new Uint8Array(digest));
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

async function encryptGrantForCli(payload: { secrets: Record<string, string>; approvedAt: string }, cliPublicKey: JsonWebKey) {
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
			<div className="install-card installed">
				<strong>Installed</strong>
				<span>Sickrat is running from the home screen.</span>
			</div>
		);
	}

	if (promptEvent) {
		return (
			<div className="install-card">
				<div>
					<strong>Install Sickrat</strong>
					<span>Use the installed PWA for phone approvals and foreground navigation.</span>
				</div>
				<button type="button" onClick={install}>
					Install
				</button>
				{installStatus ? <span className="mini-status">{installStatus}</span> : null}
			</div>
		);
	}

	if (ios) {
		return (
			<div className="install-card">
				<strong>{iosSafari ? "Add to Home Screen" : "Open in Safari"}</strong>
				<span>
					{iosSafari
						? "Tap Share, then Add to Home Screen. Open Sickrat from the new icon to enable phone approvals."
						: "iOS installs web apps from Safari. Open this vault URL in Safari, then use Share -> Add to Home Screen."}
				</span>
			</div>
		);
	}

	return (
		<div className="install-card">
			<strong>Browser session</strong>
			<span>If your browser supports install prompts, the install button will appear here.</span>
		</div>
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
		<main className="install-gate" aria-labelledby="install-gate-title">
			<section className="install-gate-panel">
				<div className="brand-lockup install-gate-brand">
					<span className="brand-mark" aria-hidden="true">
						<span className="mark-core">SR</span>
					</span>
					<span>Sickrat</span>
				</div>
				<div className="install-gate-copy">
					<p className="eyebrow">Home-screen app required</p>
					<h1 id="install-gate-title">Install Sickrat to use this console.</h1>
					<p>
						Phone approvals depend on the installed PWA context so notifications, realtime routing, and the
						vault console all open in the same app container.
					</p>
				</div>
				{promptEvent ? (
					<div className="install-gate-actions">
						<button type="button" onClick={install}>
							Install App
						</button>
						{installStatus ? <span className="mini-status">{installStatus}</span> : null}
					</div>
				) : ios ? (
					<ol className="install-steps" aria-label="Install steps">
						<li>
							<span>01</span>
							<div>
								<strong>Open the share menu</strong>
								<small>
									{iosSafari
										? "Tap the Share button in Safari."
										: "In Chrome on iPhone, tap Share from the browser menu."}
								</small>
							</div>
						</li>
						<li>
							<span>02</span>
							<div>
								<strong>Add to Home Screen</strong>
								<small>Choose Add to Home Screen from the iOS share sheet.</small>
							</div>
						</li>
						<li>
							<span>03</span>
							<div>
								<strong>Open Sickrat</strong>
								<small>Launch the new icon, then enable push approvals.</small>
							</div>
						</li>
					</ol>
				) : (
					<div className="install-steps single">
						<div>
							<strong>Use your browser install control</strong>
							<small>Look for Install app in the address bar or browser menu, then open Sickrat from the installed app.</small>
						</div>
					</div>
				)}
				<div className="install-gate-footer">
					<button type="button" className="secondary" onClick={copyUrl}>
						{copied ? "Copied" : "Copy URL"}
					</button>
					<a className="button-link secondary-link" href="https://sickrat.dev">
						Back To Site
					</a>
				</div>
			</section>
		</main>
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
		<div className="update-bar" role="status">
			<span>{updating ? "Updating..." : "Update available"}</span>
			<div>
				{needRefresh ? (
					<button disabled={updating} onClick={reloadApp}>
						{updating ? "Reloading" : "Reload"}
					</button>
				) : null}
				<button
					disabled={updating}
					onClick={() => {
						setOfflineReady(false);
						setNeedRefresh(false);
					}}
				>
					Dismiss
				</button>
			</div>
		</div>
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
	const [status, setStatus] = useState("Loading Cloudflare Worker capabilities...");
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
	const [pairingCode, setPairingCode] = useState("");
	const [pairing, setPairing] = useState<PairingCodeDetails | null>(null);
	const [pairingStatus, setPairingStatus] = useState("Enter the six-digit code shown by the CLI.");
	const [pushSubscriptionChecked, setPushSubscriptionChecked] = useState(false);
	const [cloudflareConfig, setCloudflareConfig] = useState<CloudflareOAuthConfig | null>(null);
	const [cloudflareToken, setCloudflareToken] = useState<string | null>(() => localStorage.getItem("sickrat.cf.accessToken"));
	const [cloudflareAccounts, setCloudflareAccounts] = useState<CloudflareAccount[]>([]);
	const [selectedAccountId, setSelectedAccountId] = useState("");
	const [provisioning, setProvisioning] = useState<CloudflareProvisioning | null>(null);
	const [cloudflareStatus, setCloudflareStatus] = useState(
		cloudflareToken ? "Cloudflare session found in this browser." : "Cloudflare login is not connected.",
	);
	const [busy, setBusy] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);

	const installed = useMemo(isStandalone, []);
	const vaultKeyState = vaultKey ? "Unlocked" : getPasskeyVaultRecord() ? "Locked" : "No key";
	const pushState = subscription ? "Enabled" : capabilities?.push.configured ? "Ready" : "Offline";
	const cloudflareState = capabilities?.vault.deployedBy === "sickrat-cli" ? "CLI provisioned" : cloudflareToken ? "Connected" : "Standalone";
	const vaultName = capabilities?.vault.name ?? "default";
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

	async function refreshSecrets() {
		try {
			setSecrets(await api.listSecrets());
		} catch (error) {
			setSecretStatus(error instanceof Error ? error.message : "Failed to load secrets.");
		}
	}

	async function refreshApprovals(status: ApprovalRequest["status"] | "all" = approvalFilter) {
		try {
			setApprovals(await api.listApprovals(status));
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Failed to load approvals.");
		}
	}

	async function refreshDevices() {
		try {
			setDevices(await api.listDevices());
		} catch (error) {
			setPairingStatus(error instanceof Error ? error.message : "Failed to load paired devices.");
		}
	}

	function routeNotification(notification: Pick<PendingNotification, "url">) {
		const target = new URL(notification.url, window.location.origin);
		if (target.origin === window.location.origin) navigate(`${target.pathname}${target.search}${target.hash}`);
	}

	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		const handleMessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; url?: string };
			if (data.type === "SICKRAT_NAVIGATE" && data.url) {
				routeNotification({ url: data.url });
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
				setStatus(next.push.configured ? "Push backend is configured." : "Add VAPID keys to enable remote push.");
			})
			.catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Failed to load capabilities."));
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
		if (!route.startsWith("approval")) void refreshApprovals(approvalFilter);
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
		setPairingStatus("Pairing request opened. Type the six-digit code shown by the CLI to verify this device.");
		navigate("/devices", { replace: true });
	}, [navigate, route]);

	useEffect(() => {
		api
			.getCloudflareOAuthConfig()
			.then((config) => {
				setCloudflareConfig(config);
				if (!config.clientId) setCloudflareStatus("Cloudflare control-plane login is handled by the Sickrat CLI.");
			})
			.catch(() => setCloudflareStatus("Cloudflare control-plane login is handled by the Sickrat CLI."));
	}, []);

	useEffect(() => {
		if (!isCloudflareCallback || !cloudflareConfig) return;
		const params = new URLSearchParams(window.location.search);
		const error = params.get("error");
		if (error) {
			setCloudflareStatus(params.get("error_description") ?? error);
			return;
		}
		const code = params.get("code");
		const state = params.get("state");
		const expectedState = sessionStorage.getItem("sickrat.cf.state");
		const codeVerifier = sessionStorage.getItem("sickrat.cf.codeVerifier");
		if (!code || !state || state !== expectedState || !codeVerifier || !cloudflareConfig.clientId) {
			setCloudflareStatus("Cloudflare login callback is missing a valid code, state, or PKCE verifier.");
			return;
		}

		setBusy(true);
		setCloudflareStatus("Completing Cloudflare login...");
		api
			.exchangeCloudflareCode(code, codeVerifier, cloudflareConfig.redirectUri)
			.then((accessToken) => {
				const redirectTo = sessionStorage.getItem("sickrat.cf.redirectTo") || "/";
				localStorage.setItem("sickrat.cf.accessToken", accessToken);
				sessionStorage.removeItem("sickrat.cf.state");
				sessionStorage.removeItem("sickrat.cf.codeVerifier");
				sessionStorage.removeItem("sickrat.cf.redirectTo");
				setCloudflareToken(accessToken);
				setCloudflareStatus("Cloudflare login complete. Loading accounts...");
				navigate(redirectTo, { replace: true });
			})
			.catch((error: unknown) =>
				setCloudflareStatus(error instanceof Error ? error.message : "Cloudflare login failed."),
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
				setCloudflareStatus(accounts.length > 0 ? "Cloudflare login complete. Select an account to create a vault." : "Cloudflare login complete, but no accounts were returned.");
			})
			.catch((error: unknown) => {
				localStorage.removeItem("sickrat.cf.accessToken");
				setCloudflareToken(null);
				setCloudflareAccounts([]);
				setSelectedAccountId("");
				setCloudflareStatus(error instanceof Error ? `Cloudflare session expired: ${error.message}` : "Cloudflare session expired.");
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
			.then((registration) => registration.pushManager.getSubscription())
			.then((existing) => {
				if (!existing) return;
				return api.saveSubscription(existing.toJSON());
			})
			.then((saved) => {
				if (!saved) return;
				setSubscription(saved);
				setStatus("Push is already enabled on this device.");
			})
			.catch((error: unknown) => {
				setStatus(error instanceof Error ? error.message : "Failed to sync existing push subscription.");
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
			.catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Failed to load request."));
	}, [requestId]);

	useEffect(() => {
		if (requestId || !subscription?.endpoint) return;

		let checking = false;
		const routeToPendingNotification = async () => {
			if (checking || document.visibilityState !== "visible") return;
			checking = true;
			try {
				const latest = await api.getLatestNotification(subscription.endpoint);
				if (latest) routeNotification(latest);
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
					const message = JSON.parse(event.data) as { type?: string; url?: string };
					if ((message.type === "approval.requested" || message.type === "pairing.requested") && message.url) routeNotification({ url: message.url });
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

	useEffect(() => {
		if (!sidebarOpen) return;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = previousOverflow;
		};
	}, [sidebarOpen]);

	async function enablePush() {
		if (!capabilities?.push.vapidPublicKey) {
			setStatus("VAPID keys are missing. Run `npm run vapid` and set Worker secrets.");
			return;
		}
		if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
			setStatus("This browser does not expose Service Worker PushManager.");
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
			const existing = await registration.pushManager.getSubscription();
			const nextSubscription =
				existing ??
				(await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: base64UrlToUint8Array(capabilities.push.vapidPublicKey),
				}));

			const saved = await api.saveSubscription(nextSubscription.toJSON());
			setSubscription(saved);
			setStatus("Push subscription saved in Cloudflare D1.");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Push subscription failed.");
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
			setStatus(error instanceof Error ? error.message : "Test push failed.");
		} finally {
			setBusy(false);
		}
	}

	async function loginWithCloudflare(redirectTo = "/") {
		if (!cloudflareConfig?.clientId) {
			setCloudflareStatus("Cloudflare OAuth client is not configured on this Worker.");
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
		setCloudflareStatus("Redirecting to Cloudflare...");
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
		setCloudflareStatus("Cloudflare session cleared from this browser.");
		navigate("/", { replace: true });
	}

	async function provisionSelectedAccount() {
		if (!cloudflareToken) {
			setCloudflareStatus("Log in with Cloudflare first.");
			return;
		}
		if (!selectedAccountId) {
			setCloudflareStatus("Select a Cloudflare account first.");
			return;
		}

		setBusy(true);
		setProvisioning({
			ok: false,
			accountId: selectedAccountId,
			steps: [
				{ id: "d1", label: "D1 database", status: "pending", detail: "Creating or finding sickrat-vault..." },
				{ id: "secrets-store", label: "Secrets Store", status: "pending", detail: "Creating or finding sickrat..." },
			],
			resources: {},
			next: "",
		});
		setCloudflareStatus("Creating account-owned Sickrat vault resources...");
		try {
			const result = await api.provisionCloudflare(cloudflareToken, selectedAccountId);
			setProvisioning(result);
			setCloudflareStatus(
				result.ok
					? "Created or found all account-owned vault resources."
					: "Vault resource creation completed with errors. See step details below.",
			);
		} catch (error) {
			setCloudflareStatus(error instanceof Error ? error.message : "Cloudflare vault creation failed.");
		} finally {
			setBusy(false);
		}
	}

	async function decide(action: "approve" | "deny") {
		if (!approval) return;
		setBusy(true);
		try {
			if (action === "approve" && approval.ephemeralPublicKey) {
				let key = vaultKey;
				if (!key) {
					if (getPasskeyVaultRecord()) {
						setStatus("Unlocking vault with passkey...");
						key = await unlockPasskeyVaultKey();
					} else {
						setStatus("Creating a passkey-protected vault key...");
						key = await createPasskeyWrappedVaultKey();
					}
					if (!key) throw new Error("Unlock or create the vault key before approving this CLI request.");
					setVaultKey(key);
				}
				if (missingApprovalRefs.length > 0) {
					for (const ref of missingApprovalRefs) {
						const value = approvalSecretValues[ref] ?? "";
						if (!value) throw new Error(`Enter a value for ${ref} before approving.`);
					}
					setStatus("Encrypting new secrets locally...");
					const savedSecrets: SecretMetadata[] = [];
					for (const ref of missingApprovalRefs) {
						const encrypted = await encryptSecretValue(approvalSecretValues[ref], key);
						const saved = await api.saveSecret({
							ref,
							label: ref,
							...encrypted,
						});
						savedSecrets.push(saved);
					}
					setSecrets((current) => [
						...savedSecrets,
						...current.filter((secret) => !savedSecrets.some((saved) => saved.ref === secret.ref)),
					]);
					setApprovalSecretValues((current) => {
						const next = { ...current };
						for (const ref of missingApprovalRefs) delete next[ref];
						return next;
					});
				}
				setStatus("Loading encrypted secrets from Cloudflare...");
				const encryptedSecrets = await api.resolveSecrets(approval.secretRefs);
				const plaintextSecrets: Record<string, string> = {};
				for (const secret of encryptedSecrets) {
					plaintextSecrets[secret.ref] = await decryptSecretValue(secret, key);
				}
				setStatus("Encrypting ephemeral grant for the CLI...");
				const grant = await encryptGrantForCli(
					{ secrets: plaintextSecrets, approvedAt: new Date().toISOString() },
					approval.ephemeralPublicKey,
				);
				await api.sendGrant(approval.id, grant);
			} else {
				await api.decideApproval(approval.id, action);
			}
			const next = await api.getApproval(approval.id);
			setApproval(next);
			await refreshApprovals(approvalFilter);
			setStatus(action === "approve" ? "Approved. The CLI can now decrypt its ephemeral grant." : "Denied. The request is closed.");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Decision failed.");
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
			setPairingStatus(error instanceof Error ? error.message : "Failed to load pairing code.");
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
			setPairingStatus(error instanceof Error ? error.message : "Failed to approve pairing.");
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
			setSecretStatus(error instanceof Error ? error.message : "Failed to create passkey-protected vault key.");
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
			setSecretStatus(error instanceof Error ? error.message : "Failed to unlock vault.");
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
			setSecretStatus("Uploading ciphertext to Cloudflare D1...");
			const saved = await api.saveSecret({
				ref: secretForm.ref,
				label: secretForm.label || secretForm.ref,
				...encrypted,
			});
			setSecrets((current) => [saved, ...current.filter((secret) => secret.ref !== saved.ref)]);
			setSecretForm({ label: "", ref: "", value: "" });
			setSecretStatus("Secret saved. Only encrypted ciphertext was uploaded.");
		} catch (error) {
			setSecretStatus(error instanceof Error ? error.message : "Failed to save secret.");
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
			setPairingStatus(error instanceof Error ? error.message : "Failed to revoke device.");
		} finally {
			setBusy(false);
		}
	}

	if (route === "approval" && requestId) {
		return (
			<main className="approval-screen">
				<Link className="back-link" to="/">
					Back to console
				</Link>
				{approval ? (
					<section className="approval">
						<div className="approval-header">
							<div>
								<p className="eyebrow">Quarantine event</p>
								<h1>Release grant</h1>
							</div>
							<span className={`pill ${approval.status}`}>{approval.status}</span>
						</div>
						<div className="request-meta">
							<div>
								<span>Device</span>
								<strong>{approval.device}</strong>
							</div>
							<div>
								<span>Command</span>
								<strong>{approval.command}</strong>
							</div>
							{approval.message ? (
								<div>
									<span>Message</span>
									<strong>{approval.message}</strong>
								</div>
							) : null}
							<div>
								<span>Created</span>
								<strong>{new Date(approval.createdAt).toLocaleString()}</strong>
							</div>
							<div>
								<span>Grant TTL</span>
								<strong>{approval.grantReadyAt ? "Grant sealed for CLI retrieval" : "Short-lived grant minted only after approval"}</strong>
							</div>
						</div>
						<ul className="secret-list">
							{approval.secretRefs.map((ref) => (
								<li className={missingApprovalRefs.includes(ref) ? "missing" : undefined} key={ref}>
									<strong>{ref}</strong>
									<span>{missingApprovalRefs.includes(ref) ? "Not in vault yet" : "Stored in vault"}</span>
								</li>
							))}
						</ul>
						{missingApprovalRefs.length > 0 ? (
							<div className="missing-secret-panel">
								<h2>Create missing secrets</h2>
								<p>
									The agent requested references that are not in this vault yet. Enter the values here to
									encrypt and save them, then this same approval will continue.
								</p>
								<div className="vault-panel">
									<div>
										<strong>
											{vaultKey
												? "Vault unlocked"
												: getPasskeyVaultRecord()
													? "Vault locked"
													: "No passkey vault on this device"}
										</strong>
										<span>
											{vaultKey
												? "New values will be encrypted before upload."
												: getPasskeyVaultRecord()
													? "Approving will ask you to unlock with your passkey."
													: "Approving will first create a passkey-protected vault key."}
										</span>
									</div>
								</div>
								<div className="secret-form">
									{missingApprovalRefs.map((ref) => (
										<label key={ref}>
											{ref}
											<textarea
												autoCapitalize="none"
												autoComplete="off"
												value={approvalSecretValues[ref] ?? ""}
												onChange={(event) =>
													setApprovalSecretValues((current) => ({ ...current, [ref]: event.target.value }))
												}
												placeholder="Paste value to save and approve"
												rows={3}
											/>
										</label>
									))}
								</div>
							</div>
						) : null}
						<div className="decision-row">
							<button disabled={busy || approval.status !== "pending"} onClick={() => decide("deny")} className="deny">
								Deny
							</button>
							<button disabled={busy || approval.status !== "pending"} onClick={() => decide("approve")}>
								Approve
							</button>
						</div>
						<p className="screen-status">{status}</p>
					</section>
				) : (
					<section className="approval loading">
						<h1>Loading request</h1>
						<p>{status}</p>
					</section>
				)}
			</main>
		);
	}

	if (isCloudflareCallback && !cloudflareToken) {
		return (
			<main className="auth-page">
				<section className="auth-card">
					<Link className="brand-lockup" to="/">
						<span className="brand-mark" aria-hidden="true">
							<span className="mark-core">SR</span>
						</span>
						<span>Sickrat</span>
					</Link>
					<div>
						<p className="eyebrow">Cloudflare callback</p>
						<h1>Completing login</h1>
						<p>Finishing the OAuth exchange and returning you to the console.</p>
					</div>
					<p className="screen-status">{cloudflareStatus}</p>
				</section>
			</main>
		);
	}

	if (route === "login") {
		return (
			<main className="auth-page">
				<section className="auth-card">
					<Link className="brand-lockup" to="/">
						<span className="brand-mark" aria-hidden="true">
							<span className="mark-core">SR</span>
						</span>
						<span>Sickrat</span>
					</Link>
					<div>
						<p className="eyebrow">CLI provisioned</p>
						<h1>Open your vault console</h1>
						<p>This vault is owned by the Cloudflare account that deployed it with the Sickrat CLI.</p>
					</div>
					<div className="actions">
						<Link className="button-link" to="/">Open Console</Link>
						<a className="button-link secondary-link" href="https://sickrat.dev">
							Back Home
						</a>
					</div>
					<p className="screen-status">Cloudflare login and vault creation now happen in the CLI.</p>
				</section>
			</main>
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
			<main className="auth-page">
				<section className="auth-card">
					<Link className="brand-lockup" to="/">
						<span className="brand-mark" aria-hidden="true">
							<span className="mark-core">SR</span>
						</span>
						<span>Sickrat</span>
					</Link>
					<div>
						<p className="eyebrow">First launch</p>
						<h1>Enable push approvals.</h1>
						<p>
							Sickrat uses push notifications for pairing requests and agent approval prompts. Enable
							push on this installed app before pairing an agent machine.
						</p>
					</div>
					<div className="actions">
						<button disabled={busy} onClick={enablePush}>
							{busy ? "Enabling" : "Enable Push"}
						</button>
						<a className="button-link secondary-link" href="https://sickrat.dev/skills/sickrat.md">
							Agent Skill
						</a>
					</div>
					<p className="screen-status">{status}</p>
				</section>
			</main>
		);
	}

	{
		const renderCloudflareControls = () => (
			<section className="console app-panel cloudflare-panel">
				<div>
					<h2>CLI Control Plane</h2>
					<p>This vault was deployed by `sickrat vault create`. Cloudflare account access stays in the CLI; this PWA manages secrets, devices, and approvals for the deployed vault.</p>
					<div className="request-meta">
						<div>
							<span>Vault</span>
							<strong>{capabilities?.vault.name ?? "default"}</strong>
						</div>
						<div>
							<span>Origin</span>
							<strong>{window.location.origin}</strong>
						</div>
						<div>
							<span>D1</span>
							<strong>{capabilities?.database.configured ? "Configured" : "Missing binding"}</strong>
						</div>
					</div>
				</div>
				<div className="actions">
					<a className="button-link secondary-link" href="https://sickrat.dev/skills/sickrat.md">
						Agent Skill
					</a>
				</div>
			</section>
		);

		const renderVaultKeyPanel = () => (
			<section className="console app-panel">
				<div>
					<h2>Vault Key</h2>
					<p>{secretStatus}</p>
					<div className="vault-panel">
						<div>
							<strong>{vaultKey ? "Vault unlocked" : getPasskeyVaultRecord() ? "Vault locked" : "No passkey vault on this device"}</strong>
							<span>
								{vaultKey
									? "This browser can encrypt new refs until the app reloads."
									: getPasskeyVaultRecord()
										? "Unlock with your platform passkey to add secrets."
										: "Create a passkey-protected vault key before adding secrets."}
							</span>
						</div>
					</div>
				</div>
				<div className="actions">
					{vaultKey ? (
						<button className="secondary" type="button" disabled={busy} onClick={resetVaultKey}>
							Reset Key
						</button>
					) : getPasskeyVaultRecord() ? (
						<button type="button" disabled={busy} onClick={unlockVaultKey}>
							Unlock
						</button>
					) : (
						<button type="button" disabled={busy} onClick={setupVaultKey}>
							Create Passkey
						</button>
					)}
				</div>
			</section>
		);

		const renderSecretForm = () => (
			<form className="secret-form" onSubmit={saveSecret}>
				<label>
					Label
					<input
						autoComplete="off"
						value={secretForm.label}
						onChange={(event) => setSecretForm((current) => ({ ...current, label: event.target.value }))}
						placeholder="OpenAI API key"
					/>
				</label>
				<label>
					Reference
					<input
						autoCapitalize="none"
						autoComplete="off"
						value={secretForm.ref}
						onChange={(event) => setSecretForm((current) => ({ ...current, ref: event.target.value }))}
						placeholder="openai/api-key or prod/database/url"
					/>
				</label>
				<label>
					Secret value
					<textarea
						autoCapitalize="none"
						autoComplete="off"
						value={secretForm.value}
						onChange={(event) => setSecretForm((current) => ({ ...current, value: event.target.value }))}
						placeholder="Paste secret value"
						rows={4}
					/>
				</label>
				<button disabled={busy || !vaultKey}>{busy ? "Saving" : "Encrypt And Save"}</button>
			</form>
		);

		const renderPairForm = () => (
			<>
				<form className="secret-form" onSubmit={loadPairingCode}>
					<label>
						Pairing code
						<input
							inputMode="numeric"
							autoComplete="one-time-code"
							value={pairingCode}
							onChange={(event) => setPairingCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
							placeholder="482913"
						/>
					</label>
					<button disabled={busy}>{busy ? "Loading" : "Load Device"}</button>
				</form>
				{pairing ? (
					<div className="pairing-card">
						<div className="request-meta">
							<div>
								<span>Device</span>
								<strong>{pairing.label}</strong>
							</div>
							<div>
								<span>Device ID</span>
								<strong>{pairing.deviceId}</strong>
							</div>
							<div>
								<span>Expires</span>
								<strong>{new Date(pairing.expiresAt).toLocaleString()}</strong>
							</div>
						</div>
						<div className="decision-row">
							<button className="secondary" type="button" onClick={() => setPairing(null)}>
								Cancel
							</button>
							<button disabled={busy || pairing.expired || Boolean(pairing.approvedAt)} onClick={approvePairing}>
								{pairing.approvedAt ? "Paired" : "Approve Device"}
							</button>
						</div>
					</div>
				) : null}
				<p className="screen-status">{pairingStatus}</p>
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
			routeContent = (
				<>
					<section className="app-command">
						<div>
							<p className="eyebrow">Owner console</p>
							<h1>Dashboard</h1>
							<p className="lede">
								Manage encrypted refs, admitted devices, phone approvals, and account-owned Cloudflare
								resources from one owner console.
							</p>
						</div>
						<div className="app-status-board" aria-label="Console status">
							<div>
								<span>Account</span>
								<strong>{cloudflareState}</strong>
							</div>
							<div>
								<span>Push</span>
								<strong>{pushState}</strong>
							</div>
							<div>
								<span>Vault Key</span>
								<strong>{vaultKeyState}</strong>
							</div>
						</div>
					</section>
					<section className="dashboard-grid">
						<Link className="dashboard-card" to="/vaults">
							<span>Vault</span>
							<strong>{vaultName}</strong>
							<small>{capabilities?.database.configured ? "D1 binding configured" : "D1 binding missing"}</small>
						</Link>
						<Link className="dashboard-card" to="/secrets">
							<span>Secrets</span>
							<strong>{secrets.length}</strong>
							<small>Encrypted refs stored in D1</small>
						</Link>
						<Link className="dashboard-card" to="/approvals">
							<span>Pending approvals</span>
							<strong>{pendingApprovals.length}</strong>
							<small>Approve a grant, not a permanent credential</small>
						</Link>
						<Link className="dashboard-card" to="/devices">
							<span>Active devices</span>
							<strong>{activeDevices.length}</strong>
							<small>Paired CLIs that can request access</small>
						</Link>
					</section>
					<section className="app-grid">
						{renderVaultKeyPanel()}
						<section className="console app-panel">
							<div>
								<h2>Push Approvals</h2>
								<p>{status}</p>
							</div>
							<div className="actions">
								<button disabled={busy || Boolean(subscription)} onClick={enablePush}>
									{subscription ? "Push Enabled" : "Enable Push"}
								</button>
								<button disabled={busy || !subscription} onClick={sendTest}>
									Send Test
								</button>
							</div>
						</section>
						<section className="console app-panel">
							<div>
								<h2>Install Health</h2>
								<InstallPrompt />
							</div>
						</section>
					</section>
				</>
			);
		} else if (route === "vaults") {
			routeContent = (
				<section className="route-panel">
					<div className="route-heading">
						<p className="eyebrow">User-owned deployment</p>
						<h1>Vaults</h1>
						<p>Vaults are isolated Sickrat deployments created by the CLI in your Cloudflare account.</p>
					</div>
					<div className="app-grid">
						<section className="console app-panel">
							<div>
								<h2>Current Vault</h2>
								<div className="request-meta">
									<div>
										<span>Name</span>
										<strong>{vaultName}</strong>
									</div>
									<div>
										<span>Origin</span>
										<strong>{window.location.origin}</strong>
									</div>
									<div>
										<span>D1</span>
										<strong>{capabilities?.database.configured ? "Configured" : "Missing binding"}</strong>
									</div>
									<div>
										<span>Realtime</span>
										<strong>Durable Object channel configured by Worker binding</strong>
									</div>
								</div>
							</div>
						</section>
						{renderCloudflareControls()}
					</div>
				</section>
			);
		} else if (route === "secrets") {
			routeContent = (
				<section className="route-panel">
					<div className="route-heading">
						<p className="eyebrow">Encrypted references</p>
						<h1>Secrets</h1>
						<p>Values are encrypted locally before upload. Agents can request missing refs and you can create them at approval time.</p>
					</div>
					<div className="app-grid">
						{renderVaultKeyPanel()}
						<section className="console app-panel">
							<div>
								<h2>Add Or Update Ref</h2>
								{renderSecretForm()}
								<p className="screen-status">{secretStatus}</p>
							</div>
						</section>
						<section className="console app-panel stored-refs-panel">
							<div>
								<h2>Stored References</h2>
								<label className="select-label">
									Search
									<input
										autoCapitalize="none"
										autoComplete="off"
										value={secretQuery}
										onChange={(event) => setSecretQuery(event.target.value)}
										placeholder="Filter refs"
									/>
								</label>
								{filteredSecrets.length > 0 ? (
									<ul className="secret-list">
										{filteredSecrets.map((secret) => (
											<li key={secret.id}>
												<strong>{secret.label}</strong>
												<span>{secret.ref}</span>
											</li>
										))}
									</ul>
								) : (
									<p className="screen-status">No matching encrypted refs.</p>
								)}
							</div>
						</section>
					</div>
				</section>
			);
		} else if (route === "approvals") {
			routeContent = (
				<section className="route-panel">
					<div className="route-heading">
						<p className="eyebrow">Grant history</p>
						<h1>Approvals</h1>
						<p>Review pending and decided requests from paired devices.</p>
					</div>
					<div className="segmented-control">
						{(["pending", "approved", "denied", "all"] as const).map((statusOption) => (
							<button
								className={approvalFilter === statusOption ? "active" : "secondary"}
								key={statusOption}
								type="button"
								onClick={() => setApprovalFilter(statusOption)}
							>
								{statusOption}
							</button>
						))}
					</div>
					<ul className="approval-list">
						{approvals.map((item) => (
							<li key={item.id}>
								<Link to={`/approvals/${encodeURIComponent(item.id)}`}>
									<span className={`pill ${item.status}`}>{item.status}</span>
									<strong>{item.command}</strong>
									<small>{item.message ?? `${item.secretRefs.length} refs requested`}</small>
									<time>{new Date(item.createdAt).toLocaleString()}</time>
								</Link>
							</li>
						))}
					</ul>
					{approvals.length === 0 ? <p className="screen-status">No approvals in this view.</p> : null}
				</section>
			);
		} else if (route === "approval-detail") {
			routeContent = (
				<section className="route-panel">
					<div className="route-heading">
						<p className="eyebrow">Approval event</p>
						<h1>Request detail</h1>
						<p>Inspect the command, device, message, and requested refs.</p>
					</div>
					{approval ? (
						<section className="console app-panel">
							<div>
								<div className="approval-header compact">
									<h2>{approval.device}</h2>
									<span className={`pill ${approval.status}`}>{approval.status}</span>
								</div>
								<div className="request-meta">
									<div>
										<span>Command</span>
										<strong>{approval.command}</strong>
									</div>
									{approval.message ? (
										<div>
											<span>Message</span>
											<strong>{approval.message}</strong>
										</div>
									) : null}
									<div>
										<span>Created</span>
										<strong>{new Date(approval.createdAt).toLocaleString()}</strong>
									</div>
									<div>
										<span>Decided</span>
										<strong>{approval.decidedAt ? new Date(approval.decidedAt).toLocaleString() : "Pending"}</strong>
									</div>
								</div>
								<ul className="secret-list">
									{approval.secretRefs.map((ref) => (
										<li key={ref}>
											<strong>{ref}</strong>
											<span>Requested ref</span>
										</li>
									))}
								</ul>
							</div>
							<div className="actions">
								{approval.status === "pending" ? (
									<Link className="button-link" to={`/approve/${encodeURIComponent(approval.id)}`}>
										Open Approval
									</Link>
								) : null}
								<Link className="button-link secondary-link" to="/approvals">
									Back To Approvals
								</Link>
							</div>
						</section>
					) : (
						<p className="screen-status">{status}</p>
					)}
				</section>
			);
		} else if (route === "devices") {
			routeContent = (
				<section className="route-panel">
					<div className="route-heading">
						<p className="eyebrow">Device admission</p>
						<h1>Devices</h1>
						<p>Pair CLIs that can request grants. Revoked devices cannot request new approvals.</p>
					</div>
					<div className="app-grid">
						<section className="console app-panel">
							<div>
								<h2>Pair CLI</h2>
								<p>Run <code>sickrat pair {window.location.origin}</code>, then enter the six-digit code here.</p>
								{renderPairForm()}
							</div>
						</section>
						<section className="console app-panel stored-refs-panel">
							<div>
								<h2>Paired Devices</h2>
								{devices.length > 0 ? (
									<ul className="device-list">
										{devices.map((device) => (
											<li key={device.id}>
												<div>
													<strong>{device.label}</strong>
													<span>{device.id}</span>
													<small>{device.revokedAt ? `Revoked ${new Date(device.revokedAt).toLocaleString()}` : `Paired ${new Date(device.createdAt).toLocaleString()}`}</small>
												</div>
												{device.revokedAt ? <span className="pill denied">revoked</span> : <button className="secondary" disabled={busy} onClick={() => revokeDevice(device.id)}>Revoke</button>}
											</li>
										))}
									</ul>
								) : (
									<p className="screen-status">No paired devices yet.</p>
								)}
							</div>
						</section>
					</div>
				</section>
			);
		} else {
			routeContent = (
				<section className="route-panel">
					<div className="route-heading">
						<p className="eyebrow">Console operations</p>
						<h1>Settings</h1>
						<p>Manage install state, push approvals, and the local vault key for this CLI-provisioned vault.</p>
					</div>
					<div className="app-grid">
						{renderCloudflareControls()}
						<section className="console app-panel">
							<div>
								<h2>PWA Install</h2>
								<InstallPrompt />
							</div>
						</section>
						<section className="console app-panel">
							<div>
								<h2>Push Approvals</h2>
								<p>{status}</p>
							</div>
							<div className="actions">
								<button disabled={busy || Boolean(subscription)} onClick={enablePush}>
									{subscription ? "Push Enabled" : "Enable Push"}
								</button>
								<button disabled={busy || !subscription} onClick={sendTest}>
									Send Test
								</button>
							</div>
						</section>
						{renderVaultKeyPanel()}
					</div>
				</section>
			);
		}

		return (
			<main className="app-page">
				<div className="console-shell">
					{sidebarOpen ? (
						<button
							className="sidebar-scrim"
							type="button"
							aria-label="Close console navigation"
							onClick={() => setSidebarOpen(false)}
						/>
					) : null}
					<aside className={`console-sidebar ${sidebarOpen ? "open" : ""}`}>
						<div className="sidebar-head">
							<button
								className="sidebar-close"
								type="button"
								aria-label="Close console navigation"
								onClick={() => setSidebarOpen(false)}
							>
								‹
							</button>
							<Link className="brand-lockup" to="/">
								<span className="brand-mark" aria-hidden="true">
									<span className="mark-core">SR</span>
								</span>
								<span>Sickrat</span>
							</Link>
							<span className="vault-badge">{vaultName} vault</span>
						</div>
						<nav className="sidebar-nav" aria-label="Console">
							<NavLink end to="/" onClick={() => setSidebarOpen(false)}><span aria-hidden="true">DB</span>Dashboard</NavLink>
							<NavLink end to="/vaults" onClick={() => setSidebarOpen(false)}><span aria-hidden="true">VT</span>Vaults</NavLink>
							<NavLink end to="/secrets" onClick={() => setSidebarOpen(false)}><span aria-hidden="true">SK</span>Server Secrets</NavLink>
							<NavLink end to="/approvals" onClick={() => setSidebarOpen(false)}><span aria-hidden="true">GR</span>Approval Grants</NavLink>
							<NavLink end to="/devices" onClick={() => setSidebarOpen(false)}><span aria-hidden="true">MC</span>Machines</NavLink>
							<NavLink end to="/settings" onClick={() => setSidebarOpen(false)}><span aria-hidden="true">ST</span>Account Settings</NavLink>
						</nav>
						<div className="sidebar-footer">
							<a className="sidebar-skill" href="https://sickrat.dev/skills/sickrat.md">Agent skill</a>
							<div className="account-chip">
								<span className="account-avatar">SR</span>
								<div>
									<strong>{vaultName} vault</strong>
									<span>{window.location.host}</span>
								</div>
							</div>
						</div>
					</aside>
					<section className="console-main">
						<header className="console-topbar">
							<button
								className="sidebar-toggle"
								type="button"
								aria-label="Open console navigation"
								aria-expanded={sidebarOpen}
								onClick={() => setSidebarOpen(true)}
							>
								‹
							</button>
							<div className="topbar-title">
								<span>Main menu</span>
								<strong>{currentPageTitle}</strong>
							</div>
						</header>
						{routeContent}
					</section>
				</div>
			</main>
		);
	}

}

function App() {
	return (
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
	);
}

createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</React.StrictMode>,
);
