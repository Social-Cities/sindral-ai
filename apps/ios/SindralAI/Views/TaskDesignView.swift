import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// Native revision review backed by the same design API as the web workspace.
struct TaskDesignView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    let task: TaskDetail
    var scrolls = true
    let didChange: () async -> Void
    var onConversation: () -> Void = {}

    @State private var overview: DesignOverview?
    @State private var revisionView: DesignRevisionView?
    @State private var selectedID = ""
    @State private var screen = 0
    @State private var view = DesignPane.preview
    @State private var mobilePreview = true
    @State private var errorMessage: String?
    @State private var previewError: String?
    @State private var loading = false
    @State private var loadID = UUID()
    @State private var approving = false
    @State private var handoff: DesignRevision?
    @State private var exporting = false

    private enum DesignPane: String, CaseIterable { case preview = "Preview", specification = "Specification", files = "Files" }
    private var result: DesignResult? { revisionView?.revision.result ?? (selectedID.isEmpty ? overview?.input?.result : nil) }
    private var approvedAt: String? { revisionView?.revision.approvedAt ?? (selectedID.isEmpty ? overview?.input?.approvedAt : nil) }
    private var revisionID: String? { revisionView?.revision.id ?? (selectedID.isEmpty ? overview?.input?.revisionId : nil) }
    private var isInput: Bool { selectedID.isEmpty && overview?.input != nil }

    var body: some View {
        Group {
            if scrolls { ScrollView { content } }
            else { content }
        }
        .task(id: "\(task.id)|\(task.updatedAt)|\(selectedID)|\(scenePhase)") {
            guard scenePhase == .active else { return }
            do {
                while !Task.isCancelled {
                    await load()
                    // Preview grants expire after five minutes, including frozen design inputs.
                    try await Task.sleep(for: .seconds(task.isAgentActive(store.workflows) ? 5 : 240))
                }
            } catch { }
        }
        .sheet(item: $handoff) { revision in
            DesignImplementationSheet(task: task, revision: revision)
        }
        .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json,
                      defaultFilename: "design-\(revisionID ?? task.id).json") { outcome in
            if case .failure(let error) = outcome { errorMessage = error.localizedDescription }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Label(isInput ? "Approved design input" : "Design workspace", systemImage: "sparkles")
                    .font(Theme.bodyMedium)
                Spacer()
                if loading { ProgressView().controlSize(.small) }
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(IconButtonStyle()).accessibilityLabel("Refresh design").disabled(loading)
            }
            if let revisions = overview?.revisions, !revisions.isEmpty {
                Picker("Design revision", selection: Binding(get: {
                    revisions.first(where: { $0.id == selectedID })?.id ?? revisions.last?.id ?? ""
                }, set: {
                    selectedID = $0; screen = 0; revisionView = nil; previewError = nil
                })) {
                    ForEach(Array(revisions.enumerated()), id: \.element.id) { index, revision in
                        Text("Revision \(index + 1)\(revision.approvedAt == nil ? "" : " · Approved")").tag(revision.id)
                    }
                }
                .pickerStyle(.menu)
            }
            if let errorMessage {
                Text(errorMessage).font(Theme.secondaryBody).foregroundStyle(Theme.dangerText)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            if let result {
                resultContent(result)
            } else {
                ContentUnavailableView(task.isAgentActive(store.workflows) ? "Claude is working on your design" : "Your app starts with a conversation",
                    systemImage: "sparkles",
                    description: Text(loading ? "Loading designs…" : "Start designing from the task actions. Review screens here and send feedback in Conversation."))
                if let lastError = task.lastError { Text(lastError).font(Theme.secondaryBody).foregroundStyle(Theme.dangerText) }
            }
            if !isInput {
                Button("Conversation & feedback", systemImage: "bubble.left.and.bubble.right", action: onConversation)
                    .buttonStyle(.sindral(.secondary, fullWidth: true))
            }
            if let checkpoint = overview?.checkpointAt {
                Text("Conversation and files saved · \(Formatters.day(checkpoint))")
                    .font(Theme.secondaryBody).foregroundStyle(Theme.mutedForeground)
            }
        }
        .padding(20)
        .foregroundStyle(Theme.foreground)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func resultContent(_ result: DesignResult) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if approvedAt != nil {
                Label("Approved revision", systemImage: "checkmark.seal.fill").foregroundStyle(Theme.emerald)
            }
            MarkdownText(source: result.summary)
            if !result.questions.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "Questions for you")
                    ForEach(Array(result.questions.enumerated()), id: \.offset) { _, question in
                        Text("• \(question)").font(Theme.body)
                    }
                }
                .padding(16).surface(Theme.secondary)
            }
            actions(result)
            Picker("Design view", selection: $view) {
                ForEach(DesignPane.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented)
            switch view {
            case .preview: preview(result)
            case .specification:
                if result.specification.isEmpty { Text("The specification will appear with the first design.").font(Theme.secondaryBody) }
                else { MarkdownText(source: result.specification) }
            case .files:
                ForEach(result.files) { file in
                    DisclosureGroup {
                        Text(file.encoding == "utf8" ? file.content : "Binary asset · \(file.contentType)")
                            .font(Theme.mono(12)).textSelection(.enabled)
                        Text("SHA-256 \(file.sha256)").font(Theme.mono(10)).foregroundStyle(Theme.mutedForeground)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(file.path).font(Theme.mono(13))
                            Text(file.contentType).font(Theme.mono(11)).foregroundStyle(Theme.mutedForeground)
                        }
                    }
                    .padding(14).surface()
                }
            }
            if isInput {
                Text("This task uses a frozen copy of the approved design. Later design changes do not change this input.")
                    .font(Theme.secondaryBody).foregroundStyle(Theme.mutedForeground)
            }
        }
    }

    private func actions(_ result: DesignResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let revision = revisionView?.revision {
                if revision.approvedAt != nil {
                    Button("Create implementation task", systemImage: "arrow.right.circle") { handoff = revision }
                        .buttonStyle(.sindral(.primary, fullWidth: true))
                } else {
                    Button { Task { await approve(revision) } } label: {
                        HStack { if approving { ProgressView() }; Text("Approve revision") }
                    }
                    .buttonStyle(.sindral(.success, fullWidth: true))
                    .disabled(approving || loading || task.state != "design-review" || task.isAgentActive(store.workflows) || result.designUrl == nil)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack { exportButton; Spacer(); claudeLink(result.designUrl) }
                VStack(alignment: .leading) { exportButton; claudeLink(result.designUrl) }
            }
        }
    }

    private var exportButton: some View {
        Button("Export handoff", systemImage: "square.and.arrow.up") { exporting = true }
            .buttonStyle(.sindral(.subtle)).disabled(exportDocument == nil)
    }

    @ViewBuilder private func claudeLink(_ value: String?) -> some View {
        if let value, let url = URL(string: value), url.scheme == "https", url.host == "claude.ai" {
            Link("Open in Claude ↗", destination: url).font(Theme.secondaryBody).foregroundStyle(Theme.accent)
                .frame(minHeight: 44)
        }
    }

    @ViewBuilder private func preview(_ result: DesignResult) -> some View {
        if result.screens.isEmpty {
            Text("Answer the questions in Conversation to continue designing.").font(Theme.secondaryBody).foregroundStyle(Theme.mutedForeground)
        } else {
            Picker("Design screen", selection: $screen) {
                ForEach(Array(result.screens.enumerated()), id: \.offset) { index, item in Text(item.name).tag(index) }
            }.pickerStyle(.menu)
            Toggle("Mobile preview", isOn: $mobilePreview).font(Theme.secondaryBody).tint(Theme.primary)
            if let previewError {
                Text(previewError).font(Theme.secondaryBody).foregroundStyle(Theme.dangerText)
                Button("Reload preview") { Task { await load() } }.buttonStyle(.sindral(.secondary))
            }
            if let url = previewURL {
                DesignWebPreview(url: url, errorMessage: $previewError)
                    .frame(maxWidth: mobilePreview ? 390 : .infinity)
                    .frame(height: 560)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.row))
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("Design preview: \(result.screens.indices.contains(screen) ? result.screens[screen].name : "Screen")")
            }
        }
    }

    private var previewURL: URL? {
        let paths = revisionView?.previewUrls ?? (selectedID.isEmpty ? overview?.inputPreviewUrls : nil) ?? []
        guard paths.indices.contains(screen), paths[screen].hasPrefix("/api/design-previews/") else { return nil }
        return try? api.url(for: paths[screen])
    }

    private var exportDocument: DesignBundleDocument? {
        guard let result, let revisionID else { return nil }
        return DesignBundleDocument(result: result, revisionID: revisionID, approvedAt: approvedAt)
    }

    private func load() async {
        let requestID = UUID()
        loadID = requestID
        loading = true
        defer { if loadID == requestID { loading = false } }
        do {
            let overview = try await api.design(taskId: task.id)
            let id = overview.revisions.first(where: { $0.id == selectedID })?.id ?? overview.revisions.last?.id ?? ""
            let revision = id.isEmpty ? nil : try await api.designRevision(taskId: task.id, revisionId: id)
            try Task.checkCancellation()
            guard loadID == requestID else { return }
            self.overview = overview
            if revisionView?.revision.id != revision?.revision.id { screen = 0 }
            revisionView = revision
            previewError = nil; errorMessage = nil
        } catch is CancellationError { } catch {
            if !Task.isCancelled, loadID == requestID { errorMessage = error.localizedDescription }
        }
    }

    private func approve(_ revision: DesignRevision) async {
        guard !approving else { return }
        approving = true; errorMessage = nil
        defer { approving = false }
        do {
            _ = try await api.approveDesign(taskId: task.id, revisionId: revision.id, expectedVersion: task.version)
            await load(); await didChange(); await store.refreshTasks()
        } catch {
            errorMessage = error.localizedDescription
            await didChange()
        }
    }
}

