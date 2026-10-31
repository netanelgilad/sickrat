import CryptoKit
import Foundation
import LocalAuthentication
import Observation

struct PublicJWK: Sendable, Decodable {
  let kty: String
  let crv: String
  let x: String
  let y: String
  var fields: [String: String] { ["kty": kty, "crv": crv, "x": x, "y": y] }
}

struct Approval: Sendable, Decodable, Identifiable {
  let id: String
  let device: String
  let command: String
  let message: String?
  let secretRefs: [String]
  let resourceRequests: [Resource]
  let accessDurationSeconds: Int?
  let status: String
  let expiresAt: String
  let expired: Bool
  let ephemeralPublicKey: PublicJWK?
  struct Resource: Sendable, Decodable, Identifiable {
    var id: String {
      [
        type, ref ?? "", providerId ?? "", connectionName ?? "", env ?? "", resourceRef ?? "",
        access ?? "",
      ].joined(separator: "|")
    }
    let type: String
    let ref: String?
    let providerId: String?
    let connectionName: String?
    let scopes: [String]?
    let env: String?
    let resourceRef: String?
    let access: String?
  }
  var pending: Bool { status == "pending" && !expired }
}
struct Secret: Sendable, Decodable, Identifiable {
  let id: String
  let ref: String
  let label: String
  let updatedAt: String
}
struct Device: Sendable, Decodable, Identifiable {
  let id: String
  let label: String
  let revokedAt: String?
}
struct Connection: Sendable, Decodable, Identifiable {
  let id: String
  let providerId: String
  let connectionName: String
  let accountLabel: String
  var accountSubject: String? = nil
  let grantedScopes: [String]
  let revokedAt: String?
}
struct BrowserSession: Sendable, Decodable, Identifiable {
  let id: String
  let resourceRef: String
  let state: String
}

final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

