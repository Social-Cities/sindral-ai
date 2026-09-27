import SwiftUI

enum Provider: String, CaseIterable, Identifiable {
    case github, linear, jira
    var id: String { rawValue }
    var title: String { self == .github ? "GitHub" : rawValue.capitalized }
    var description: String {
        switch self {
        case .github: "Personal access token used to open PRs, read diffs and ingest PR comments. Needs repo scope."
        case .linear: "API key used to import tickets from linear.app URLs."
        case .jira: "Account email and API token used to import tickets from atlassian.net URLs."
        }
    }
    var tokenLabel: String { self == .github ? "Token" : self == .linear ? "API key" : "API token" }
    var placeholder: String { self == .github ? "ghp_…" : self == .linear ? "lin_api_…" : "ATATT…" }
    var hint: String {
        switch self {
        case .github: "Stored encrypted; only the last characters are shown."
        case .linear: "Create one under Linear → Settings → API."
        case .jira: "Create one at id.atlassian.com → Security → API tokens."
        }
    }
}

private enum SettingsPane: Hashable, Identifiable {
    case integration(Provider), workerKeys, workers
    var id: Self { self }
}

/// Settings: section list and detail pane side by side on iPad; a pushed list on iPhone.
struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(APIClient.self) private var api
    @Environment(SessionStore.self) private var session
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var secrets: [SecretStatus] = []
    @State private var keys: [WorkerKey] = []
    @State private var pane: SettingsPane? = .workerKeys

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                HStack(spacing: 0) {
                    sidebar.frame(width: 300)
                    ScrollView { detail(pane ?? .workerKeys).padding(.horizontal, 40).padding(.vertical, 32).frame(maxWidth: 900, alignment: .leading) }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .refreshable { await reload() }
                }
            } else {
                sidebar
                    .navigationDestination(item: $pane) { pane in
                        ScrollView { detail(pane).padding(16) }.background(Theme.background).navigationBarTitleDisplayMode(.inline)
                    }
            }
        }
        .background(Theme.background)
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
        .onAppear {
            if horizontalSizeClass == .compact { pane = nil }
            #if DEBUG
            if DemoMode.isEnabled, let demo = DemoMode.settingsPane { pane = demo == "workers" ? .workers : Provider(rawValue: demo).map { .integration($0) } ?? .workerKeys }
            #endif
        }
    }

    // MARK: Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Settings").font(Theme.pageTitle).tracking(-0.6).foregroundStyle(Theme.foreground).padding(.bottom, 20)
                    groupLabel("Integrations")
                    ForEach(Provider.allCases) { provider in
                        let connected = status(provider)?.configured == true
                        row(provider.title, detail: connected ? "connected" : "not set", detailColor: connected ? Theme.emerald : Theme.mutedForeground, pane: .integration(provider))
                    }
                    groupLabel("Agents").padding(.top, 20)
                    let activeKeys = keys.filter { $0.revokedAt == nil }.count
                    row("Worker keys", detail: "\(activeKeys) key\(activeKeys == 1 ? "" : "s")", detailColor: Theme.secondaryForeground, pane: .workerKeys)
                    let online = store.workers.filter { $0.status == "online" }.count
                    row("Workers", detail: "\(online) online", detailColor: online > 0 ? Theme.emerald : Theme.mutedForeground, pane: .workers)
                }
                .padding(.horizontal, 16).padding(.top, 28)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(store.displayName(fallbackEmail: session.user?.email)).font(Theme.bodyMedium).foregroundStyle(Theme.foreground)
                if let email = store.profile?.email ?? session.user?.email { Text(email).font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1) }
                Button("Sign out") { store.signOut() }.buttonStyle(.sindral(.subtle)).padding(.top, 10)
            }
            .padding(.horizontal, 24).padding(.vertical, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .hairline(.top)
            .padding(.horizontal, 16)
        }
        .background(Theme.muted.ignoresSafeArea(edges: .bottom))
        .hairline(.trailing)
    }

    private func groupLabel(_ text: String) -> some View {
        Text(text.uppercased()).font(Theme.mono(12, .medium)).tracking(2.5).foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, 8).padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }

    private func row(_ title: String, detail: String, detailColor: Color, pane target: SettingsPane) -> some View {
        let selected = horizontalSizeClass == .regular && pane == target
        return Button { pane = target } label: {
            HStack {
                Text(title).font(Theme.font(16)).foregroundStyle(selected ? Theme.foreground : Theme.secondaryForeground)
                Spacer()
                Text(detail).font(Theme.mono(12)).foregroundStyle(detailColor)
                if horizontalSizeClass == .compact { Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground) }
            }
            .padding(.horizontal, 14).frame(height: 48)
            .background { if selected { RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.secondary).overlay { RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(Theme.borderStrong) } } }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Detail

    @ViewBuilder private func detail(_ pane: SettingsPane) -> some View {
        switch pane {
        case .integration(let provider):
            section(provider.title, provider.description) {
                SecretForm(provider: provider, status: status(provider)) { await load() }
            }
        case .workerKeys:
            VStack(alignment: .leading, spacing: 40) {
                section("Worker keys", "A worker runs agent jobs on your machine. Each key authenticates one worker installation.") {
                    WorkerKeysCard(keys: keys) { await load() }
                }
                workersSection
            }
        case .workers:
            workersSection
        }
    }

    private var workersSection: some View {
        section("Workers", "Workers registered with this account and their current status.") {
            VStack(spacing: 8) {
                if store.workers.isEmpty {
                    Text("No workers yet. Create a worker key, then start the worker on your machine.")
                        .font(Theme.font(14)).foregroundStyle(Theme.mutedForeground)
                        .padding(20).frame(maxWidth: .infinity, alignment: .leading).surface(Theme.card, radius: Theme.Radius.card)
                }
                ForEach(store.workers) { worker in
                    let online = worker.status == "online"
                    HStack(spacing: 14) {
                        PulsingDot(color: online ? Theme.emerald : Theme.mutedForeground, size: 9)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(worker.name).font(Theme.bodyMedium).foregroundStyle(Theme.foreground)
                            Text("\(worker.hostname) · v\(worker.version)").font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground)
                        }
                        Spacer()
                        Text(online ? "online · \(worker.runningJobs) job\(worker.runningJobs == 1 ? "" : "s")" : "offline · seen \(Formatters.shortAgo(worker.lastSeenAt)) ago")
                            .font(Theme.mono(12)).foregroundStyle(online ? Theme.emerald : Theme.mutedForeground)
                    }
                    .padding(.horizontal, 20).frame(minHeight: 68)
                    .surface(Theme.card, radius: Theme.Radius.card)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func section<Content: View>(_ title: String, _ description: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(Theme.paneTitle).foregroundStyle(Theme.foreground).accessibilityAddTraits(.isHeader)
                Text(description).font(Theme.body).foregroundStyle(Theme.secondaryForeground)
            }
            content()
        }
    }

    private func status(_ provider: Provider) -> SecretStatus? { secrets.first { $0.provider == provider.rawValue } }

    private func load() async {
        do { async let secrets = api.secrets(); async let keys = api.workerKeys(); self.secrets = try await secrets; self.keys = try await keys }
        catch { store.present(error) }
    }

    private func reload() async { await load(); await store.refreshWorkers() }
}

