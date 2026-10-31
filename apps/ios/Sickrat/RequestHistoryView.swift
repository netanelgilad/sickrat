import SwiftUI

struct RequestHistoryView: View {
  @Environment(VaultModel.self) private var model
  @State private var pulling = false
  var body: some View {
    List {
      if let error = model.historyError {
        Section {
          Text(error).foregroundStyle(.secondary)
          Button { Task { await model.loadHistory() } } label: {
            if model.loadingHistory { ProgressView("Trying again…") } else { Text("Try again") }
          }
            .disabled(model.loadingHistory)
        }
      }
      if !model.historyLoaded && model.historyError == nil {
        InitialVaultState(showProgress: !pulling, title: "Fetching history…")
      } else if model.historyLoaded && model.requestHistory.isEmpty {
        ContentUnavailableView("No request history", systemImage: "clock.arrow.circlepath",
                               description: Text("Completed and expired requests will appear here."))
      }
      Section {
        ForEach(model.requestHistory) { request in
          NavigationLink { RequestDetail(request: request) } label: { RequestRow(request: request) }
        }
      } footer: {
        if !model.requestHistory.isEmpty { Text("Completed and expired requests from the latest 100 requests.") }
      }
    }
    .navigationTitle("Request history").navigationBarTitleDisplayMode(.inline)
    .task { await model.loadHistory() }
    .refreshable {
      pulling = true
      defer { pulling = false }
      await model.loadHistory()
    }
  }
}
