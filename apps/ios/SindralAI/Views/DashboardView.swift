import SwiftUI
import UniformTypeIdentifiers

struct DashboardView: View {
    @Environment(AppStore.self) private var store
    @State private var showingCreate = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Welcome, \(store.profile?.displayName ?? store.profile?.email?.split(separator: "@").first.map(String.init) ?? "there").")
                        .font(.largeTitle.bold())
                    Text("What would you like to work on today?").foregroundStyle(.secondary)
                }
                Button { showingCreate = true } label: { Label("Create a task", systemImage: "plus.circle.fill").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                LazyVGrid(columns: [.init(.adaptive(minimum: 180, maximum: 260))], spacing: 12) {
                    DashboardMetric(label: "To do", value: count("todo"), color: .secondary)
                    DashboardMetric(label: "In progress", value: activeCount, color: .indigo)
                    DashboardMetric(label: "In review", value: count("in-review"), color: .orange)
                    DashboardMetric(label: "Done", value: count("done"), color: .green)
                }
                HStack { Text("Recent activity").font(.title2.bold()); Spacer(); Label(store.liveStatus, systemImage: store.liveStatus == "Live" ? "dot.radiowaves.left.and.right" : "wifi.slash").font(.caption).foregroundStyle(.secondary) }
                if activeTasks.isEmpty { ContentUnavailableView("No active tasks", systemImage: "sparkles", description: Text("Create a task to start a workflow.")) }
                else { ForEach(activeTasks) { task in NavigationLink(value: task.id) { TaskRow(task: task) }.buttonStyle(.plain); Divider() } }
            }.padding().frame(maxWidth: 1000, alignment: .leading).frame(maxWidth: .infinity)
        }
        .navigationTitle("Home").navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: String.self) { TaskDetailView(taskID: $0) }
        .sheet(isPresented: $showingCreate) { CreateTaskView() }
        .refreshable { await store.bootstrap() }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { showingCreate = true } label: { Image(systemName: "plus") }.accessibilityLabel("Create task") } }
    }

    private func count(_ state: String) -> Int { store.tasks.filter { $0.parentTaskId == nil && $0.state == state }.count }
    private var activeCount: Int { store.tasks.filter { $0.parentTaskId == nil && !["todo", "in-review", "done", "failure"].contains($0.state) }.count }
    private var activeTasks: [SindralTask] { Array(store.tasks.filter { $0.parentTaskId == nil && !["todo", "done"].contains($0.state) }.sorted { $0.updatedAt > $1.updatedAt }.prefix(4)) }
}

private struct DashboardMetric: View {
    let label: String; let value: Int; let color: Color
    var body: some View { VStack(alignment: .leading, spacing: 5) { Text(value.formatted()).font(.title.bold()).foregroundStyle(color); Text(label).font(.caption).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, alignment: .leading).padding().background(.background.secondary, in: RoundedRectangle(cornerRadius: 14)) }
}

struct CreateTaskView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppStore.self) private var store
    @Environment(APIClient.self) private var api
    @State private var source = 0
    @State private var description = ""
    @State private var ticketURL = ""
    @State private var ticket: TicketImport?
    @State private var repos = ""
    @State private var workflowID = ""
    @State private var isBusy = false
    @State private var errorMessage: String?
    @State private var importingFile = false

    var body: some View {
        NavigationStack {
            Form {
                Picker("Source", selection: $source) { Text("Describe").tag(0); Text("Ticket URL").tag(1) }.pickerStyle(.segmented)
                if source == 0 {
                    Section("Task") { TextEditor(text: $description).frame(minHeight: 150); Button { importingFile = true } label: { Label("Import Markdown or text", systemImage: "doc") } }
                } else {
                    Section("Ticket") {
                        TextField("Jira, Linear, or GitHub URL", text: $ticketURL).keyboardType(.URL).textInputAutocapitalization(.never)
                        Button("Import ticket") { Task { await importTicket() } }.disabled(ticketURL.isEmpty || isBusy)
                        if let ticket { LabeledContent(ticket.provider.capitalized, value: ticket.id); Text(ticket.title).font(.headline); Text(ticket.description).font(.caption).foregroundStyle(.secondary).lineLimit(5) }
                    }
                }
                Section("Delivery") {
                    TextField("Repositories (owner/name, comma separated)", text: $repos).textInputAutocapitalization(.never)
                    Picker("Workflow", selection: $workflowID) { Text("Default").tag(""); ForEach(store.workflows) { Text($0.name).tag($0.id) } }
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle("New task").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Create") { Task { await create() } }.disabled(!canCreate || isBusy) } }
            .fileImporter(isPresented: $importingFile, allowedContentTypes: [.plainText, .text, .sourceCode]) { result in
                do { let url = try result.get(); guard url.startAccessingSecurityScopedResource() else { return }; defer { url.stopAccessingSecurityScopedResource() }; let data = try Data(contentsOf: url); guard data.count <= 1_000_000 else { throw ImportError.tooLarge }; description = String(decoding: data, as: UTF8.self); source = 0 } catch { errorMessage = error.localizedDescription }
            }
            .overlay { if isBusy { ProgressView().controlSize(.large) } }
        }
    }

    private var canCreate: Bool { source == 0 ? !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : ticket != nil }
    private func importTicket() async { isBusy = true; defer { isBusy = false }; do { ticket = try await api.importTicket(ticketURL.trimmingCharacters(in: .whitespacesAndNewlines)) } catch { errorMessage = error.localizedDescription } }
    private func create() async {
        isBusy = true; defer { isBusy = false }
        let detail = source == 0 ? description.trimmingCharacters(in: .whitespacesAndNewlines) : ticket?.description ?? ""
        let title = source == 0 ? String(detail.split(separator: "\n").first ?? "New task").prefix(200).description : ticket?.title ?? "New task"
        let normalizedRepos = repos.commaSeparated
        guard normalizedRepos.allSatisfy({ $0.range(of: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", options: .regularExpression) != nil }) else { errorMessage = "Repositories must use owner/name."; return }
        do { _ = try await api.createTask(title: title, description: detail, ticket: ticket, repos: normalizedRepos, workflowId: workflowID.isEmpty ? nil : workflowID); await store.refreshTasks(); dismiss() } catch { errorMessage = error.localizedDescription }
    }
}

private enum ImportError: LocalizedError { case tooLarge; var errorDescription: String? { "Files must be 1 MB or smaller." } }
