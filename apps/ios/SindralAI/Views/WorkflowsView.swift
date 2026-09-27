import SwiftUI

struct WorkflowsView: View {
    @Environment(AppStore.self) private var store
    @Environment(APIClient.self) private var api
    @State private var showingCreate = false
    @State private var name = ""
    @State private var cloneFrom = ""

    var body: some View {
        List(store.workflows) { workflow in
            NavigationLink { WorkflowEditorView(workflow: workflow) } label: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack { Text(workflow.name).font(.headline); if workflow.isDefault == true { Text("DEFAULT").font(.caption2.bold()).foregroundStyle(.indigo) } }
                    Text("\(workflow.steps.count) steps · \(workflow.edges.count) transitions").font(.caption).foregroundStyle(.secondary)
                    if let description = workflow.description, !description.isEmpty { Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                }.padding(.vertical, 4)
            }
        }
        .navigationTitle("Workflows")
        .overlay { if store.workflows.isEmpty { ContentUnavailableView("No workflows", systemImage: "point.3.connected.trianglepath.dotted") } }
        .toolbar { Button { showingCreate = true } label: { Image(systemName: "plus") } }
        .refreshable { await store.refreshWorkflows() }
        .sheet(isPresented: $showingCreate) {
            NavigationStack { Form { TextField("Workflow name", text: $name); Picker("Clone from", selection: $cloneFrom) { Text("Full SDLC default").tag(""); ForEach(store.workflows) { Text($0.name).tag($0.id) } } }.navigationTitle("New workflow").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showingCreate = false } }; ToolbarItem(placement: .confirmationAction) { Button("Create") { Task { await create() } }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty) } } }
        }
    }
    private func create() async { do { _ = try await api.createWorkflow(name: name.trimmingCharacters(in: .whitespaces), cloneFrom: cloneFrom.isEmpty ? nil : cloneFrom); await store.refreshWorkflows(); showingCreate = false; name = "" } catch { store.present(error) } }
}

private struct WorkflowEditorView: View {
    @Environment(AppStore.self) private var store
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var draft: Workflow
    @State private var saving = false
    @State private var confirmingDelete = false
    init(workflow: Workflow) { _draft = State(initialValue: workflow) }

    var body: some View {
        Form {
            Section("Workflow") { TextField("Name", text: $draft.name); TextField("Description", text: Binding(get: { draft.description ?? "" }, set: { draft.description = $0 })); Picker("Entry step", selection: $draft.entryStepId) { ForEach(draft.steps.filter { $0.type == "human" }) { Text($0.label).tag($0.id) } } }
            Section("Steps") {
                ForEach($draft.steps) { $step in NavigationLink { WorkflowStepEditor(step: $step, allSteps: draft.steps) } label: { HStack { Image(systemName: icon(step.type)); VStack(alignment: .leading) { Text(step.label); Text("\(step.id) · \(step.state)").font(.caption.monospaced()).foregroundStyle(.secondary) } } } }
                .onDelete { indexes in let removed = indexes.map { draft.steps[$0].id }; draft.steps.remove(atOffsets: indexes); draft.edges.removeAll { removed.contains($0.from) || removed.contains($0.to) } }
                Button("Add step", systemImage: "plus") { addStep() }
            }
            Section("Transitions") {
                ForEach($draft.edges) { $edge in NavigationLink { WorkflowEdgeEditor(edge: $edge, steps: draft.steps) } label: { VStack(alignment: .leading) { Text(edge.label ?? edge.event.capitalized); Text("\(edge.from) → \(edge.to) [\(edge.event)]").font(.caption.monospaced()).foregroundStyle(.secondary) } } }
                .onDelete { draft.edges.remove(atOffsets: $0) }
                Button("Add transition", systemImage: "plus") { if let first = draft.steps.first, let last = draft.steps.last { draft.edges.append(.init(from: first.id, to: last.id, event: "complete", label: nil)) } }
            }
            Section { Button("Delete workflow", role: .destructive) { confirmingDelete = true }.disabled(draft.isDefault == true) }
        }
        .navigationTitle(draft.name).navigationBarTitleDisplayMode(.inline)
        .toolbar { Button(saving ? "Saving…" : "Save") { Task { await save() } }.disabled(saving || validationIssue != nil) }
        .safeAreaInset(edge: .bottom) { if let issue = validationIssue { Text(issue).font(.caption).foregroundStyle(.red).frame(maxWidth: .infinity).padding(8).background(.bar) } }
        .confirmationDialog("Delete workflow?", isPresented: $confirmingDelete) { Button("Delete", role: .destructive) { Task { await delete() } } }
    }

