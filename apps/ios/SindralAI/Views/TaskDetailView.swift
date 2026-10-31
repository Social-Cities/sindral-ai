import SwiftUI

struct TaskDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(APIClient.self) private var api
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let taskID: String
    /// iPad portrait: wrap the pipeline and stretch the tab bar across the width.
    var portrait = false
    /// Shows the "Tasks" list toggle in the toolbar when the list is collapsed.
    var onShowList: (() -> Void)?

    @State private var task: TaskDetail?
    @State private var selectedTab: DetailTab = {
        #if DEBUG
        if DemoMode.isEnabled, let tab = DemoMode.tab { return tab }
        #endif
        return .summary
    }()
    @State private var isLoading = true
    @State private var error: Error?
    @State private var isActing = false
    @State private var actionError: String?
    @State private var showingEdit = false
    @State private var showingJobs = false
    @State private var confirmingDelete = false
    @State private var pendingClose: String?
    @State private var loadedTaskID: String?
    @State private var userSelectedTab = false

    private var isCompact: Bool { horizontalSizeClass == .compact }
    /// Changes whenever the list refresh (SSE) reports a newer version of this task.
    private var listVersion: String { store.tasks.first { $0.id == taskID }?.updatedAt ?? "" }

    var body: some View {
        Group {
            if isLoading && task == nil { ProgressView("Loading task…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            else if let error, task == nil { ErrorRetryView(error: error) { Task { await load() } } }
            else if let task { content(task) }
        }
        .background(Theme.background)
        .navigationTitle(task?.key ?? "Task").navigationBarTitleDisplayMode(.inline)
        .toolbar(isCompact ? .visible : .hidden, for: .navigationBar)
        .sheet(isPresented: $showingEdit) { if let task { EditTaskView(task: task.summary) { await load() } } }
        .sheet(isPresented: $showingJobs) { NavigationStack { TaskJobsView(taskID: taskID).navigationTitle("Jobs").toolbar { Button("Done") { showingJobs = false } } } }
        .confirmationDialog("Delete this task?", isPresented: $confirmingDelete, titleVisibility: .visible) { Button("Delete task", role: .destructive) { Task { await deleteTask() } } }
        .alert(pendingClose == "mark-done" ? "Mark task done?" : "Mark task as won't do?", isPresented: Binding(get: { pendingClose != nil }, set: { if !$0 { pendingClose = nil } })) {
            Button("Cancel", role: .cancel) { pendingClose = nil }
            Button(pendingClose == "mark-done" ? "Mark done" : "Won't do", role: pendingClose == "mark-done" ? nil : .destructive) {
                if let event = pendingClose { Task { await run(event) } }
                pendingClose = nil
            }
        } message: {
            Text("This stops queued work for the task and hides it from the default Active task view. If an agent is already working, wait for it to finish first. You can still find the task with the status filter.")
        }
        .task(id: "\(taskID)|\(listVersion)") { await load() }
        .onChange(of: task?.resolvedWorkflow(store.workflows)?.isDesign) { _, isDesign in
            if isDesign == true, !userSelectedTab { selectedTab = .design }
        }
    }

    private func content(_ task: TaskDetail) -> some View {
        VStack(spacing: 0) {
            toolbar(task)
            if isCompact {
                compactContent(task)
            } else {
                header(task)
                tabContent(task)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    @ViewBuilder private func header(_ task: TaskDetail) -> some View {
        headerContent(task)
            .hairline(.bottom)
    }

    private func compactContent(_ task: TaskDetail) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                header(task)
                compactTabContent(task)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func headerContent(_ task: TaskDetail) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(task.title).font(Theme.font(portrait ? 24 : 22, .semibold, relativeTo: .title2)).tracking(-0.3)
                .foregroundStyle(Theme.foreground).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            PipelineView(task: task, workflow: task.resolvedWorkflow(store.workflows), wraps: portrait || isCompact)
            tabBar(task)
        }
        .padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Toolbar

    @ViewBuilder private func toolbar(_ task: TaskDetail) -> some View {
        if isCompact {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Text(task.key).font(Theme.mono(13)).foregroundStyle(Theme.mutedForeground)
                    StatusBadge(state: task.state, step: task.currentStep(store.workflows))
                    Spacer(minLength: 0)
                    moreMenu(task)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(task.summary.availableActions(workflows: store.workflows)) { action in
                            Button(action.label) { Task { await run(action.event) } }
                                .buttonStyle(.sindral(ButtonVariant.forEvent(action.event))).disabled(isActing)
                        }
                        if task.isAgentActive(store.workflows) {
                            Button("Stop agent") { Task { await stopAgent() } }.buttonStyle(.sindral(.warning)).disabled(isActing)
                            ProgressView().tint(Theme.violet)
                            Text("Agent working…").font(Theme.secondaryBody).foregroundStyle(Theme.secondaryForeground)
                        }
                    }.fixedSize(horizontal: true, vertical: false)
                }
                if let actionError { Text(actionError).font(Theme.secondaryBody).foregroundStyle(Theme.dangerText) }
            }
            .padding(.horizontal, 20).padding(.vertical, 10).hairline(.bottom)
        } else {
            regularToolbar(task)
        }
    }

    private func regularToolbar(_ task: TaskDetail) -> some View {
        let actions = task.summary.availableActions(workflows: store.workflows)
            .filter { $0.event != "approve" || (selectedTab != .summary && selectedTab != .plan) }
        let agentActive = task.isAgentActive(store.workflows)
        return HStack(spacing: 10) {
            if let onShowList {
                Button(action: onShowList) { Label("Tasks", systemImage: "sidebar.left").font(Theme.font(16)) }
                    .foregroundStyle(Theme.secondaryForeground).frame(minHeight: 44)
                    .padding(.trailing, 6)
            }
            Text(task.key).font(Theme.mono(13)).foregroundStyle(Theme.mutedForeground)
            StatusBadge(state: task.state, step: task.currentStep(store.workflows))
            Spacer(minLength: 8)
            if let actionError { Text(actionError).font(Theme.font(12)).foregroundStyle(Theme.dangerText).lineLimit(1).frame(maxWidth: 200) }
            if let pr = task.prUrl, let url = URL(string: pr) {
                Link(destination: url) { Text("View PR ↗").font(Theme.mono(13)) }.buttonStyle(.sindral(.ghost))
            } else if let ticket = task.ticketUrl, let url = URL(string: ticket), !isCompact {
                Link(destination: url) { Text("\(task.key) ↗").font(Theme.mono(13)) }.buttonStyle(.sindral(.ghost))
            }
            ForEach(actions) { action in
                Button(action.label) { Task { await run(action.event) } }
                    .buttonStyle(.sindral(ButtonVariant.forEvent(action.event)))
                    .disabled(isActing)
            }
            if agentActive {
                Button("Stop agent") { Task { await stopAgent() } }
                    .buttonStyle(.sindral(.warning))
                    .disabled(isActing)
            }
            if agentActive {
                HStack(spacing: 8) {
                    ProgressView().tint(Theme.violet)
                    Text("Agent working…").font(Theme.font(15)).foregroundStyle(Theme.secondaryForeground)
                }
                .accessibilityElement(children: .combine)
            }
            moreMenu(task)
        }
        .padding(.leading, onShowList == nil ? 24 : 16).padding(.trailing, 20)
        .frame(minHeight: 64)
        .hairline(.bottom)
    }

    private func moreMenu(_ task: TaskDetail) -> some View {
        let terminal = TaskStates.terminal.contains(task.state)
        let workflow = task.resolvedWorkflow(store.workflows)
        return Menu {
            Button("Edit", systemImage: "pencil") { showingEdit = true }
            Button("Mark done", systemImage: "checkmark.circle") { pendingClose = "mark-done" }.disabled(terminal)
            Button("Won't do", systemImage: "xmark.circle") { pendingClose = "mark-wont-do" }.disabled(terminal)
            Button("Stop agent", systemImage: "stop.circle") { Task { await stopAgent() } }.disabled(!task.isAgentActive(store.workflows))
            Button("Jobs", systemImage: "terminal") { showingJobs = true }
            Section("Info") {
                Text("Created \(Formatters.day(task.createdAt))")
                if let ticket = task.ticketUrl, let url = URL(string: ticket) { Link("Ticket \(task.key) ↗", destination: url) }
                if let workflow {
                    Text(task.pinnedWorkflow != nil ? "📌 \(workflow.name) — pinned" : task.state == "todo" ? "⬡ \(workflow.name) — pinned when started" : "⬡ \(workflow.name) — live workflow")
                }
            }
            Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = true }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.secondaryForeground)
                .frame(width: 44, height: 44)
                .overlay { RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(Theme.border) }
                .contentShape(Rectangle())
        }
        .accessibilityLabel("More actions")
    }

    // MARK: Tabs

    private func tabs(_ task: TaskDetail) -> [DetailTab] {
        DetailTab.allCases.filter { tab in
            (tab != .review || hasReviewSurface(task)) && (tab != .design || task.hasDesign(store.workflows))
        }
    }

    private func hasReviewSurface(_ task: TaskDetail) -> Bool {
        let reviewArtifactNames = Set(["review-slices.json", "diff-explanation.md", "adversarial-review.md"])
        if task.artifacts.contains(where: { reviewArtifactNames.contains($0.name) }) { return true }
        guard let workflow = task.resolvedWorkflow(store.workflows) else { return false }
        return workflow.steps.contains { step in
            step.id == "review-slice" || step.state == "review-slice" || step.output == "review-slice" || step.id == "adversarial-review"
        }
    }

    private func tabBar(_ task: TaskDetail) -> some View {
        let bar = HStack(spacing: 4) {
            ForEach(tabs(task)) { tab in
                let selected = selectedTab == tab
                Button { selectedTab = tab; userSelectedTab = true } label: {
                    HStack(spacing: 6) {
                        Text(tab.title)
                        if let count = count(tab, task) { Text("\(count)").font(Theme.mono(11)).foregroundStyle(Theme.mutedForeground) }
                    }
                    .font(Theme.font(14, .medium))
                    .foregroundStyle(selected ? Theme.foreground : Theme.mutedForeground)
                    .lineLimit(1)
                    .padding(.horizontal, 16).frame(height: 36)
                    .frame(maxWidth: portrait ? .infinity : nil)
                    .background {
                        if selected {
                            RoundedRectangle(cornerRadius: 9).fill(Theme.secondary)
                                .overlay { RoundedRectangle(cornerRadius: 9).strokeBorder(Theme.borderStrong) }
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(4)
        .surface(Theme.muted, radius: 12)
        return Group {
            if portrait { bar } else { ScrollView(.horizontal, showsIndicators: false) { bar } }
        }
        .frame(minHeight: 44)
    }

    private func count(_ tab: DetailTab, _ task: TaskDetail) -> Int? {
        switch tab {
        case .chat: task.messages.isEmpty ? nil : task.messages.count
        default: nil
        }
    }

    @ViewBuilder private func tabContent(_ task: TaskDetail) -> some View {
        let canApprove = task.summary.availableActions(workflows: store.workflows).contains { $0.event == "approve" }
        switch selectedTab {
        case .design: TaskDesignView(task: task, didChange: { await load() }, onConversation: { selectedTab = .chat })
        case .summary:
            TaskSummaryView(task: task, canApprove: canApprove, approving: isActing,
                            onApprove: { Task { await run("approve") } }, onViewPlan: { selectedTab = .plan },
                            onRequestChanges: { selectedTab = .chat })
        case .chat:
            TaskChatView(task: task, userInitial: String(store.displayName(fallbackEmail: session.user?.email).prefix(1)).uppercased()) { await load() }
        case .plan: TaskPlanView(task: task, canApprove: canApprove, approving: isActing, onFeedbackSent: { await load(); await store.refreshTasks() }) { Task { await run("approve") } }
        case .code: TaskCodeView(task: task)
        case .review: TaskReviewView(task: task)
        case .steps: TaskStepsView(task: task)
        case .artifacts: TaskArtifactsView(artifacts: task.artifacts)
        }
    }

    @ViewBuilder private func compactTabContent(_ task: TaskDetail) -> some View {
        let canApprove = task.summary.availableActions(workflows: store.workflows).contains { $0.event == "approve" }
        switch selectedTab {
        case .design: TaskDesignView(task: task, scrolls: false, didChange: { await load() }, onConversation: { selectedTab = .chat })
        case .summary:
            TaskSummaryView(task: task, canApprove: canApprove, approving: isActing, scrolls: false,
                            onApprove: { Task { await run("approve") } }, onViewPlan: { selectedTab = .plan },
                            onRequestChanges: { selectedTab = .chat })
        case .chat:
            TaskChatView(task: task, userInitial: String(store.displayName(fallbackEmail: session.user?.email).prefix(1)).uppercased(), scrolls: false) { await load() }
        case .plan: TaskPlanView(task: task, canApprove: canApprove, approving: isActing, scrolls: false, onFeedbackSent: { await load(); await store.refreshTasks() }) { Task { await run("approve") } }
        case .code: TaskCodeView(task: task, scrolls: false)
        case .review: TaskReviewView(task: task, scrolls: false)
        case .steps: TaskStepsView(task: task, scrolls: false)
        case .artifacts: TaskArtifactsView(artifacts: task.artifacts, scrolls: false)
        }
    }

    // MARK: Actions

    private func load() async {
        isLoading = task == nil; defer { isLoading = false }
        do {
            let loaded = try await api.task(taskID)
            try Task.checkCancellation()
            task = loaded; error = nil
            if loadedTaskID != taskID {
                selectedTab = loaded.resolvedWorkflow(store.workflows)?.isDesign == true ? .design : .summary
                userSelectedTab = false
                #if DEBUG
                if DemoMode.isEnabled, let tab = DemoMode.tab { selectedTab = tab; userSelectedTab = true }
                #endif
                loadedTaskID = taskID
            }
        } catch is CancellationError { } catch { self.error = error }
    }

    private func run(_ event: String) async {
        guard let task else { return }
        isActing = true; actionError = nil; defer { isActing = false }
        do { _ = try await api.runAction(task: task.summary, event: event); await load(); await store.refreshTasks() }
        catch { actionError = error.localizedDescription; store.present(error) }
    }

    private func deleteTask() async {
        do { try await api.deleteTask(taskID); router.selectedTaskID = nil; await store.refreshTasks() } catch { store.present(error) }
    }

    private func stopAgent() async {
        isActing = true; actionError = nil; defer { isActing = false }
        do { _ = try await api.stopAgent(taskId: taskID); await load(); await store.refreshTasks() }
        catch { actionError = error.localizedDescription; store.present(error) }
    }
}

enum DetailTab: String, CaseIterable, Identifiable {
    case summary, design, plan, chat, code, review, steps, artifacts
    var id: String { rawValue }
    var title: String {
        switch self {
        case .review: "Review"
        default: rawValue.capitalized
        }
    }
}

// MARK: - Pipeline

/// The workflow's happy path with the current step highlighted, mirroring `Pipeline.tsx`.
struct PipelineView: View {
    let task: TaskDetail
    let workflow: Workflow?
    var wraps = false

    var body: some View {
        if TaskStates.offPath.contains(task.state) {
            let style = StateStyle.for(task.state)
            let failed = workflow?.step(task.failedStepId ?? task.currentStepId)
            let label = task.state == "failure" ? "⚠ Failed" : task.state == "conflict-resolution" ? "◐ Resolving Conflict" : "◐ Troubleshoot"
            HStack(spacing: 8) {
                Text(label).font(Theme.mono(12, .medium)).foregroundStyle(style.color)
                    .padding(.horizontal, 8).frame(height: 28)
                    .background(Color(hex: 0xF87171, opacity: 0.08), in: RoundedRectangle(cornerRadius: 7))
                    .overlay { RoundedRectangle(cornerRadius: 7).strokeBorder(Color(hex: 0xFB923C, opacity: 0.13)) }
                Text("— task is off the main flow\(failed.map { " (failed at \($0.label))" } ?? "")")
                    .font(Theme.font(13)).foregroundStyle(Theme.mutedForeground)
            }
        } else if let workflow, !workflow.happyPath.isEmpty {
            let path = workflow.happyPath
            let currentIndex = index(in: path, workflow: workflow)
            let items = ForEach(Array(path.enumerated()), id: \.element.id) { i, step in
                chip(step, isCurrent: i == currentIndex && !TaskStates.terminal.contains(task.state),
                     isPast: i < currentIndex || (task.state == "done" && i <= currentIndex), isLast: i == path.count - 1)
            }
            Group {
                if wraps { FlowLayout(spacing: 0, lineSpacing: 10) { items } }
                else { ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: 0) { items } } }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Pipeline")
        } else {
            Text("No workflow attached.").font(Theme.font(13)).foregroundStyle(Theme.mutedForeground)
        }
    }

    private func index(in path: [WorkflowStep], workflow: Workflow) -> Int {
        guard let current = workflow.step(task.currentStepId ?? workflow.entryStepId) else { return -1 }
        if task.state == "done" { return path.count - 1 }
        if let i = path.firstIndex(where: { $0.id == current.id }) { return i }
        // Feedback loops count as the step they return to.
        if let back = workflow.edges.first(where: { $0.from == current.id && $0.event == "complete" }), let i = path.firstIndex(where: { $0.id == back.to }) { return i }
        return -1
    }

    private func chip(_ step: WorkflowStep, isCurrent: Bool, isPast: Bool, isLast: Bool) -> some View {
        HStack(spacing: 0) {
            HStack(spacing: 5) {
                if isPast { Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)) }
                Text(step.label).font(Theme.font(13, .medium)).lineLimit(1)
            }
            .foregroundStyle(isCurrent ? Theme.violet : isPast ? Theme.secondaryForeground : Theme.mutedForeground)
            .padding(.horizontal, 8).frame(height: 30)
            .background(isCurrent ? Theme.primary.opacity(0.12) : isPast ? Theme.card : .clear, in: RoundedRectangle(cornerRadius: 7))
            .overlay { RoundedRectangle(cornerRadius: 7).strokeBorder(isCurrent ? Theme.primary.opacity(0.4) : isPast ? Theme.border : .clear) }
            .accessibilityElement(children: .combine)
            .accessibilityValue(isCurrent ? "Current step" : isPast ? "Completed" : "Upcoming")
            if !isLast { Rectangle().fill(isPast ? Theme.borderStrong : Theme.border).frame(width: 8, height: 1).padding(.horizontal, 2) }
        }
    }
}

/// Left-to-right wrapping layout for pipeline chips and tags.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, rows.count - 1)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: .unspecified)
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !rows[rows.count - 1].indices.isEmpty, rows[rows.count - 1].width + spacing + size.width > width { rows.append(Row()) }
            var row = rows[rows.count - 1]
            row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
            rows[rows.count - 1] = row
        }
        return rows
    }
}

