import Foundation
import Observation

struct EmptyResponse: Decodable {}
struct TasksResponse: Decodable { let tasks: [SindralTask] }
struct TaskResponse<T: Decodable>: Decodable { let task: T }
struct ProjectsResponse: Decodable { let projects: [Project] }
struct ProjectResponse: Decodable { let project: Project }
struct WorkflowsResponse: Decodable { let workflows: [Workflow] }
struct WorkflowResponse: Decodable { let workflow: Workflow }
struct WorkersResponse: Decodable { let workers: [Worker] }
struct WorkerKeysResponse: Decodable { let keys: [WorkerKey] }
struct WorkerKeyResponse: Decodable { let key: WorkerKey; let secret: String }
struct SecretsResponse: Decodable { let secrets: [SecretStatus] }
struct SecretResponse: Decodable { let secret: SecretStatus }
struct PushDeviceResponse: Decodable { let device: PushDevice }
struct TicketResponse: Decodable { let ticket: TicketImport }
struct ProfileResponse: Decodable { let user: Profile }
struct JobsResponse: Decodable { let jobs: [Job] }
struct LogsResponse: Decodable { let logs: [JobLog] }
struct DiffResponse: Decodable { let files: [DiffFile] }
struct MessageResponse: Decodable { let message: Message; let task: SindralTask }
struct GitHubConnectResponse: Decodable { let url: String }

@MainActor @Observable
final class APIClient {
    let baseURL: URL
    let sessionStore: SessionStore
    let urlSession: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(baseURL: URL, sessionStore: SessionStore, urlSession: URLSession = .shared) {
        self.baseURL = baseURL; self.sessionStore = sessionStore; self.urlSession = urlSession
    }