    private var validationIssue: String? {
        if draft.name.trimmingCharacters(in: .whitespaces).isEmpty { return "A workflow name is required." }
        if draft.steps.isEmpty { return "Add at least one step." }
        if !draft.steps.contains(where: { $0.id == draft.entryStepId && $0.type == "human" }) { return "The entry step must be a human step." }
        if !draft.steps.contains(where: { $0.type == "end" }) { return "Add an end step." }
        if Set(draft.steps.map(\.id)).count != draft.steps.count { return "Step IDs must be unique." }
        if draft.edges.contains(where: { edge in !draft.steps.contains(where: { $0.id == edge.from }) || !draft.steps.contains(where: { $0.id == edge.to }) }) { return "Every transition must connect existing steps." }
        for step in draft.steps where step.type == "agent" { if step.output == nil || (step.output != "merge" && (step.engine == nil || step.model?.isEmpty != false || step.prompt?.isEmpty != false)) { return "Configure engine, model, prompt, and output for every agent step." } }
        return nil
    }
    private func icon(_ type: String) -> String { type == "agent" ? "cpu" : type == "human" ? "person" : "flag.checkered" }
    private func addStep() { var number = draft.steps.count + 1; while draft.steps.contains(where: { $0.id == "step-\(number)" }) { number += 1 }; draft.steps.append(.init(id: "step-\(number)", type: "human", label: "New step", state: "new-step")) }
    private func save() async { saving = true; defer { saving = false }; do { draft = try await api.saveWorkflow(draft); await store.refreshWorkflows() } catch { store.present(error) } }
    private func delete() async { do { try await api.deleteWorkflow(draft.id); await store.refreshWorkflows(); dismiss() } catch { store.present(error) } }
}

private struct WorkflowStepEditor: View {
    @Binding var step: WorkflowStep; let allSteps: [WorkflowStep]
    let types = ["human", "agent", "end"], engines = ["claude", "codex"], modes = ["high", "normal", "low"], outputs = ["plan", "pr", "review", "verdict", "document", "troubleshoot", "conflict-resolution", "merge"]
    let availableTools = ["read_file", "write_file", "run_command", "search_codebase", "list_directory", "create_pr", "web_search"]
    let availablePermissions = ["read", "write", "execute"]
    var body: some View { Form { TextField("ID", text: $step.id).textInputAutocapitalization(.never); TextField("Label", text: $step.label); TextField("State", text: $step.state).textInputAutocapitalization(.never); Picker("Type", selection: $step.type) { ForEach(types, id: \.self) { Text($0.capitalized).tag($0) } }; if step.type == "agent" { Section("Agent") { Picker("Engine", selection: optional($step.engine, fallback: "codex")) { ForEach(engines, id: \.self) { Text($0.capitalized).tag($0) } }; TextField("Model", text: optional($step.model, fallback: "gpt-5")); Picker("Mode", selection: optional($step.mode, fallback: "normal")) { ForEach(modes, id: \.self) { Text($0.capitalized).tag($0) } }; Picker("Output", selection: optional($step.output, fallback: "pr")) { ForEach(outputs, id: \.self) { Text($0).tag($0) } } }; Section("Tools") { ForEach(availableTools, id: \.self) { tool in Toggle(tool.replacingOccurrences(of: "_", with: " ").capitalized, isOn: membership(tool, in: $step.tools)) } }; Section("Permissions") { ForEach(availablePermissions, id: \.self) { permission in Toggle(permission.capitalized, isOn: membership(permission, in: $step.permissions)) } }; Section("Prompt") { TextEditor(text: optional($step.prompt, fallback: "")).frame(minHeight: 180) } } }.navigationTitle(step.label) }
    private func optional(_ binding: Binding<String?>, fallback: String) -> Binding<String> { Binding(get: { binding.wrappedValue ?? fallback }, set: { binding.wrappedValue = $0 }) }
    private func membership(_ value: String, in binding: Binding<[String]?>) -> Binding<Bool> { Binding(get: { binding.wrappedValue?.contains(value) == true }, set: { enabled in var values = binding.wrappedValue ?? []; if enabled && !values.contains(value) { values.append(value) }; if !enabled { values.removeAll { $0 == value } }; binding.wrappedValue = values }) }
}

private struct WorkflowEdgeEditor: View {
    @Binding var edge: WorkflowEdge; let steps: [WorkflowStep]
    var body: some View { Form { Picker("From", selection: $edge.from) { ForEach(steps) { Text($0.label).tag($0.id) } }; Picker("To", selection: $edge.to) { ForEach(steps) { Text($0.label).tag($0.id) } }; TextField("Event", text: $edge.event).textInputAutocapitalization(.never); TextField("Label", text: Binding(get: { edge.label ?? "" }, set: { edge.label = $0.isEmpty ? nil : $0 })) }.navigationTitle("Transition") }
}
