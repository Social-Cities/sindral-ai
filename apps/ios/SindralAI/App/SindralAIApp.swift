import SwiftUI

@main
struct SindralAIApp: App {
    @State private var store: AppStore?
    @State private var router = AppRouter()
    @State private var configurationError: String?

    init() {
        #if DEBUG
        if DemoMode.isEnabled {
            _store = State(initialValue: AppStore(configuration: DemoMode.configuration, urlSession: DemoMode.urlSession))
            return
        }
        #endif
        do { _store = State(initialValue: AppStore(configuration: try .fromBundle())) }
        catch { _configurationError = State(initialValue: error.localizedDescription) }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if let store {
                    RootView()
                        .environment(store)
                        .environment(store.session)
                        .environment(store.api)
                        .environment(router)
                } else {
                    ContentUnavailableView("Configuration needed", systemImage: "gear.badge.xmark", description: Text(configurationError ?? "Check the app build settings."))
                }
            }
            #if DEBUG
            .modifier(DemoLandscape(enabled: DemoMode.isEnabled && DemoMode.landscape))
            #endif
            .preferredColorScheme(.dark)
            .tint(Theme.accent)
            .background(Theme.background.ignoresSafeArea())
        }
    }
}

private struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router

    var body: some View {
        Group {
            if session.isRestoring { ProgressView("Restoring session…") }
            else if session.session == nil { AuthView() }
            else { AppShell() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .task(id: session.session?.accessToken) { if session.session != nil { await store.bootstrap() } }
        #if DEBUG
        .task { await startDemoSession() }
        #endif
        .alert("Sindral AI", isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
            Button("OK", role: .cancel) { store.errorMessage = nil }
        } message: { Text(store.errorMessage ?? "") }
    }

    #if DEBUG
    private func startDemoSession() async {
        guard DemoMode.isEnabled else { return }
        if DemoMode.startsSignedOut { session.signOut() }
        if let section = DemoMode.section { router.section = section }
        router.selectedTaskID = DemoMode.taskID
        if !DemoMode.startsSignedOut && session.session == nil { do { try await session.signIn(email: "luc@example.com", password: "demo") } catch { print("Demo sign-in failed:", error) } }
    }
    #endif
}

/// Top bar with segmented tabs on regular width; the themed `TabView` on compact width.
private struct AppShell: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(AppRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        if horizontalSizeClass == .regular {
            VStack(spacing: 0) {
                TopBar()
                section(router.section)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Theme.background.ignoresSafeArea())
            .sheet(isPresented: $router.showingCreateTask) { CreateTaskSheet() }
        } else {
            TabView(selection: $router.section) {
                ForEach(AppSection.allCases) { item in
                    NavigationStack { section(item) }
                        .tabItem { Label(item.title, systemImage: item.icon) }
                        .tag(item)
                }
            }
            .toolbarBackground(Theme.muted, for: .tabBar)
            .toolbarBackground(.visible, for: .tabBar)
            .sheet(isPresented: $router.showingCreateTask) { CreateTaskSheet() }
        }
    }

    @ViewBuilder private func section(_ section: AppSection) -> some View {
        switch section {
        case .home: DashboardView()
        case .tasks: TasksView()
        case .workflows: WorkflowsView()
        case .settings: SettingsView()
        }
    }
}

private struct TopBar: View {
    @Environment(AppStore.self) private var store
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router

    var body: some View {
        ViewThatFits(in: .horizontal) {
            bar(showWordmark: true)
            bar(showWordmark: false)
        }
        .frame(height: 60)
        .padding(.horizontal, 20)
        .background(Theme.background)
        .hairline(.bottom)
    }

    private func bar(showWordmark: Bool) -> some View {
        HStack(spacing: 0) {
            HStack(spacing: 10) {
                LogoTile(size: 30)
                if showWordmark { Text("Sindral AI").font(Theme.font(16, .semibold)).foregroundStyle(Theme.foreground).fixedSize() }
            }
            .frame(width: showWordmark ? 220 : 90, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Sindral AI")
            Spacer(minLength: 12)
            tabs
            Spacer(minLength: 12)
            HStack(spacing: 14) {
                if showWordmark { liveIndicator }
                accountMenu
            }
            .frame(width: showWordmark ? 220 : 90, alignment: .trailing)
        }
    }

    private var tabs: some View {
        HStack(spacing: 2) {
            ForEach(AppSection.allCases) { item in
                let selected = router.section == item
                Button { router.section = item } label: {
                    Text(item.title)
                        .font(Theme.font(14, selected ? .semibold : .medium))
                        .foregroundStyle(selected ? Theme.foreground : Theme.mutedForeground)
                        .padding(.horizontal, 20)
                        .frame(height: 38)
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
        .surface(Theme.card, radius: 12)
        .fixedSize()
    }

    private var liveIndicator: some View {
        HStack(spacing: 6) {
            Circle().fill(store.isLive ? Theme.emerald : Theme.amber).frame(width: 7, height: 7)
            Text(store.isLive ? "Live" : store.liveStatus).font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Live updates: \(store.liveStatus)")
    }

    private var accountMenu: some View {
        Menu {
            Section {
                Text(displayName)
                if let email = store.profile?.email ?? session.user?.email { Text(email) }
            }
            Button("Settings", systemImage: "gearshape") { router.section = .settings }
            Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { store.signOut() }
        } label: {
            Text(String(displayName.prefix(1)).uppercased())
                .font(Theme.font(14, .semibold))
                .foregroundStyle(Theme.accent)
                .frame(width: 38, height: 38)
                .background(LinearGradient(colors: [Theme.primary.opacity(0.13), Theme.accent.opacity(0.13)], startPoint: .topLeading, endPoint: .bottomTrailing), in: Circle())
                .overlay { Circle().strokeBorder(Theme.accent.opacity(0.25)) }
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .accessibilityLabel("Account menu for \(displayName)")
    }

    private var displayName: String { store.displayName(fallbackEmail: session.user?.email) }
}

extension AppStore {
    func displayName(fallbackEmail: String? = nil) -> String {
        if let name = profile?.displayName, !name.isEmpty { return name }
        let email = profile?.email ?? fallbackEmail
        return email?.split(separator: "@").first.map(String.init) ?? "there"
    }
}