/// Load only signed previews, without cookies, an auth header, or native message handlers.
private struct DesignWebPreview: UIViewRepresentable {
    let url: URL
    @Binding var errorMessage: String?

    func makeCoordinator() -> Coordinator { Coordinator(errorMessage: $errorMessage) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.allowsLinkPreview = false
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.url != url else { return }
        context.coordinator.url = url
        #if DEBUG
        if DemoMode.isEnabled, url.host == "demo.sindral.invalid" {
            view.loadHTMLString(DemoFixtures.designHTML, baseURL: nil)
            return
        }
        #endif
        view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var url: URL?
        @Binding var errorMessage: String?
        init(errorMessage: Binding<String?>) { _errorMessage = errorMessage }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            // CSP on the preview response also isolates scripts, forms, frames and network access.
            let target = action.request.url
            #if DEBUG
            if DemoMode.isEnabled, target?.absoluteString == "about:blank" { return .allow }
            #endif
            let allowed = target?.scheme == url?.scheme && target?.host == url?.host && target?.port == url?.port
                && target?.path == url?.path && target?.query == url?.query && action.targetFrame?.isMainFrame == true
            return allowed ? .allow : .cancel
        }
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            if let http = response.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                errorMessage = "The preview expired or is unavailable. Reload to get a fresh preview."
                return .cancel
            } else { return .allow }
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { errorMessage = "Could not load the design preview. Reload to try again." }
        }
    }
}

