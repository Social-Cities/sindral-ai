import SwiftUI
import UniformTypeIdentifiers

/// Home: greeting, the create-task card, active tasks, bucket counts and the worker panel.
struct DashboardView: View {
    @Environment(AppStore.self) private var store
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(Formatters.greeting(hour: Calendar.current.component(.hour, from: .now))), \(store.displayName(fallbackEmail: session.user?.email)).")
                        .font(Theme.pageTitle).tracking(-0.6).foregroundStyle(Theme.foreground)
                    Text("What would you like to work on today?").font(Theme.body).foregroundStyle(Theme.secondaryForeground)
                }
                if horizontalSizeClass == .regular {
                    RatioColumns(ratios: [2, 1], spacing: 24) {
                        mainColumn
                        statsColumn
                    }
                } else {
                    mainColumn
                    statsColumn
                }
            }
            .padding(horizontalSizeClass == .regular ? 40 : 16)
            .padding(.top, horizontalSizeClass == .regular ? -8 : 0)
            .frame(maxWidth: 1200, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background)
        .refreshable { await store.bootstrap() }
        .toolbar(.hidden, for: .navigationBar)
        .navigationTitle("Home")
    }

    private var mainColumn: some View {
        VStack(alignment: .leading, spacing: 28) {
            CreateTaskCard { router.section = .tasks }
            if !activeTasks.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        SectionLabel(text: "Active tasks")
                        Spacer()
                        Button("View all →") { router.openTasks(filter: .active) }
                            .font(Theme.font(15)).foregroundStyle(Theme.accent).frame(minHeight: 44)
                    }
                    ForEach(activeTasks) { task in
                        Button { router.openTask(task.id) } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(task.title).font(Theme.bodyMedium).foregroundStyle(Theme.foreground).lineLimit(1)
                                    Text(([Optional(task.key), task.projectId.flatMap { id in store.projects.first { $0.id == id }?.name }].compactMap { $0 }).joined(separator: " · "))
                                        .font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground)
                                }
                                Spacer(minLength: 8)
                                StatusBadge(state: task.state, step: task.currentStep(store.workflows))
                            }
                            .padding(.horizontal, 18).frame(minHeight: 60)
                            .surface(Theme.card)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var statsColumn: some View {
        VStack(spacing: 14) {
            countCard(label: "Tasks in Todo", sub: "Awaiting start", bucket: .todo, color: Color(hex: 0x8B92A8))
            countCard(label: "In Progress", sub: "Agent working", bucket: .inProgress, color: Color(hex: 0xA78BFA))
            countCard(label: "In Review", sub: "Needs approval", bucket: .inReview, color: Color(hex: 0x22D3EE))
            WorkerPanel(workers: store.workers)
        }
    }

    private func countCard(label: String, sub: String, bucket: DashboardBucket, color: Color) -> some View {
        Button { router.openTasks(filter: TaskFilter(bucket: bucket)) } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(store.isLoading && store.tasks.isEmpty ? "–" : "\(count(bucket))")
                    .font(Theme.font(38, .semibold, relativeTo: .largeTitle)).monospacedDigit().foregroundStyle(color)
                    .padding(.bottom, 4)
                Text(label).font(Theme.bodyMedium).foregroundStyle(Theme.foreground)
                Text(sub).font(Theme.font(14)).foregroundStyle(Theme.mutedForeground)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .surface(Theme.card, radius: Theme.Radius.card)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(count(bucket)) \(label), \(sub)")
        .accessibilityHint("Shows these tasks")
    }

    private func count(_ bucket: DashboardBucket) -> Int {
        store.tasks.filter { $0.parentTaskId == nil && $0.bucket(store.workflows) == bucket }.count
    }

    private var activeTasks: [SindralTask] {
        Array(store.tasks.filter { $0.parentTaskId == nil && $0.state != "todo" && !TaskStates.terminal.contains($0.state) }
            .sorted { $0.updatedAt > $1.updatedAt }.prefix(4))
    }
}

/// Top-aligned columns whose widths follow `ratios` (e.g. 2:1), sized to the tallest column.
struct RatioColumns: Layout {
    var ratios: [CGFloat]
    var spacing: CGFloat = 24
    /// Stretch every column to the tallest one (for side-by-side cards).
    var equalHeights = false

