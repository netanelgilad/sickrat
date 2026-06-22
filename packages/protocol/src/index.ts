export type PairingCodeRequest = {
	label: string;
	publicKey: JsonWebKey;
};

export type PairingCodeResponse = {
	code: string;
	deviceId: string;
	expiresAt: string;
};

export type PairingCodeStatusResponse = {
	status: "pending" | "approved" | "expired";
	deviceId: string;
	workerUrl: string;
};

export type ApprovalRequestCreate = {
	deviceId: string;
	command: string;
	message?: string;
	secretRefs: string[];
	accessDurationSeconds?: number;
	approvalWaitSeconds?: number;
	ephemeralPublicKey: JsonWebKey;
	timestamp: string;
	nonce: string;
	signature: string;
};

export type GrantPayload = {
	secrets: Record<string, string>;
	approvedAt: string;
	accessExpiresAt?: string;
};

export type EncryptedGrant = {
	ephemeralPublicKey: JsonWebKey;
	iv: string;
	ciphertext: string;
	alg: "ECDH-P256-HKDF-SHA256-AES-256-GCM:v1";
};

export function canonicalApprovalPayload(input: Omit<ApprovalRequestCreate, "signature">) {
	return JSON.stringify({
		deviceId: input.deviceId,
		command: input.command,
		message: input.message,
		secretRefs: input.secretRefs,
		accessDurationSeconds: input.accessDurationSeconds,
		approvalWaitSeconds: input.approvalWaitSeconds,
		ephemeralPublicKey: input.ephemeralPublicKey,
		timestamp: input.timestamp,
		nonce: input.nonce,
	});
}