private struct SecretForm: View {
    @Environment(APIClient.self) private var api
    @Environment(AppStore.self) private var store
    let provider: Provider
    let status: SecretStatus?
    let didChange: () async -> Void
    @State private var token = ""
    @State private var email = ""
    @State private var busy = false
    @State private var confirmingRemove = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if status?.configured == true {
                HStack(spacing: 8) {
                    Circle().fill(Theme.emerald).frame(width: 7, height: 7)
                    Text("Connected · \(status?.hint ?? "credential saved")").font(Theme.mono(13)).foregroundStyle(Theme.emerald)
                    Spacer()
                    Button("Remove") { confirmingRemove = true }.buttonStyle(.sindral(.danger))
                }
            }
            if provider == .jira {
                label("Account email")
                TextField("", text: $email, prompt: Text(verbatim: "you@company.com").foregroundStyle(Theme.mutedForeground))
                    .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .font(Theme.body).foregroundStyle(Theme.foreground).fieldChrome(height: 48)
            }
            label(provider.tokenLabel)
            HStack(spacing: 12) {
                SecureField("", text: $token, prompt: Text(provider.placeholder).foregroundStyle(Theme.mutedForeground))
                    .font(Theme.body).foregroundStyle(Theme.foreground).fieldChrome(height: 48)
                    .accessibilityLabel(provider.tokenLabel)
                Button("Save") { Task { await save() } }
                    .buttonStyle(.sindral(.primary, height: 48))
                    .disabled(token.count < 8 || (provider == .jira && !email.contains("@")) || busy)
            }
            Text(provider.hint).font(Theme.font(14)).foregroundStyle(Theme.secondaryForeground)
        }
        .padding(24)
        .surface(Theme.card, radius: Theme.Radius.card)
        .confirmationDialog("Remove the \(provider.title) credential?", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { await remove() } }
        }
    }

    private func label(_ text: String) -> some View { Text(text).font(Theme.font(15)).foregroundStyle(Theme.secondaryForeground) }

    private func save() async {
        busy = true; defer { busy = false }
        do { _ = try await api.setSecret(provider: provider.rawValue, token: token, email: provider == .jira ? email : nil); token = ""; await didChange() }
        catch { store.present(error) }
    }

    private func remove() async {
        do { try await api.deleteSecret(provider.rawValue); await didChange() } catch { store.present(error) }
    }
}

