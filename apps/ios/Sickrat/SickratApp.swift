import SwiftUI
import UniformTypeIdentifiers

@main struct SickratApp: App {
  @State private var model = VaultModel()
  @Environment(\.scenePhase) private var phase
  var body: some Scene {
    WindowGroup {
      RootView().environment(model)
        .overlay {
          if phase == .background {
            Color(.systemBackground).ignoresSafeArea().overlay {
              Image(systemName: "lock.shield").font(.largeTitle)
            }
          }
        }
        .onChange(of: phase) { _, phase in if phase == .background { model.lock() } }
    }
  }
}
struct RootView: View {
  @Environment(VaultModel.self) private var model
  @Environment(\.scenePhase) private var phase
  var body: some View {
    @Bindable var model = model
    Group {
      if model.configured {
        TabView {
          Tab("Requests", systemImage: "checkmark.shield") { RequestsView() }.badge(
            model.pending.count)
          Tab("Vault", systemImage: "key.horizontal") { VaultView() }
          Tab("Settings", systemImage: "gearshape") { SettingsView() }
        }
      } else {
        WelcomeView()
      }
    }
    .tint(.indigo)
    .alert(
      "Couldn’t complete action",
      isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })
    ) {
      Button("OK") { model.error = nil }
    } message: {
      Text(model.error ?? "")
    }
    .task(id: "\(phase)-\(model.endpoint)") {
      guard phase == .active, model.configured else { return }
      while !Task.isCancelled {
        await model.reload()
        do { try await Task.sleep(for: .seconds(15)) } catch { return }
      }
    }
  }
}
struct WelcomeView: View {
  @Environment(VaultModel.self) private var model
  @State private var address = ""
  var body: some View {
    NavigationStack {
      Form {
        Section {
          VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "lock.shield.fill").font(.system(size: 52)).foregroundStyle(.indigo)
              .accessibilityHidden(true)
            Text("Your secrets.\nYour say.").font(.largeTitle.bold())
            Text("Approve access, manage secrets, and keep your vault close.").foregroundStyle(
              .secondary)
          }.padding(.vertical, 24)
        }.listRowBackground(Color.clear)
        Section("Connect your vault") {
          TextField("https://your-vault.workers.dev", text: $address).textContentType(.URL)
            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
          Button {
            Task { await model.run("Connecting to vault…") { try await model.connect(address) } }
          } label: {
            HStack {
              Text("Continue")
              Spacer()
              if model.busy { ProgressView() } else { Image(systemName: "arrow.right") }
            }
          }.disabled(model.busy || address.isEmpty)
        }
        Section {
          Text(
            "Use the address of your existing Sickrat vault. You’ll transfer its key securely from the PWA, then unlock with Face ID or your device passcode."
          ).font(.footnote).foregroundStyle(.secondary)
        }
      }.vaultActivity()
        .navigationTitle("Sickrat").navigationBarTitleDisplayMode(.inline)
    }
  }
}
struct RequestsView: View {
  @Environment(VaultModel.self) private var model
  var body: some View {
    NavigationStack {
      List {
        if model.lastRefresh == nil {
          InitialVaultState()
        } else if model.pending.isEmpty {
          ContentUnavailableView(
            "All clear", systemImage: "checkmark.shield",
            description: Text("New access requests appear here while the app is open.")
          ).listRowBackground(Color.clear)
        } else {
          Section("Needs your approval") {
            ForEach(model.pending) { request in
              NavigationLink {
                RequestDetail(request: request)
              } label: {
                RequestRow(request: request)
              }
            }
          }
        }
        let history = model.approvals.filter { !$0.pending }
        if !history.isEmpty {
          Section("Recent activity") {
            ForEach(history) { request in
              NavigationLink {
                RequestDetail(request: request)
              } label: {
                RequestRow(request: request)
              }
            }
          }
        }
      }.vaultActivity()
        .navigationTitle("Requests")
        .refreshable { await model.reload() }
        .toolbar { UnlockButton() }
    }
  }
}
struct RequestRow: View {
  let request: Approval
  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(request.device).font(.headline)
      Text(request.message ?? request.command).font(.subheadline).foregroundStyle(.secondary)
        .lineLimit(2)
      Text(request.expired ? "Expired" : request.status.capitalized).font(.caption).foregroundStyle(
        request.pending ? .orange : .secondary)
    }.padding(.vertical, 4)
  }
}
struct RequestDetail: View {
  @Environment(VaultModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  let request: Approval
  @State private var confirm = false
  @State private var missingValues: [String: String] = [:]
  @Environment(\.scenePhase) private var phase
  var current: Approval { model.approvals.first { $0.id == request.id } ?? request }
  var body: some View {
    Form {
      Section("Requested by") {
        LabeledContent("Device", value: current.device)
        Text(current.command).font(.system(.body, design: .monospaced)).textSelection(.enabled)
        if let message = current.message { Text(message) }
      }
      Section("Access") {
        ForEach(current.secretRefs, id: \.self) { Text($0) }
        ForEach(
          Array(current.resourceRequests.filter { $0.type != "secret" }.enumerated()), id: \.offset
        ) { _, resource in
          VStack(alignment: .leading) {
            Text(resource.resourceRef ?? resource.providerId ?? resource.type)
            Text(resource.scopes?.joined(separator: ", ") ?? resource.access ?? "").font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        LabeledContent(
          "Duration",
          value: current.accessDurationSeconds.map { "\($0 / 60) minutes" } ?? "One-time access")
        LabeledContent("Status", value: current.expired ? "Expired" : current.status.capitalized)
      }
      if current.pending {
        let missing = current.secretRefs.filter { ref in !model.secrets.contains { $0.ref == ref } }
        if !missing.isEmpty {
          Section("Create requested secrets") {
            ForEach(missing, id: \.self) { ref in
              SecureField(
                ref,
                text: Binding(get: { missingValues[ref] ?? "" }, set: { missingValues[ref] = $0 })
              ).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
          }
        }
        Section {
          Button("Approve access", systemImage: "checkmark.shield") { confirm = true }.disabled(
            model.busy)
          Button("Deny request", role: .destructive) {
            Task {
              await model.run("Denying request…") {
                try await model.revoke("approvals/\(current.id)/deny")
                dismiss()
              }
            }
          }.disabled(model.busy)
        } footer: {
          Text("Only the requesting device can decrypt an approved grant.")
        }
      }
    }.vaultActivity()
      .navigationTitle("Review request").navigationBarTitleDisplayMode(.inline)
      .onChange(of: phase) { _, phase in if phase == .background { missingValues = [:] } }
      .confirmationDialog(
        "Allow \(current.device) to access these resources?", isPresented: $confirm,
        titleVisibility: .visible
      ) {
        Button("Approve access") {
          Task {
            await model.run("Approving access…") {
              if model.key == nil { try await model.unlock() }
              try await model.approve(current, missingValues: missingValues)
              missingValues = [:]
              dismiss()
            }
          }
        }
      }
  }
}
struct UnlockButton: ToolbarContent {
  @Environment(VaultModel.self) private var model
  var body: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Button(
        model.key == nil ? "Unlock" : "Lock", systemImage: model.key == nil ? "lock" : "lock.open"
      ) {
        Task {
          await model.run(model.key == nil ? "Unlocking vault…" : "Locking vault…") {
            if model.key == nil { try await model.unlock() } else { model.lock() }
          }
        }
      }.disabled(model.busy)
    }
  }
}
struct VaultView: View {
  @Environment(VaultModel.self) private var model
  @State private var search = ""
  @State private var adding = false
  var body: some View {
    NavigationStack {
      List {
        Section("Secrets") {
          if model.lastRefresh == nil {
            InitialVaultState()
          } else if model.secrets.isEmpty {
            ContentUnavailableView(
              "A place for your secrets", systemImage: "key.horizontal",
              description: Text("Add a secret to share it through approved requests."))
          }
          ForEach(
            model.secrets.filter {
              search.isEmpty || $0.ref.localizedCaseInsensitiveContains(search)
                || $0.label.localizedCaseInsensitiveContains(search)
            }
          ) { secret in
            NavigationLink {
              SecretDetail(secret: secret)
            } label: {
              VStack(alignment: .leading) {
                Text(secret.label)
                Text(secret.ref).font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
        Section {
          NavigationLink {
            ConnectionsView()
          } label: {
            Label("Connected accounts", systemImage: "person.crop.circle.badge.checkmark")
          }
          NavigationLink {
            SessionsView()
          } label: {
            Label("Browser sessions", systemImage: "globe")
          }
        }
      }.vaultActivity()
        .navigationTitle("Vault").searchable(text: $search, prompt: "Find a secret")
        .refreshable { await model.reload() }
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Add secret", systemImage: "plus") { adding = true }
          }
          UnlockButton()
        }
        .sheet(isPresented: $adding) { SecretEditor() }
    }
  }
}
struct SecretDetail: View {
  @Environment(VaultModel.self) private var model
  @Environment(\.scenePhase) private var phase
  let secret: Secret
  @State private var value: String?
  @State private var editing = false
  var body: some View {
    Form {
      Section {
        LabeledContent("Reference", value: secret.ref)
        LabeledContent("Updated", value: secret.updatedAt)
      }
      Section("Value") {
        if let value {
          Text(value).font(.system(.body, design: .monospaced)).privacySensitive()
          Button("Hide value") { self.value = nil }
        } else {
          Button("Reveal value", systemImage: "eye") {
            Task {
              await model.run("Revealing secret…") {
                if model.key == nil { try await model.unlock() }
                value = try await model.value(for: secret.ref)
              }
            }
          }
        }
      }
      Section { Button("Edit secret") { editing = true } }
    }.vaultActivity()
      .navigationTitle(secret.label).navigationBarTitleDisplayMode(.inline)
      .sheet(isPresented: $editing) { SecretEditor(secret: secret) }
      .onDisappear { value = nil }
      .onChange(of: phase) { _, phase in if phase != .active { value = nil } }
      .onChange(of: model.key == nil) { _, locked in if locked { value = nil } }
  }
}
struct SecretEditor: View {
  @Environment(VaultModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  var secret: Secret?
  @State private var ref = ""
  @State private var name = ""
  @State private var value = ""
  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Name", text: $name)
          TextField("service/api-key", text: $ref).textInputAutocapitalization(.never)
            .autocorrectionDisabled().disabled(secret != nil)
          SecureField("Secret value", text: $value).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
        Section {
          Button("Generate random value", systemImage: "sparkles") {
            value = UUID().uuidString + UUID().uuidString
          }
        } footer: {
          Text("Encrypted on this device before it leaves the app.")
        }
      }.vaultActivity()
        .navigationTitle(secret == nil ? "New secret" : "Edit secret")
        .navigationBarTitleDisplayMode(
          .inline
        )
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button("Save") {
              Task {
                await model.run("Saving secret…") {
                  if model.key == nil { try await model.unlock() }
                  try await model.saveSecret(ref: ref, label: name, value: value)
                  value = ""
                  dismiss()
                }
              }
            }.disabled(model.busy || ref.isEmpty || name.isEmpty || value.isEmpty)
          }
        }.onAppear {
          ref = secret?.ref ?? ""
          name = secret?.label ?? ""
        }
        .onChange(of: phase) { _, phase in if phase == .background { value = "" } }
    }
  }
}
struct SettingsView: View {
  @Environment(VaultModel.self) private var model
  var body: some View {
    NavigationStack {
      Form {
        Section("Your vault") {
          Text(model.endpoint).font(.footnote).textSelection(.enabled)
          NavigationLink {
            TransferView()
          } label: {
            Label("Transfer vault key", systemImage: "iphone.and.arrow.forward")
          }
          NavigationLink {
            DevicesView()
          } label: {
            Label("Paired devices", systemImage: "laptopcomputer.and.iphone")
          }
        }
        Section("Security") {
          Button(model.key == nil ? "Unlock vault" : "Lock vault", systemImage: "faceid") {
            Task {
              await model.run(model.key == nil ? "Unlocking vault…" : "Locking vault…") {
                if model.key == nil { try await model.unlock() } else { model.lock() }
              }
            }
          }
          Text(
            "Your key stays in this device’s Keychain, protected by Face ID or your passcode. The vault locks when the app enters the background."
          ).font(.footnote).foregroundStyle(.secondary)
        }
        Section("Development preview") {
          Text(
            "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") · Build \(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "")"
          )
          Text(
            "Requests refresh while the app is open. Background push and vault provisioning are still being migrated."
          ).font(.footnote).foregroundStyle(.secondary)
          if let url = URL(string: model.endpoint) { Link("Open web console", destination: url) }
        }
      }.vaultActivity()
        .navigationTitle("Settings")
    }
  }
}
struct TransferView: View {
  @Environment(VaultModel.self) private var model
  @State private var transfer = ""
  @State private var importing = false
  @State private var complete = false
  var body: some View {
    Form {
      Section {
        Text("Bring your existing key").font(.title2.bold())
        Text(
          "Start here, then paste the transfer request into Settings → Native iOS transfer in your unlocked web console. Save the encrypted file and import it here within 10 minutes."
        )
      }
      Section {
        Button("Start encrypted transfer") {
          do {
            transfer = try model.startTransfer()
            complete = false
          } catch { model.error = error.localizedDescription }
        }
        if !transfer.isEmpty {
          ShareLink("Share transfer request", item: transfer)
          Button("Copy transfer request") {
            UIPasteboard.general.setItems(
              [[UIPasteboard.typeAutomatic: transfer]],
              options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(600)])
          }
          Button("Import encrypted file") { importing = true }
        }
        if complete {
          Label("Vault key secured on this iPhone", systemImage: "checkmark.shield.fill")
            .foregroundStyle(.green)
        }
      } footer: {
        Text(
          "The request contains only a public key. Only this app can decrypt the transfer. Keep this screen’s transfer active until import completes."
        )
      }
    }.vaultActivity()
      .navigationTitle("Transfer key").navigationBarTitleDisplayMode(.inline)
      .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
        do {
          let url = try result.get()
          let access = url.startAccessingSecurityScopedResource()
          defer { if access { url.stopAccessingSecurityScopedResource() } }
          try model.importTransfer(Data(contentsOf: url))
          complete = true
          transfer = ""
        } catch { model.error = error.localizedDescription }
      }
  }
}
struct DevicesView: View {
  @Environment(VaultModel.self) private var model
  @State private var code = ""
  @State private var pairLabel: String?
  @State private var revoke: Device?
  var body: some View {
    Form {
      Section("Pair a device") {
        TextField("Pairing code", text: $code).textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        Button("Review device") {
          Task {
            await model.run("Looking up device…") {
              let result = try await model.request(
                "devices/pairing-codes/\(code.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "")"
              )
              guard result["expired"] as? Bool == false, result["approvedAt"] is NSNull,
                let label = result["label"] as? String
              else { throw VaultError("This pairing code is no longer pending.") }
              pairLabel = label
            }
          }
        }
      }
      Section("Devices") {
        ForEach(model.devices) { device in
          HStack {
            VStack(alignment: .leading) {
              Text(device.label)
              Text(device.revokedAt == nil ? "Paired" : "Revoked").font(.caption).foregroundStyle(
                .secondary)
            }
            Spacer()
            if device.revokedAt == nil { Button("Revoke", role: .destructive) { revoke = device } }
          }
        }
      }
    }.vaultActivity()
      .navigationTitle("Devices")
      .confirmationDialog(
        "Pair \(pairLabel ?? "device")?",
        isPresented: Binding(get: { pairLabel != nil }, set: { if !$0 { pairLabel = nil } }),
        titleVisibility: .visible
      ) {
        Button("Pair device") {
          Task {
            await model.run("Pairing device…") {
              try await model.revoke(
                "devices/pairing-codes/\(code.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "")/approve"
              )
              code = ""
            }
          }
        }
      }
      .confirmationDialog(
        "Revoke \(revoke?.label ?? "device")?",
        isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } }),
        titleVisibility: .visible
      ) {
        if let device = revoke {
          Button("Revoke device", role: .destructive) {
            Task {
              await model.run("Revoking device…") {
                try await model.revoke("devices/\(device.id)/revoke")
              }
            }
          }
        }
      }
  }
}
struct ConnectionsView: View {
  @Environment(VaultModel.self) private var model
  @State private var selected: Connection?
  @State private var connecting = false
  var body: some View {
    List {
      ForEach(model.connections) { connection in
        VStack(alignment: .leading, spacing: 6) {
          Text(connection.accountLabel).font(.headline)
          Text("\(connection.providerId) · \(connection.connectionName)")
          Text(connection.grantedScopes.joined(separator: ", ")).font(.caption).foregroundStyle(
            .secondary)
          if connection.revokedAt == nil {
            Button("Revoke connection", role: .destructive) { selected = connection }
          } else {
            Text("Revoked").foregroundStyle(.secondary)
          }
        }
      }
      if model.connections.isEmpty {
        ContentUnavailableView(
          "No connected accounts", systemImage: "person.crop.circle",
          description: Text("Connect a service to approve short-lived access tokens."))
      }
    }.vaultActivity()
      .navigationTitle("Accounts")
      .toolbar { Button("Connect account", systemImage: "plus") { connecting = true } }
      .sheet(isPresented: $connecting) { ConnectAccountView() }
      .confirmationDialog(
        "Revoke this connection?",
        isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } }),
        titleVisibility: .visible
      ) {
        if let connection = selected {
          Button("Revoke", role: .destructive) {
            Task {
              await model.run("Revoking account…") {
                try await model.revoke("oauth/connections/\(connection.id)/revoke")
              }
            }
          }
        }
      }
  }
}
struct SessionsView: View {
  @Environment(VaultModel.self) private var model
  @State private var selected: BrowserSession?
  var body: some View {
    List {
      ForEach(model.sessions) { session in
        VStack(alignment: .leading, spacing: 6) {
          Text(session.resourceRef)
          Text(session.state).font(.caption).foregroundStyle(.secondary)
          if session.state != "revoked" {
            Button("Revoke session", role: .destructive) { selected = session }
          }
        }
      }
      if model.sessions.isEmpty {
        ContentUnavailableView("No browser sessions", systemImage: "globe")
      }
    }.vaultActivity()
      .navigationTitle("Browser sessions")
      .confirmationDialog(
        "Revoke this browser session?",
        isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } }),
        titleVisibility: .visible
      ) {
        if let session = selected {
          Button("Revoke", role: .destructive) {
            Task {
              await model.run("Revoking session…") {
                try await model.revoke("browser-sessions/\(session.id)/revoke")
              }
            }
          }
        }
      }
  }
}
