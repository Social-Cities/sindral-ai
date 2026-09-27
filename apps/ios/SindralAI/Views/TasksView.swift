import SwiftUI

struct TasksView: View {
    @Environment(AppStore.self) private var store
    @State private var search = ""
    @State private var status = "All"
    @State private var showingCreate = false

    var body: some View {
        List(filtered) { task in
            NavigationLink(value: task.id) { TaskRow(task: task) }
            if let children = childrenByParent[task.id] {
                ForEach(children) { child in NavigationLink(value: child.id) { HStack { Image(systemName: "arrow.turn.down.right").foregroundStyle(.secondary); TaskRow(task: child) } } }
            }
        }
        .overlay { if filtered.isEmpty { ContentUnavailableView.search(text: search) } }
        .navigationTitle("Tasks")
        .searchable(text: $search, prompt: "Search tasks")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Menu { Picker("Status", selection: $status) { ForEach(statuses, id: \.self) { Text($0.replacingOccurrences(of: "-", with: " ").capitalized).tag($0) } } } label: { Label(status == "All" ? "All" : status, systemImage: "line.3.horizontal.decrease.circle") } }
            ToolbarItem(placement: .topBarTrailing) { Button { showingCreate = true } label: { Image(systemName: "plus") } }
        }
        .navigationDestination(for: String.self) { TaskDetailView(taskID: $0) }
        .sheet(isPresented: $showingCreate) { CreateTaskView() }
        .refreshable { await store.refreshTasks() }
    }

    private var statuses: [String] { ["All"] + Set(store.tasks.map(\.state)).sorted() }
    private var childrenByParent: [String: [SindralTask]] { Dictionary(grouping: store.tasks.filter { $0.parentTaskId != nil }, by: { $0.parentTaskId! }).mapValues { $0.sorted { ($0.sequence ?? 0) < ($1.sequence ?? 0) } } }
    private var filtered: [SindralTask] {
        let parentIDs = Set(store.tasks.map(\.id)); let q = search.lowercased()
        return store.tasks.filter { task in
            let topLevel = task.parentTaskId == nil || !parentIDs.contains(task.parentTaskId!)
            let statusMatches = status == "All" || task.state == status
            let searchMatches = q.isEmpty || task.title.lowercased().contains(q) || task.key.lowercased().contains(q) || task.description.lowercased().contains(q)
            return topLevel && statusMatches && searchMatches
        }.sorted { $0.updatedAt > $1.updatedAt }
    }
}