@MainActor @Observable final class VaultModel {
  var endpoint = UserDefaults.standard.string(forKey: "vault.endpoint") ?? ""
  var vaultName = "Sickrat"
  var key: SymmetricKey?
  var approvals: [Approval] = []
  var secrets: [Secret] = []
  var devices: [Device] = []
  var connections: [Connection] = []
  var sessions: [BrowserSession] = []
  var error: String?
  var activity: String?
  var busy: Bool { activity != nil }
  var refreshing = false
  var refreshError: String?
  private var lockGeneration = 0
  var lastRefresh: Date?
  var lastRequestRefresh: Date?
  var requestHistory: [Approval] = []
  var loadingHistory = false
  var historyError: String?
  var historyLoaded = false
  var transferKey: P256.KeyAgreement.PrivateKey?
  private let session: URLSession
  init(session: URLSession? = nil) {
    self.session = session ?? Self.makeSession()
  }
  private static func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 25
    configuration.urlCache = nil
    return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
  }
  var configured: Bool { !endpoint.isEmpty }
  var pending: [Approval] { approvals.filter(\.pending) }
  func canonicalEndpoint(_ value: String) throws -> String {
    guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
      url.scheme == "https", url.host != nil, url.user == nil, url.password == nil,
      url.query == nil, url.fragment == nil, url.path == "" || url.path == "/"
    else { throw VaultError("Enter your vault’s HTTPS origin, without a path or credentials.") }
    return url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  }
  func request(
    _ path: String, method: String = "GET", body: [String: Any]? = nil, origin: String? = nil,
    bearer: String? = nil
  ) async throws -> [String: Any] {
    #if DEBUG
      if DesignFixture.enabled { throw VaultError("Sample previews do not contact a vault.") }
    #endif
    let root = try canonicalEndpoint(origin ?? endpoint)
    guard let url = URL(string: root + "/api/" + path) else {
      throw VaultError("Invalid vault address.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse, response.url?.host == url.host,
      (200..<300).contains(response.statusCode)
    else {
      throw VaultError(
        "The vault request failed. Check the address, connection, and whether this request is still pending."
      )
    }
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw VaultError(
        "The vault returned an unexpected response. A Cloudflare Access sign-in may be required.")
    }
    return object
  }
  func decode<T: Decodable>(_ object: [String: Any], _ field: String, as: T.Type) throws -> T {
    guard let value = object[field] else { throw VaultError("Missing \(field) in vault response.") }
    return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value))
  }
  func connect(_ value: String) async throws {
    let origin = try canonicalEndpoint(value)
    let response = try await request("capabilities", origin: origin)
    guard let vault = response["vault"] as? [String: Any], let name = vault["name"] as? String
    else { throw VaultError("This address is not a Sickrat vault.") }
    lock()
    transferKey = nil
    endpoint = origin
    vaultName = name
    UserDefaults.standard.set(origin, forKey: "vault.endpoint")
    lastRefresh = nil
    lastRequestRefresh = nil
    requestHistory = []
    historyLoaded = false
    historyError = nil
    refreshError = nil
    approvals = []
    secrets = []
    devices = []
    connections = []
    sessions = []
    try await refresh()
  }
  func refresh() async throws {
    guard !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    do {
      try await fetchSnapshot()
      refreshError = nil
    } catch {
      if !Self.isExpectedCancellation(error) && !Task.isCancelled {
        refreshError = "Couldn’t refresh. Pull to try again."
      }
      throw error
    }
  }
  func reload() async {
    #if DEBUG
      if DesignFixture.enabled {
        try? await Task.sleep(for: .seconds(20))
        return
      }
    #endif
    do { try await refresh() } catch { /* Refresh errors are inline, never modal. */  }
  }
  private func fetch<T: Decodable & Sendable>(
    _ path: String, field: String, as type: T.Type, origin: String
  ) async throws -> T {
    try decode(try await request(path, origin: origin), field, as: type)
  }
  private func fetchSnapshot() async throws {
    let origin = endpoint
    async let pending: [Approval] = fetch("approvals?status=pending", field: "approvals", as: [Approval].self, origin: origin)
    async let recent: [Approval] = fetch("approvals?limit=3", field: "approvals", as: [Approval].self, origin: origin)
    async let nextSecrets: [Secret] = fetch("secrets", field: "secrets", as: [Secret].self, origin: origin)
    async let nextDevices: [Device] = fetch("devices", field: "devices", as: [Device].self, origin: origin)
    async let nextConnections: [Connection] = fetch("oauth/connections", field: "connections", as: [Connection].self, origin: origin)
    async let nextSessions: [BrowserSession] = fetch("browser-sessions", field: "browserSessions", as: [BrowserSession].self, origin: origin)
    let (pendingItems, recentItems) = try await (pending, recent)
    try Task.checkCancellation()
    guard endpoint == origin else { throw CancellationError() }
    // Publish the decision inbox before slower account/session metadata arrives.
    let pendingIDs = Set(pendingItems.map(\.id))
    approvals = pendingItems + recentItems.filter { !pendingIDs.contains($0.id) }
    lastRequestRefresh = Date()
    let catalog = try await (nextSecrets, nextDevices, nextConnections, nextSessions)
    try Task.checkCancellation()
    guard endpoint == origin else { throw CancellationError() }
    (secrets, devices, connections, sessions) = catalog
    lastRefresh = Date()
  }
  func loadHistory() async {
    guard !loadingHistory else { return }
    loadingHistory = true
    defer { loadingHistory = false }
    #if DEBUG
      if DesignFixture.enabled {
        requestHistory = approvals.filter { !$0.pending }
        historyLoaded = true
        return
      }
    #endif
    let origin = endpoint
    do {
      let result: [Approval] = try await fetch("approvals?limit=100", field: "approvals", as: [Approval].self, origin: origin)
      try Task.checkCancellation()
      guard endpoint == origin else { return }
      requestHistory = result.filter { !$0.pending }
      historyLoaded = true
      historyError = nil
    } catch {
      if endpoint == origin && !Self.isExpectedCancellation(error) {
        historyError = "Couldn’t load history. Try again."
      }
    }
  }
  func loadNotificationRequest(_ id: String) async {
    guard !approvals.contains(where: { $0.id == id }) else { return }
    let origin = endpoint
    do {
      let request: Approval = try await fetch("approvals/\(id)", field: "approval", as: Approval.self, origin: origin)
      guard endpoint == origin, !Task.isCancelled else { return }
      if !approvals.contains(where: { $0.id == id }) { approvals.append(request) }
    } catch { /* The destination presents the existing unavailable/offline state. */ }
  }
  static func isExpectedCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    let nsError = error as NSError
    if nsError.domain == NSCocoaErrorDomain && nsError.code == NSUserCancelledError { return true }
    if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return true }
    if nsError.domain == LAError.errorDomain {
      return [
        LAError.userCancel.rawValue, LAError.systemCancel.rawValue, LAError.appCancel.rawValue,
      ].contains(nsError.code)
    }
    return nsError.domain == NSOSStatusErrorDomain && nsError.code == Int(errSecUserCanceled)
  }
  func run(_ label: String = "Working…", _ work: () async throws -> Void) async {
    guard !busy else { return }
    activity = label
    defer { activity = nil }
    do { try await work() } catch {
      if !Self.isExpectedCancellation(error) && !Task.isCancelled {
        self.error = error.localizedDescription
      }
    }
  }
  func lock() {
    lockGeneration += 1
    key = nil
  }
  func unlock() async throws {
    let account = endpoint
    let generation = lockGeneration
    let data = try await Task.detached(priority: .userInitiated) { try KeyStore.read(account) }
      .value
    try Task.checkCancellation()
    guard generation == lockGeneration, account == endpoint else { throw CancellationError() }
    key = SymmetricKey(data: data)
  }
  func startTransfer() throws -> String {
    let pair = P256.KeyAgreement.PrivateKey()
    transferKey = pair
    let value: [String: Any] = [
      "type": "sickrat-ios-transfer-request", "version": 1, "origin": endpoint,
      "publicKey": VaultCrypto.publicJWK(pair.publicKey),
    ]
    return String(
      decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
      as: UTF8.self)
  }
  func importTransfer(_ data: Data) throws {
    guard data.count < 16_384, let pair = transferKey,
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      object["type"] as? String == "sickrat-ios-transfer", object["version"] as? Int == 1,
      let ephemeral = VaultCrypto.jwkFields(object["ephemeralPublicKey"]),
      let ciphertext = object["ciphertext"] as? String, let iv = object["iv"] as? String
    else { throw VaultError("Start a transfer on this device, then import its encrypted file.") }
    let wrapping = try VaultCrypto.agreement(
      pair, publicKey: VaultCrypto.publicKey(ephemeral), transfer: true)
    let plaintext = try VaultCrypto.open(["ciphertext": ciphertext, "iv": iv], key: wrapping)
    guard let payload = try JSONSerialization.jsonObject(with: plaintext) as? [String: String],
      payload["origin"] == endpoint,
      let encoded = payload["key"], let expiry = payload["expiresAt"],
      let date = ISO8601DateFormatter().date(from: expiry), date > Date(),
      date < Date().addingTimeInterval(660)
    else { throw VaultError("This transfer expired or belongs to a different vault.") }
    let raw = try Data(base64URL: encoded)
    guard raw.count == 32 else { throw VaultError("Invalid vault key.") }
    try KeyStore.save(raw, account: endpoint)
    key = SymmetricKey(data: raw)
    transferKey = nil
  }
  func saveSecret(ref: String, label: String, value: String) async throws {
    guard let key else { throw VaultError("Unlock your vault first.") }
    guard !ref.isEmpty, ref.count <= 512,
      ref == ref.trimmingCharacters(in: .whitespacesAndNewlines),
      !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !value.isEmpty
    else { throw VaultError("Use a reference such as openai/api-key and enter a name and value.") }
    var record = try VaultCrypto.secret(value, key: key)
    record["ref"] = ref
    record["label"] = label
    _ = try await request("secrets", method: "POST", body: record)
    try await refresh()
  }
  func value(for ref: String) async throws -> String {
    let generation = lockGeneration
    guard let key else { throw VaultError("Unlock your vault first.") }
    let result = try await request("secrets/resolve", method: "POST", body: ["refs": [ref]])
    guard let records = result["secrets"] as? [[String: Any]], let record = records.first,
      record["ref"] as? String == ref, record["kdf"] as? String == VaultCrypto.format,
      let ciphertext = record["ciphertext"] as? String, let iv = record["iv"] as? String
    else { throw VaultError("The secret is missing or uses unsupported encryption.") }
    let data = try VaultCrypto.open(["ciphertext": ciphertext, "iv": iv], key: key)
    guard let text = String(data: data, encoding: .utf8) else {
      throw VaultError("Invalid secret encoding.")
    }
    try Task.checkCancellation()
    guard generation == lockGeneration else { throw CancellationError() }
    return text
  }
  func approve(_ approval: Approval, missingValues: [String: String] = [:]) async throws {
    guard key != nil else { throw VaultError("Unlock your vault first.") }
    let result = try await request("approvals/\(approval.id)")
    let fresh = try decode(result, "approval", as: Approval.self)
    guard fresh.pending,
      fresh.resourceRequests.allSatisfy({
        ["secret", "oauth_token", "browser_session"].contains($0.type)
      }), let publicKey = fresh.ephemeralPublicKey
    else {
      throw VaultError(
        "This request expired, was already decided, or uses an unsupported resource.")
    }
    var values: [String: String] = [:]
    var created: [[String: String]] = []
    for ref in fresh.secretRefs {
      if secrets.contains(where: { $0.ref == ref }) {
        values[ref] = try await value(for: ref)
      } else {
        guard let value = missingValues[ref], !value.isEmpty, let key else {
          throw VaultError("Enter a value for \(ref) before approving.")
        }
        var encrypted = try VaultCrypto.secret(value, key: key)
        encrypted["ref"] = ref
        encrypted["label"] = ref
        created.append(encrypted)
        values[ref] = value
      }
    }
    let now = Date()
    var payload: [String: Any] = [
      "secrets": values, "approvedAt": ISO8601DateFormatter().string(from: now),
    ]
    if let seconds = fresh.accessDurationSeconds {
      payload["accessExpiresAt"] = ISO8601DateFormatter().string(
        from: now.addingTimeInterval(Double(seconds)))
    }
    payload["oauthTokens"] = try await oauthGrants(fresh)
    let browser = try await browserGrant(fresh)
    if let browser { payload["browserSession"] = browser.grant }
    let grant = try VaultCrypto.grant(payload, recipient: publicKey.fields)
    var body: [String: Any] = ["grantCiphertext": grant, "createdSecrets": created]
    if let browser { body["browserSessionAuthorization"] = browser.authorization }
    guard key != nil else {
      throw VaultError(
        "The vault locked before approval completed. Unlock and review the request again.")
    }
    _ = try await request("approvals/\(fresh.id)/grant", method: "POST", body: body)
    try await refresh()
  }
  func revoke(_ path: String) async throws {
    _ = try await request(path, method: "POST")
    try await refresh()
  }
}
