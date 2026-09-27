import SwiftUI

struct TaskDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let taskID: String
    @State private var task: TaskDetail?
    @State private var selectedTab = DetailTab.summary
    @State private var isLoading = true
    @State private var error: Error?
    @State private var isActing = false
    @State private var showingEdit = false
    @State private var confirmingDelete = false

    var body: some View {
        Group {
            if isLoading { ProgressView("Loading task…") }
            else if let error { ErrorRetryView(error: error) { Task { await load() } } }
            else if let task {
                VStack(spacing: 0) {
                    header(task)
                    ScrollView(.horizontal, showsIndicators: false) { HStack { ForEach(DetailTab.allCases) { tab in Button(tab.title) { selectedTab = tab }.buttonStyle(.bordered).tint(selectedTab == tab ? .indigo : .secondary) } }.padding(.horizontal).padding(.vertical, 8) }
                    Divider()
                    tabContent(task)
                }
            }
        }
        .navigationTitle(task?.key ?? "Task").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Menu { Button("Edit", systemImage: "pencil") { showingEdit = true }; Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = true } } label: { Image(systemName: "ellipsis.circle") } } }
        .sheet(isPresented: $showingEdit) { if let task { EditTaskView(task: task.summary) { await load() } } }
        .confirmationDialog("Delete this task?", isPresented: $confirmingDelete, titleVisibility: .visible) { Button("Delete task", role: .destructive) { Task { await deleteTask() } } }
        .task(id: taskID) { await load() }
        .refreshable { await load() }
    }

    private func header(_ task: TaskDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) { Text(task.title).font(.title2.bold()); Spacer(); StatusPill(state: task.state) }
            let actions = task.summary.availableActions(workflows: store.workflows)
            if !actions.isEmpty { ScrollView(.horizontal, showsIndicators: false) { HStack { ForEach(actions) { action in Button(action.label) { Task { await run(action.event) } }.buttonStyle(.borderedProminent).disabled(isActing) } } } }
        }.padding()
    }

    @ViewBuilder private func tabContent(_ task: TaskDetail) -> some View {
        switch selectedTab {
        case .summary: TaskSummaryView(task: task)
        case .chat: TaskChatView(task: task) { await load() }
        case .plan: TextDocumentView(title: "Implementation plan", content: task.plan)
        case .code: TaskCodeView(task: task)
        case .steps: TaskStepsView(task: task)
        case .artifacts: TaskArtifactsView(artifacts: task.artifacts)
        case .subtasks: TaskSubtasksView(tasks: task.subtasks)
        case .jobs: TaskJobsView(taskID: task.id)
        }
    }

    private func load() async { isLoading = task == nil; defer { isLoading = false }; do { task = try await api.task(taskID); error = nil } catch { self.error = error } }
    private func run(_ event: String) async { guard let task else { return }; isActing = true; defer { isActing = false }; do { _ = try await api.runAction(task: task.summary, event: event); await load(); await store.refreshTasks() } catch { store.present(error) } }
    private func deleteTask() async { do { try await api.deleteTask(taskID); await store.refreshTasks(); dismiss() } catch { store.present(error) } }
}

private enum DetailTab: String, CaseIterable, Identifiable { case summary, chat, plan, code, steps, artifacts, subtasks, jobs; var id: String { rawValue }; var title: String { rawValue.capitalized } }

private struct TaskSummaryView: View {
    let task: TaskDetail
    var body: some View {
        List {
            if !task.outcome.isEmpty { Section("Outcome") { Text(task.outcome) } }
            if !task.acceptanceCriteria.isEmpty { Section("Acceptance criteria") { Text(task.acceptanceCriteria) } }
            Section("Description") { Text(task.description.isEmpty ? "No description" : task.description) }
            if let error = task.lastError { Section("Last error") { Text(error).foregroundStyle(.red) } }
            Section("Delivery") {
                if !task.repos.isEmpty { LabeledContent("Repositories", value: task.repos.joined(separator: ", ")) }
                if let branch = task.branch { LabeledContent("Branch", value: branch) }
                if let url = task.ticketUrl, let link = URL(string: url) { Link("Open source ticket", destination: link) }
                if let url = task.prUrl, let link = URL(string: url) { Link("Open pull request", destination: link) }
            }
        }.listStyle(.insetGrouped)
    }
}

