import AuthenticationServices
import CryptoKit
import SwiftUI

struct Provider: Decodable, Identifiable {
  let id: String
  let name: String
  let clientId: String?
  let authorizationEndpoint: String
  let redirectUri: String
  let identityScopes: [String]
  let connectionScopes: [String]
  let scopes: [Scope]
  struct Scope: Decodable, Identifiable {
    let id: String
    let label: String
    let description: String
    let risk: String
  }
}

@MainActor
final class SystemAuthentication: NSObject, ASWebAuthenticationPresentationContextProviding {
  var session: ASWebAuthenticationSession?
  var cancelled = false
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
      .first { $0.isKeyWindow } ?? ASPresentationAnchor()
  }
  func open(_ url: URL) throws {
    // The existing Worker seals its HTTPS callback to our ephemeral key.
    // Poll that handoff, then cancel this system browser when it completes.
    cancelled = false
    let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "sickrat-oauth") {
      [weak self] _, error in
      if error != nil { Task { @MainActor in self?.cancelled = true } }
    }
    session.presentationContextProvider = self
    self.session = session
    guard session.start() else { throw VaultError("Could not start system authentication.") }
  }
  func close() {
    session?.cancel()
    session = nil
  }
}
struct ConnectAccountView: View {
  @Environment(VaultModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var providers: [Provider] = []
  @State private var providerID = ""
  @State private var name = "personal"
  @State private var clientID = ""
  @State private var scopes = Set<String>()
  @State private var connecting = false
  @State private var auth = SystemAuthentication()
  @State private var task: Task<Void, Never>?
  var provider: Provider? { providers.first { $0.id == providerID } }
  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Service", selection: $providerID) {
            Text("Choose a service").tag("")
            ForEach(providers) { Text($0.name).tag($0.id) }
          }
          TextField("Connection name", text: $name).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
        if let provider {
          if provider.clientId == nil {
            Section("Provider setup") {
              TextField("Public OAuth client ID", text: $clientID).textInputAutocapitalization(
                .never
              ).autocorrectionDisabled()
              Text("Register this callback with your provider:").font(.footnote)
              Text(provider.redirectUri).font(.caption).textSelection(.enabled)
              Button("Save client ID") {
                Task {
                  await model.run {
                    _ = try await model.request(
                      "oauth/providers/\(provider.id)/config", method: "PUT",
                      body: ["clientId": clientID])
                    try await loadProviders()
                  }
                }
              }
            }
          }
          Section("Allow access to") {
            ForEach(provider.scopes) { scope in
              Toggle(
                isOn: Binding(
                  get: {
                    scopes.contains(scope.id) || provider.identityScopes.contains(scope.id)
                      || provider.connectionScopes.contains(scope.id)
                  }, set: { if $0 { scopes.insert(scope.id) } else { scopes.remove(scope.id) } })
              ) {
                VStack(alignment: .leading) {
                  Text(scope.label)
                  Text(scope.description).font(.caption).foregroundStyle(.secondary)
                  if ["high", "sensitive"].contains(scope.risk) {
                    Text(scope.risk.capitalized + " access").font(.caption).foregroundStyle(.orange)
                  }
                }
              }.disabled(
                provider.identityScopes.contains(scope.id)
                  || provider.connectionScopes.contains(scope.id))
            }
          }
          Section {
            Button(connecting ? "Waiting for authorization…" : "Connect securely") {
              task = Task { await connect(provider) }
            }.disabled(connecting || provider.clientId == nil || model.busy)
          } footer: {
            Text(
              "Sign in using the iOS authentication browser. Your refresh token is encrypted with your vault key before it is stored."
            )
          }
        }
      }.navigationTitle("Connect account").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") {
              task?.cancel()
              auth.close()
              dismiss()
            }
          }
        }
        .task { await model.run { try await loadProviders() } }
        .onChange(of: providerID) { _, _ in scopes = [] }
        .onDisappear {
          task?.cancel()
          auth.close()
        }
    }
  }
  private func loadProviders() async throws {
    providers = try model.decode(
      try await model.request("oauth/providers"), "providers", as: [Provider].self)
  }
  private func connect(_ provider: Provider) async {
    connecting = true
    defer {
      connecting = false
      auth.close()
    }
    do {
      guard
        name.range(of: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$", options: .regularExpression) != nil
      else {
        throw VaultError("Use lowercase letters, numbers, and hyphens for the connection name.")
      }
      guard
        !model.connections.contains(where: {
          $0.revokedAt == nil && $0.providerId == provider.id && $0.connectionName == name
        })
      else { throw VaultError("That connection name already exists.") }
      if model.key == nil { try model.unlock() }
      let pair = P256.KeyAgreement.PrivateKey()
      let random = { SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64URL } }
      let id = random()
      let state = "v1.\(id).\(random())"
      let verifier = random()
      let requested = Array(scopes.union(provider.identityScopes).union(provider.connectionScopes))
        .sorted()
      _ = try await model.request(
        "oauth/handoffs", method: "POST",
        body: [
          "id": id, "providerId": provider.id,
          "stateHash": Data(SHA256.hash(data: Data(state.utf8))).base64URL,
          "publicKey": VaultCrypto.publicJWK(pair.publicKey),
        ])
      guard var url = URLComponents(string: provider.authorizationEndpoint), url.scheme == "https",
        let client = provider.clientId
      else { throw VaultError("Invalid provider configuration.") }
      url.queryItems = [
        "response_type": "code", "client_id": client, "redirect_uri": provider.redirectUri,
        "scope": requested.joined(separator: " "), "state": state,
        "code_challenge": Data(SHA256.hash(data: Data(verifier.utf8))).base64URL,
        "code_challenge_method": "S256",
      ].map { URLQueryItem(name: $0.key, value: $0.value) }
      guard let authorizationURL = url.url else { throw VaultError("Invalid authorization URL.") }
      try auth.open(authorizationURL)
      let deadline = Date().addingTimeInterval(300)
      while Date() < deadline {
        try await Task.sleep(for: .seconds(2))
        if auth.cancelled { throw CancellationError() }
        let result = try await model.request("oauth/handoffs/\(id)")
        guard result["status"] as? String == "completed" else { continue }
        guard let jwk = VaultCrypto.jwkFields(result["ephemeralPublicKey"]),
          let ciphertext = result["ciphertext"] as? String, let iv = result["iv"] as? String
        else { throw VaultError("Invalid authorization response.") }
        let shared = try pair.sharedSecretFromKeyAgreement(with: VaultCrypto.publicKey(jwk))
        let wrapping = shared.hkdfDerivedSymmetricKey(
          using: SHA256.self, salt: Data("sickrat:oauth-handoff-salt:v1".utf8),
          sharedInfo: Data("sickrat:oauth-handoff:v1".utf8), outputByteCount: 32)
        let data = try VaultCrypto.open(["ciphertext": ciphertext, "iv": iv], key: wrapping)
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          payload["state"] as? String == state, payload["providerId"] as? String == provider.id,
          let code = payload["code"] as? String
        else { throw VaultError("Authorization was denied or the response did not match.") }
        auth.close()
        let token = try await model.request(
          "oauth/token", method: "POST",
          body: [
            "action": "authorization_code", "providerId": provider.id, "code": code,
            "codeVerifier": verifier, "redirectUri": provider.redirectUri, "scopes": requested,
          ])
        guard let refresh = token["refreshToken"] as? String,
          let access = token["accessToken"] as? String, let granted = token["scopes"] as? [String],
          Set(requested).subtracting(provider.connectionScopes).isSubset(of: Set(granted))
        else {
          throw VaultError("Provider did not return persistent access with the requested scopes.")
        }
        let identityResponse = try await model.request(
          "oauth/identity", method: "POST",
          body: ["providerId": provider.id, "accessToken": access])
        guard let identity = identityResponse["identity"] as? [String: Any] else {
          throw VaultError("Invalid provider identity response.")
        }
        if model.key == nil { try model.unlock() }
        guard let key = model.key, let subject = identity["subject"] as? String,
          let label = identity["label"] as? String
        else { throw VaultError("Could not verify account identity.") }
        let encrypted = try VaultCrypto.secret(refresh, key: key)
        var record: [String: Any] = [
          "id": UUID().uuidString.lowercased(), "providerId": provider.id, "connectionName": name,
          "accountSubject": subject, "accountLabel": label, "grantedScopes": granted,
          "tokenType": token["tokenType"] as? String ?? "Bearer",
          "refreshTokenCiphertext": encrypted["ciphertext"]!, "refreshTokenIv": encrypted["iv"]!,
          "refreshTokenSalt": encrypted["salt"]!, "refreshTokenKdf": encrypted["kdf"]!,
        ]
        if let seconds = token["expiresIn"] as? Double {
          record["accessTokenExpiresAt"] = ISO8601DateFormatter().string(
            from: Date().addingTimeInterval(seconds))
        }
        _ = try await model.request("oauth/connections", method: "POST", body: record)
        _ = try await model.request("oauth/handoffs/\(id)", method: "DELETE")
        try await model.refresh()
        dismiss()
        return
      }
      throw VaultError("Authorization expired. Please try again.")
    } catch is CancellationError {} catch { model.error = error.localizedDescription }
  }
}
