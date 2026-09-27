import SwiftUI

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(APIClient.self) private var api
    @State private var secrets: [SecretStatus] = []
    @State private var keys: [WorkerKey] = []
    @State private var editingProvider: Provider?
    @State private var showingNewKey = false
    @State private var newKeySecret: String?

    var body: some View {
        List {
            Section("Account") { LabeledContent("Email", value: store.profile?.email ?? "—"); LabeledContent("Live updates", value: store.liveStatus); Button("Sign out", role: .destructive) { store.signOut() } }
            Section("Integrations") { ForEach(Provider.allCases) { provider in Button { editingProvider = provider } label: { HStack { Label(provider.title, systemImage: provider.icon); Spacer(); Text(status(provider)?.configured == true ? "Connected" : "Not configured").foregroundStyle(status(provider)?.configured == true ? .green : .secondary) } }.foregroundStyle(.primary) } }
            Section("Worker keys") { ForEach(keys.filter { $0.revokedAt == nil }) { key in HStack { VStack(alignment: .leading) { Text(key.name); Text("\(key.keyPrefix)…").font(.caption.monospaced()).foregroundStyle(.secondary) }; Spacer(); Button("Revoke", role: .destructive) { Task { await revoke(key) } }.font(.caption) } }; Button("Create worker key", systemImage: "key") { showingNewKey = true } }
            Section("Connected workers") { if store.workers.isEmpty { Text("No workers connected").foregroundStyle(.secondary) }; ForEach(store.workers) { worker in VStack(alignment: .leading) { HStack { Text(worker.name).font(.headline); Spacer(); StatusPill(state: worker.status) }; Text("\(worker.hostname) · v\(worker.version) · \(worker.runningJobs) running").font(.caption).foregroundStyle(.secondary) } } }
        }
        .navigationTitle("Settings")
        .task { await load() }.refreshable { await load(); await store.refreshWorkers() }
        .sheet(item: $editingProvider) { provider in SecretEditor(provider: provider, existing: status(provider)) { await load() } }
        .sheet(isPresented: $showingNewKey) { WorkerKeyCreator(createdSecret: $newKeySecret) { await load() } }
        .sheet(isPresented: Binding(get: { newKeySecret != nil }, set: { if !$0 { newKeySecret = nil } })) { SecretRevealView(secret: newKeySecret ?? "") }
    }
    private func status(_ provider: Provider) -> SecretStatus? { secrets.first { $0.provider == provider.rawValue } }
    private func load() async { do { async let secrets = api.secrets(); async let keys = api.workerKeys(); self.secrets = try await secrets; self.keys = try await keys } catch { store.present(error) } }
    private func revoke(_ key: WorkerKey) async { do { try await api.revokeWorkerKey(key.id); await load() } catch { store.present(error) } }
}

enum Provider: String, CaseIterable, Identifiable { case github, linear, jira; var id: String { rawValue }; var title: String { rawValue.capitalized }; var icon: String { self == .github ? "chevron.left.forwardslash.chevron.right" : self == .jira ? "ticket" : "line.diagonal" } }

private struct SecretEditor: View {
    @Environment(\.dismiss) private var dismiss; @Environment(APIClient.self) private var api; @Environment(AppStore.self) private var store
    let provider: Provider; let existing: SecretStatus?; let didChange: () async -> Void
    @State private var token = ""; @State private var email = ""; @State private var busy = false
    var body: some View { NavigationStack { Form { if existing?.configured == true { Text("Connected · \(existing?.hint ?? "credential saved")").foregroundStyle(.green) }; if provider == .jira { TextField("Jira account email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never) }; SecureField(provider == .github ? "Personal access token" : "API token", text: $token); if existing?.configured == true { Button("Remove credential", role: .destructive) { Task { await remove() } } } }.navigationTitle(provider.title).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(token.count < 8 || (provider == .jira && !email.contains("@")) || busy) } } } }
    private func save() async { busy = true; defer { busy = false }; do { _ = try await api.setSecret(provider: provider.rawValue, token: token, email: provider == .jira ? email : nil); await didChange(); dismiss() } catch { store.present(error) } }
    private func remove() async { do { try await api.deleteSecret(provider.rawValue); await didChange(); dismiss() } catch { store.present(error) } }
}

private struct WorkerKeyCreator: View {
    @Environment(\.dismiss) private var dismiss; @Environment(APIClient.self) private var api; @Environment(AppStore.self) private var store
    @Binding var createdSecret: String?; let didChange: () async -> Void; @State private var name = ""
    var body: some View { NavigationStack { Form { TextField("MacBook Pro", text: $name); Text("The secret is shown once. Copy it before dismissing.").font(.caption).foregroundStyle(.secondary) }.navigationTitle("New worker key").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Create") { Task { await create() } }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty) } } } }
    private func create() async { do { let result = try await api.createWorkerKey(name: name); await didChange(); dismiss(); createdSecret = result.secret } catch { store.present(error) } }
}

private struct SecretRevealView: View {
    @Environment(\.dismiss) private var dismiss; let secret: String
    var body: some View { NavigationStack { VStack(alignment: .leading, spacing: 18) { Label("Copy this key now", systemImage: "exclamationmark.shield.fill").font(.title2.bold()).foregroundStyle(.orange); Text(secret).font(.body.monospaced()).textSelection(.enabled).padding().frame(maxWidth: .infinity, alignment: .leading).background(.background.secondary, in: RoundedRectangle(cornerRadius: 12)); Button("Copy") { UIPasteboard.general.string = secret }.buttonStyle(.borderedProminent); Text("This value is never stored by Sindral and cannot be shown again.").font(.caption).foregroundStyle(.secondary); Spacer() }.padding().navigationTitle("Worker key").toolbar { Button("Done") { dismiss() } } } }
}