// MARK: - Summary

private struct TaskSummaryView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let task: TaskDetail
    let canApprove: Bool
    let approving: Bool
    var scrolls = true
    let onApprove: () -> Void
    let onViewPlan: () -> Void
    let onRequestChanges: () -> Void

    var body: some View {
        Group {
            if scrolls { ScrollView { content } }
            else { content }
        }
    }

    private var content: some View {
        let step = task.currentStep(store.workflows)
        let agentActive = task.isAgentActive(store.workflows)
        return VStack(alignment: .leading, spacing: 22) {
            if agentActive {
                HStack(alignment: .top, spacing: 12) {
                    PulsingDot(color: Theme.amber, pulses: true, size: 8).padding(.top, 7)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Agent is working").font(Theme.bodyMedium).foregroundStyle(Color(hex: 0xFDE68A, opacity: 0.85))
                        Text(task.state == "troubleshoot" ? "The troubleshooting agent is diagnosing what went wrong."
                             : step.map { "\($0.label) is running on your worker (\(StateStyle.for(task.state, step: $0).label))." } ?? "An agent is running on your worker.")
                            .font(Theme.secondaryBody).foregroundStyle(Theme.mutedForeground)
                    }
                    Spacer(minLength: 0)
                }
                .padding(16)
                .surface(Theme.amber.opacity(0.03), radius: Theme.Radius.row, border: Theme.amber.opacity(0.13))
            }
            if !agentActive, let step, step.type == "human", task.state != "todo" {
                HStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Waiting for you").font(Theme.bodyMedium).foregroundStyle(Theme.foreground)
                        Text("\(step.label): use the action buttons above, or send chat feedback to request changes.")
                            .font(Theme.secondaryBody).foregroundStyle(Theme.mutedForeground)
                    }
                    Spacer(minLength: 0)
                    if task.chatTriggersFeedback(store.workflows) {
                        Button("Request changes", action: onRequestChanges).buttonStyle(.sindral(.subtle))
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 14)
                .surface(Theme.secondary)
            }
            if task.state == "todo" {
                Text("This task is ready to start. Use the action button above to hand it to the first agent.")
                    .font(Theme.secondaryBody).foregroundStyle(Theme.secondaryForeground)
                    .padding(16).frame(maxWidth: .infinity, alignment: .leading).surface(Theme.secondary)
            }

            section("Description") {
                if task.description.isEmpty { Text("No description.").italic().font(Theme.body).foregroundStyle(Theme.mutedForeground) }
                else { MarkdownText(source: task.description) }
            }

            if let project = task.projectId.flatMap({ id in store.projects.first { $0.id == id } }) {
                section("Project") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(project.name).font(Theme.bodyMedium).foregroundStyle(Theme.foreground)
                        if !project.description.isEmpty {
                            Text(project.description).font(Theme.secondaryBody).foregroundStyle(Theme.mutedForeground)
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .surface(Theme.secondary, radius: Theme.Radius.row)
                }
            }

            section("Task contract") {
                if horizontalSizeClass == .regular {
                    RatioColumns(ratios: [1, 1], spacing: 12, equalHeights: true) { contractBox("Outcome", task.outcome); contractBox("Acceptance criteria", task.acceptanceCriteria) }
                } else {
                    VStack(spacing: 12) { contractBox("Outcome", task.outcome); contractBox("Acceptance criteria", task.acceptanceCriteria) }
                }
            }

            if !task.repos.isEmpty {
                section("Repositories") {
                    FlowLayout(spacing: 6, lineSpacing: 6) {
                        ForEach(task.repos, id: \.self) { repo in
                            Text(repo).font(Theme.mono(13)).foregroundStyle(Theme.secondaryForeground)
                                .padding(.horizontal, 10).frame(height: 32)
                                .surface(Theme.secondary, radius: 8)
                        }
                    }
                }
            }

            if let plan = task.plan, !plan.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        SectionLabel(text: "Plan at a glance")
                        Spacer()
                        Button("View full plan →", action: onViewPlan).font(Theme.font(14)).foregroundStyle(Theme.accent).frame(minHeight: 44)
                    }
                    let overview = PlanOverview(plan)
                    contractBox("Summary", overview.summary, empty: "No summary section.")
                    contractBox("Assumptions", overview.assumptions, empty: "No assumptions section.")
                    if canApprove {
                        HStack { Spacer(); Button(task.bddPlan != nil ? "Approve Both Plans" : "Approve Plan", action: onApprove).buttonStyle(.sindral(.success)).disabled(approving) }
                    }
                }
            }

            if !pullRequests.isEmpty {
                section("Pull requests") {
                    VStack(spacing: 8) {
                        ForEach(pullRequests, id: \.url) { pr in
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(pr.repository).font(Theme.mono(13)).foregroundStyle(Theme.secondaryForeground).lineLimit(1)
                                    if !pr.branch.isEmpty {
                                        Text(pr.baseBranch.isEmpty ? pr.branch : "\(pr.branch) → \(pr.baseBranch)").font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                                    }
                                }
                                Spacer(minLength: 8)
                                Text(pr.status.uppercased()).font(Theme.mono(11)).foregroundStyle(Theme.mutedForeground)
                                if let url = URL(string: pr.url), url.scheme == "https" {
                                    Link(destination: url) { Text("\(pr.number.map { "#\($0)" } ?? "PR") ↗").font(Theme.mono(13)).foregroundStyle(Theme.accent) }
                                        .frame(minHeight: 44)
                                }
                            }
                            .padding(.horizontal, 14).frame(minHeight: 56)
                            .surface(Theme.input)
                        }
                    }
                }
            }

            if task.state == "failure" {
                stateCard(title: "Task failed", titleColor: Color(hex: 0xFCA5A5, opacity: 0.85), fill: Color(hex: 0xF87171, opacity: 0.03), border: Color(hex: 0xF87171, opacity: 0.13),
                          message: "The agent ran into an error it couldn't resolve. Use the chat to provide guidance, retry the step, or run the troubleshoot agent.", detail: task.lastError)
            }
            if task.state == "done" {
                stateCard(title: "Task complete", titleColor: Color(hex: 0x6EE7B7, opacity: 0.85), fill: Theme.emerald.opacity(0.03), border: Theme.emerald.opacity(0.13), message: "All work has been accepted.")
            }
            if task.state == "wont-do" {
                stateCard(title: "Task closed", titleColor: Theme.secondaryForeground, fill: Theme.secondary, border: Theme.border, message: "This task was marked as won't do.")
            }
        }
        .padding(24)
        .frame(maxWidth: 980, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private struct PRRow { let repository: String; let url: String; let number: Int?; let branch: String; let baseBranch: String; let status: String }

    private var pullRequests: [PRRow] {
        if !task.pullRequests.isEmpty {
            return task.pullRequests.map { PRRow(repository: $0.repository, url: $0.url, number: $0.number, branch: $0.branch, baseBranch: $0.baseBranch, status: $0.status) }
        }
        guard let url = task.prUrl else { return [] }
        return [PRRow(repository: task.repos.first ?? "Repository", url: url, number: nil, branch: task.branch ?? "", baseBranch: task.baseBranch ?? "", status: "open")]
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) { SectionLabel(text: title); content() }
    }

    private func contractBox(_ title: String, _ text: String, empty: String = "Will be generated by the first agent.") -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(text: title, size: 11)
            if text.isEmpty { Text(empty).italic().font(Theme.secondaryBody).foregroundStyle(Theme.mutedForeground) }
            else { MarkdownText(source: text, size: 14) }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .surface(Theme.muted)
    }

    private func stateCard(title: String, titleColor: Color, fill: Color, border: Color, message: String, detail: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(Theme.bodyMedium).foregroundStyle(titleColor)
            Text(message).font(Theme.secondaryBody).foregroundStyle(Theme.mutedForeground)
            if let detail {
                Text(detail).font(Theme.mono(12)).foregroundStyle(Color(hex: 0xFECACA, opacity: 0.7)).textSelection(.enabled)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .surface(Theme.background.opacity(0.6), radius: 8)
                    .padding(.top, 6)
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .surface(fill, border: border)
    }
}

