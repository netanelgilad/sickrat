export type OAuthApprovalRequestSummary = {
	providerId: string;
	connectionName?: string;
	scopes: string[];
};

export type OAuthConnectionSummary = {
	providerId: string;
	connectionName: string;
	grantedScopes: string[];
	revokedAt?: string | null;
};

export function matchingOAuthConnections<T extends OAuthConnectionSummary>(request: OAuthApprovalRequestSummary, connections: T[]) {
	return connections.filter(
		(connection) =>
			!connection.revokedAt &&
			connection.providerId === request.providerId &&
			(!request.connectionName || connection.connectionName === request.connectionName) &&
			request.scopes.every((scope) => connection.grantedScopes.includes(scope)),
	);
}

export function matchingOAuthConnection<T extends OAuthConnectionSummary>(request: OAuthApprovalRequestSummary, connections: T[]) {
	const matches = matchingOAuthConnections(request, connections);
	return request.connectionName ? matches[0] : matches.length === 1 ? matches[0] : undefined;
}

export function describeOAuthApprovalBlocker(request: OAuthApprovalRequestSummary, connections: OAuthConnectionSummary[]) {
	if (matchingOAuthConnection(request, connections)) return null;

	const candidates = connections.filter(
		(connection) =>
			!connection.revokedAt &&
			connection.providerId === request.providerId &&
			(!request.connectionName || connection.connectionName === request.connectionName),
	);
	const eligible = matchingOAuthConnections(request, connections);
	if (!request.connectionName && eligible.length > 1) {
		return `Multiple ${request.providerId} connections have the requested scopes. The command must request one by name.`;
	}
	if (candidates.length === 0) {
		return `No active ${request.providerId}${request.connectionName ? ` connection named ${request.connectionName}` : " connection"} is available. Connect it before approving.`;
	}

	const missingScopes = [...new Set(candidates.flatMap((connection) => request.scopes.filter((scope) => !connection.grantedScopes.includes(scope))))];
	return `${request.providerId}${request.connectionName ? `/${request.connectionName}` : ""} is missing required OAuth scopes: ${missingScopes.join(", ")}. Reauthorize the connection and confirm the OAuth client permits these exact scope IDs.`;
}