private struct WorkerKeysCard: View {
    @Environment(APIClient.self) private var api
    @Environment(AppStore.self) private var store
    let keys: [WorkerKey]
    let didChange: () async -> Void
    @State private var name = ""
    @State private var creating = false
    @State private var createdSecret: String?
    @State private var revoking: WorkerKey?

    var body: some View {
        let active = keys.filter { $0.revokedAt == nil }
        VStack(alignment: .leading, spacing: 14) {
            Text("New worker key").font(Theme.font(15)).foregroundStyle(Theme.secondaryForeground)
            HStack(spacing: 12) {
                TextField("", text: $name, prompt: Text("e.g. MacBook Pro").foregroundStyle(Theme.mutedForeground))
                    .font(Theme.body).foregroundStyle(Theme.foreground).fieldChrome(height: 48)
                    .onSubmit { Task { await create() } }
                    .accessibilityLabel("New worker key name")
                Button("Create key") { Task { await create() } }
                    .buttonStyle(.sindral(.primary, height: 48))
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || creating)
            }
            Text("ACTIVE KEYS").font(Theme.mono(12, .medium)).tracking(2.5).foregroundStyle(Theme.mutedForeground).padding(.top, 8)
            if active.isEmpty { Text("No active keys.").font(Theme.font(14)).foregroundStyle(Theme.mutedForeground) }
            ForEach(active) { key in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(key.name).font(Theme.bodyMedium).foregroundStyle(Theme.foreground)
                        Text("\(key.keyPrefix)•••• · created \(Formatters.day(key.createdAt))\(key.lastUsedAt.map { " · used \(Formatters.shortAgo($0)) ago" } ?? "")")
                            .font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                    }
                    Spacer()
                    Button("Revoke") { revoking = key }.buttonStyle(.sindral(.danger))
                }
                .padding(.leading, 20).padding(.trailing, 12).frame(minHeight: 68)
                .surface(Theme.input)
            }
        }
        .padding(24)
        .surface(Theme.card, radius: Theme.Radius.card)
        .confirmationDialog("Revoke worker key?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { key in
            Button("Revoke \(key.name)", role: .destructive) { Task { await revoke(key) } }
        } message: { _ in Text("Workers using this key stop receiving jobs immediately.") }
        .sheet(isPresented: Binding(get: { createdSecret != nil }, set: { if !$0 { createdSecret = nil } })) {
            SecretRevealView(secret: createdSecret ?? "", serverURL: api.baseURL.absoluteString)
        }
    }

    private func create() async {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        creating = true; defer { creating = false }
        do { let result = try await api.createWorkerKey(name: trimmed); name = ""; await didChange(); createdSecret = result.secret }
        catch { store.present(error) }
    }

    private func revoke(_ key: WorkerKey) async {
        do { try await api.revokeWorkerKey(key.id); await didChange() } catch { store.present(error) }
    }
}

/// The new worker key is shown exactly once.
private struct SecretRevealView: View {
    @Environment(\.dismiss) private var dismiss
    let secret: String
    let serverURL: String

    var body: some View {
        let command = "SINDRAL_SERVER_URL=\(serverURL) SINDRAL_WORKER_KEY=\(secret) pnpm dev:worker"
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                Label("Copy this key now", systemImage: "exclamationmark.shield.fill").font(Theme.font(22, .semibold)).foregroundStyle(Theme.warning)
                Text("This value is never stored by Sindral and cannot be shown again.").font(Theme.body).foregroundStyle(Theme.secondaryForeground)
                Text(secret).font(Theme.mono(14)).foregroundStyle(Theme.foreground).textSelection(.enabled)
                    .padding(16).frame(maxWidth: .infinity, alignment: .leading).surface(Theme.input)
                Button("Copy key") { UIPasteboard.general.string = secret }.buttonStyle(.sindral(.primary))
                Text("Start the worker").font(Theme.font(15, .medium)).foregroundStyle(Theme.foreground).padding(.top, 8)
                Text(command).font(Theme.mono(12)).foregroundStyle(Theme.secondaryForeground).textSelection(.enabled)
                    .padding(16).frame(maxWidth: .infinity, alignment: .leading).surface(Theme.input)
                Button("Copy command") { UIPasteboard.general.string = command }.buttonStyle(.sindral(.subtle))
                Spacer()
            }
            .padding(24)
            .background(Theme.background)
            .navigationTitle("Worker key").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
        }
        .presentationBackground(Theme.background)
        .interactiveDismissDisabled()
    }
}