/// Pulls the Summary and Assumptions sections out of a plan, like `planOverview` in the web app.
struct PlanOverview {
    let summary: String
    let assumptions: String

    init(_ plan: String) {
        var sections: [String: [String]] = [:]
        var current: String?
        for line in plan.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("#") {
                current = trimmed.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces).lowercased()
                continue
            }
            if let current { sections[current, default: []].append(line) }
        }
        func pick(_ key: String) -> String {
            (sections.first { $0.key.hasPrefix(key) }?.value ?? []).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let summary = pick("summary")
        self.summary = summary.isEmpty && sections.isEmpty ? String(plan.prefix(600)) : summary
        assumptions = pick("assumption")
    }
}

// MARK: - Chat

private struct TaskChatView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppStore.self) private var store
    let task: TaskDetail
    let userInitial: String
    var scrolls = true
    let didSend: () async -> Void
    @State private var draft = ""
    @State private var sending = false
    @State private var sendError: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if scrolls {
                ScrollViewReader { proxy in
                    ScrollView { messages }
                    .defaultScrollAnchor(.bottom)
                    .onChange(of: task.messages.count) { if let last = task.messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } } }
                    .accessibilityLabel("Conversation")
                }
            } else {
                messages
                    .accessibilityLabel("Conversation")
            }
            composer.hairline(.top)
        }
    }

    private var messages: some View {
        LazyVStack(spacing: 18) {
            if task.messages.isEmpty {
                VStack(spacing: 8) {
                    AgentAvatar()
                    Text("No messages yet").font(Theme.body).foregroundStyle(Theme.secondaryForeground)
                    Text("Send a message to guide the agent").font(Theme.secondaryBody).foregroundStyle(Theme.mutedForeground)
                }
                .padding(.top, 80)
            }
            ForEach(task.messages) { ChatMessageView(message: $0, userInitial: userInitial).id($0.id) }
        }
        .padding(.horizontal, 24).padding(.vertical, 20)
    }

    private var composer: some View {
        let target = task.feedbackTarget(store.workflows)
        let canSend = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending
        return VStack(alignment: .leading, spacing: 8) {
            if let sendError { Text(sendError).font(Theme.font(13)).foregroundStyle(Theme.dangerText) }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("", text: $draft, prompt: Text("Type a message...").foregroundStyle(Theme.mutedForeground), axis: .vertical)
                    .font(Theme.body).foregroundStyle(Theme.foreground)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.vertical, 12)
                    .onKeyPress(.return, phases: .down) { press in
                        guard !press.modifiers.contains(.shift) else { return .ignored }
                        Task { await send() }
                        return .handled
                    }
                    .accessibilityLabel("Message")
                Button { Task { await send() } } label: { Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold)) }
                    .buttonStyle(IconButtonStyle(filled: true))
                    .opacity(canSend ? 1 : 0.4)
                    .disabled(!canSend)
                    .accessibilityLabel("Send message")
                    .padding(.vertical, 6)
            }
            .padding(.leading, 16).padding(.trailing, 6)
            .background(Theme.input, in: RoundedRectangle(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(focused ? Theme.accent.opacity(0.4) : Theme.border) }
            HStack(spacing: 8) {
                if target != nil { Circle().fill(Theme.amber).frame(width: 7, height: 7) }
                Text(target.map { "Sending will trigger an agent revision (\($0.label))" } ?? "Message is saved to the thread — no agent run will start")
                    .foregroundStyle(Theme.secondaryForeground)
                Text("· Return to send · Shift-Return for new line").foregroundStyle(Theme.mutedForeground.opacity(0.7))
            }
            .font(Theme.font(13)).lineLimit(1)
            .padding(.horizontal, 4)
        }
        .padding(.horizontal, 24).padding(.vertical, 14)
    }

    private func send() async {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !sending else { return }
        sending = true; sendError = nil; defer { sending = false }
        do { _ = try await api.sendMessage(taskId: task.id, content: content); draft = ""; await didSend(); await store.refreshTasks() }
        catch { sendError = error.localizedDescription }
    }
}

