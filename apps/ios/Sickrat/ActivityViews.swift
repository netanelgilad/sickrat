import SwiftUI

struct VaultActivity: ViewModifier {
  @Environment(VaultModel.self) private var model
  func body(content: Content) -> some View {
    content
      .disabled(model.busy)
      .safeAreaInset(edge: .top, spacing: 0) {
        if let activity = model.activity {
          status(activity)
        } else if model.refreshing && model.lastRefresh != nil {
          status("Updating vault…")
        } else if let error = model.refreshError {
          HStack {
            Image(systemName: "wifi.exclamationmark")
            Text(error).font(.subheadline)
            Spacer()
            Button("Retry") { Task { await model.reload() } }
          }
          .padding().background(.regularMaterial)
        }
      }
  }
  private func status(_ text: String) -> some View {
    HStack(spacing: 10) {
      ProgressView().accessibilityHidden(true)
      Text(text).font(.subheadline)
      Spacer()
    }
    .padding(.horizontal).padding(.vertical, 12)
    .background(.regularMaterial)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(text)
  }
}
extension View {
  func vaultActivity() -> some View { modifier(VaultActivity()) }
}
struct InitialVaultState: View {
  @Environment(VaultModel.self) private var model
  var body: some View {
    VStack(spacing: 12) {
      if model.refreshError == nil {
        ProgressView()
        Text("Loading your vault…").foregroundStyle(.secondary)
      } else {
        Image(systemName: "wifi.exclamationmark").font(.title)
        Text("Your vault hasn’t loaded yet").font(.headline)
        Text("Check your connection and try again.").foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity).padding(.vertical, 40)
    .listRowBackground(Color.clear)
  }
}
