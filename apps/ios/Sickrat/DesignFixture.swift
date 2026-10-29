import Foundation

extension VaultModel {
  static func appModel() -> VaultModel {
    #if DEBUG
      if DesignFixture.enabled { return DesignFixture.model() }
    #endif
    return VaultModel()
  }
}

#if DEBUG
  // Deterministic, non-sensitive screenshots and UI regression checks. Never
  // compiled into the AltStore Release app and never contacts a real vault.
  @MainActor enum DesignFixture {
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("--design-preview") }
    static var scenario: String {
      ProcessInfo.processInfo.environment["SICKRAT_DESIGN_STATE"] ?? "idle"
    }
    static let provider = Provider(
      id: "google", name: "Google", clientId: "example-client",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      redirectUri: "https://preview.example/oauth/callback/google",
      identityScopes: ["openid"], connectionScopes: ["offline_access"],
      scopes: [
        Provider.Scope(
          id: "openid", label: "Account identity", description: "Verify your account", risk: "low"),
        Provider.Scope(
          id: "drive.readonly", label: "Read Drive files",
          description: "View files in your Google Drive", risk: "sensitive"),
      ])
    static func model() -> VaultModel {
      let model = VaultModel()
      model.endpoint = "https://preview.example"
      if scenario == "initial" {
        model.refreshing = true
        return model
      }
      model.lastRefresh = Date()
      if scenario == "oauth" {
        model.connections = [
          Connection(
            id: "google-personal", providerId: "google", connectionName: "personal",
            accountLabel: "alex@example.com", accountSubject: "subject-1",
            grantedScopes: ["openid"], revokedAt: nil)
        ]
        model.approvals = [
          Approval(
            id: "oauth-request", device: "Research agent", command: "Read project files",
            message: "Summarize the project notes", secretRefs: [],
            resourceRequests: [
              Approval.Resource(
                type: "oauth_token", ref: nil, providerId: "google", connectionName: "personal",
                scopes: ["drive.readonly"], env: "GOOGLE_TOKEN", resourceRef: nil, access: nil)
            ], accessDurationSeconds: nil, status: "pending", expiresAt: "2099-01-01T00:00:00Z",
            expired: false, ephemeralPublicKey: nil)
        ]
        return model
      }
      let items = [
        ("studio", "Mac Studio", "Run the website deployment", "approved"),
        ("agent", "Research agent", "Read project notes for the weekly review", "approved"),
        ("laptop", "MacBook Air", "Connect to the development database", "denied"),
      ]
      model.approvals = items.map { id, device, message, status in
        Approval(
          id: id, device: device, command: "test", message: message, secretRefs: [],
          resourceRequests: [], accessDurationSeconds: nil, status: status,
          expiresAt: "2099-01-01T00:00:00Z", expired: false, ephemeralPublicKey: nil)
      }
      model.secrets = [
        Secret(
          id: "sample", ref: "demo/api-key", label: "Example API key",
          updatedAt: "2026-10-29T12:00:00Z")
      ]
      if scenario == "automatic" { model.refreshing = true }
      if scenario == "unlock" { model.activity = "Unlocking vault…" }
      return model
    }
  }
#endif
