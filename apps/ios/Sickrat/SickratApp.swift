import SwiftUI
import UniformTypeIdentifiers

@main struct SickratApp: App {
  @State private var model = VaultModel.appModel()
  @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var appDelegate
  @Environment(\.scenePhase) private var phase
  @ViewBuilder private var appContent: some View {
    #if DEBUG
      if DesignFixture.enabled && DesignFixture.scenario == "receipt" {
        NavigationStack {
          RequestReceipt(outcome: .approved, device: "Mac Studio", duration: "15 minutes") {}
            .navigationTitle("Request complete").navigationBarTitleDisplayMode(.inline)
        }.tint(.indigo)
      } else { RootView() }
    #else
      RootView()
    #endif
  }
  var body: some Scene {
    WindowGroup {
      appContent.environment(model)
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
  @State private var push = PushCoordinator.shared
  @State private var selection = 0
  var body: some View {
    @Bindable var model = model
    Group {
      if model.configured {
        TabView(selection: $selection) {
          Tab("Requests", systemImage: "checkmark.shield", value: 0) { RequestsView() }.badge(
            model.pending.count)
          Tab("Vault", systemImage: "key.horizontal", value: 1) { VaultView() }
          Tab("Settings", systemImage: "gearshape", value: 2) { SettingsView() }
        }
      } else {
        WelcomeView()
      }
    }
    .tint(.indigo)
    .onChange(of: push.requestID) { _, id in if id != nil { selection = 0 } }
    .task(id: "push-\(phase)-\(model.endpoint)") {
      if phase == .active { await push.start(model) }
    }
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
      #if DEBUG
        if DesignFixture.enabled { return }
      #endif
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
  @State private var pulling = false
  @State private var push = PushCoordinator.shared
  @State private var path: [String] = []
  var body: some View {
    NavigationStack(path: $path) {
      List {
        RefreshErrorRow()
        if model.lastRefresh == nil {
          if model.refreshError == nil { InitialVaultState(showProgress: !pulling) }
        } else if model.pending.isEmpty {
          Section { RequestsClearRow() }
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
        .navigationDestination(for: String.self) { id in
          if let request = model.approvals.first(where: { $0.id == id }) {
            RequestDetail(request: request)
          } else if model.refreshing || (model.lastRefresh == nil && model.refreshError == nil) {
            ProgressView("Loading request…")
          } else if model.lastRefresh == nil {
            ContentUnavailableView("Couldn’t load request", systemImage: "wifi.exclamationmark", description: Text("Check your connection and try again."))
          } else {
            ContentUnavailableView("Request unavailable", systemImage: "tray", description: Text("It may have expired or already been removed."))
          }
        }
        .task(id: push.requestID) {
          guard let id = push.requestID else { return }
          #if DEBUG
            if !DesignFixture.enabled { await model.reload() }
          #else
            await model.reload()
          #endif
          path = [id]
          push.requestID = nil
        }
        .navigationTitle("Requests")
        .refreshable {
          pulling = true
          defer { pulling = false }
          await model.reload()
        }
        .toolbar { UnlockButton() }
    }
  }
}
struct RequestRow: View {
  let request: Approval
  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      VaultSymbol(symbol: request.pending ? "hand.raised" : request.statusSymbol,
                  tint: request.pending ? .indigo : request.statusTint)
      VStack(alignment: .leading, spacing: 5) {
        Text(request.device).font(.headline).lineLimit(2)
        Text(request.message ?? request.command).font(.subheadline).foregroundStyle(.secondary)
          .lineLimit(2)
        if request.pending {
          Text(request.accessSummary).font(.caption).foregroundStyle(.secondary)
        } else {
          Label(request.statusTitle, systemImage: request.statusSymbol)
            .font(.caption).foregroundStyle(request.statusTint)
        }
      }
    }
    .padding(.vertical, 5)
    .accessibilityElement(children: .combine)
  }
}
struct RequestDetail: View {
  @Environment(VaultModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var phase
  let request: Approval
  @State private var confirm = false
  @State private var missingValues: [String: String] = [:]
  @State private var outcome: RequestOutcome?
  @Environment(\.dynamicTypeSize) private var typeSize
  private var oauthBlocked: Bool {
    current.resourceRequests.filter { $0.type == "oauth_token" }.contains {
      OAuthPolicy.matches($0, model.connections).count != 1
    }
  }
  var current: Approval { model.approvals.first { $0.id == request.id } ?? request }
  var body: some View {
    Group {
      if let outcome {
        RequestReceipt(outcome: outcome, device: request.device, duration: request.durationTitle) {
          dismiss()
        }
      } else {
        review
      }
    }
    .navigationTitle(outcome == nil ? "Review request" : "Request complete")
    .navigationBarTitleDisplayMode(.inline)
    .sensoryFeedback(.success, trigger: outcome != nil)
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
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { outcome = .approved }
          }
        }
      }
    }
  }
  private var review: some View {
    Form {
      Section {
        VStack(alignment: .leading, spacing: 14) {
          VaultSymbol(symbol: current.pending ? "laptopcomputer" : current.statusSymbol,
                      tint: current.pending ? .indigo : current.statusTint)
          Text(current.device).font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
          if let message = current.message, !message.isEmpty {
            Text(message).font(.body).foregroundStyle(.secondary)
          }
          Label(current.pending ? "Requests your approval" : current.statusTitle,
                systemImage: current.pending ? "hand.raised" : current.statusSymbol)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(current.pending ? Color.indigo : current.statusTint)
        }.padding(.vertical, 8)
      }
      Section("Requested access") {
        ForEach(current.secretRefs, id: \.self) { ref in
          Label {
            VStack(alignment: .leading, spacing: 4) {
              Text(model.secrets.first { $0.ref == ref }?.label ?? ref)
              Text(ref).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
          } icon: { Image(systemName: "key.horizontal").foregroundStyle(.indigo) }
        }
        ForEach(current.resourceRequests.filter { $0.type != "secret" }) { resource in
          if resource.type == "oauth_token", current.pending {
            OAuthAccessRow(resource: resource)
          } else {
            VStack(alignment: .leading, spacing: 4) {
              Text(resource.resourceRef ?? resource.providerId ?? resource.type)
              Text(resource.scopes?.joined(separator: ", ") ?? resource.access ?? "")
                .font(.caption).foregroundStyle(.secondary)
            }
          }
        }
        LabeledContent("Access duration", value: current.durationTitle)
        if current.pending, let expiry = VaultDate.parse(current.expiresAt) {
          LabeledContent("Respond before") { Text(expiry, style: .time) }
        }
      }
      Section {
        DisclosureGroup("Command details") {
          Text(current.command).font(.body.monospaced()).textSelection(.enabled)
        }
      } footer: {
        Text("Only the requesting device can decrypt an approved grant.")
      }
      if current.pending {
        let missing = current.secretRefs.filter { ref in !model.secrets.contains { $0.ref == ref } }
        if !missing.isEmpty {
          Section {
            ForEach(missing, id: \.self) { ref in
              SecureField(ref, text: Binding(get: { missingValues[ref] ?? "" }, set: { missingValues[ref] = $0 }))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            }
          } header: { Text("Create requested secrets") } footer: {
            Text("These secrets aren’t in your vault yet. Enter their values to create and share them when you approve.")
          }
        }
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if current.pending {
        VStack(spacing: 12) {
          if oauthBlocked {
            Text("Update the account permissions above to approve.")
              .font(.footnote).foregroundStyle(.secondary)
          }
          Button { confirm = true } label: {
            OperationLabel(title: typeSize.isAccessibilitySize ? "Approve" : "Approve access", systemImage: "checkmark.shield", operations: ["Approving access…"])
              .frame(maxWidth: .infinity).padding(.vertical, 5)
          }.buttonStyle(.borderedProminent).controlSize(.large)
            .accessibilityLabel("Approve access")
            .disabled(model.busy || oauthBlocked)
          Button(role: .destructive) {
            Task {
              await model.run("Denying request…") {
                try await model.revoke("approvals/\(current.id)/deny")
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { outcome = .denied }
              }
            }
          } label: {
            OperationLabel(title: typeSize.isAccessibilitySize ? "Deny" : "Deny request", systemImage: "xmark", operations: ["Denying request…"])
              .frame(maxWidth: .infinity).padding(.vertical, 5)
          }.buttonStyle(.bordered).tint(.red).controlSize(.large)
            .accessibilityLabel("Deny request").disabled(model.busy)
        }.padding().background(.bar)
      }
    }
    .vaultActivity()
  }
}
struct UnlockButton: ToolbarContent {
  @Environment(VaultModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private var unlocking: Bool { model.activity == "Unlocking vault…" }
  var body: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Button {
        Task {
          await model.run(model.key == nil ? "Unlocking vault…" : "Locking vault…") {
            if model.key == nil { try await model.unlock() } else { model.lock() }
          }
        }
      } label: {
        ZStack {
          if unlocking {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: model.key == nil ? "lock" : "lock.open")
              .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
          }
        }.frame(width: 24, height: 24)
      }
      .accessibilityLabel(
        unlocking ? "Unlocking vault" : (model.key == nil ? "Unlock vault" : "Lock vault")
      )
      .sensoryFeedback(.success, trigger: model.key != nil) { _, unlocked in unlocked }
      .disabled(model.busy)
    }
  }
}
struct VaultView: View {
  @Environment(VaultModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Namespace private var secretTransition
  @State private var pulling = false
  @State private var search = ""
  @State private var adding = false
  private var results: [Secret] {
    model.secrets.filter {
      search.isEmpty || $0.ref.localizedCaseInsensitiveContains(search)
        || $0.label.localizedCaseInsensitiveContains(search)
    }.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
  }
  var body: some View {
    NavigationStack {
      List {
        RefreshErrorRow()
        if search.isEmpty {
          Section {
            NavigationLink { ConnectionsView() } label: {
              VaultCategoryRow(title: "Connected accounts", symbol: "person.crop.circle", tint: .blue,
                               count: model.lastRefresh == nil ? nil : model.connections.filter { $0.revokedAt == nil }.count)
            }
            NavigationLink { SessionsView() } label: {
              VaultCategoryRow(title: "Browser sessions", symbol: "globe", tint: .teal,
                               count: model.lastRefresh == nil ? nil : model.sessions.filter { $0.state != "revoked" }.count)
            }
          }
        }
        Section(search.isEmpty ? "Secrets" : "Search results") {
          if model.lastRefresh == nil {
            if model.refreshError == nil { InitialVaultState(showProgress: !pulling, title: "Fetching secrets…") }
          } else if model.secrets.isEmpty {
            ContentUnavailableView {
              Label("Your first secret", systemImage: "key.horizontal")
            } description: {
              Text("Store an API key or password. Share access only when you approve a request.")
            } actions: {
              Button("Add a secret") { adding = true }.buttonStyle(.borderedProminent)
            }
          } else if results.isEmpty {
            ContentUnavailableView.search(text: search)
          }
          ForEach(results) { secret in
            NavigationLink {
              SecretDetail(secret: secret)
                .vaultNavigationTransition(id: secret.id, namespace: secretTransition, reduceMotion: reduceMotion)
            } label: {
              HStack(spacing: 12) {
                VaultSymbol(symbol: "key.horizontal", tint: .indigo)
                  .matchedTransitionSource(id: secret.id, in: secretTransition)
                VStack(alignment: .leading, spacing: 4) {
                  Text(secret.label).font(.body.weight(.medium))
                  Text(secret.ref).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
              }.padding(.vertical, 3)
            }
          }
        }
      }.vaultActivity()
        .navigationTitle("Vault").searchable(text: $search, prompt: "Find a secret")
        .refreshable {
          pulling = true
          defer { pulling = false }
          await model.reload()
        }
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) { Button("Add secret", systemImage: "plus") { adding = true } }
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
        LabeledContent("Updated") {
          if let date = VaultDate.parse(secret.updatedAt) {
            Text(date, format: .dateTime.day().month(.abbreviated).year())
          } else { Text("Unavailable").foregroundStyle(.secondary) }
        }
      }
      Section("Value") {
        if let value {
          Text(value).font(.system(.body, design: .monospaced)).privacySensitive()
            .textSelection(.enabled)
          Button("Hide value") { self.value = nil }
        } else {
          Button {
            Task {
              await model.run("Revealing secret…") {
                if model.key == nil { try await model.unlock() }
                value = try await model.value(for: secret.ref)
              }
            }
          } label: {
            OperationLabel(
              title: "Reveal value", systemImage: "eye", operations: ["Revealing secret…"])
          }.disabled(model.busy)
        }
      }
    }.vaultActivity()
      .navigationTitle(secret.label).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button("Edit") { editing = true } }
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
            Button {
              Task {
                await model.run("Saving secret…") {
                  if model.key == nil { try await model.unlock() }
                  try await model.saveSecret(ref: ref, label: name, value: value)
                  value = ""
                  dismiss()
                }
              }
            } label: {
              OperationLabel(title: "Save", operations: ["Saving secret…"])
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
        Section {
          HStack(spacing: 14) {
            VaultSymbol(symbol: "lock.shield", tint: .indigo)
            VStack(alignment: .leading, spacing: 5) {
              Text("Your vault").font(.headline)
              Text(URL(string: model.endpoint)?.host ?? model.endpoint)
                .font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
            }
          }.padding(.vertical, 7)
        }
        Section("Access & alerts") {
          NavigationLink { NotificationSettingsView() } label: {
            Label("Notifications", systemImage: "bell.badge")
          }
          NavigationLink { DevicesView() } label: {
            Label("Paired devices", systemImage: "laptopcomputer.and.iphone")
          }
        }
        Section {
          Button {
            Task {
              await model.run(model.key == nil ? "Unlocking vault…" : "Locking vault…") {
                if model.key == nil { try await model.unlock() } else { model.lock() }
              }
            }
          } label: {
            OperationLabel(title: model.key == nil ? "Unlock vault" : "Lock vault",
                           systemImage: model.key == nil ? "lock" : "lock.open",
                           operations: ["Unlocking vault…", "Locking vault…"])
          }
          NavigationLink { TransferView() } label: {
            Label("Transfer vault key", systemImage: "iphone.and.arrow.forward")
          }
        } header: { Text("Security") } footer: {
          Text("Your vault locks when you leave the app. Its key is protected by this iPhone’s Keychain and device authentication. Keep your web passkey for recovery.")
        }
        Section {
          if let url = URL(string: model.endpoint) {
            Link(destination: url) { Label("Open web console", systemImage: "safari") }
          }
        } footer: {
          Text("Sickrat \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") · Build \(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") · Development preview")
        }
      }.vaultActivity().navigationTitle("Settings")
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
          "Start here, then use the request on your other iPhone or in Settings → Native iOS transfer in your web console. Import the encrypted file here within 10 minutes."
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
      Section {
        NavigationLink("Send to another iPhone") { SendKeyView() }
      } footer: {
        Text("Already have your key on this iPhone? Transfer it directly to another iPhone.")
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
  @State private var revokingID: String?
  var body: some View {
    Form {
      Section("Pair a device") {
        TextField("Pairing code", text: $code).textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        Button {
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
        } label: {
          OperationLabel(
            title: "Review device", operations: ["Looking up device…", "Pairing device…"])
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
            if device.revokedAt == nil {
              Button(role: .destructive) {
                revoke = device
              } label: {
                if revokingID == device.id { ProgressView("Revoking…") } else { Text("Revoke") }
              }
            }
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
              revokingID = device.id
              defer { revokingID = nil }
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
  @State private var connecting = false
  var body: some View {
    List {
      ForEach(model.connections) { connection in
        NavigationLink {
          ConnectionDetail(connection: connection)
        } label: {
          VStack(alignment: .leading, spacing: 5) {
            Text(connection.connectionName).font(.headline)
            Text(connection.accountLabel).font(.subheadline).foregroundStyle(.secondary)
            Text(connection.revokedAt == nil ? connection.providerId : "Revoked").font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
      if model.connections.isEmpty {
        ContentUnavailableView(
          "No connected accounts", systemImage: "person.crop.circle",
          description: Text("Connect a service to approve short-lived access tokens."))
      }
    }
    .navigationTitle("Accounts")
    .toolbar { Button("Connect account", systemImage: "plus") { connecting = true } }
    .sheet(isPresented: $connecting) { ConnectAccountView() }
  }
}
struct SessionsView: View {
  @Environment(VaultModel.self) private var model
  @State private var selected: BrowserSession?
  @State private var revokingID: String?
  var body: some View {
    List {
      ForEach(model.sessions) { session in
        VStack(alignment: .leading, spacing: 6) {
          Text(session.resourceRef)
          Text(session.state).font(.caption).foregroundStyle(.secondary)
          if session.state != "revoked" {
            Button(role: .destructive) {
              selected = session
            } label: {
              if revokingID == session.id {
                ProgressView("Revoking session…")
              } else {
                Text("Revoke session")
              }
            }
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
              revokingID = session.id
              defer { revokingID = nil }
              await model.run("Revoking session…") {
                try await model.revoke("browser-sessions/\(session.id)/revoke")
              }
            }
          }
        }
      }
  }
}