    private func widths(_ total: CGFloat, count: Int) -> [CGFloat] {
        let ratios = (0..<count).map { $0 < self.ratios.count ? self.ratios[$0] : 1 }
        let available = max(0, total - spacing * CGFloat(count - 1))
        let sum = ratios.reduce(0, +)
        return ratios.map { available * $0 / sum }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 900
        let columns = widths(width, count: subviews.count)
        let height = zip(subviews, columns).map { $0.sizeThatFits(.init(width: $1, height: nil)).height }.max() ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        for (subview, width) in zip(subviews, widths(bounds.width, count: subviews.count)) {
            subview.place(at: CGPoint(x: x, y: bounds.minY), proposal: .init(width: width, height: equalHeights ? bounds.height : nil))
            x += width + spacing
        }
    }
}

struct WorkerPanel: View {
    @Environment(AppRouter.self) private var router
    let workers: [Worker]

    var body: some View {
        let online = workers.filter { $0.status == "online" }
        let running = online.reduce(0) { $0 + $1.runningJobs }
        VStack(alignment: .leading, spacing: 10) {
            if online.isEmpty {
                Text("No worker connected").font(Theme.font(14)).foregroundStyle(Theme.mutedForeground)
                if !workers.isEmpty { Text("\(workers.count) registered, all offline.").font(Theme.font(13)).foregroundStyle(Theme.mutedForeground) }
                Button("See Settings") { router.section = .settings }.font(Theme.font(14)).foregroundStyle(Theme.accent)
            } else {
                (Text("\(online.count) worker\(online.count == 1 ? "" : "s")").foregroundStyle(Theme.secondaryForeground).fontWeight(.medium)
                 + Text(" connected · \(running > 0 ? "\(running) job\(running == 1 ? "" : "s") running" : "idle")").foregroundStyle(Theme.mutedForeground))
                    .font(Theme.font(14))
                ForEach(online) { worker in
                    HStack(spacing: 8) {
                        PulsingDot(color: Theme.emerald, pulses: true)
                        Text("\(worker.name) · \(worker.hostname)").font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surface(Theme.muted, radius: Theme.Radius.row, dashed: true)
        .accessibilityElement(children: .combine)
    }
}

/// The create-task card from `apps/web/src/pages/Home.tsx`, reused by Home and the Tasks "+" sheet.
struct CreateTaskCard: View {
    @Environment(AppStore.self) private var store
    @Environment(APIClient.self) private var api
    @Environment(AppRouter.self) private var router
    var onCreated: () -> Void = {}

    private enum Mode: String, CaseIterable { case text = "New task", url = "Paste a URL", project = "New project" }
    @State private var mode = Mode.text
    @State private var textInput = ""
    @State private var urlInput = ""
    @State private var ticket: TicketImport?
    @State private var importing = false
    @State private var importError: String?
    @State private var reposInput = ""
    @State private var projectID = ""
    @State private var githubCatalog: GitHubCatalog?
    @State private var githubCatalogError: String?
    @State private var loadingGitHubCatalog = false
    @State private var workflowID = ""
    @State private var formError: String?
    @State private var uploadNote: String?
    @State private var importingFile = false
    @State private var creating = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                ForEach(Mode.allCases, id: \.self) { item in
                    let selected = mode == item
                    Button { mode = item } label: {
                        Text(item.rawValue)
                            .font(Theme.font(15, .medium))
                            .foregroundStyle(selected ? Theme.foreground : Theme.mutedForeground)
                            .padding(.horizontal, 12).frame(height: 48)
                            .overlay(alignment: .bottom) { if selected { Rectangle().fill(Theme.accent).frame(height: 2) } }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .hairline(.bottom)

            VStack(alignment: .leading, spacing: 14) {
                if mode == .project {
                    ProjectsSettingsCard(embedded: true)
                } else {
                    if mode == .text { textMode } else { urlMode }
                    projectSection
                    repoSection
                    if let formError { Text(formError).font(Theme.font(13)).foregroundStyle(Theme.dangerText) }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) { uploadButton; Spacer(minLength: 8); workflowPicker; createButton }
                        VStack(alignment: .leading, spacing: 10) {
                            uploadButton
                            HStack(spacing: 10) { workflowPicker; createButton.frame(maxWidth: .infinity) }
                        }
                    }
                }
            }
            .padding(20)
        }
        .surface(Theme.card, radius: Theme.Radius.card)
        .onAppear { pickDefaultWorkflow(); pickDefaultProject() }
        .onChange(of: store.workflows) { pickDefaultWorkflow() }
        .onChange(of: store.projects) { pickDefaultProject() }
        .task { await loadGitHubCatalog() }
        .onChange(of: router.section) { _, section in
            guard section == .home else { return }
            Task { await loadGitHubCatalog(force: true) }
        }
        .fileImporter(isPresented: $importingFile, allowedContentTypes: [.plainText, .text, UTType(filenameExtension: "md") ?? .text]) { handleFile($0) }
    }

    @ViewBuilder private var projectSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Menu {
                    if !store.projects.isEmpty {
                        Picker("Project", selection: $projectID) {
                            ForEach(store.projects) { project in
                                Text(project.name).tag(project.id)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "rectangle.stack").font(.system(size: 13))
                        Text(selectedProject?.name ?? "No project").lineLimit(1)
                        Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
                        Spacer(minLength: 0)
                    }
                    .font(Theme.font(14)).foregroundStyle(Theme.secondaryForeground)
                    .padding(.horizontal, 12).frame(minHeight: 44)
                    .surface(Theme.input, radius: Theme.Radius.control)
                }
                .accessibilityLabel("Project")
            }

            if let project = selectedProject {
                Text("\(project.repositories.count) repos · \(project.repositories.map(\.repository).joined(separator: ", "))")
                    .font(Theme.font(12)).foregroundStyle(Theme.mutedForeground).lineLimit(2)
            }
        }
    }