    func request<Response: Decodable, Body: Encodable>(_ path: String, method: String = "GET", body: Body? = Optional<String>.none, headers: [String: String] = [:]) async throws -> Response {
        var request = URLRequest(url: try url(for: path)); request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(try await sessionStore.validAccessToken())", forHTTPHeaderField: "Authorization")
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        if let body { request.httpBody = try encoder.encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if http.statusCode == 401 {
            do {
                request.setValue("Bearer \(try await sessionStore.validAccessToken(forceRefresh: true))", forHTTPHeaderField: "Authorization")
                let (retryData, retryResponse) = try await urlSession.data(for: request)
                guard let retryHTTP = retryResponse as? HTTPURLResponse else { throw APIError.invalidResponse }
                if retryHTTP.statusCode == 401 { sessionStore.signOut() }
                guard (200..<300).contains(retryHTTP.statusCode) else { throw decodeError(data: retryData, status: retryHTTP.statusCode) }
                if retryData.isEmpty, Response.self == EmptyResponse.self { return EmptyResponse() as! Response }
                return try decoder.decode(Response.self, from: retryData)
            } catch {
                sessionStore.signOut()
                throw error
            }
        }
        guard (200..<300).contains(http.statusCode) else { throw decodeError(data: data, status: http.statusCode) }
        if data.isEmpty, Response.self == EmptyResponse.self { return EmptyResponse() as! Response }
        return try decoder.decode(Response.self, from: data)
    }

    func request<Response: Decodable>(_ path: String, method: String = "GET", headers: [String: String] = [:]) async throws -> Response {
        try await request(path, method: method, body: Optional<String>.none, headers: headers)
    }

    func listTasks() async throws -> [SindralTask] { let response: TasksResponse = try await request("api/tasks"); return response.tasks }
    func task(_ id: String) async throws -> TaskDetail { let response: TaskResponse<TaskDetail> = try await request("api/tasks/\(id)"); return response.task }
    func createTask(title: String, description: String, ticket: TicketImport?, projectId: String? = nil, repos: [String], workflowId: String?, newRepository: NewGitHubRepository? = nil) async throws -> SindralTask {
        struct Body: Encodable { let title: String; let description: String; let ticketUrl: String?; let key: String?; let projectId: String?; let workflowId: String?; let repos: [String]; let newRepository: NewGitHubRepository? }
        let key = ticket.flatMap { $0.id.range(of: "^[A-Z][A-Z0-9]*-[0-9]+$", options: .regularExpression) == nil ? nil : $0.id }
        let response: TaskResponse<SindralTask> = try await request("api/tasks", method: "POST", body: Body(title: title, description: description, ticketUrl: ticket?.url, key: key, projectId: projectId, workflowId: workflowId, repos: repos, newRepository: newRepository)); return response.task
    }
    func updateTask(_ id: String, title: String, description: String, projectId: String?, repos: [String], workflowId: String?) async throws -> SindralTask {
        struct Body: Encodable { let title: String; let description: String; let projectId: String?; let repos: [String]; let workflowId: String? }
        let response: TaskResponse<SindralTask> = try await request("api/tasks/\(id)", method: "PATCH", body: Body(title: title, description: description, projectId: projectId, repos: repos, workflowId: workflowId)); return response.task
    }
    func deleteTask(_ id: String) async throws { let _: EmptyResponse = try await request("api/tasks/\(id)", method: "DELETE") }
    func runAction(task: SindralTask, event: String) async throws -> SindralTask {
        struct Body: Encodable { let event: String; let expectedVersion: Int }
        let response: TaskResponse<SindralTask> = try await request("api/tasks/\(task.id)/actions", method: "POST", body: Body(event: event, expectedVersion: task.version), headers: ["Idempotency-Key": UUID().uuidString]); return response.task
    }
    func stopAgent(taskId: String) async throws -> SindralTask {
        let response: TaskResponse<SindralTask> = try await request("api/tasks/\(taskId)/agent/stop", method: "POST")
        return response.task
    }
    func sendMessage(taskId: String, content: String) async throws -> MessageResponse {
        struct Body: Encodable { let content: String }
        return try await request("api/tasks/\(taskId)/messages", method: "POST", body: Body(content: content))
    }
    func jobs(taskId: String) async throws -> [Job] { let response: JobsResponse = try await request("api/tasks/\(taskId)/jobs"); return response.jobs }
    func logs(jobId: String) async throws -> [JobLog] { let response: LogsResponse = try await request("api/jobs/\(jobId)/logs"); return response.logs }
    func diff(taskId: String, repository: String?) async throws -> [DiffFile] {
        let query = repository.map { "?repository=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0)" } ?? ""
        let response: DiffResponse = try await request("api/tasks/\(taskId)/diff\(query)"); return response.files
    }
    func projects() async throws -> [Project] { let response: ProjectsResponse = try await request("api/projects"); return response.projects }
    func createProject(name: String, description: String, repository: NewGitHubRepository) async throws -> Project {
        struct Body: Encodable { let name: String; let description: String; let repository: NewGitHubRepository }
        let response: ProjectResponse = try await request("api/projects", method: "POST", body: Body(name: name, description: description, repository: repository)); return response.project
    }
    func workflows() async throws -> [Workflow] { let response: WorkflowsResponse = try await request("api/workflows"); return response.workflows }
    func createWorkflow(name: String, cloneFrom: String?) async throws -> Workflow {
        struct Body: Encodable { let name: String; let cloneFrom: String? }
        let response: WorkflowResponse = try await request("api/workflows", method: "POST", body: Body(name: name, cloneFrom: cloneFrom)); return response.workflow
    }
    func saveWorkflow(_ workflow: Workflow) async throws -> Workflow {
        struct Body: Encodable { let name: String; let description: String?; let entryStepId: String; let steps: [WorkflowStep]; let edges: [WorkflowEdge]; let troubleshootStep: WorkflowStep? }
        let body = Body(name: workflow.name, description: workflow.description, entryStepId: workflow.entryStepId, steps: workflow.steps, edges: workflow.edges, troubleshootStep: workflow.troubleshootStep)
        let response: WorkflowResponse = try await request("api/workflows/\(workflow.id)", method: "PUT", body: body); return response.workflow
    }
    func deleteWorkflow(_ id: String) async throws { let _: EmptyResponse = try await request("api/workflows/\(id)", method: "DELETE") }
    func workers() async throws -> [Worker] { let response: WorkersResponse = try await request("api/workers"); return response.workers }
    func workerKeys() async throws -> [WorkerKey] { let response: WorkerKeysResponse = try await request("api/settings/worker-keys"); return response.keys }
    func createWorkerKey(name: String) async throws -> WorkerKeyResponse { struct Body: Encodable { let name: String }; return try await request("api/settings/worker-keys", method: "POST", body: Body(name: name)) }
    func revokeWorkerKey(_ id: String) async throws { let _: EmptyResponse = try await request("api/settings/worker-keys/\(id)", method: "DELETE") }
    func secrets() async throws -> [SecretStatus] { let response: SecretsResponse = try await request("api/settings/secrets"); return response.secrets }
    func setSecret(provider: String, token: String, email: String?) async throws -> SecretStatus { struct Body: Encodable { let provider: String; let token: String; let email: String? }; let response: SecretResponse = try await request("api/settings/secrets", method: "PUT", body: Body(provider: provider, token: token, email: email)); return response.secret }
    func deleteSecret(_ provider: String) async throws { let _: EmptyResponse = try await request("api/settings/secrets/\(provider)", method: "DELETE") }
    func registerPushDevice(token: String, environment: String) async throws -> PushDevice {
        struct Body: Encodable { let platform = "ios"; let environment: String; let token: String }
        let response: PushDeviceResponse = try await request("api/settings/push-device", method: "PUT", body: Body(environment: environment, token: token))
        return response.device
    }
    func unregisterPushDevice(token: String, environment: String) async throws {
        struct Body: Encodable { let platform = "ios"; let environment: String; let token: String }
        let _: EmptyResponse = try await request("api/settings/push-device", method: "DELETE", body: Body(environment: environment, token: token))
    }
    func githubAuthorizationURL() async throws -> URL {
        struct Body: Encodable { let returnTo = "ios" }
        let response: GitHubConnectResponse = try await request("api/github/connect", method: "POST", body: Body())
        guard let url = URL(string: response.url) else { throw APIError.invalidURL }
        return url
    }
    func githubCatalog() async throws -> GitHubCatalog { try await request("api/github/catalog") }
    func profile() async throws -> Profile { let response: ProfileResponse = try await request("api/me"); return response.user }
    func importTicket(_ url: String) async throws -> TicketImport { struct Body: Encodable { let url: String }; let response: TicketResponse = try await request("api/tickets/import", method: "POST", body: Body(url: url)); return response.ticket }

    private func url(for path: String) throws -> URL {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else { throw APIError.invalidURL }
        return url
    }
    private func decodeError(data: Data, status: Int) -> APIError {
        struct ErrorEnvelope: Decodable { struct Detail: Decodable { let code: String?; let message: String; let details: JSONValue? }; let error: Detail }
        if let error = try? decoder.decode(ErrorEnvelope.self, from: data).error { return .server(status: status, code: error.code ?? "ERROR", message: error.message) }
        return .server(status: status, code: "HTTP_ERROR", message: String(data: data, encoding: .utf8) ?? "Request failed")
    }
}

enum APIError: LocalizedError {
    case invalidURL, invalidResponse, server(status: Int, code: String, message: String)
    var errorDescription: String? { switch self { case .invalidURL: "The API URL is invalid."; case .invalidResponse: "The server returned an invalid response."; case .server(_, _, let message): message } }
}
