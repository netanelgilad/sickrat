import CryptoKit
import SwiftUI
import UniformTypeIdentifiers

// Same envelope as the PWA; the server and CLI never receive the root key.
enum KeyTransfer {
  static func recipient(_ text: String, origin: String) throws -> P256.KeyAgreement.PublicKey {
    guard text.utf8.count < 16_384,
      let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
      object["type"] as? String == "sickrat-ios-transfer-request",
      object["version"] as? Int == 1, object["origin"] as? String == origin,
      let jwk = VaultCrypto.jwkFields(object["publicKey"])
    else { throw VaultError("Use a transfer request from your other iPhone for this vault.") }
    return try VaultCrypto.publicKey(jwk)
  }

  static func seal(key: SymmetricKey, recipient: P256.KeyAgreement.PublicKey, origin: String,
                   now: Date = Date()) throws -> Data {
    let ephemeral = P256.KeyAgreement.PrivateKey()
    let wrapping = try VaultCrypto.agreement(ephemeral, publicKey: recipient, transfer: true)
    let payload = ["origin": origin, "key": key.withUnsafeBytes { Data($0).base64URL },
                   "expiresAt": ISO8601DateFormatter().string(from: now.addingTimeInterval(600))]
    var envelope: [String: Any] = try VaultCrypto.seal(
      JSONSerialization.data(withJSONObject: payload), key: wrapping)
    envelope["type"] = "sickrat-ios-transfer"
    envelope["version"] = 1
    envelope["ephemeralPublicKey"] = VaultCrypto.publicJWK(ephemeral.publicKey)
    return try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
  }
}

struct TransferDocument: FileDocument {
  static var readableContentTypes: [UTType] { [.json] }
  var data: Data
  init(data: Data) { self.data = data }
  init(configuration: ReadConfiguration) throws {
    guard let data = configuration.file.regularFileContents else {
      throw VaultError("The transfer file is unreadable.")
    }
    self.data = data
  }
  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: data)
  }
}

struct SendKeyView: View {
  @Environment(VaultModel.self) private var model
  @State private var request = ""
  @State private var document: TransferDocument?
  @State private var exporting = false
  @State private var saved = false

  var body: some View {
    Form {
      Section {
        Text("On your other iPhone, connect to this vault and open Settings → Transfer vault key. Start a transfer and copy its request here.")
      }
      Section {
        TextField("Paste request from other iPhone", text: $request, axis: .vertical)
          .lineLimit(3...6).font(.callout.monospaced())
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .accessibilityIdentifier("transferRequest")
      } header: {
        Text("Transfer request")
      } footer: {
        Text("Only use a request from a device you own. Transferring the key gives that device full access to this vault.")
      }
      Section {
        Button {
          Task {
            await model.run("Preparing transfer…") {
              let origin = model.endpoint
              let recipient = try KeyTransfer.recipient(request, origin: origin)
              // Require fresh device authentication even if the vault is already unlocked.
              try await model.unlock()
              guard origin == model.endpoint, let key = model.key else { throw CancellationError() }
              document = TransferDocument(data: try KeyTransfer.seal(key: key, recipient: recipient, origin: origin))
              saved = false
              exporting = true
            }
          }
        } label: {
          OperationLabel(title: "Authenticate and save transfer", systemImage: "faceid",
                         operations: ["Preparing transfer…"])
        }.disabled(request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        if saved {
          Label("Encrypted transfer saved", systemImage: "checkmark.shield")
          Text("Send the file to your other iPhone and import it there within 10 minutes.")
            .font(.footnote).foregroundStyle(.secondary)
        }
      } footer: {
        Text("The file is encrypted for the requesting iPhone. It is a temporary transfer, not a recovery backup.")
      }
    }
    .navigationTitle("Send to another iPhone").navigationBarTitleDisplayMode(.inline)
    .vaultActivity()
    .fileExporter(isPresented: $exporting, document: document, contentType: .json,
                  defaultFilename: "sickrat-ios-transfer") { result in
      defer { document = nil }
      switch result {
      case .success: saved = true; request = ""
      case .failure(let error):
        if !VaultModel.isExpectedCancellation(error) { model.error = error.localizedDescription }
      }
    }
  }
}
