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
    static func model() -> VaultModel {
      let model = VaultModel()
      model.endpoint = "https://preview.example"
      if scenario == "initial" {
        model.refreshing = true
        return model
      }
      model.lastRefresh = Date()
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
