import SwiftUI
import UIKit
import UserNotifications
import Observation
import Security
import UniformTypeIdentifiers

enum NotificationCredential {
  static func query(_ origin: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.sickrat.notifications", kSecAttrAccount as String: origin]
  }
  static func read(_ origin: String) -> String? {
    var item = query(origin)
    item[kSecReturnData as String] = true
    var value: CFTypeRef?
    guard SecItemCopyMatching(item as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }
  static func save(_ secret: String, origin: String) throws {
    let q = query(origin)
    let data = Data(secret.utf8)
    let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var item = q
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw VaultError("Couldn’t save notification setup securely.") }
    } else if status != errSecSuccess { throw VaultError("Couldn’t save notification setup securely.") }
  }
}

@MainActor @Observable final class PushCoordinator {
  static let shared = PushCoordinator()
  var model: VaultModel?
  var requestID: String?
  var status = "Not enabled"
  var setupReady = false
  var pairingCode: String?
  var enrolling = false
  private var attempt = 0
  var enabled: Bool { UserDefaults.standard.bool(forKey: "nativePush.enabled") }
  private var token: String? { UserDefaults.standard.string(forKey: "nativePush.token") }
  private var registeredOrigin: String? { UserDefaults.standard.string(forKey: "nativePush.origin") }

  func start(_ model: VaultModel) async {
    self.model = model
    setupReady = NotificationCredential.read(model.endpoint) != nil
    #if DEBUG
      if DesignFixture.enabled { return }
    #endif
    guard enabled, model.configured, setupReady else { return }
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
      status = "Notifications are off in iOS Settings"
      return
    }
    registerWithApple()
  }

  func importSetup(_ data: Data) throws {
    guard data.count < 4096, let model,
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      object["type"] as? String == "sickrat-native-push-setup", object["version"] as? Int == 1,
      object["origin"] as? String == model.endpoint, let secret = object["secret"] as? String,
      secret.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    else { throw VaultError("This setup file doesn’t match your vault.") }
    try NotificationCredential.save(secret, origin: model.endpoint)
    setupReady = true
    status = "Ready to enable"
  }

  func enable() async throws {
    guard !enrolling else { return }
    enrolling = true
    defer { enrolling = false }
    guard let model, model.configured else { throw VaultError("Connect a vault first.") }
    let origin = model.endpoint
    if NotificationCredential.read(origin) == nil {
      let pendingAccount = origin + "#pending-notifications"
      var bytes = [UInt8](repeating: 0, count: 32)
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw VaultError("Couldn’t create device credential.") }
      let generatedCredential = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
      let credential = NotificationCredential.read(pendingAccount) ?? generatedCredential
      try NotificationCredential.save(credential, origin: pendingAccount)
      var approved = false
      let deadline = Date().addingTimeInterval(600)
      while Date() < deadline {
        try Task.checkCancellation()
        guard model.endpoint == origin else { throw VaultError("Vault changed. Try again.") }
        guard UIApplication.shared.applicationState == .active else {
          try await Task.sleep(for: .seconds(2))
          continue
        }
        let result: [String: Any]
        do {
          result = try await model.request("native-push/enroll", method: "POST", origin: origin, bearer: credential)
        } catch let error as URLError where [.networkConnectionLost, .notConnectedToInternet, .timedOut, .cancelled].contains(error.code) {
          status = UIApplication.shared.applicationState == .active ? "Waiting for connection…" : "Waiting for approval on your Mac"
          try await Task.sleep(for: .seconds(2))
          continue
        }
        if let value = result["approved"] as? Int, value == 1 { approved = true; break }
        pairingCode = result["code"] as? String
        status = "Waiting for approval on your Mac"
        try await Task.sleep(for: .seconds(5))
      }
      guard approved else { throw VaultError("Pairing expired. Enable notifications to try again.") }
      try NotificationCredential.save(credential, origin: origin)
      pairingCode = nil
      setupReady = true
      SecItemDelete(NotificationCredential.query(pendingAccount) as CFDictionary)
    }
    let capabilities = try await model.request("capabilities")
    guard let native = capabilities["nativePush"] as? [String: Any], native["configured"] as? Bool == true else {
      throw VaultError("Native notifications are not configured for this vault yet.")
    }
    let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    guard allowed else { throw VaultError("Allow notifications for Sickrat in iOS Settings.") }
    UserDefaults.standard.set(true, forKey: "nativePush.enabled")
    registerWithApple()
  }

  private func registerWithApple() {
    attempt += 1
    let current = attempt
    status = "Connecting…"
    UIApplication.shared.registerForRemoteNotifications()
    Task {
      try? await Task.sleep(for: .seconds(20))
      if attempt == current && status == "Connecting…" {
        status = "Couldn’t connect. Try reconnecting."
      }
    }
  }

  func didRegister(_ data: Data) {
    let value = data.map { String(format: "%02x", $0) }.joined()
    UserDefaults.standard.set(value, forKey: "nativePush.token")
    Task { await synchronize() }
  }

  func synchronize() async {
    guard enabled, let model, model.configured, let token else { return }
    let origin = model.endpoint
    guard let secret = NotificationCredential.read(origin) else { status = "Import the setup file again."; return }
    do {
      var registrationID = UserDefaults.standard.string(forKey: "nativePush.id")
      var registeredToken = UserDefaults.standard.string(forKey: "nativePush.registeredToken")
      if let previous = registeredOrigin, previous != origin, let previousToken = registeredToken {
        _ = try await model.request("native-push/unregister", method: "POST", body: ["token": previousToken], origin: previous, bearer: NotificationCredential.read(previous))
        registrationID = nil
        registeredToken = nil
        UserDefaults.standard.removeObject(forKey: "nativePush.id")
        UserDefaults.standard.removeObject(forKey: "nativePush.registeredToken")
        UserDefaults.standard.removeObject(forKey: "nativePush.origin")
      }
      var body: [String: Any] = ["token": token]
      if let registrationID, let registeredToken {
        body["id"] = registrationID
        body["previousToken"] = registeredToken
      }
      let response = try await model.request("native-push/register", method: "POST", body: body, origin: origin, bearer: secret)
      guard let id = response["id"] as? String else { throw VaultError("Invalid notification response.") }
      guard enabled, model.endpoint == origin else {
        _ = try await model.request("native-push/unregister", method: "POST", body: ["token": token], origin: origin, bearer: secret)
        return
      }
      UserDefaults.standard.set(id, forKey: "nativePush.id")
      UserDefaults.standard.set(token, forKey: "nativePush.registeredToken")
      UserDefaults.standard.set(origin, forKey: "nativePush.origin")
      status = "On"
    } catch {
      status = "Couldn’t connect. Turn notifications off and enable them again."
    }
  }

  func disable() async throws {
    UserDefaults.standard.set(false, forKey: "nativePush.enabled")
    attempt += 1
    do {
      if let registeredToken = UserDefaults.standard.string(forKey: "nativePush.registeredToken"),
         let origin = registeredOrigin, let model {
        _ = try await model.request("native-push/unregister", method: "POST", body: ["token": registeredToken], origin: origin, bearer: NotificationCredential.read(origin))
      }
    } catch {
      UserDefaults.standard.set(true, forKey: "nativePush.enabled")
      throw error
    }
    UserDefaults.standard.removeObject(forKey: "nativePush.origin")
    UserDefaults.standard.removeObject(forKey: "nativePush.id")
    UserDefaults.standard.removeObject(forKey: "nativePush.registeredToken")
    UIApplication.shared.unregisterForRemoteNotifications()
    status = "Not enabled"
  }
}

