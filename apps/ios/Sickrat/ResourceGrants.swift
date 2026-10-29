import CryptoKit
import Foundation

extension VaultModel {
  func decryptRecord(_ record: [String: Any], prefix: String = "") throws -> String {
    guard let key, record[prefix.isEmpty ? "kdf" : prefix + "Kdf"] as? String == VaultCrypto.format,
      let ciphertext = record[prefix.isEmpty ? "ciphertext" : prefix + "Ciphertext"] as? String,
      let iv = record[prefix.isEmpty ? "iv" : prefix + "Iv"] as? String
    else { throw VaultError("Unsupported encrypted record or vault is locked.") }
    return String(
      decoding: try VaultCrypto.open(["ciphertext": ciphertext, "iv": iv], key: key), as: UTF8.self)
  }
  func oauthGrants(_ approval: Approval) async throws -> [String: Any] {
    guard let key else { throw VaultError("Unlock your vault first.") }
    var output: [String: Any] = [:]
    var refreshed: [String: [String: Any]] = [:]
    for resource in approval.resourceRequests where resource.type == "oauth_token" {
      let scopes = resource.scopes ?? []
      let matches = OAuthPolicy.matches(resource, connections)
      guard matches.count == 1, let connection = matches.first, let env = resource.env else {
        throw VaultError(
          "Select a named connected account with the requested scopes in the CLI request.")
      }
      var token = refreshed[connection.id]
      if token == nil {
        let response = try await request("oauth/connections/\(connection.id)/resolve")
        guard var record = response["connection"] as? [String: Any] else {
          throw VaultError("Connection is unavailable.")
        }
        let refreshToken = try decryptRecord(record, prefix: "refreshToken")
        let result: [String: Any]
        do {
          result = try await request(
            "oauth/token", method: "POST",
            body: [
              "action": "refresh_token", "providerId": connection.providerId,
              "refreshToken": refreshToken, "scopes": connection.grantedScopes,
              "connectionId": connection.id,
            ])
        } catch {
          if Self.isExpectedCancellation(error) { throw error }
          throw VaultError(
            "Couldn’t refresh \(connection.connectionName). Check your connection, or reconnect the account from this request’s Access section and try again."
          )
        }
        guard let granted = result["scopes"] as? [String],
          Set(connection.grantedScopes).isSubset(of: Set(granted))
        else {
          throw VaultError(
            "The refreshed token has fewer scopes. Reconnect this account from the request’s Access section."
          )
        }
        if let rotated = result["refreshToken"] as? String {
          let encrypted = try VaultCrypto.secret(rotated, key: key)
          record["refreshTokenCiphertext"] = encrypted["ciphertext"]
          record["refreshTokenIv"] = encrypted["iv"]
          record["refreshTokenSalt"] = encrypted["salt"]
          record["refreshTokenKdf"] = encrypted["kdf"]
          record["grantedScopes"] = granted
          record["tokenType"] = result["tokenType"]
          record["accessTokenExpiresAt"] = (result["expiresIn"] as? Double).map {
            ISO8601DateFormatter().string(from: Date().addingTimeInterval($0))
          }
          _ = try await request("oauth/connections", method: "POST", body: record)
        }
        token = result
        refreshed[connection.id] = result
      }
      guard let token, let accessToken = token["accessToken"] as? String,
        let granted = token["scopes"] as? [String], Set(scopes).isSubset(of: Set(granted))
      else { throw VaultError("Provider did not return the requested access.") }
      var grant: [String: Any] = [
        "providerId": connection.providerId, "connectionId": connection.id,
        "connectionName": connection.connectionName, "accessToken": accessToken,
        "tokenType": token["tokenType"] as? String ?? "Bearer", "scopes": granted,
      ]
      if let seconds = token["expiresIn"] as? Double {
        grant["expiresAt"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(seconds))
      }
      output[env] = grant
    }
    return output
  }
  func browserGrant(_ approval: Approval) async throws -> (
    grant: [String: Any], authorization: [String: Any]
  )? {
    guard let resource = approval.resourceRequests.first(where: { $0.type == "browser_session" })
    else { return nil }
    guard approval.resourceRequests.count == 1, let ref = resource.resourceRef,
      let access = resource.access, let key
    else { throw VaultError("Invalid browser-session request.") }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let deadline =
      formatter.date(from: approval.expiresAt)
      ?? ISO8601DateFormatter().date(from: approval.expiresAt)
    guard let deadline, deadline > Date() else { throw VaultError("This request has expired.") }
    let expiresAt = ISO8601DateFormatter().string(
      from: min(deadline, Date().addingTimeInterval(300)))
    let capability = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64URL }
    var authorization: [String: Any] = [
      "resourceRef": ref,
      "transactionCapabilityHash": Data(SHA256.hash(data: Data(capability.utf8))).base64URL,
      "expiresAt": expiresAt,
    ]
    var grant: [String: Any] = [
      "resourceRef": ref, "access": access, "transactionCapability": capability,
      "expiresAt": expiresAt,
    ]
    let capabilities = try await request("capabilities")
    guard let vault = capabilities["vault"] as? [String: Any], let name = vault["name"] as? String
    else { throw VaultError("Vault identity unavailable.") }
    grant["vaultId"] = name
    if access == "create" {
      let id = UUID().uuidString.lowercased()
      let dataKey = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64URL }
      let wrapped = try VaultCrypto.secret(dataKey, key: key)
      grant["sessionId"] = id
      grant["artifactObjectKey"] = "browser-session-artifacts/\(id)/current"
      grant["dataKey"] = dataKey
      authorization["sessionId"] = id
      authorization["wrappedDataKey"] = wrapped["ciphertext"]
      authorization["wrappedDataKeyIv"] = wrapped["iv"]
      authorization["wrappedDataKeyKdf"] = wrapped["kdf"]
      authorization["encryptionAlgorithm"] = "AES-256-GCM"
    } else {
      let encoded = ref.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
      let response = try await request("browser-sessions/resolve?resourceRef=\(encoded)")
      guard let record = response["browserSession"] as? [String: Any],
        record["encryptionAlgorithm"] as? String == "AES-256-GCM",
        record["wrappedDataKeyKdf"] as? String == VaultCrypto.format,
        let ciphertext = record["wrappedDataKey"] as? String,
        let iv = record["wrappedDataKeyIv"] as? String,
        let id = record["id"] as? String, let objectKey = record["artifactObjectKey"] as? String
      else { throw VaultError("Browser-session encryption is unsupported.") }
      let dataKey = String(
        decoding: try VaultCrypto.open(["ciphertext": ciphertext, "iv": iv], key: key),
        as: UTF8.self)
      guard try Data(base64URL: dataKey).count == 32 else {
        throw VaultError("Invalid session key.")
      }
      grant["sessionId"] = id
      grant["artifactObjectKey"] = objectKey
      grant["dataKey"] = dataKey
      if let etag = record["artifactEtag"] as? String { grant["baseEtag"] = etag }
      authorization["sessionId"] = id
    }
    return (grant, authorization)
  }
}
