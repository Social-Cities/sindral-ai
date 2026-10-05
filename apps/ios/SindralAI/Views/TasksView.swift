import SwiftUI

/// Tasks: side-by-side list and detail on iPad (list collapses in portrait); a pushed stack on iPhone.
struct TasksView: View {
    @Environment(AppStore.self) private var store
    @Environment(AppRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var listVisible = true

    var body: some View {
        @Bindable var router = router
        if horizontalSizeClass == .regular {
            GeometryReader { proxy in
                let landscape = proxy.size.width >= 1000
                ZStack(alignment: .leading) {
                    HStack(spacing: 0) {
                        if landscape { TaskListPane().frame(width: 380) }
                        detail(landscape: landscape)
                    }
                    if !landscape && listVisible {
                        Color.black.opacity(0.45).ignoresSafeArea()
                            .onTapGesture { if router.selectedTaskID != nil { listVisible = false } }
                            .accessibilityHidden(true)
                        TaskListPane()
                            .frame(width: 380)
                            .shadow(color: .black.opacity(0.5), radius: 24, x: 8)
                            .transition(.move(edge: .leading))
                    }
                }
                .animation(.easeOut(duration: 0.2), value: listVisible)
                .onChange(of: router.selectedTaskID) { if !landscape { listVisible = router.selectedTaskID == nil } }
                .onAppear {
                    if landscape { selectFirstIfNeeded() }
                    listVisible = !landscape && router.selectedTaskID == nil
                }
                .onChange(of: landscape) { listVisible = !landscape && router.selectedTaskID == nil; if landscape { selectFirstIfNeeded() } }
                .onChange(of: store.tasks) { if landscape { selectFirstIfNeeded() } }
            }
            .background(Theme.background)
        } else {
            TaskListPane()
                .navigationTitle("Tasks")
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(item: $router.selectedTaskID) { TaskDetailView(taskID: $0) }
        }
    }

    @ViewBuilder private func detail(landscape: Bool) -> some View {
        if let id = router.selectedTaskID {
            TaskDetailView(taskID: id, portrait: !landscape, onShowList: landscape ? nil : { listVisible = true })
                .id(id)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            EmptyPane(title: store.tasks.isEmpty ? "No tasks yet" : "Select a task", systemImage: "checklist",
                      message: store.tasks.isEmpty ? "Create one with the + button." : nil)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func selectFirstIfNeeded() {
        guard !store.tasks.isEmpty, router.selectedTaskID == nil || !store.tasks.contains(where: { $0.id == router.selectedTaskID }) else { return }
        router.selectedTaskID = TaskListModel(tasks: store.tasks, workflows: store.workflows, filter: router.taskFilter, projectID: router.projectFilterID, search: "").rows.first?.task.id
    }
}

/// Filtering and sorting, mirroring `apps/web/src/pages/Tasks.tsx`.
struct TaskListModel {
    struct Row: Identifiable { let task: SindralTask; var id: String { task.id } }
    let rows: [Row]
    let activeCount: Int

    init(tasks: [SindralTask], workflows: [Workflow], filter: TaskFilter, projectID: String?, search: String) {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        func matches(_ task: SindralTask) -> Bool {
            let searchMatches = q.isEmpty || task.title.lowercased().contains(q) || task.key.lowercased().contains(q) || task.description.lowercased().contains(q)
            let filterMatches: Bool = switch filter {
            case .all: true
            case .active: !TaskStates.terminal.contains(task.state)
            default: task.bucket(workflows) == filter.bucket
            }
            let projectMatches = projectID == nil || task.projectId == projectID
            return searchMatches && filterMatches && projectMatches
        }
        rows = tasks.filter(matches).sorted { $0.updatedAt > $1.updatedAt }.map(Row.init(task:))
        activeCount = tasks.filter { !TaskStates.terminal.contains($0.state) && (projectID == nil || $0.projectId == projectID) }.count
    }
}

private struct TaskListPane: View {
    @Environment(AppStore.self) private var store
    @Environment(AppRouter.self) private var router
    @State private var search = ""
    @FocusState private var searchFocused: Bool

    var body: some View {
        let model = TaskListModel(tasks: store.tasks, workflows: store.workflows, filter: router.taskFilter, projectID: router.projectFilterID, search: search)
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("Tasks").font(Theme.paneTitle).tracking(-0.5).foregroundStyle(Theme.foreground)
                        Text("\(model.activeCount) active").font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground)
                    }
                    Spacer()
                    Button { router.showingCreateTask = true } label: { Image(systemName: "plus") }
                        .buttonStyle(IconButtonStyle(filled: true))
                        .accessibilityLabel("New task")
                }
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground)
                    TextField("", text: $search, prompt: Text("Search tasks...").foregroundStyle(Theme.mutedForeground))
                        .font(Theme.body).foregroundStyle(Theme.foreground)
                        .focused($searchFocused).submitLabel(.search)
                        .accessibilityLabel("Search tasks")
                    if !search.isEmpty {
                        Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }
                            .foregroundStyle(Theme.mutedForeground).accessibilityLabel("Clear search")
                    }
                }
                .fieldChrome(height: 44, focused: searchFocused)
                .background { Button("") { searchFocused = true }.keyboardShortcut("f", modifiers: .command).hidden() }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(TaskFilter.allCases) { filter in
                            let selected = router.taskFilter == filter
                            Button { router.taskFilter = filter } label: {
                                Text(filter.title)
                                    .font(Theme.font(14, .medium))
                                    .foregroundStyle(selected ? Theme.lavender : Theme.mutedForeground)
                                    .padding(.horizontal, 14).frame(height: 36)
                                    .background(selected ? Theme.primary.opacity(0.13) : .clear, in: Capsule())
                                    .overlay { Capsule().strokeBorder(selected ? Theme.primary.opacity(0.4) : Theme.border) }
                                    .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                            .frame(minHeight: 44)
                            .accessibilityAddTraits(selected ? .isSelected : [])
                        }
                    }
                }
                if !store.projects.isEmpty {
                    Menu {
                        Button("All projects") { router.projectFilterID = nil }
                        ForEach(store.projects) { project in
                            Button(project.name) { router.projectFilterID = project.id }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "rectangle.stack").font(.system(size: 13))
                            Text(router.projectFilterID.flatMap { id in store.projects.first { $0.id == id }?.name } ?? "All projects").lineLimit(1)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
                        }
                        .font(Theme.font(14)).foregroundStyle(Theme.secondaryForeground)
                        .padding(.horizontal, 12).frame(height: 40)
                        .surface(Theme.input, radius: Theme.Radius.control)
                    }
                    .accessibilityLabel("Filter by project")
                }
            }
            .padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 6)

            ScrollView {
                LazyVStack(spacing: 8) {
                    if model.rows.isEmpty {
                        EmptyPane(title: store.tasks.isEmpty ? "No tasks yet" : "No tasks match your filters", systemImage: "checklist",
                                  message: router.taskFilter == .active && search.isEmpty && !store.tasks.isEmpty ? "Done and won't-do tasks are hidden. Choose All to show them." : nil)
                            .padding(.top, 40)
                    }
                    ForEach(model.rows) { row in
                        card(row.task)
                    }
                }
                .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 16)
            }
            .refreshable { await store.refreshTasks() }
        }
        .background(Theme.muted.ignoresSafeArea(edges: .bottom))
        .hairline(.trailing)
    }

    private func card(_ task: SindralTask) -> some View {
        Button { router.selectedTaskID = task.id } label: {
            TaskCard(task: task, step: task.currentStep(store.workflows), projectName: task.projectId.flatMap { id in store.projects.first { $0.id == id }?.name }, selected: router.selectedTaskID == task.id)
        }
        .buttonStyle(.plain)
    }
}
