import Foundation
import Observation

@MainActor @Observable
final class AppStore {
    let session: SessionStore
    let api: APIClient
    private(set) var tasks: [SindralTask] = []
    private(set) var projects: [Project] = []
    private(set) var workflows: [Workflow] = []
    private(set) var workers: [Worker] = []
    private(set) var profile: Profile?
    private(set) var isLoading = false
    private(set) var liveStatus = "Disconnected"
    var errorMessage: String?
    private var eventTask: Task<Void, Never>?

    init(configuration: AppConfiguration, urlSession: URLSession = .shared) {
        let session = SessionStore(configuration: configuration, urlSession: urlSession)
        self.session = session
        self.api = APIClient(baseURL: configuration.apiURL, sessionStore: session, urlSession: urlSession)
    }

    var isLive: Bool { liveStatus == "Live" }

    func bootstrap() async {
        guard session.session != nil else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let tasks = api.listTasks()
            async let projects = api.projects()
            async let workflows = api.workflows()
            async let workers = api.workers()
            async let profile = api.profile()
            self.tasks = try await tasks
            self.projects = try await projects
            self.workflows = try await workflows
            self.workers = try await workers
            self.profile = try await profile
            startEvents()
        } catch { present(error) }
    }

    func refreshTasks() async { do { tasks = try await api.listTasks() } catch { present(error) } }
    func refreshProjects() async { do { projects = try await api.projects() } catch { present(error) } }
    func refreshWorkflows() async { do { workflows = try await api.workflows() } catch { present(error) } }
    func refreshWorkers() async { do { workers = try await api.workers() } catch { present(error) } }
    func signOut() { eventTask?.cancel(); eventTask = nil; PushNotificationDelegate.store = nil; session.signOut(); tasks = []; projects = []; workflows = []; workers = []; profile = nil }
    func present(_ error: Error) { if !(error is CancellationError) { errorMessage = error.localizedDescription } }

    private func startEvents() {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, session.session != nil {
                do {
                    liveStatus = "Connecting"
                    var request = URLRequest(url: api.baseURL.appending(path: "api/events"))
                    request.setValue("Bearer \(try await session.validAccessToken())", forHTTPHeaderField: "Authorization")
                    let (bytes, response) = try await api.urlSession.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw APIError.invalidResponse }
                    liveStatus = "Live"
                    for try await line in bytes.lines where line.hasPrefix("data: ") {
                        guard !Task.isCancelled, let data = String(line.dropFirst(6)).data(using: .utf8),
                              let event = try? JSONDecoder().decode(ServerEvent.self, from: data) else { continue }
                        if event.type.hasPrefix("task.") { await refreshTasks() }
                        if event.type == "worker.updated" { await refreshWorkers() }
                    }
                } catch is CancellationError { return }
                catch {
                    liveStatus = "Offline"
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        }
    }
}

private struct ServerEvent: Decodable { let type: String; let taskId: String?; let workerId: String? }