final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }
  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    PushCoordinator.shared.didRegister(deviceToken)
  }
  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    PushCoordinator.shared.status = "Couldn’t register. Check the app’s signing and try again."
  }
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    guard let id = response.notification.request.content.userInfo["requestId"] as? String,
          UUID(uuidString: id) != nil else { return }
    await MainActor.run { PushCoordinator.shared.requestID = id }
  }
}

struct NotificationSettingsView: View {
  @Environment(VaultModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var push = PushCoordinator.shared
  var body: some View {
    Form {
      Section {
        VStack(alignment: .leading, spacing: 14) {
          VaultSymbol(symbol: push.status == "On" ? "bell.badge.fill" : "bell", tint: .indigo)
            .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
          Text(push.status == "On" ? "Ready when you’re needed" : "Know when access is needed")
            .font(.title2.bold())
          Text("Get an alert when a device needs access. Open Sickrat to review the resources and decide.")
            .foregroundStyle(.secondary)
        }.padding(.vertical, 8)
      }
      Section {
        LabeledContent("Status") {
          Text(push.status).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
            .accessibilityIdentifier("notification-status")
        }
        if let code = push.pairingCode {
          VStack(alignment: .leading, spacing: 12) {
            Text("Approve this iPhone on your Mac").font(.headline)
            Text(code).font(.title2.monospaced().bold()).textSelection(.enabled)
              .accessibilityLabel("Pairing code, \(code.map(String.init).joined(separator: " "))")
            Text("Share this code with your Mac, then return here. It expires in 10 minutes. You can switch apps while you wait.")
              .font(.subheadline).foregroundStyle(.secondary)
            ShareLink(item: code) { Label("Share pairing code", systemImage: "square.and.arrow.up") }
          }.padding(.vertical, 8)
        }
        if push.enrolling {
          HStack(spacing: 10) {
            ProgressView().controlSize(.small).accessibilityHidden(true)
            Text(push.pairingCode == nil ? "Setting up notifications…" : "Waiting for your Mac…")
              .font(.subheadline).foregroundStyle(.secondary)
          }.accessibilityElement(children: .combine)
        } else if push.enabled {
          Button {
            Task { await model.run("Connecting notifications…") { await push.start(model) } }
          } label: { OperationLabel(title: "Reconnect", systemImage: "arrow.clockwise", operations: ["Connecting notifications…"]) }
          Button("Turn off notifications", role: .destructive) {
            Task { await model.run("Turning off notifications…") { try await push.disable() } }
          }
        } else {
          Button {
            Task {
              do { try await push.enable() }
              catch {
                if !VaultModel.isExpectedCancellation(error) {
                  push.status = "Setup paused. Try again."
                  model.error = error.localizedDescription
                }
              }
            }
          } label: { Label("Enable notifications", systemImage: "bell.badge") }
        }
      } footer: {
        Text("Alerts contain no secret values. Approving a notification pairing code allows alerts on this iPhone; it doesn’t grant vault access.")
      }
      if !push.enabled {
        Section("First-time setup") {
          Label("Approve this iPhone from your Mac.", systemImage: "1.circle")
          Label("Allow notifications when iOS asks.", systemImage: "2.circle")
          Label("Review access requests from an alert.", systemImage: "3.circle")
        }.font(.subheadline)
      }
      Section {
        if let url = URL(string: UIApplication.openSettingsURLString) {
          Link(destination: url) { Label("Open iOS notification settings", systemImage: "arrow.up.forward.app") }
        }
      }
    }
    .vaultActivity().navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
    .sensoryFeedback(.success, trigger: push.status == "On") { _, ready in ready }
  }
}
