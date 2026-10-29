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
  let flow: AccountFlow
  @State private var failure: String?
  @State private var loading = true
  @State private var progress = "Waiting for authorization…"
  @State private var providers: [Provider] = []
  @State private var providerID = ""
  @State private var name = "personal"
  @State private var clientID = ""
  @State private var scopes = Set<String>()
  @State private var connecting = false
  @State private var auth = SystemAuthentication()
  @State private var task: Task<Void, Never>?
  init(flow: AccountFlow = AccountFlow()) {
    self.flow = flow
    _providerID = State(initialValue: flow.providerID)
    _name = State(initialValue: flow.name)
    _scopes = State(
      initialValue: Set(flow.requiredScopes).union(flow.connection?.grantedScopes ?? []))
  }
  var provider: Provider? { providers.first { $0.id == providerID } }
  var body: some View {
    NavigationStack {
      Form {
        Section {
          if loading { ProgressView("Loading services…") }
          Picker("Service", selection: $providerID) {
            Text("Choose a service").tag("")
            ForEach(providers) { Text($0.name).tag($0.id) }
          }.disabled(!flow.providerID.isEmpty || connecting)
          TextField("Connection name", text: $name).textInputAutocapitalization(.never)
            .autocorrectionDisabled().disabled(
              flow.connection != nil || flow.fixedName || connecting)
          if let account = flow.connection {
            Text("Sign in as \(account.accountLabel).").font(.subheadline).foregroundStyle(
              .secondary)
          }
        }
        if let failure {
          Section { Text(failure).foregroundStyle(.red) }
        }
        if let provider {
          Section {
            DisclosureGroup("Service settings") {
              TextField("Public OAuth client ID", text: $clientID).textInputAutocapitalization(
                .never
              ).autocorrectionDisabled()
              Text("Changes apply to every connection for this service.").font(.footnote)
                .foregroundStyle(.secondary)
              Text("Register this callback with your provider:").font(.footnote)
              Text(provider.redirectUri).font(.caption).textSelection(.enabled)
              Button {
                Task {
                  await model.run("Saving provider settings…") {
                    do {
                      _ = try await model.request(
                        "oauth/providers/\(provider.id)/config", method: "PUT",
                        body: ["clientId": clientID.trimmingCharacters(in: .whitespacesAndNewlines)]
                      )
                      try await loadProviders()
                      failure = nil
                    } catch { failure = "Couldn’t save service settings. Please try again." }
                  }
                }
              } label: {
                OperationLabel(title: "Save client ID", operations: ["Saving provider settings…"])
              }.disabled(
                connecting || clientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  || clientID == provider.clientId)
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
                  || provider.connectionScopes.contains(scope.id)
                  || flow.requiredScopes.contains(scope.id) || connecting)
            }
          }
          let otherScopes = scopes.subtracting(provider.scopes.map(\.id)).subtracting(
            provider.identityScopes
          ).subtracting(provider.connectionScopes).sorted()
          if !otherScopes.isEmpty {
            Section("Additional permissions") {
              ForEach(otherScopes, id: \.self) { scope in
                Toggle(
                  scope,
                  isOn: Binding(
                    get: { scopes.contains(scope) },
                    set: { if $0 { scopes.insert(scope) } else { scopes.remove(scope) } })
                )
                .disabled(flow.requiredScopes.contains(scope) || connecting)
              }
            }
          }
          if !flow.requiredScopes.isEmpty {
            Section("Required by this request") {
              ForEach(Array(Set(flow.requiredScopes)).sorted(), id: \.self) {
                Text($0).font(.caption)
              }
            }
          }
          Section {
            if connecting { ProgressView(progress) }
            Button(
              connecting
                ? "Authorization in progress"
                : (flow.connection == nil ? "Connect securely" : "Reconnect securely")
            ) {
              task = Task { await connect(provider) }
            }.disabled(connecting || provider.clientId == nil || model.busy)
          } footer: {
            Text(
              "Sign in using the iOS authentication browser. Your refresh token is encrypted with your vault key before it is stored."
            )
          }
        }
      }.vaultActivity()
        .navigationTitle(flow.connection == nil ? "Connect account" : "Reconnect account")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") {
              task?.cancel()
              auth.close()
              dismiss()
            }
          }
        }
        .task {
          do { try await loadProviders() } catch {
            failure = "Couldn’t load services. Close this sheet and try again."
          }
          loading = false
        }
        .onChange(of: providerID) { _, _ in
          scopes = Set(flow.requiredScopes).union(flow.connection?.grantedScopes ?? [])
          clientID = provider?.clientId ?? ""
        }
        .interactiveDismissDisabled(connecting)
        .onDisappear {
          task?.cancel()
          auth.close()
        }
    }
  }
  private func loadProviders() async throws {
    #if DEBUG
      if DesignFixture.enabled {
        providers = [DesignFixture.provider]
        clientID = provider?.clientId ?? ""
        return
      }
    #endif
    providers = try model.decode(
      try await model.request("oauth/providers"), "providers", as: [Provider].self)
    clientID = provider?.clientId ?? ""
  }
  private func connect(_ provider: Provider) async {
    connecting = true
    failure = nil
    progress = "Waiting for authorization…"
    defer {
      connecting = false
      auth.close()
    }
    do {
      #if DEBUG
        if DesignFixture.enabled { throw VaultError("Authorization is disabled for sample accounts.") }
      #endif
      guard
        OAuthPolicy.validName(name)
      else {
        throw VaultError("Use lowercase letters, numbers, and hyphens for the connection name.")
      }
      guard
        !model.connections.contains(where: {
          $0.revokedAt == nil && $0.providerId == provider.id && $0.connectionName == name
            && $0.id != flow.connection?.id
        })
      else { throw VaultError("That connection name already exists.") }
      if let existing = flow.connection {
        guard
          model.connections.contains(where: {
            $0.id == existing.id && $0.revokedAt == nil && $0.connectionName == name
          })
        else {
          throw VaultError("This connection changed. Close this sheet and open it again.")
        }
      }
      if model.key == nil { try await model.unlock() }
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
        progress = "Verifying account…"
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
        if model.key == nil { try await model.unlock() }
        guard let subject = identity["subject"] as? String,
          let label = identity["label"] as? String
        else { throw VaultError("Could not verify account identity.") }
        try OAuthPolicy.validateIdentity(existing: flow.connection, subject: subject)
        try Task.checkCancellation()
        if let existing = flow.connection {
          let response = try await model.request("oauth/connections/\(existing.id)/resolve")
          guard let live = response["connection"] as? [String: Any],
            live["connectionName"] as? String == name,
            live["accountSubject"] as? String == subject
          else { throw VaultError("This connection changed. Close this sheet and try again.") }
        }
        try Task.checkCancellation()
        if model.key == nil { try await model.unlock() }
        try Task.checkCancellation()
        guard let key = model.key else {
          throw VaultError("Unlock your vault to save this connection.")
        }
        progress = "Saving encrypted connection…"
        let encrypted = try VaultCrypto.secret(refresh, key: key)
        var record: [String: Any] = [
          "id": flow.connection?.id ?? UUID().uuidString.lowercased(), "providerId": provider.id,
          "connectionName": name,
          "accountSubject": subject, "accountLabel": label, "grantedScopes": granted,
          "tokenType": token["tokenType"] as? String ?? "Bearer",
          "refreshTokenCiphertext": encrypted["ciphertext"]!, "refreshTokenIv": encrypted["iv"]!,
          "refreshTokenSalt": encrypted["salt"]!, "refreshTokenKdf": encrypted["kdf"]!,
        ]
        if let seconds = token["expiresIn"] as? Double {
          record["accessTokenExpiresAt"] = ISO8601DateFormatter().string(
            from: Date().addingTimeInterval(seconds))
        }
        let saved = try await model.request("oauth/connections", method: "POST", body: record)
        if let object = saved["connection"] {
          let updated = try JSONDecoder().decode(
            Connection.self, from: JSONSerialization.data(withJSONObject: object))
          if let index = model.connections.firstIndex(where: { $0.id == updated.id }) {
            model.connections[index] = updated
          } else {
            model.connections.append(updated)
          }
        }
        _ = try? await model.request("oauth/handoffs/\(id)", method: "DELETE")
        dismiss()
        return
      }
      throw VaultError("Authorization expired. Please try again.")
    } catch {
      if !VaultModel.isExpectedCancellation(error) { failure = error.localizedDescription }
    }
  }
}
