import SwiftUI

/// Workflow editor: toolbar, zoomable canvas and the step config panel (a sheet on iPhone).
struct WorkflowsView: View {
    @Environment(AppStore.self) private var store
    @Environment(APIClient.self) private var api
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var workflowID: String?
    @State private var draft: Workflow?
    @State private var selectedStepID: String?
    @State private var saving = false
    @State private var showingCreate = false
    @State private var confirmingDelete = false

    private var original: Workflow? { store.workflows.first { $0.id == workflowID } }
    private var isDirty: Bool { draft != nil && draft != original }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                toolbar
                if draft != nil {
                    WorkflowCanvas(workflow: Binding(get: { draft! }, set: { draft = $0 }), selectedStepID: $selectedStepID)
                } else {
                    EmptyPane(title: "No workflows", systemImage: "point.3.connected.trianglepath.dotted", message: "Create one with the + button.")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            if horizontalSizeClass == .regular, let binding = selectedStepBinding {
                StepConfigPanel(step: binding, workflow: Binding(get: { draft! }, set: { draft = $0 })) { selectedStepID = nil }
                    .frame(width: 300)
                    .transition(.move(edge: .trailing))
            }
        }
        .animation(.easeOut(duration: 0.2), value: selectedStepID)
        .background(Theme.background)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: Binding(get: { horizontalSizeClass == .compact && selectedStepID != nil }, set: { if !$0 { selectedStepID = nil } })) {
            if let binding = selectedStepBinding {
                NavigationStack { StepConfigPanel(step: binding, workflow: Binding(get: { draft! }, set: { draft = $0 })) { selectedStepID = nil } }
                    .presentationDetents([.medium, .large])
                    .presentationBackground(Theme.muted)
            }
        }
        .sheet(isPresented: $showingCreate) { NewWorkflowSheet { workflowID = $0 } }
        .confirmationDialog("Delete workflow?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete workflow", role: .destructive) { Task { await delete() } }
        } message: { Text("Tasks already pinned to this workflow keep their snapshot.") }
        .onAppear(perform: syncSelection)
        .onChange(of: store.workflows) { syncSelection() }
        .onChange(of: workflowID) { old, _ in draft = original; if old != nil { selectedStepID = nil } }
        .refreshable { await store.refreshWorkflows() }
    }

    private var selectedStepBinding: Binding<WorkflowStep>? {
        guard let draft, let id = selectedStepID, let index = draft.steps.firstIndex(where: { $0.id == id }) else { return nil }
        return Binding(get: { self.draft?.steps[safe: index] ?? draft.steps[index] }, set: { self.draft?.steps[index] = $0 })
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            Menu {
                Picker("Workflow", selection: Binding(get: { workflowID ?? "" }, set: { workflowID = $0 })) {
                    ForEach(store.workflows) { workflow in Text(workflow.isDefault == true ? "\(workflow.name) (default)" : workflow.name).tag(workflow.id) }
                }
                if let original, original.isDefault != true {
                    Button("Delete workflow", systemImage: "trash", role: .destructive) { confirmingDelete = true }
                }
            } label: {
                HStack(spacing: 10) {
                    Text(draft?.name ?? "Workflows").font(Theme.font(17, .semibold)).foregroundStyle(Theme.foreground).lineLimit(1)
                    if original?.isDefault == true {
                        Text("default").font(Theme.mono(12)).foregroundStyle(Theme.emerald)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Theme.emerald.opacity(0.1), in: RoundedRectangle(cornerRadius: 5))
                    }
                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.mutedForeground)
                }
                .padding(.horizontal, 16).frame(height: 44)
                .surface(Theme.card, radius: Theme.Radius.control)
            }
            .accessibilityLabel("Workflow: \(draft?.name ?? "none")")
            Button { showingCreate = true } label: { Image(systemName: "plus") }
                .buttonStyle(IconButtonStyle()).accessibilityLabel("New workflow")
            Spacer(minLength: 8)
            if let issue = validationIssue, isDirty {
                Text(issue).font(Theme.font(13)).foregroundStyle(Theme.dangerText).lineLimit(1)
            }
            if let draft, horizontalSizeClass == .regular {
                Text("\(draft.steps.count) steps · \(draft.edges.count) edges").font(Theme.mono(13)).foregroundStyle(Theme.mutedForeground)
            }
            Button("Add step") { addStep() }.buttonStyle(.sindral(.secondary)).disabled(draft == nil)
            if isDirty {
                Button("Revert") { draft = original }.buttonStyle(.sindral(.subtle))
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .buttonStyle(.sindral(.primary)).disabled(saving || validationIssue != nil)
            }
        }
        .padding(.horizontal, 20)
        .frame(height: 60)
        .hairline(.bottom)
    }

    private var validationIssue: String? {
        guard let draft else { return nil }
        if draft.name.trimmingCharacters(in: .whitespaces).isEmpty { return "A workflow name is required." }
        if draft.steps.isEmpty { return "Add at least one step." }
        if !draft.steps.contains(where: { $0.id == draft.entryStepId && $0.type == "human" }) { return "The entry step must be a human step." }
        if !draft.steps.contains(where: { $0.type == "end" }) { return "Add an end step." }
        if Set(draft.steps.map(\.id)).count != draft.steps.count { return "Step IDs must be unique." }
        if draft.edges.contains(where: { edge in !draft.steps.contains(where: { $0.id == edge.from }) || !draft.steps.contains(where: { $0.id == edge.to }) }) { return "Every transition must connect existing steps." }
        for step in draft.steps where step.type == "agent" {
            if step.output == nil || (step.output != "merge" && (step.engine == nil || step.model?.isEmpty != false || step.prompt?.isEmpty != false)) { return "Configure engine, model, prompt and output for “\(step.label)”." }
        }
        return nil
    }

    private func syncSelection() {
        if workflowID == nil || original == nil { workflowID = (store.workflows.first { $0.isDefault == true } ?? store.workflows.first)?.id }
        if !isDirty { draft = original }
        #if DEBUG
        if DemoMode.isEnabled, selectedStepID == nil, let step = DemoMode.stepID { selectedStepID = step }
        #endif
    }

    private func addStep() {
        guard var workflow = draft else { return }
        var number = workflow.steps.count + 1
        while workflow.steps.contains(where: { $0.id == "step-\(number)" }) { number += 1 }
        let maxX = workflow.steps.compactMap { $0.position?.x }.max() ?? 0
        workflow.steps.append(.init(id: "step-\(number)", type: "human", label: "New step", state: "new-step", position: .init(x: maxX + 180, y: 60)))
        draft = workflow
        selectedStepID = "step-\(number)"
    }

    private func save() async {
        guard let draft else { return }
        saving = true; defer { saving = false }
        do { self.draft = try await api.saveWorkflow(draft); await store.refreshWorkflows() } catch { store.present(error) }
    }

    private func delete() async {
        guard let id = workflowID else { return }
        do { try await api.deleteWorkflow(id); workflowID = nil; await store.refreshWorkflows() } catch { store.present(error) }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

// MARK: - Canvas

private enum NodeMetrics {
    static let size = CGSize(width: 140, height: 60)
    static func tint(_ type: String) -> Color {
        switch type { case "human": Color(hex: 0x38BDF8); case "end": Theme.emerald; default: Theme.violet }
    }
}

private struct WorkflowCanvas: View {
    @Binding var workflow: Workflow
    @Binding var selectedStepID: String?
    @State private var zoom: CGFloat = 1
    @State private var pinchStart: CGFloat?
    @State private var pan: CGSize = .zero
    @State private var panStart: CGSize?
    @State private var dragStart: [String: WorkflowPosition] = [:]

    var body: some View {
        GeometryReader { proxy in
            let world = worldBounds
            let fit = min(1.4, max(0.3, min((proxy.size.width - 80) / world.width, (proxy.size.height - 80) / world.height)))
            let scale = fit * zoom
            let origin = CGPoint(x: (proxy.size.width - world.width * scale) / 2 + pan.width, y: (proxy.size.height - world.height * scale) / 2 + pan.height)
            let toScreen = { (p: CGPoint) in CGPoint(x: origin.x + (p.x - world.minX) * scale, y: origin.y + (p.y - world.minY) * scale) }

            ZStack(alignment: .topLeading) {
                DotGrid(offset: CGSize(width: origin.x, height: origin.y), spacing: 20 * scale)
                    .contentShape(Rectangle())
                    .onTapGesture { selectedStepID = nil }
                    .gesture(DragGesture()
                        .onChanged { value in
                            let start = panStart ?? pan; panStart = start
                            pan = CGSize(width: start.width + value.translation.width, height: start.height + value.translation.height)
                        }
                        .onEnded { _ in panStart = nil })
                    .accessibilityHidden(true)

                Canvas { context, _ in
                    drawEdges(in: &context, scale: scale, toScreen: toScreen)
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)

                ForEach(workflow.steps) { step in
                    let center = toScreen(center(of: step))
                    WorkflowNode(step: step, selected: selectedStepID == step.id, dashed: isFeedbackLoop(step), isEntry: workflow.entryStepId == step.id)
                        .scaleEffect(scale)
                        .position(center)
                        .onTapGesture { selectedStepID = step.id }
                        .gesture(DragGesture(minimumDistance: 6)
                            .onChanged { value in
                                guard let index = workflow.steps.firstIndex(where: { $0.id == step.id }) else { return }
                                let start = dragStart[step.id] ?? position(of: step)
                                dragStart[step.id] = start
                                workflow.steps[index].position = .init(x: (start.x + value.translation.width / scale).rounded(), y: (start.y + value.translation.height / scale).rounded())
                            }
                            .onEnded { _ in dragStart[step.id] = nil; selectedStepID = step.id })
                }

                zoomControl(scale: scale)
                    .position(x: 88, y: proxy.size.height - 42)
            }
            .clipped()
            .simultaneousGesture(MagnifyGesture()
                .onChanged { value in
                    let start = pinchStart ?? zoom; pinchStart = start
                    zoom = min(3, max(0.4, start * value.magnification))
                }
                .onEnded { _ in pinchStart = nil })
        }
        .background(Theme.background)
    }

    private func zoomControl(scale: CGFloat) -> some View {
        HStack(spacing: 0) {
            Button { zoom = max(0.4, zoom / 1.2) } label: { Image(systemName: "minus").frame(width: 44, height: 44) }
                .accessibilityLabel("Zoom out")
            Button { zoom = 1; pan = .zero } label: { Text("\(Int((scale * 100).rounded()))%").font(Theme.mono(13)).frame(width: 56, height: 44) }
                .accessibilityLabel("Reset zoom")
            Button { zoom = min(3, zoom * 1.2) } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
                .accessibilityLabel("Zoom in")
        }
        .foregroundStyle(Theme.secondaryForeground)
        .padding(.horizontal, 6)
        .surface(Theme.card, radius: Theme.Radius.row)
    }

    // Geometry

    private func position(of step: WorkflowStep) -> WorkflowPosition {
        if let position = step.position { return position }
        let unpositioned = workflow.steps.filter { $0.position == nil }
        let columns = max(1, Int(Double(unpositioned.count).squareRoot().rounded(.up)))
        let i = unpositioned.firstIndex { $0.id == step.id } ?? 0
        return .init(x: 50 + Double(i % columns) * 180, y: 60 + Double(i / columns) * 120)
    }

    private func center(of step: WorkflowStep) -> CGPoint {
        let p = position(of: step)
        return CGPoint(x: p.x + NodeMetrics.size.width / 2, y: p.y + NodeMetrics.size.height / 2)
    }

    private var worldBounds: CGRect {
        let rects = workflow.steps.map { step -> CGRect in let p = position(of: step); return CGRect(x: p.x, y: p.y, width: NodeMetrics.size.width, height: NodeMetrics.size.height) }
        guard let first = rects.first else { return CGRect(x: 0, y: 0, width: 600, height: 400) }
        return rects.dropFirst().reduce(first) { $0.union($1) }.insetBy(dx: -20, dy: -30)
    }

    /// Agent steps reached by a feedback or reject edge (revision loops) draw dashed.
    private func isFeedbackLoop(_ step: WorkflowStep) -> Bool {
        step.type == "agent" && workflow.edges.contains { $0.to == step.id && ($0.event == "feedback" || $0.event == "reject") }
    }

    private func drawEdges(in context: inout GraphicsContext, scale: CGFloat, toScreen: (CGPoint) -> CGPoint) {
        let steps = Dictionary(workflow.steps.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for edge in workflow.edges {
            guard let from = steps[edge.from], let to = steps[edge.to] else { continue }
            let dashed = edge.event == "feedback" || edge.event == "reject" || isFeedbackLoop(from)
            let style = StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round, dash: dashed ? [5, 4] : [])
            let label = edge.label ?? edge.event
            if from.id == to.id {
                let c = toScreen(center(of: from)), top = c.y - NodeMetrics.size.height / 2 * scale
                var loop = Path()
                loop.move(to: CGPoint(x: c.x - 20, y: top))
                loop.addCurve(to: CGPoint(x: c.x + 20, y: top), control1: CGPoint(x: c.x - 20, y: top - 34), control2: CGPoint(x: c.x + 20, y: top - 34))
                context.stroke(loop, with: .color(Theme.edge), style: style)
                drawArrow(&context, tip: CGPoint(x: c.x + 20, y: top), angle: .pi / 2)
                continue
            }
            let a = toScreen(center(of: from)), b = toScreen(center(of: to))
            let hasReverse = workflow.edges.contains { $0.from == edge.to && $0.to == edge.from }
            let dx = b.x - a.x, dy = b.y - a.y, length = max(1, hypot(dx, dy))
            // Offset parallel edges so a pair of opposite edges doesn't overlap.
            let offset = hasReverse ? 10 * scale : 0
            let nx = -dy / length * offset, ny = dx / length * offset
            let start = borderPoint(center: CGPoint(x: a.x + nx, y: a.y + ny), dx: dx, dy: dy, scale: scale)
            let end = borderPoint(center: CGPoint(x: b.x + nx, y: b.y + ny), dx: -dx, dy: -dy, scale: scale)
            var path = Path(); path.move(to: start); path.addLine(to: end)
            context.stroke(path, with: .color(Theme.edge), style: style)
            drawArrow(&context, tip: end, angle: atan2(end.y - start.y, end.x - start.x))
            let visible = hypot(end.x - start.x, end.y - start.y)
            if visible > 90 {
                let mid = CGPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)
                let text = Text(label).font(Theme.mono(11)).foregroundColor(Theme.mutedForeground)
                let vertical = abs(dy) > abs(dx)
                context.draw(text, at: vertical ? CGPoint(x: mid.x + 10, y: mid.y) : CGPoint(x: mid.x, y: mid.y - 10), anchor: vertical ? .leading : .bottom)
            }
        }
    }

    private func borderPoint(center: CGPoint, dx: CGFloat, dy: CGFloat, scale: CGFloat) -> CGPoint {
        let hw = NodeMetrics.size.width / 2 * scale + 2, hh = NodeMetrics.size.height / 2 * scale + 2
        guard dx != 0 || dy != 0 else { return center }
        let t = min(dx == 0 ? .infinity : hw / abs(dx), dy == 0 ? .infinity : hh / abs(dy))
        return CGPoint(x: center.x + dx * t, y: center.y + dy * t)
    }

    private func drawArrow(_ context: inout GraphicsContext, tip: CGPoint, angle: CGFloat) {
        var head = Path()
        head.move(to: tip)
        head.addLine(to: CGPoint(x: tip.x - 9 * cos(angle - 0.45), y: tip.y - 9 * sin(angle - 0.45)))
        head.addLine(to: CGPoint(x: tip.x - 9 * cos(angle + 0.45), y: tip.y - 9 * sin(angle + 0.45)))
        head.closeSubpath()
        context.fill(head, with: .color(Theme.edge))
    }
}

