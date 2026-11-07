import CommonCrypto
import CryptoKit
import SwiftUI
import UniformTypeIdentifiers

// Portable recovery, independent of passkeys, Apple IDs, and the original device.
// Only the encrypted file leaves this process; the password is never persisted.
enum VaultRecovery {
  static let rounds: UInt32 = 600_000
  static func wrappingKey(password: String, salt: Data) throws -> SymmetricKey {
    guard password.count >= 16, password.utf8.count <= 1024, salt.count == 32 else {
      throw VaultError("Use a recovery password of at least 16 characters (at most 1024 UTF-8 bytes).")
    }
    let passwordBytes = Array(password.utf8)
    var derived = [UInt8](repeating: 0, count: 32)
    let status = passwordBytes.withUnsafeBytes { passwordBuffer in
      salt.withUnsafeBytes { saltBuffer in
        CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
          passwordBuffer.baseAddress!.assumingMemoryBound(to: Int8.self), passwordBytes.count,
          saltBuffer.baseAddress!.assumingMemoryBound(to: UInt8.self), salt.count,
          CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), rounds, &derived, derived.count)
      }
    }
    guard status == kCCSuccess else { throw VaultError("Couldn’t protect the recovery file.") }
    return SymmetricKey(data: derived)
  }
  static func seal(_ key: SymmetricKey, origin: String, password: String) throws -> Data {
    let salt = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    let wrapping = try wrappingKey(password: password, salt: salt)
    let payload = ["origin": origin, "key": key.withUnsafeBytes { Data($0).base64URL }]
    var envelope: [String: Any] = try VaultCrypto.seal(JSONSerialization.data(withJSONObject: payload), key: wrapping)
    envelope["type"] = "sickrat-recovery"
    envelope["version"] = 1
    envelope["kdf"] = "PBKDF2-SHA256"
    envelope["rounds"] = rounds
    envelope["salt"] = salt.base64URL
    return try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
  }
  static func open(_ data: Data, origin: String, password: String) throws -> Data {
    guard data.count < 16_384,
      let record = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      record["type"] as? String == "sickrat-recovery", record["version"] as? Int == 1,
      record["kdf"] as? String == "PBKDF2-SHA256", record["rounds"] as? UInt32 == rounds,
      let salt = record["salt"] as? String, let iv = record["iv"] as? String,
      let ciphertext = record["ciphertext"] as? String else {
      throw VaultError("This isn’t a supported Sickrat recovery file.")
    }
    let wrapping = try wrappingKey(password: password, salt: Data(base64URL: salt))
    let clear: Data
    do { clear = try VaultCrypto.open(["iv": iv, "ciphertext": ciphertext], key: wrapping) }
    catch { throw VaultError("The password is incorrect or the recovery file was changed.") }
    guard let payload = try JSONSerialization.jsonObject(with: clear) as? [String: String],
      payload["origin"] == origin, let value = payload["key"],
      let raw = try? Data(base64URL: value), raw.count == 32 else {
      throw VaultError("This recovery file belongs to another vault.")
    }
    return raw
  }
}

extension VaultModel {
  func initializeKey() async throws {
    let origin = endpoint, generation = recoveryGeneration
    // Query all encrypted record categories afresh. Never initialize from a failed
    // or partial catalog, or replace a key for a populated vault.
    let secrets = try await request("secrets", origin: origin)
    let connections = try await request("oauth/connections", origin: origin)
    let sessions = try await request("browser-sessions", origin: origin)
    guard (secrets["secrets"] as? [Any])?.isEmpty == true,
      (connections["connections"] as? [Any])?.isEmpty == true,
      (sessions["browserSessions"] as? [Any])?.isEmpty == true else {
      throw VaultError("This vault has encrypted records. Restore its key or transfer it from your other iPhone.")
    }
    guard origin == endpoint, generation == recoveryGeneration else { throw CancellationError() }
    let generated = SymmetricKey(size: .bits256)
    try KeyStore.save(generated.withUnsafeBytes { Data($0) }, account: origin)
    key = generated
  }
}

struct RecoveryView: View {
  @Environment(VaultModel.self) private var model
  @Environment(\.scenePhase) private var phase
  @State private var password = ""
  @State private var confirmation = ""
  @State private var document: TransferDocument?
  @State private var importing = false
  @State private var exporting = false
  @State private var status: String?
  var body: some View {
    Form {
      Section {
        Text("Save an encrypted copy of your vault key in Files. You need both this file and its password to recover on another iPhone. Keep the password in your password manager, separately from the file.")
        SecureField("Recovery password", text: $password).textContentType(.password)
        SecureField("Confirm password for backup", text: $confirmation).textContentType(.newPassword)
      } header: { Text("Recovery password") } footer: {
        Text("Use a unique password of at least 16 characters. Sickrat cannot reset it. Recovery grants full vault access; it does not revoke your other devices.")
      }
      Section {
        Button {
          Task { await model.run("Preparing backup…") {
            let origin = model.endpoint
            try await model.unlock()
            guard origin == model.endpoint, let key = model.key else { throw CancellationError() }
            let secret = password
            let data = try await Task.detached(priority: .userInitiated) {
              try VaultRecovery.seal(key, origin: origin, password: secret)
            }.value
            guard origin == model.endpoint, model.key != nil else { throw CancellationError() }
            document = TransferDocument(data: data)
            exporting = true
          } }
        } label: {
          OperationLabel(title: "Authenticate and save backup", systemImage: "externaldrive", operations: ["Preparing backup…"])
        }.disabled(model.busy || password.count < 16 || password != confirmation)
        Button("Restore from recovery file") { importing = true }
          .disabled(model.busy || password.count < 16)
        if let status { Text(status).foregroundStyle(.secondary) }
      } footer: { Text("Restore adds the key to this iPhone’s protected Keychain. An existing key is never replaced.") }
      Section {
        Button("Create key for an empty vault") {
          Task { await model.run("Creating vault key…") {
            try await model.initializeKey()
            status = "Vault key created. Save a recovery backup before adding secrets."
          } }
        }.disabled(model.busy)
      } footer: { Text("Only for a newly provisioned, empty vault. Existing vaults require their original key.") }
    }
    .navigationTitle("Vault recovery").navigationBarTitleDisplayMode(.inline).vaultActivity()
    .onChange(of: phase) { _, value in if value == .background { password = ""; confirmation = "" } }
    .fileExporter(isPresented: $exporting, document: document, contentType: .json,
                  defaultFilename: "sickrat-recovery") { result in
      document = nil
      switch result {
      case .success: status = "Encrypted backup saved. Keep its password safe."; password = ""; confirmation = ""
      case .failure(let error): if !VaultModel.isExpectedCancellation(error) { model.error = error.localizedDescription }
      }
    }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
      Task { await model.run("Restoring vault key…") {
        let url = try result.get()
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0, size < 16_384 else {
          throw VaultError("This recovery file is too large.")
        }
        let data = try Data(contentsOf: url), origin = model.endpoint, secret = password
        let generation = model.recoveryGeneration
        let raw = try await Task.detached(priority: .userInitiated) {
          try VaultRecovery.open(data, origin: origin, password: secret)
        }.value
        guard origin == model.endpoint, generation == model.recoveryGeneration else { throw CancellationError() }
        try KeyStore.save(raw, account: origin)
        model.key = SymmetricKey(data: raw)
        password = ""; confirmation = ""
        status = "Vault key restored on this iPhone."
      } }
    }
  }
}