private struct AgentAvatar: View {
    var body: some View {
        Text("∆").font(Theme.font(14, .semibold)).foregroundStyle(Theme.violet)
            .frame(width: 32, height: 32)
            .background(Theme.primary.opacity(0.13), in: Circle())
            .overlay { Circle().strokeBorder(Theme.primary.opacity(0.19)) }
            .accessibilityHidden(true)
    }
}

private struct ChatMessageView: View {
    let message: Message
    let userInitial: String

    var body: some View {
        let isUser = message.role == "user"
        if message.role == "system" {
            Text(message.content).font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Theme.secondary.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
                .frame(maxWidth: .infinity)
        } else {
            HStack(alignment: .top, spacing: 12) {
                if isUser { Spacer(minLength: 80) } else { AgentAvatar() }
                VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text("\(isUser ? "You" : "Sindral") · \(Formatters.time(message.createdAt))").font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground)
                        if message.source == "github" {
                            Text("via GitHub").font(Theme.mono(11)).foregroundStyle(Theme.mutedForeground)
                                .padding(.horizontal, 5).padding(.vertical, 1).background(Theme.secondary, in: RoundedRectangle(cornerRadius: 4))
                        }
                    }
                    Group {
                        if isUser { Text(message.content).font(Theme.body).foregroundStyle(Theme.foreground).textSelection(.enabled) }
                        else { MarkdownText(source: message.content, color: Theme.foreground) }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .surface(isUser ? Theme.secondary : Theme.card, radius: Theme.Radius.row, border: isUser ? Theme.borderStrong : Theme.border)
                }
                .frame(maxWidth: 760, alignment: isUser ? .trailing : .leading)
                if isUser {
                    Text(userInitial).font(Theme.font(13, .semibold)).foregroundStyle(Theme.secondaryForeground)
                        .frame(width: 32, height: 32).background(Theme.border, in: Circle())
                        .overlay { Circle().strokeBorder(Theme.borderStrong) }
                        .accessibilityHidden(true)
                } else { Spacer(minLength: 80) }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: - Other tabs

private struct TaskPlanView: View {
    @Environment(APIClient.self) private var api
    let task: TaskDetail; let canApprove: Bool; let approving: Bool; var scrolls = true
    var onFeedbackSent: (() async -> Void)? = nil
    let onApprove: () -> Void
    @State private var selectedPlan = "implementation"
    @State private var feedbackTarget = "implementation"
    @State private var feedback = ""
    @State private var sending = false
    @State private var feedbackError: String?
    private var isMobile: Bool { task.bddPlan != nil || task.pinnedWorkflow?.mobilePlatforms != nil }
    var body: some View {
        Group {
            if scrolls { ScrollView { content } }
            else { content }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            if isMobile {
                Text("Review both plans before approving implementation.").font(Theme.secondaryBody)
                Picker("Plan", selection: $selectedPlan) {
                    Text("Implementation plan").tag("implementation")
                    Text("BDD test plan").tag("bdd")
                }.pickerStyle(.segmented)
            }
            if canApprove { HStack { Spacer(); Button(isMobile ? "Approve Both Plans" : "Approve Plan", action: onApprove).buttonStyle(.sindral(.success)).disabled(approving || (isMobile && task.bddPlan == nil)) } }
            if selectedPlan == "bdd", let bdd = task.bddPlan {
                MarkdownText(source: bdd.plan)
                ForEach(bdd.scenarios) { scenario in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(scenario.id).font(Theme.bodyMedium)
                        Text("Given \(scenario.given)\nWhen \(scenario.when)\nThen \(scenario.then)").font(Theme.secondaryBody)
                    }.padding(12).surface(Theme.muted)
                }
            } else if let plan = task.plan, !plan.isEmpty { MarkdownText(source: plan) }
            else { EmptyPane(title: "No plan yet", systemImage: "doc.text", message: "The planning agent writes the plan here.").padding(.top, 60) }
            if isMobile && canApprove {
                Picker("Feedback for", selection: $feedbackTarget) {
                    Text("Implementation plan").tag("implementation")
                    Text("BDD test plan").tag("bdd")
                }
                TextField("Plan feedback", text: $feedback, axis: .vertical).lineLimit(3...6).fieldChrome(height: 80)
                if let feedbackError { Text(feedbackError).foregroundStyle(Theme.dangerText) }
                Button("Request plan changes") { Task { await requestChanges() } }
                    .buttonStyle(.sindral(.primary)).disabled(sending || feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24).frame(maxWidth: 980, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func requestChanges() async {
        sending = true; feedbackError = nil; defer { sending = false }
        do {
            _ = try await api.sendMessage(taskId: task.id, content: feedback, feedbackTarget: feedbackTarget)
            feedback = ""
            await onFeedbackSent?()
        } catch { feedbackError = error.localizedDescription }
    }
}

private struct TaskCodeView: View {
    @Environment(APIClient.self) private var api
    let task: TaskDetail
    var scrolls = true
    @State private var files: [DiffFile] = []; @State private var repository: String?; @State private var error: Error?; @State private var loading = false
    var body: some View {
        Group {
            if scrolls {
                list
                    .overlay { if files.isEmpty && !loading && error == nil && task.pullRequests.isEmpty { EmptyPane(title: "No code changes yet", systemImage: "chevron.left.forwardslash.chevron.right", message: "The Review Slicer opens the PR after implementation finishes.") } }
            } else {
                compactContent
            }
        }
        .task(id: repository) { await load() }
    }

    private var list: some View {
        List {
            rows
        }
        .themedList()
    }

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if files.isEmpty && !loading && error == nil && task.pullRequests.isEmpty {
                EmptyPane(title: "No code changes yet", systemImage: "chevron.left.forwardslash.chevron.right", message: "The Review Slicer opens the PR after implementation finishes.")
                    .padding(.top, 60)
            } else {
                rows
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var rows: some View {
        if task.pullRequests.count > 1 { Picker("Repository", selection: $repository) { Text("First PR").tag(String?.none); ForEach(task.pullRequests) { Text($0.repository).tag(Optional($0.repository)) } } }
        ForEach(task.pullRequests) { pr in if let url = URL(string: pr.url) { Link(destination: url) { Label("#\(pr.number) · \(pr.repository)", systemImage: "arrow.up.right.square").foregroundStyle(Theme.accent) } } }
        if loading { ProgressView() }
        if let error { Text(error.localizedDescription).foregroundStyle(Theme.dangerText) }
        ForEach(files) { file in DisclosureGroup { if let patch = file.patch { ScrollView(.horizontal) { Text(patch).font(Theme.mono(12)).textSelection(.enabled) } } else { Text("Patch unavailable").foregroundStyle(Theme.mutedForeground) } } label: { VStack(alignment: .leading) { Text(file.filename).font(Theme.mono(13)); Text("+\(file.additions) −\(file.deletions) · \(file.status)").font(Theme.font(12)).foregroundStyle(Theme.mutedForeground) } } }
    }

    private func load() async { loading = true; defer { loading = false }; do { files = try await api.diff(taskId: task.id, repository: repository); error = nil } catch { self.error = error } }
}

private struct TaskReviewView: View {
    let task: TaskDetail
    var scrolls = true
    @State private var selectedID: String?

    var body: some View {
        let docs = documents
        Group {
            if docs.isEmpty {
                EmptyPane(title: "No automated review yet", systemImage: "doc.text.magnifyingglass", message: "Commit guide, diff explanation, and adversarial review will appear here after review completes.")
                    .padding(.top, scrolls ? 0 : 60)
            } else if scrolls {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 0) { sidebar(docs); document(docs) }
                    VStack(spacing: 0) { compactPicker(docs); document(docs) }
                }
            } else {
                VStack(spacing: 0) { compactPicker(docs); documentContent(docs) }
            }
        }
        .onAppear { selectFirstIfNeeded(docs) }
        .onChange(of: docs.map(\.id)) { selectFirstIfNeeded(documents) }
    }

    private var documents: [ReviewDocument] {
        let artifacts = task.artifacts
            .filter { ["review-slices.json", "diff-explanation.md", "adversarial-review.md"].contains($0.name) }
            .sorted { $0.createdAt > $1.createdAt }
        return artifacts.map { artifact in
            switch artifact.name {
            case "review-slices.json":
                ReviewDocument(label: "Commit guide", artifact: artifact, content: commitGuideMarkdown(artifact.content), order: 0)
            case "diff-explanation.md":
                ReviewDocument(label: "Diff explanation", artifact: artifact, content: artifact.content, order: 1)
            default:
                ReviewDocument(label: "Adversarial review", artifact: artifact, content: artifact.content, order: 2)
            }
        }
        .sorted { left, right in
            left.artifact.createdAt == right.artifact.createdAt ? left.order < right.order : left.artifact.createdAt > right.artifact.createdAt
        }
    }

    private func sidebar(_ docs: [ReviewDocument]) -> some View {
        List(selection: $selectedID) {
            Section("Reviews") {
                ForEach(docs) { doc in
                    Button { selectedID = doc.id } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(doc.label).font(Theme.mono(12)).foregroundStyle(Theme.foreground).lineLimit(1)
                            Text(Formatters.day(doc.artifact.createdAt)).font(Theme.mono(10)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                        }
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(selectedID == doc.id ? Theme.secondary : Theme.card)
                }
            }
        }
        .themedList()
        .frame(width: 230)
        .hairline(.trailing)
    }

    private func compactPicker(_ docs: [ReviewDocument]) -> some View {
        Picker("Review", selection: Binding(get: { selectedID ?? docs.first?.id }, set: { selectedID = $0 })) {
            ForEach(docs) { Text($0.label).tag(Optional($0.id)) }
        }
        .pickerStyle(.segmented)
        .padding(16)
        .hairline(.bottom)
    }

    private func document(_ docs: [ReviewDocument]) -> some View {
        ScrollView { documentContent(docs) }
    }

    private func documentContent(_ docs: [ReviewDocument]) -> some View {
        let selected = docs.first { $0.id == selectedID } ?? docs.first
        return VStack(alignment: .leading, spacing: 16) {
            if let selected {
                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: selected.label)
                    HStack(spacing: 10) {
                        Text(Formatters.day(selected.artifact.createdAt) + " · " + Formatters.time(selected.artifact.createdAt))
                        Text(ByteCountFormatter.string(fromByteCount: Int64(selected.artifact.byteSize), countStyle: .file))
                    }
                    .font(Theme.mono(11)).foregroundStyle(Theme.mutedForeground)
                }
                if let content = selected.content {
                    MarkdownText(source: content)
                        .padding(16)
                        .surface(Theme.muted, radius: Theme.Radius.row)
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("This review is stored securely and is not loaded into the page.")
                            .font(Theme.secondaryBody).foregroundStyle(Theme.mutedForeground)
                        if let link = selected.artifact.downloadUrl.flatMap(URL.init(string:)) {
                            Link(destination: link) { Label("Download review", systemImage: "arrow.down.doc").foregroundStyle(Theme.accent) }
                        }
                    }
                    .padding(16)
                    .surface(Theme.muted, radius: Theme.Radius.row)
                }
            }
        }
        .padding(24)
        .frame(maxWidth: 980, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func selectFirstIfNeeded(_ docs: [ReviewDocument]) {
        guard selectedID == nil || !docs.contains(where: { $0.id == selectedID }) else { return }
        selectedID = docs.first?.id
    }

    private func commitGuideMarkdown(_ content: String?) -> String? {
        guard let content else { return nil }
        guard let data = content.data(using: .utf8),
              let guide = try? JSONDecoder().decode(ReviewSliceGuide.self, from: data),
              !guide.slices.isEmpty else { return content }
        var lines = ["# Commit guide"]
        if let summary = guide.summary, !summary.isEmpty { lines.append(contentsOf: ["", summary]) }
        for (index, slice) in guide.slices.enumerated() {
            lines.append(contentsOf: ["", "## \(index + 1). \(slice.title)", "", "- Repository: `\(slice.repository)`", "- Commit: `\(slice.commit)`"])
            if !slice.files.isEmpty { lines.append("- Files: \(slice.files.map { "`\($0)`" }.joined(separator: ", "))") }
            lines.append(contentsOf: ["", slice.summary])
            if let reviewNotes = slice.reviewNotes, !reviewNotes.isEmpty { lines.append(contentsOf: ["", "Reviewer notes: \(reviewNotes)"]) }
        }
        return lines.joined(separator: "\n")
    }

    private struct ReviewDocument: Identifiable, Hashable {
        var label: String
        var artifact: Artifact
        var content: String?
        var order: Int
        var id: String { artifact.id }
    }

    private struct ReviewSliceGuide: Decodable {
        var summary: String?
        var slices: [ReviewSlice]
    }

    private struct ReviewSlice: Decodable {
        var repository: String
        var commit: String
        var title: String
        var summary: String
        var files: [String]
        var reviewNotes: String?
    }
}

private struct TaskStepsView: View {
    let task: TaskDetail
    var scrolls = true
    var body: some View {
        Group {
            if scrolls {
                list
                    .overlay { if task.events.isEmpty { EmptyPane(title: "No steps yet", systemImage: "list.number") } }
            } else {
                compactContent
            }
        }
    }

    private var list: some View {
        List(task.events.sorted { $0.createdAt > $1.createdAt }) { event in
            eventRow(event)
        }
        .themedList()
    }

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            if task.events.isEmpty {
                EmptyPane(title: "No steps yet", systemImage: "list.number")
                    .padding(.top, 60)
            } else {
                ForEach(task.events.sorted { $0.createdAt > $1.createdAt }) { event in
                    eventRow(event)
                        .padding(14)
                        .surface(Theme.card)
                }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func eventRow(_ event: TaskEvent) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(event.type.replacingOccurrences(of: "-", with: " ").capitalized).font(Theme.bodyMedium)
            if let from = event.fromState, let to = event.toState { Text("\(from) → \(to)").font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground) }
            Text(Formatters.day(event.createdAt) + " · " + Formatters.time(event.createdAt)).font(Theme.mono(11)).foregroundStyle(Theme.mutedForeground)
        }
        .listRowBackground(Theme.card)
    }
}

private struct TaskArtifactsView: View {
    let artifacts: [Artifact]
    var scrolls = true
    var body: some View {
        Group {
            if scrolls {
                list
                    .overlay { if artifacts.isEmpty { EmptyPane(title: "No artifacts", systemImage: "archivebox") } }
            } else {
                compactContent
            }
        }
    }

