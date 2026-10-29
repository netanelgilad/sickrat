import SwiftUI

struct AccountFlow: Identifiable {
  let id = UUID()
  var connection: Connection? = nil
  var providerID = ""
  var name = "personal"
  var requiredScopes: [String] = []
  var fixedName = false
}

enum OAuthPolicy {
  static func validName(_ name: String) -> Bool {
    name.range(of: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$", options: .regularExpression) != nil
  }
  static func candidates(_ resource: Approval.Resource, _ connections: [Connection]) -> [Connection]
  {
    connections.filter {
      $0.revokedAt == nil && $0.providerId == resource.providerId
        && (resource.connectionName == nil || $0.connectionName == resource.connectionName)
    }
  }
  static func matches(_ resource: Approval.Resource, _ connections: [Connection]) -> [Connection] {
    candidates(resource, connections).filter {
      Set(resource.scopes ?? []).isSubset(of: Set($0.grantedScopes))
    }
  }
  static func validateIdentity(existing: Connection?, subject: String) throws {
    if let existing, existing.accountSubject != subject {
      throw VaultError(
        "Sign in as \(existing.accountLabel) to reconnect this account. To use another account, create a separate connection."
      )
    }
  }
}

struct OAuthAccessRow: View {
  @Environment(VaultModel.self) private var model
  let resource: Approval.Resource
  @State private var flow: AccountFlow?
  private var matches: [Connection] { OAuthPolicy.matches(resource, model.connections) }
  private var candidates: [Connection] { OAuthPolicy.candidates(resource, model.connections) }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(resource.providerId ?? "Account").font(.headline)
      if let name = resource.connectionName {
        Text(name).font(.subheadline).foregroundStyle(.secondary)
      }
      Text((resource.scopes ?? []).joined(separator: "\n")).font(.caption).foregroundStyle(
        .secondary)
      if matches.count == 1, let account = matches.first {
        Label(account.accountLabel, systemImage: "checkmark.circle").font(.subheadline)
        Button("Reconnect account") { repair(account) }
      } else if matches.count > 1 {
        Text(
          "Several accounts allow this access. Ask the requesting device to specify a connection name."
        )
        .font(.subheadline).foregroundStyle(.secondary)
      } else if candidates.isEmpty {
        Text("Connect an account to allow these permissions.").font(.subheadline).foregroundStyle(
          .secondary)
        Button("Connect account") {
          flow = AccountFlow(
            providerID: resource.providerId ?? "", name: resource.connectionName ?? "personal",
            requiredScopes: resource.scopes ?? [], fixedName: resource.connectionName != nil)
        }
      } else {
        Text("Additional permissions required").font(.subheadline)
        ForEach(candidates) { account in
          Button("Update permissions for \(account.connectionName)") { repair(account) }
        }
      }
    }
    .padding(.vertical, 4)
    .sheet(item: $flow) { ConnectAccountView(flow: $0) }
  }
  private func repair(_ account: Connection) {
    flow = AccountFlow(
      connection: account, providerID: account.providerId,
      name: account.connectionName, requiredScopes: resource.scopes ?? [])
  }
}

struct ConnectionDetail: View {
  @Environment(VaultModel.self) private var model
  let connection: Connection
  @State private var flow: AccountFlow?
  @State private var renaming = false
  @State private var revoke = false
  var current: Connection { model.connections.first { $0.id == connection.id } ?? connection }
  var body: some View {
    Form {
      Section("Account") {
        LabeledContent("Service", value: current.providerId)
        LabeledContent("Account", value: current.accountLabel)
        LabeledContent("Connection name", value: current.connectionName)
        LabeledContent("Status", value: current.revokedAt == nil ? "Connected" : "Revoked")
      }
      Section("Allowed permissions") {
        ForEach(current.grantedScopes, id: \.self) { Text($0).font(.subheadline) }
      }
      if current.revokedAt == nil {
        Section {
          Button("Rename connection") { renaming = true }
          Button("Reconnect or change permissions") {
            flow = AccountFlow(
              connection: current, providerID: current.providerId, name: current.connectionName)
          }
          Button(role: .destructive) {
            revoke = true
          } label: {
            OperationLabel(title: "Revoke connection", operations: ["Revoking account…"])
          }
        }
      }
    }
    .navigationTitle(current.connectionName).navigationBarTitleDisplayMode(.inline)
    .vaultActivity()
    .sheet(isPresented: $renaming) { RenameConnectionView(connection: current) }
    .sheet(item: $flow) { ConnectAccountView(flow: $0) }
    .confirmationDialog("Revoke this connection?", isPresented: $revoke, titleVisibility: .visible)
    {
      Button("Revoke", role: .destructive) {
        Task {
          await model.run("Revoking account…") {
            try await model.revoke("oauth/connections/\(current.id)/revoke")
          }
        }
      }
    }
  }
}

struct RenameConnectionView: View {
  @Environment(VaultModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  let connection: Connection
  @State private var name: String
  @State private var error: String?
  // A sheet owns its edit draft, seeded once from the selected account.
  init(connection: Connection) {
    self.connection = connection
    _name = State(initialValue: connection.connectionName)
  }
  private var duplicate: Bool {
    model.connections.contains {
      $0.id != connection.id && $0.revokedAt == nil && $0.providerId == connection.providerId
        && $0.connectionName == name
    }
  }
  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Connection name", text: $name).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        } footer: {
          Text(
            "Use lowercase letters, numbers and hyphens. Commands using the old name must be updated."
          )
        }
        if duplicate { Text("This name is already in use.").foregroundStyle(.red) }
        if let error { Text(error).foregroundStyle(.red) }
      }
      .navigationTitle("Rename connection").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(model.busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button {
            Task {
              await model.run("Renaming connection…") {
                do {
                  let response = try await model.request(
                    "oauth/connections/\(connection.id)/name", method: "POST",
                    body: ["connectionName": name])
                  let updated = try JSONDecoder().decode(
                    Connection.self,
                    from: JSONSerialization.data(withJSONObject: response["connection"] as Any))
                  if let index = model.connections.firstIndex(where: { $0.id == updated.id }) {
                    model.connections[index] = updated
                  }
                  dismiss()
                } catch { self.error = "Couldn’t rename this connection. Please try again." }
              }
            }
          } label: {
            OperationLabel(title: "Save", operations: ["Renaming connection…"])
          }
          .disabled(
            model.busy || !OAuthPolicy.validName(name) || duplicate
              || name == connection.connectionName)
        }
      }
      .interactiveDismissDisabled(model.busy)
    }
  }
}