struct DesignBundleDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let data: Data

    init(result: DesignResult, revisionID: String, approvedAt: String?) {
        struct Bundle: Encodable {
            let result: DesignResult; let revisionId: String; let approvedAt: String?
            func encode(to encoder: Encoder) throws {
                try result.encode(to: encoder)
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(revisionId, forKey: .revisionId)
                try container.encode(approvedAt, forKey: .approvedAt)
            }
            enum CodingKeys: String, CodingKey { case revisionId, approvedAt }
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        data = (try? encoder.encode(Bundle(result: result, revisionId: revisionID, approvedAt: approvedAt))) ?? Data()
    }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

private struct DesignImplementationSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(AppStore.self) private var store
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    let task: TaskDetail
    let revision: DesignRevision
    @State private var title = ""
    @State private var scope = "Implement the approved screens and flows, including responsive behavior and the specified interaction states."
    @State private var repos = ""
    @State private var projectID = ""
    @State private var workflowID = ""
    @State private var creating = false
    @State private var errorMessage: String?
    @State private var requestKey = UUID().uuidString
    @State private var lastPayload: String?
    private var workflows: [Workflow] { store.workflows.filter(\.supportsImplementation) }
    private var canCreate: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.count <= 200
            && (!repos.commaSeparated.isEmpty || !projectID.isEmpty) && workflows.contains { $0.id == workflowID }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("This task receives the approved revision, source files, assets, and specification as a permanent snapshot.")
                        .font(Theme.secondaryBody)
                }
                Section("Implementation") {
                    TextField("Title", text: $title).accessibilityLabel("Implementation title")
                    TextField("Implementation scope", text: $scope, axis: .vertical).lineLimit(3...8).accessibilityLabel("Implementation scope")
                    Picker("Project", selection: $projectID) {
                        Text("No project").tag("")
                        ForEach(store.projects) { Text($0.name).tag($0.id) }
                    }
                    .onChange(of: projectID) { _, id in
                        if let project = store.projects.first(where: { $0.id == id }) { repos = project.repositories.map(\.repository).joined(separator: ", ") }
                    }
                    TextField("Repositories: owner/app, owner/api", text: $repos)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("Implementation repositories")
                    Picker("Workflow", selection: $workflowID) {
                        ForEach(workflows) { Text($0.name).tag($0.id) }
                    }
                    if workflows.isEmpty { Text("Add an implementation workflow before creating this task.").foregroundStyle(Theme.warning) }
                }
                Section {
                    if let errorMessage { Text(errorMessage).foregroundStyle(Theme.dangerText) }
                    Button { Task { await create() } } label: {
                        HStack { if creating { ProgressView() }; Text("Create implementation task") }
                    }
                    .disabled(creating || !canCreate)
                }
            }
            .disabled(creating)
            .themedList()
            .navigationTitle("Implement design").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(creating) } }
            .onAppear {
                title = String("Implement \(task.title)".prefix(200))
                repos = task.repos.joined(separator: ", ")
                projectID = task.projectId ?? ""
                workflowID = workflows.first?.id ?? ""
            }
        }
        .interactiveDismissDisabled(creating)
    }

    private func create() async {
        guard canCreate, !creating, revision.approvedAt != nil else { return }
        let rawRepos = repos.commaSeparated
        let normalized = rawRepos.compactMap(Tickets.normalizeRepo)
        guard normalized.count == rawRepos.count, Set(normalized).count <= 10 else {
            errorMessage = "Use up to 10 repositories in owner/name form."; return
        }
        let description = String("\(scope)\n\nApproved design revision: \(revision.id)\n\n\(revision.result.specification)".prefix(100_000))
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let payload = [trimmedTitle, description, projectID, workflowID, normalized.joined(separator: ",")].joined(separator: "\u{0}")
        if let lastPayload, lastPayload != payload { requestKey = UUID().uuidString }
        lastPayload = payload
        creating = true; errorMessage = nil
        defer { creating = false }
        do {
            let created = try await api.createTask(title: trimmedTitle, description: description, ticket: nil,
                projectId: projectID.isEmpty ? nil : projectID, repos: Array(Set(normalized)).sorted(), workflowId: workflowID,
                designHandoff: .init(revisionId: revision.id, idempotencyKey: requestKey))
            await store.refreshTasks()
            dismiss()
            router.openTask(created.id)
        } catch { errorMessage = error.localizedDescription }
    }
}
