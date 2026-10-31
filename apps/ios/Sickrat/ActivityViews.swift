import SwiftUI

// Activity belongs to the control that started it. This modifier only prevents
// conflicting mutations; it never inserts chrome or moves scroll content.
struct VaultActivity: ViewModifier {
  @Environment(VaultModel.self) private var model
  func body(content: Content) -> some View { content.disabled(model.busy) }
}
extension View {
  func vaultActivity() -> some View { modifier(VaultActivity()) }
}

struct OperationLabel: View {
  @Environment(VaultModel.self) private var model
  let title: String
  var systemImage: String? = nil
  let operations: [String]
  private var active: Bool { model.activity.map(operations.contains) ?? false }
  var body: some View {
    HStack(spacing: 10) {
      if systemImage != nil || active {
        ZStack {
          if active {
            ProgressView().controlSize(.small)
          } else if let systemImage {
            Image(systemName: systemImage).font(.system(size: 18))
          }
        }
        .frame(width: 22, height: 22).accessibilityHidden(true)
      }
      Text(title)
    }
    .accessibilityElement(children: .combine)
    .accessibilityValue(active ? (model.activity ?? "") : "")
  }
}

struct RefreshErrorRow: View {
  @Environment(VaultModel.self) private var model
  var body: some View {
    if model.refreshError != nil {
      HStack(alignment: .center, spacing: 12) {
        Image(systemName: "wifi.exclamationmark").foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 3) {
          Text("Couldn’t update").font(.subheadline.weight(.medium))
          Text(model.lastRefresh == nil ? "Check your connection." : "Showing your last update.")
            .font(.caption).foregroundStyle(.secondary)
        }
        Spacer(minLength: 8)
        Button {
          Task { await model.reload() }
        } label: {
          if model.refreshing { ProgressView().controlSize(.small) } else { Text("Retry") }
        }.disabled(model.refreshing)
      }.padding(.vertical, 4)
    }
  }
}

struct InitialVaultState: View {
  var showProgress = true
  var title = "Fetching requests…"
  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      HStack(spacing: 10) {
        if showProgress { ProgressView().controlSize(.small).accessibilityLabel(title) }
        Text(title).font(.subheadline).foregroundStyle(.secondary).accessibilityHidden(showProgress)
      }
      ForEach(0..<3) { _ in
        VStack(alignment: .leading, spacing: 9) {
          RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(width: 160, height: 13)
          RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(maxWidth: 240).frame(height: 10)
          RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(width: 66, height: 9)
        }.accessibilityHidden(true)
      }
    }.padding(.vertical, 12)
  }
}

struct RequestsClearRow: View {
  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "checkmark.shield.fill").font(.title2)
        .foregroundStyle(.green).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text("No pending requests").font(.body.weight(.medium))
        Text("New requests will appear here.").font(.subheadline).foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 6)
    .accessibilityElement(children: .combine)
  }
}