    private var list: some View {
        List(artifacts) { artifact in
            artifactRow(artifact)
        }
        .themedList()
    }

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            if artifacts.isEmpty {
                EmptyPane(title: "No artifacts", systemImage: "archivebox")
                    .padding(.top, 60)
            } else {
                ForEach(artifacts) { artifact in
                    artifactRow(artifact)
                        .padding(14)
                        .surface(Theme.card)
                }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func artifactRow(_ artifact: Artifact) -> some View {
        DisclosureGroup {
            if let content = artifact.content { Text(content).font(Theme.mono(12)).textSelection(.enabled) }
            if let link = artifact.downloadUrl.flatMap(URL.init(string:)) { Link("Download", destination: link) }
        } label: {
            Label { VStack(alignment: .leading) { Text(artifact.name); Text(ByteCountFormatter.string(fromByteCount: Int64(artifact.byteSize), countStyle: .file)).font(Theme.font(12)).foregroundStyle(Theme.mutedForeground) } } icon: { Image(systemName: "doc") }
        }
        .listRowBackground(Theme.card)
    }
}

struct TaskJobsView: View {
    @Environment(APIClient.self) private var api
    let taskID: String
    @State private var jobs: [Job] = []; @State private var selected: Job?
    var body: some View {
        List(jobs) { job in
            Button { selected = job } label: {
                HStack {
                    VStack(alignment: .leading) { Text(job.kind.replacingOccurrences(of: "-", with: " ").capitalized).foregroundStyle(Theme.foreground); Text("Attempt \(job.attempt)").font(Theme.font(12)).foregroundStyle(Theme.mutedForeground) }
                    Spacer()
                    Text(job.status).font(Theme.mono(12)).foregroundStyle(job.status == "failed" ? Theme.dangerText : job.status == "succeeded" ? Theme.emerald : Theme.secondaryForeground)
                }
            }
            .listRowBackground(Theme.card)
        }
        .themedList()
        .overlay { if jobs.isEmpty { EmptyPane(title: "No jobs", systemImage: "terminal") } }
        .task { jobs = (try? await api.jobs(taskId: taskID)) ?? [] }
        .sheet(item: $selected) { JobLogsView(job: $0) }
    }
}

private struct JobLogsView: View {
    @Environment(\.dismiss) private var dismiss; @Environment(APIClient.self) private var api
    let job: Job; @State private var logs: [JobLog] = []
    var body: some View {
        NavigationStack {
            List {
                if let result = job.result { Section("Result") { Text(result.prettyPrinted).font(Theme.mono(12)).textSelection(.enabled) } }
                if let error = job.error { Section("Error") { Text(error).foregroundStyle(Theme.dangerText).textSelection(.enabled) } }
                Section("Logs") { ForEach(logs) { log in VStack(alignment: .leading) { Text(log.type.uppercased()).font(Theme.font(11)).foregroundStyle(Theme.mutedForeground); Text(log.message).font(Theme.mono(12)).textSelection(.enabled) } } }
            }
            .themedList()
            .navigationTitle("Job details").toolbar { Button("Done") { dismiss() } }
            .task { logs = (try? await api.logs(jobId: job.id)) ?? [] }
        }
    }
}

private struct EditTaskView: View {
    @Environment(\.dismiss) private var dismiss; @Environment(APIClient.self) private var api; @Environment(AppStore.self) private var store
    let task: SindralTask; let didSave: () async -> Void
    @State private var platforms: [String]?
    @State private var title: String; @State private var description: String; @State private var projectID: String; @State private var repos: String; @State private var workflowID: String; @State private var saving = false
    init(task: SindralTask, didSave: @escaping () async -> Void) { self.task = task; self.didSave = didSave; _title = State(initialValue: task.title); _description = State(initialValue: task.description); _projectID = State(initialValue: task.projectId ?? ""); _repos = State(initialValue: task.repos.joined(separator: ", ")); _workflowID = State(initialValue: task.workflowId ?? ""); _platforms = State(initialValue: task.platforms) }
    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title)
                TextEditor(text: $description).frame(minHeight: 130)
                Picker("Project", selection: $projectID) {
                    Text("No project").tag("")
                    ForEach(store.projects) { Text($0.name).tag($0.id) }
                }
                TextField("Repositories", text: $repos).font(Theme.mono(14)).textInputAutocapitalization(.never)
                Picker("Workflow", selection: $workflowID) { Text("Default").tag(""); ForEach(store.workflows) { Text($0.name).tag($0.id) } }
                if let workflow = store.workflows.first(where: { $0.id == workflowID }), workflow.mobilePlatforms != nil {
                    TaskPlatformSelector(selection: $platforms, workflow: workflow, project: store.projects.first { $0.id == projectID })
                        .disabled(task.state != "todo" || task.pinnedWorkflow != nil)
                }
            }
            .onChange(of: projectID) { platforms = nil }
            .onChange(of: workflowID) { platforms = nil }
            .themedList()
            .navigationTitle("Edit task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(title.isEmpty || saving || platforms?.isEmpty == true) }
            }
        }
    }
    private func save() async {
        saving = true; defer { saving = false }
        do {
            var resolvedRepos = repos.commaSeparated
            if let project = store.projects.first(where: { $0.id == projectID }), resolvedRepos.isEmpty {
                resolvedRepos = project.repositories.map(\.repository)
            }
            _ = try await api.updateTask(task.id, title: title, description: description, projectId: projectID.isEmpty ? nil : projectID, repos: resolvedRepos, workflowId: workflowID.isEmpty ? nil : workflowID, platforms: task.state == "todo" ? platforms : nil)
            await store.refreshTasks()
            await didSave()
            dismiss()
        } catch { store.present(error) }
    }
}