private struct TaskChatView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppStore.self) private var store
    let task: TaskDetail; let didSend: () async -> Void
    @State private var message = ""; @State private var sending = false
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                List(task.messages) { item in
                    HStack { if item.role == "user" { Spacer(minLength: 40) }; VStack(alignment: .leading, spacing: 4) { Text(item.role.capitalized).font(.caption2).foregroundStyle(.secondary); Text(item.content).textSelection(.enabled) }.padding(10).background(item.role == "user" ? Color.indigo.opacity(0.14) : Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 12)); if item.role != "user" { Spacer(minLength: 40) } }.id(item.id).listRowSeparator(.hidden)
                }.listStyle(.plain).onAppear { if let last = task.messages.last { proxy.scrollTo(last.id) } }
            }
            Divider()
            HStack(alignment: .bottom) { TextField("Message or feedback", text: $message, axis: .vertical).lineLimit(1...5).textFieldStyle(.roundedBorder); Button { Task { await send() } } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }.disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending) }.padding()
        }
    }
    private func send() async { let content = message.trimmingCharacters(in: .whitespacesAndNewlines); sending = true; defer { sending = false }; do { _ = try await api.sendMessage(taskId: task.id, content: content); message = ""; await didSend(); await store.refreshTasks() } catch { store.present(error) } }
}

private struct TextDocumentView: View {
    let title: String; let content: String?
    var body: some View { ScrollView { if let content, !content.isEmpty { Text(content).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled).padding() } else { ContentUnavailableView("No \(title.lowercased()) yet", systemImage: "doc.text") } }.navigationTitle(title) }
}

private struct TaskCodeView: View {
    @Environment(APIClient.self) private var api
    let task: TaskDetail
    @State private var files: [DiffFile] = []; @State private var repository: String?; @State private var error: Error?; @State private var loading = false
    var body: some View {
        List {
            if task.pullRequests.count > 1 { Picker("Repository", selection: $repository) { Text("First PR").tag(String?.none); ForEach(task.pullRequests) { Text($0.repository).tag(Optional($0.repository)) } } }
            ForEach(task.pullRequests) { pr in if let url = URL(string: pr.url) { Link(destination: url) { Label("#\(pr.number) · \(pr.repository)", systemImage: "arrow.up.right.square") } } }
            if loading { ProgressView() }
            if let error { Text(error.localizedDescription).foregroundStyle(.red) }
            ForEach(files) { file in DisclosureGroup { if let patch = file.patch { ScrollView(.horizontal) { Text(patch).font(.caption.monospaced()).textSelection(.enabled) } } else { Text("Patch unavailable") } } label: { VStack(alignment: .leading) { Text(file.filename).font(.subheadline.monospaced()); Text("+\(file.additions) −\(file.deletions) · \(file.status)").font(.caption).foregroundStyle(.secondary) } } }
        }.task(id: repository) { await load() }
    }
    private func load() async { loading = true; defer { loading = false }; do { files = try await api.diff(taskId: task.id, repository: repository); error = nil } catch { self.error = error } }
}

private struct TaskStepsView: View {
    let task: TaskDetail
    var body: some View { List(task.events.sorted { $0.createdAt > $1.createdAt }) { event in VStack(alignment: .leading, spacing: 4) { Text(event.type.replacingOccurrences(of: "-", with: " ").capitalized).font(.headline); if let from = event.fromState, let to = event.toState { Text("\(from) → \(to)").font(.caption.monospaced()).foregroundStyle(.secondary) }; Text(event.createdAt).font(.caption2).foregroundStyle(.secondary) } } }
}

