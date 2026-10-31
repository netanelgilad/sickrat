import SwiftUI

// Shared vocabulary for the presentation layer. No secrets, grants, or access
// policies are changed here; resource counts include each secret only once.
extension Approval {
  var statusTitle: String { expired ? "Expired" : status.capitalized }
  var statusSymbol: String {
    if expired { return "clock.badge.xmark" }
    switch status {
    case "approved": return "checkmark.circle.fill"
    case "denied": return "xmark.circle.fill"
    default: return "clock"
    }
  }
  var statusTint: Color {
    if expired { return .secondary }
    switch status {
    case "approved": return .green
    case "denied": return .secondary
    default: return .indigo
    }
  }
  var durationTitle: String {
    guard let seconds = accessDurationSeconds else { return "One-time access" }
    return Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .wide, maximumUnitCount: 2))
  }
  var resourceCount: Int {
    Set(secretRefs).count + resourceRequests.filter { $0.type != "secret" }.count
  }
  var accessSummary: String {
    "\(resourceCount) \(resourceCount == 1 ? "resource" : "resources") · \(durationTitle)"
  }
}

enum VaultDate {
  static func parse(_ value: String) -> Date? {
    (try? Date(value, strategy: .iso8601.time(includingFractionalSeconds: true)))
      ?? (try? Date(value, strategy: .iso8601))
  }
}

struct VaultSymbol: View {
  let symbol: String
  var tint: Color = .indigo
  @ScaledMetric(relativeTo: .body) private var symbolSize = 20.0
  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: min(symbolSize, 28), weight: .medium))
      .foregroundStyle(tint)
      .frame(width: 44, height: 44)
      .background(tint.opacity(0.1), in: .rect(cornerRadius: 12))
      .accessibilityHidden(true)
  }
}

struct VaultCategoryRow: View {
  let title: String
  let symbol: String
  let tint: Color
  let count: Int?
  var body: some View {
    HStack(spacing: 12) {
      VaultSymbol(symbol: symbol, tint: tint)
      Text(title)
      Spacer(minLength: 4)
      if let count { Text(count, format: .number).foregroundStyle(.secondary).monospacedDigit() }
    }.padding(.vertical, 2).accessibilityElement(children: .combine)
  }
}

enum RequestOutcome: String { case approved, denied }

struct RequestReceipt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var appeared = false
  let outcome: RequestOutcome
  let device: String
  let duration: String
  let done: () -> Void
  var body: some View {
    ScrollView {
      VStack(spacing: 20) {
        Image(systemName: outcome == .approved ? "checkmark.shield.fill" : "hand.raised.slash.fill")
          .font(.system(size: 64, weight: .medium))
          .foregroundStyle(outcome == .approved ? Color.green : Color.secondary)
          .frame(width: 120, height: 120)
          .background((outcome == .approved ? Color.green : Color.secondary).opacity(0.1), in: .circle)
          .symbolEffect(.bounce, value: reduceMotion ? false : appeared)
          .accessibilityHidden(true)
        Text(outcome == .approved ? "Access approved" : "Request denied")
          .font(.largeTitle.bold()).multilineTextAlignment(.center)
          .accessibilityAddTraits(.isHeader)
        Text(outcome == .approved
             ? "\(device) can now use the requested resources."
             : "No access was granted to \(device) by this request.")
          .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
        if outcome == .approved {
          Label(duration, systemImage: "clock").font(.subheadline).foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: 500).frame(maxWidth: .infinity)
      .padding(.horizontal, 28).padding(.vertical, 48)
    }
    .background(Color(.systemGroupedBackground))
    .safeAreaInset(edge: .bottom) {
      Button(action: done) {
        Text("Done").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 8)
      }.buttonStyle(.borderedProminent).controlSize(.large).padding()
    }
    .onAppear { appeared = true }
  }
}

extension View {
  @ViewBuilder func vaultNavigationTransition(id: String, namespace: Namespace.ID, reduceMotion: Bool) -> some View {
    if reduceMotion { self } else { self.navigationTransition(.zoom(sourceID: id, in: namespace)) }
  }
}