private struct DotGrid: View {
    let offset: CGSize
    let spacing: CGFloat
    var body: some View {
        Canvas { context, size in
            let step = max(8, spacing)
            let startX = offset.width.truncatingRemainder(dividingBy: step) - step
            let startY = offset.height.truncatingRemainder(dividingBy: step) - step
            var dots = Path()
            var y = startY
            while y < size.height {
                var x = startX
                while x < size.width { dots.addEllipse(in: CGRect(x: x - 0.9, y: y - 0.9, width: 1.8, height: 1.8)); x += step }
                y += step
            }
            context.fill(dots, with: .color(Theme.border))
        }
    }
}

private struct WorkflowNode: View {
    let step: WorkflowStep
    let selected: Bool
    let dashed: Bool
    let isEntry: Bool

    var body: some View {
        let tint = NodeMetrics.tint(step.type)
        VStack(alignment: .leading, spacing: 3) {
            Text(step.type.uppercased()).font(Theme.mono(10, .medium)).tracking(1).foregroundStyle(tint)
            Text(step.label).font(Theme.font(13, .semibold)).foregroundStyle(Theme.foreground).lineLimit(2).minimumScaleFactor(0.85)
        }
        .padding(.horizontal, 12)
        .frame(width: NodeMetrics.size.width, height: NodeMetrics.size.height, alignment: .leading)
        .background(selected ? Theme.secondary : Theme.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(selected ? Theme.primary : tint.opacity(0.25), style: StrokeStyle(lineWidth: selected ? 1.5 : 1, dash: dashed && !selected ? [4, 3] : []))
        }
        .overlay(alignment: .leading) { if isEntry { Circle().fill(Theme.accent).frame(width: 7, height: 7).offset(x: -3.5) } }
        .background { if selected { RoundedRectangle(cornerRadius: 15).stroke(Theme.primary.opacity(0.18), lineWidth: 4).padding(-3) } }
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(step.type) step \(step.label)\(isEntry ? ", entry step" : "")")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - Step config

private struct StepConfigPanel: View {
    @Binding var step: WorkflowStep
    @Binding var workflow: Workflow
    let onClose: () -> Void

    static let engines = ["claude", "codex"]
    static let modes = ["high", "normal", "low"]
    static let outputs = ["plan", "pr", "review", "verdict", "document", "troubleshoot", "conflict-resolution", "merge"]
    static let tools = ["read_file", "write_file", "run_command", "search_codebase", "list_directory", "create_pr", "web_search"]
    static let permissions = ["read", "write", "execute"]
    static let models = ["claude": ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1"], "codex": ["gpt-5-codex", "gpt-5", "o4-mini"]]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("STEP CONFIG").font(Theme.mono(12, .medium)).tracking(2).foregroundStyle(Theme.mutedForeground)
                Spacer()
                Button(action: onClose) { Image(systemName: "xmark").font(.system(size: 14, weight: .medium)).frame(width: 44, height: 44) }
                    .foregroundStyle(Theme.secondaryForeground).accessibilityLabel("Close step config")
            }
            .padding(.leading, 20).padding(.trailing, 8).frame(height: 60)
            .hairline(.bottom)

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    field("Label") { TextField("Label", text: $step.label).font(Theme.font(15)).fieldChrome(height: 44) }
                    HStack(alignment: .top, spacing: 10) {
                        field("Type") {
                            menu(selection: $step.type, options: ["human", "agent", "end"], tint: NodeMetrics.tint(step.type), filled: true)
                        }
                        field("State") {
                            TextField("state", text: Binding(get: { step.state }, set: { step.state = $0.lowercased().replacingOccurrences(of: #"[^a-z0-9-]"#, with: "-", options: .regularExpression) }))
                                .font(Theme.mono(14)).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .fieldChrome(height: 44).disabled(step.type == "end")
                        }
                    }
                    if step.type == "human" {
                        Toggle("Entry step (tasks start here)", isOn: Binding(get: { workflow.entryStepId == step.id }, set: { if $0 { workflow.entryStepId = step.id } }))
                            .font(Theme.font(14)).foregroundStyle(Theme.secondaryForeground).tint(Theme.primary)
                    }
                    if step.type == "agent" { agentFields }
                    if step.type != "end" { edgesSection }
                    Button("Delete step", role: .destructive) { deleteStep() }
                        .buttonStyle(.sindral(.danger)).disabled(workflow.steps.count <= 1)
                        .padding(.top, 4)
                }
                .padding(20)
            }
        }
        .background(Theme.muted)
        .hairline(.leading)
    }

    @ViewBuilder private var agentFields: some View {
        HStack(alignment: .top, spacing: 10) {
            field("Engine") {
                menu(selection: Binding(get: { step.engine ?? "" }, set: { engine in step.engine = engine; step.model = Self.models[engine]?.first ?? step.model }), options: Self.engines, labels: ["claude": "Claude Code", "codex": "Codex"])
            }
            field("Mode") { menu(selection: Binding(get: { step.mode ?? "normal" }, set: { step.mode = $0 }), options: Self.modes) }
        }
        field("Model") {
            let options = (Self.models[step.engine ?? ""] ?? []) + (step.model.map { model in (Self.models[step.engine ?? ""] ?? []).contains(model) ? [] : [model] } ?? [])
            menu(selection: Binding(get: { step.model ?? "" }, set: { step.model = $0 }), options: options, mono: true)
        }
        field("Output") { menu(selection: Binding(get: { step.output ?? "" }, set: { step.output = $0 }), options: Self.outputs, mono: true) }
        field("Prompt") {
            TextEditor(text: Binding(get: { step.prompt ?? "" }, set: { step.prompt = $0 }))
                .font(Theme.mono(13)).scrollContentBackground(.hidden)
                .padding(8).frame(minHeight: 180)
                .surface(Theme.input, radius: Theme.Radius.control)
        }
        field("Allowed tools") { toggles(Self.tools, selection: $step.tools, tint: Theme.violet) }
        field("Permissions") { toggles(Self.permissions, selection: $step.permissions, tint: Theme.emerald) }
    }

    private var edgesSection: some View {
        let outgoing = workflow.edges.indices.filter { workflow.edges[$0].from == step.id }
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Outgoing edges").font(Theme.font(14)).foregroundStyle(Theme.secondaryForeground)
                Spacer()
                Button("+ add") { addEdge() }.font(Theme.mono(13)).foregroundStyle(Theme.accent).frame(minHeight: 44)
            }
            if outgoing.isEmpty { Text("No edges yet.").font(Theme.font(13)).foregroundStyle(Theme.mutedForeground) }
            ForEach(outgoing, id: \.self) { index in
                HStack(spacing: 8) {
                    TextField("event", text: Binding(get: { workflow.edges[safe: index]?.event ?? "" }, set: { workflow.edges[index].event = $0.lowercased().replacingOccurrences(of: #"[^a-z0-9_-]"#, with: "", options: .regularExpression) }))
                        .font(Theme.mono(13)).foregroundStyle(Theme.secondaryForeground)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .frame(maxWidth: 100)
                        .accessibilityLabel("Edge event")
                    Spacer(minLength: 4)
                    Menu {
                        Picker("Target", selection: Binding(get: { workflow.edges[safe: index]?.to ?? "" }, set: { workflow.edges[index].to = $0 })) {
                            ForEach(workflow.steps) { Text("\($0.label) (\($0.type))").tag($0.id) }
                        }
                    } label: {
                        Text("→ \(workflow.steps.first { $0.id == workflow.edges[safe: index]?.to }?.label ?? "?")")
                            .font(Theme.mono(13)).foregroundStyle(Theme.secondaryForeground).lineLimit(1)
                    }
                    .accessibilityLabel("Edge target")
                    Button { workflow.edges.remove(at: index) } label: { Image(systemName: "xmark").font(.system(size: 11)).frame(width: 32, height: 44) }
                        .foregroundStyle(Theme.mutedForeground).accessibilityLabel("Remove edge")
                }
                .padding(.leading, 14).padding(.trailing, 4)
                .frame(minHeight: 52)
                .surface(Theme.card, radius: Theme.Radius.control)
            }
            if step.type == "human" {
                Text("Each edge becomes an action button. A feedback edge is triggered by chat instead.")
                    .font(Theme.font(12)).foregroundStyle(Theme.mutedForeground)
            }
        }
    }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(Theme.font(14)).foregroundStyle(Theme.secondaryForeground)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func menu(selection: Binding<String>, options: [String], labels: [String: String] = [:], tint: Color? = nil, filled: Bool = false, mono: Bool = false) -> some View {
        Menu {
            Picker("", selection: selection) { ForEach(options, id: \.self) { Text(labels[$0] ?? $0).tag($0) } }
        } label: {
            Text(selection.wrappedValue.isEmpty ? "Select…" : labels[selection.wrappedValue] ?? selection.wrappedValue)
                .font(mono || filled ? Theme.mono(14) : Theme.font(15))
                .foregroundStyle(tint ?? Theme.foreground).lineLimit(1)
                .padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background((tint ?? Theme.input).opacity(filled ? 0.1 : 1), in: RoundedRectangle(cornerRadius: Theme.Radius.control))
                .overlay { RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(filled ? (tint ?? Theme.border).opacity(0.35) : Theme.border) }
        }
    }

    private func toggles(_ values: [String], selection: Binding<[String]?>, tint: Color) -> some View {
        FlowLayout(spacing: 6, lineSpacing: 6) {
            ForEach(values, id: \.self) { value in
                let on = selection.wrappedValue?.contains(value) == true
                Button {
                    var next = Set(selection.wrappedValue ?? [])
                    if on { next.remove(value) } else { next.insert(value) }
                    selection.wrappedValue = values.filter(next.contains)
                } label: {
                    Text(value).font(Theme.mono(12)).foregroundStyle(on ? tint : Theme.mutedForeground)
                        .padding(.horizontal, 10).frame(minHeight: 36)
                        .background(on ? tint.opacity(0.12) : Theme.input, in: RoundedRectangle(cornerRadius: 8))
                        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(on ? tint.opacity(0.35) : Theme.border) }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }

    private func addEdge() {
        let target = workflow.steps.first { $0.id != step.id } ?? step
        let used = Set(workflow.edges.filter { $0.from == step.id }.map(\.event))
        let base = step.type == "agent" ? "complete" : "approve"
        var event = base, n = 2
        while used.contains(event) { event = "\(base)-\(n)"; n += 1 }
        workflow.edges.append(.init(from: step.id, to: target.id, event: event, label: nil))
    }

    private func deleteStep() {
        let id = step.id
        onClose()
        workflow.edges.removeAll { $0.from == id || $0.to == id }
        workflow.steps.removeAll { $0.id == id }
    }
}

private struct NewWorkflowSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppStore.self) private var store
    @Environment(APIClient.self) private var api
    let onCreated: (String) -> Void
    @State private var name = ""
    @State private var cloneFrom = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("Workflow name", text: $name)
                Picker("Clone from", selection: $cloneFrom) { Text("Full SDLC default").tag(""); ForEach(store.workflows) { Text($0.name).tag($0.id) } }
            }
            .themedList()
            .navigationTitle("New workflow").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Create") { Task { await create() } }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
        }
    }

    private func create() async {
        do {
            let workflow = try await api.createWorkflow(name: name.trimmingCharacters(in: .whitespaces), cloneFrom: cloneFrom.isEmpty ? nil : cloneFrom)
            await store.refreshWorkflows(); onCreated(workflow.id); dismiss()
        } catch { store.present(error) }
    }
}