private struct TaskArtifactsView: View {
    let artifacts: [Artifact]
    var body: some View { List(artifacts) { artifact in DisclosureGroup { if let content = artifact.content { Text(content).font(.caption.monospaced()).textSelection(.enabled) }; if let link = artifact.downloadUrl.flatMap(URL.init(string:)) { Link("Download", destination: link) } } label: { Label { VStack(alignment: .leading) { Text(artifact.name); Text(ByteCountFormatter.string(fromByteCount: Int64(artifact.byteSize), countStyle: .file)).font(.caption).foregroundStyle(.secondary) } } icon: { Image(systemName: "doc") } } }.overlay { if artifacts.isEmpty { ContentUnavailableView("No artifacts", systemImage: "archivebox") } } }
}

private struct TaskSubtasksView: View {
    let tasks: [SindralTask]
    var body: some View { List(tasks.sorted { ($0.sequence ?? 0) < ($1.sequence ?? 0) }) { task in NavigationLink(value: task.id) { TaskRow(task: task) } }.overlay { if tasks.isEmpty { ContentUnavailableView("No subtasks", systemImage: "list.bullet.indent") } } }
}

private struct TaskJobsView: View {
    @Environment(APIClient.self) private var api
    let taskID: String
    @State private var jobs: [Job] = []; @State private var selected: Job?
    var body: some View { List(jobs) { job in Button { selected = job } label: { HStack { VStack(alignment: .leading) { Text(job.kind.replacingOccurrences(of: "-", with: " ").capitalized); Text("Attempt \(job.attempt)").font(.caption).foregroundStyle(.secondary) }; Spacer(); StatusPill(state: job.status) } }.buttonStyle(.plain) }.overlay { if jobs.isEmpty { ContentUnavailableView("No jobs", systemImage: "terminal") } }.task { jobs = (try? await api.jobs(taskId: taskID)) ?? [] }.sheet(item: $selected) { JobLogsView(job: $0) } }
}

private struct JobLogsView: View {
    @Environment(\.dismiss) private var dismiss; @Environment(APIClient.self) private var api
    let job: Job; @State private var logs: [JobLog] = []
    var body: some View { NavigationStack { List { if let result = job.result { Section("Result") { Text(result.prettyPrinted).font(.caption.monospaced()).textSelection(.enabled) } }; if let error = job.error { Section("Error") { Text(error).foregroundStyle(.red).textSelection(.enabled) } }; Section("Logs") { ForEach(logs) { log in VStack(alignment: .leading) { Text(log.type.uppercased()).font(.caption2).foregroundStyle(.secondary); Text(log.message).font(.caption.monospaced()).textSelection(.enabled) } } } }.navigationTitle("Job details").toolbar { Button("Done") { dismiss() } }.task { logs = (try? await api.logs(jobId: job.id)) ?? [] } } }
}

private struct EditTaskView: View {
    @Environment(\.dismiss) private var dismiss; @Environment(APIClient.self) private var api; @Environment(AppStore.self) private var store
    let task: SindralTask; let didSave: () async -> Void
    @State private var title: String; @State private var description: String; @State private var repos: String; @State private var workflowID: String; @State private var saving = false
    init(task: SindralTask, didSave: @escaping () async -> Void) { self.task = task; self.didSave = didSave; _title = State(initialValue: task.title); _description = State(initialValue: task.description); _repos = State(initialValue: task.repos.joined(separator: ", ")); _workflowID = State(initialValue: task.workflowId ?? "") }
    var body: some View { NavigationStack { Form { TextField("Title", text: $title); TextEditor(text: $description).frame(minHeight: 130); TextField("Repositories", text: $repos); Picker("Workflow", selection: $workflowID) { Text("Default").tag(""); ForEach(store.workflows) { Text($0.name).tag($0.id) } } }.navigationTitle("Edit task").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(title.isEmpty || saving) } } } }
    private func save() async { saving = true; defer { saving = false }; do { _ = try await api.updateTask(task.id, title: title, description: description, repos: repos.commaSeparated, workflowId: workflowID.isEmpty ? nil : workflowID); await store.refreshTasks(); await didSave(); dismiss() } catch { store.present(error) } }
}