    @ViewBuilder private var repoSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "shippingbox").font(.system(size: 13)).foregroundStyle(Theme.mutedForeground)
                TextField("", text: $reposInput, prompt: Text(verbatim: selectedProject != nil ? "Repositories: leave empty to use all project repos" : "Repositories: owner/name, owner/other").foregroundStyle(Theme.mutedForeground))
                    .font(Theme.mono(13)).foregroundStyle(Theme.foreground)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onChange(of: reposInput) { formError = nil }
                    .accessibilityLabel("Repositories")
            }
            .fieldChrome(height: 48)

            if loadingGitHubCatalog {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading GitHub repositories...").font(Theme.font(12)).foregroundStyle(Theme.mutedForeground)
                }
            } else if !repositoryChoices.isEmpty {
                Menu {
                    ForEach(repositoryChoices, id: \.self) { repository in
                        Button(repository) { appendRepo(repository) }
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
                        Text("Choose from \(repositoryChoices.count) \(selectedProject == nil ? "available" : "project") repositories").lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .font(Theme.font(13)).foregroundStyle(Theme.secondaryForeground)
                    .padding(.horizontal, 12).frame(minHeight: 40)
                    .surface(Theme.input, radius: Theme.Radius.control)
                }
                .accessibilityLabel("Add repository")
            } else if selectedProject == nil {
                if let catalog = githubCatalog, catalog.connected {
                    if catalog.repositories.isEmpty {
                        Text("No GitHub repositories are available.")
                            .font(Theme.font(12)).foregroundStyle(Theme.mutedForeground)
                    }
                } else if let githubCatalogError {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle").font(.system(size: 12)).foregroundStyle(Theme.warning)
                        Text(githubCatalogError).font(Theme.font(12)).foregroundStyle(Theme.mutedForeground).lineLimit(2)
                        Spacer(minLength: 0)
                        Button("Retry") { Task { await loadGitHubCatalog(force: true) } }
                            .font(Theme.font(12, .medium)).foregroundStyle(Theme.accent)
                    }
                } else if githubCatalog != nil {
                    HStack(spacing: 6) {
                        Text("Connect GitHub to browse repositories.")
                            .font(Theme.font(12)).foregroundStyle(Theme.mutedForeground)
                        Button("Settings") { router.section = .settings }
                            .font(Theme.font(12, .medium)).foregroundStyle(Theme.accent)
                    }
                }
            }
        }
    }

    private var repositoryChoices: [String] {
        if let selectedProject {
            return selectedProject.repositories.map(\.repository)
        }
        return githubCatalog?.repositories.map(\.fullName) ?? []
    }

    private var uploadButton: some View {
        HStack(spacing: 10) {
            Button { importingFile = true } label: { Label("Upload plan", systemImage: "square.and.arrow.up").font(Theme.font(15)).fixedSize() }
                .foregroundStyle(Theme.secondaryForeground).frame(minHeight: 44)
            if let uploadNote { Text(uploadNote).font(Theme.font(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1) }
        }
    }

    private var createButton: some View {
                    Button { Task { await create() } } label: {
                        HStack(spacing: 10) {
                            Text("Create task").fixedSize()
                            Text("⌘↵").font(Theme.mono(11)).padding(.horizontal, 5).padding(.vertical, 2)
                                .background(.white.opacity(0.18), in: RoundedRectangle(cornerRadius: 5))
                                .accessibilityHidden(true)
                        }
                    }
                    .buttonStyle(.sindral(.primary, height: 48))
                    .disabled(!canCreate || creating)
                    .keyboardShortcut(.return, modifiers: .command)
    }

    private var textMode: some View {
        TextField("", text: $textInput, prompt: Text("Describe the task in detail. Include the problem, expected behavior, and any relevant context...").foregroundStyle(Theme.mutedForeground), axis: .vertical)
            .font(Theme.body).foregroundStyle(Theme.foreground).lineSpacing(4)
            .frame(minHeight: 128, alignment: .topLeading)
            .accessibilityLabel("Task description")
    }

    @ViewBuilder private var urlMode: some View {
        let detected = Tickets.detect(urlInput)
        HStack(spacing: 10) {
            TextField("", text: $urlInput, prompt: Text(verbatim: "https://linear.app/org/issue/ENG-123").foregroundStyle(Theme.mutedForeground))
                .font(Theme.mono(14)).foregroundStyle(Theme.foreground)
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                .onSubmit { Task { await importTicket() } }
                .onChange(of: urlInput) { ticket = nil; importError = nil }
                .fieldChrome(height: 48, focused: !urlInput.isEmpty)
                .accessibilityLabel("Ticket URL")
            Button { Task { await importTicket() } } label: { if importing { ProgressView() } else { Text("Import") } }
                .buttonStyle(.sindral(.subtle, height: 48)).disabled(detected == nil || importing)
        }
        if let importError { Text(importError).font(Theme.font(13)).foregroundStyle(Theme.dangerText) }
        if let ticket {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text(TicketProvider(rawValue: ticket.provider)?.label ?? ticket.provider).font(Theme.mono(11)).foregroundStyle(Theme.accent)
                        .padding(.horizontal, 6).padding(.vertical, 2).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 5))
                    Text(ticket.id).font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground)
                }
                TextField("Title", text: Binding(get: { ticket.title }, set: { self.ticket = TicketImport(provider: ticket.provider, id: ticket.id, title: $0, description: ticket.description, url: ticket.url) }))
                    .font(Theme.bodyMedium).foregroundStyle(Theme.foreground).accessibilityLabel("Imported title")
                TextField("Description", text: Binding(get: { ticket.description }, set: { self.ticket = TicketImport(provider: ticket.provider, id: ticket.id, title: ticket.title, description: $0, url: ticket.url) }), axis: .vertical)
                    .font(Theme.font(14)).foregroundStyle(Theme.secondaryForeground).lineLimit(3...8).accessibilityLabel("Imported description")
            }
            .padding(14).surface(Theme.input, radius: Theme.Radius.control)
        } else {
            Text(detected.map { "Detected a \($0.provider.label) ticket (\($0.id)). Import to pre-fill the task. Jira and GitHub issue URLs work too." }
                 ?? "Paste a Linear, Jira, or GitHub issue URL. Sindral will import the ticket title, description, and metadata automatically.")
                .font(Theme.font(14)).foregroundStyle(Theme.mutedForeground)
                .frame(minHeight: 72, alignment: .topLeading)
        }
    }

    private var workflowPicker: some View {
        Menu {
            Picker("Workflow", selection: $workflowID) {
                if store.workflows.isEmpty { Text("No workflows").tag("") }
                ForEach(store.workflows) { Text($0.name).tag($0.id) }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 13))
                Text(store.workflows.first { $0.id == workflowID }?.name ?? "Workflow").lineLimit(1).fixedSize()
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
            .font(Theme.font(15)).foregroundStyle(Theme.secondaryForeground)
            .padding(.horizontal, 16).frame(height: 48)
            .surface(Theme.secondary.opacity(0.6), radius: Theme.Radius.control)
        }
        .accessibilityLabel("Workflow")
    }

    private var canCreate: Bool { mode == .text ? !textInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : ticket != nil }
    private var selectedProject: Project? { store.projects.first { $0.id == projectID } }

    private func pickDefaultWorkflow() {
        guard workflowID.isEmpty || !store.workflows.contains(where: { $0.id == workflowID }) else { return }
        workflowID = (store.workflows.first { $0.isDefault == true } ?? store.workflows.first)?.id ?? ""
    }

    private func pickDefaultProject() {
        guard projectID.isEmpty || !store.projects.contains(where: { $0.id == projectID }) else { return }
        projectID = store.projects.first?.id ?? ""
    }

    private func parseRepos() -> [String]? {
        var repos: [String] = []
        for raw in reposInput.commaSeparated {
            guard let repo = Tickets.normalizeRepo(raw) else { formError = "\"\(raw)\" is not a valid repository. Use owner/name."; return nil }
            if !repos.contains(repo) { repos.append(repo) }
        }
        return repos
    }

    private func appendRepo(_ repository: String) {
        let current = reposInput.commaSeparated.compactMap(Tickets.normalizeRepo)
        guard !current.contains(repository) else { return }
        reposInput = (current + [repository]).joined(separator: ", ")
        formError = nil
    }

    private func loadGitHubCatalog(force: Bool = false) async {
        guard !loadingGitHubCatalog, force || githubCatalog == nil || githubCatalogError != nil else { return }
        loadingGitHubCatalog = true
        githubCatalogError = nil
        defer { loadingGitHubCatalog = false }
        do {
            let catalog = try await api.githubCatalog()
            githubCatalog = catalog
        } catch {
            githubCatalog = nil
            githubCatalogError = error.localizedDescription
        }
    }

    private func importTicket() async {
        guard Tickets.detect(urlInput) != nil else { return }
        importError = nil; importing = true; defer { importing = false }
        do { ticket = try await api.importTicket(urlInput.trimmingCharacters(in: .whitespacesAndNewlines)) }
        catch { importError = error.localizedDescription }
    }

    private func create() async {
        guard canCreate, !creating else { return }
        formError = nil
        guard let repos = parseRepos() else { return }
        creating = true; defer { creating = false }
        let description = mode == .text ? textInput.trimmingCharacters(in: .whitespacesAndNewlines) : ticket?.description ?? ""
        let title = mode == .text ? String((description.split(separator: "\n").first ?? "").prefix(200)) : ticket?.title ?? ""
        do {
            let resolvedProjectID = projectID.isEmpty ? nil : projectID
            var resolvedRepos = repos
            if let project = selectedProject, repos.isEmpty {
                resolvedRepos = project.repositories.map(\.repository)
            }

            _ = try await api.createTask(title: title, description: description, ticket: mode == .url ? ticket : nil, projectId: resolvedProjectID, repos: resolvedRepos, workflowId: workflowID.isEmpty ? nil : workflowID)
            textInput = ""; urlInput = ""; ticket = nil; reposInput = ""; projectID = resolvedProjectID ?? ""
            await store.refreshTasks()
            onCreated()
        } catch { formError = error.localizedDescription }
    }

    private func handleFile(_ result: Result<URL, Error>) {
        uploadNote = nil
        do {
            let url = try result.get()
            guard url.startAccessingSecurityScopedResource() else { return }
            defer { url.stopAccessingSecurityScopedResource() }
            guard ["md", "txt", "markdown"].contains(url.pathExtension.lowercased()) else { uploadNote = "Only .md and .txt files are supported."; return }
            let data = try Data(contentsOf: url)
            guard data.count <= 1_048_576 else { uploadNote = "File is larger than 1 MB."; return }
            let content = String(decoding: data, as: UTF8.self)
            mode = .text
            textInput = textInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? content : "\(textInput.trimmingCharacters(in: .whitespacesAndNewlines))\n\n\(content)"
            uploadNote = "Loaded \(url.lastPathComponent)"
        } catch { uploadNote = "Could not read the file." }
    }
}

/// Create-task card presented as a sheet (Tasks "+" button).
struct CreateTaskSheet: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView { CreateTaskCard { dismiss() }.padding(24) }
                .background(Theme.background)
                .navigationTitle("New task").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationBackground(Theme.background)
    }
}
