import SwiftUI

@main
struct SindralAIApp: App {
    @State private var store: AppStore?
    @State private var configurationError: String?

    init() {
        do { _store = State(initialValue: AppStore(configuration: try .fromBundle())) }
        catch { _configurationError = State(initialValue: error.localizedDescription) }
    }

    var body: some Scene {
        WindowGroup {
            if let store {
                RootView()
                    .environment(store)
                    .environment(store.session)
                    .environment(store.api)
            } else {
                ContentUnavailableView("Configuration needed", systemImage: "gear.badge.xmark", description: Text(configurationError ?? "Check the app build settings."))
            }
        }
    }
}

private struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(SessionStore.self) private var session

    var body: some View {
        Group {
            if session.isRestoring { ProgressView("Restoring session…") }
            else if session.session == nil { AuthView() }
            else { AppTabs() }
        }
        .task(id: session.session?.accessToken) { if session.session != nil { await store.bootstrap() } }
        .alert("Sindral AI", isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
            Button("OK", role: .cancel) { store.errorMessage = nil }
        } message: { Text(store.errorMessage ?? "") }
    }
}

private struct AppTabs: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var selection = AppSection.home

    var body: some View {
        if horizontalSizeClass == .regular {
            NavigationSplitView {
                List(AppSection.allCases) { section in
                    Button { selection = section } label: {
                        Label(section.title, systemImage: section.icon)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(selection == section ? Color.indigo.opacity(0.14) : Color.clear)
                    .accessibilityAddTraits(selection == section ? .isSelected : [])
                }
                .navigationTitle("Sindral AI")
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
            } detail: {
                NavigationStack { selection.content }
                    .id(selection)
            }
            .navigationSplitViewStyle(.balanced)
        } else {
            TabView(selection: $selection) {
                ForEach(AppSection.allCases) { section in
                    NavigationStack { section.content }
                        .tabItem { Label(section.title, systemImage: section.icon) }
                        .tag(section)
                }
            }
            .tint(.indigo)
        }
    }
}

private enum AppSection: String, CaseIterable, Identifiable {
    case home, tasks, workflows, settings
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var icon: String {
        switch self { case .home: "house"; case .tasks: "checklist"; case .workflows: "point.3.connected.trianglepath.dotted"; case .settings: "gearshape" }
    }
    @ViewBuilder var content: some View {
        switch self { case .home: DashboardView(); case .tasks: TasksView(); case .workflows: WorkflowsView(); case .settings: SettingsView() }
    }
}
