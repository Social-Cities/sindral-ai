import XCTest
@testable import SindralAI

@MainActor
final class TaskAPITests: XCTestCase {
    private func client() async throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TaskURLProtocol.self]
        let transport = URLSession(configuration: configuration)
        let app = AppConfiguration(apiURL: URL(string: "https://tasks.example.com")!, supabaseURL: URL(string: "https://auth.example.com")!, supabaseAnonKey: "test")
        let session = SessionStore(configuration: app, urlSession: transport, keychain: KeychainStore(service: "ai.sindral.task-tests.\(UUID().uuidString)"))
        try await session.signIn(email: "person@example.com", password: "test")
        return APIClient(baseURL: app.apiURL, sessionStore: session, urlSession: transport)
    }

    func testCreateAndEditSendSelectedPlatforms() async throws {
        let api = try await client()
        let created = try await api.createTask(title: "Mobile task", description: "Scope", ticket: nil, projectId: "project", repos: ["acme/app"], workflowId: "mobile", platforms: ["ios", "web"])
        XCTAssertEqual(created.platforms, ["ios", "web"])
        let updated = try await api.updateTask("mobile", title: "Mobile task", description: "Scope",
            scope: .init(projectId: "project", repos: ["acme/app"], workflowId: "mobile", platforms: ["ios", "web"]))
        XCTAssertEqual(updated.platforms, ["ios", "web"])
    }

    func testStartedTaskEditOmitsLockedScope() async throws {
        let api = try await client()
        let updated = try await api.updateTask("started", title: "Updated title", description: "Updated description")
        XCTAssertEqual(updated.title, "Updated title")
    }

    func testClearingProjectAndWorkflowSendsExplicitNull() async throws {
        let api = try await client()
        let updated = try await api.updateTask("clear-scope", title: "General task", description: "Scope",
            scope: .init(projectId: nil, repos: [], workflowId: nil, platforms: nil))
        XCTAssertNil(updated.projectId)
        XCTAssertNil(updated.workflowId)
        XCTAssertNil(updated.platforms)
    }

    func testBddFeedbackSendsPlanTarget() async throws {
        let api = try await client()
        let response = try await api.sendMessage(taskId: "mobile", content: "Add offline scenarios", feedbackTarget: "bdd")
        XCTAssertEqual(response.message.content, "Add offline scenarios")
    }
}

/// Contract stub rejects missing platform scope, edits to locked scope and untargeted BDD feedback.
private final class TaskURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else { return }
        let input = requestBody()
        var status = 200
        var task: [String: Any] = ["id": "mobile", "userId": "user", "version": 1, "key": "SIN-1", "title": input["title"] ?? "Mobile task", "description": "Scope", "outcome": "", "acceptanceCriteria": "", "state": "todo", "repos": [], "createdAt": "", "updatedAt": ""]
        let body: [String: Any]
        if url.path == "/auth/v1/token" {
            body = ["access_token": "task-test-token", "refresh_token": "refresh", "expires_in": 3600, "user": ["id": "user", "email": "person@example.com"]]
        } else if request.value(forHTTPHeaderField: "Authorization") != "Bearer task-test-token" {
            status = 403; body = ["error": ["message": "Missing bearer token"]]
        } else {
            switch (request.httpMethod ?? "GET", url.path) {
            case ("POST", "/api/tasks"), ("PATCH", "/api/tasks/mobile"):
                if input["platforms"] as? [String] == ["ios", "web"], input["workflowId"] as? String == "mobile", input["projectId"] as? String == "project", input["repos"] as? [String] == ["acme/app"] {
                    task["platforms"] = input["platforms"]; body = ["task": task]
                } else { status = 400; body = ["error": ["message": "Incorrect mobile scope"]] }
            case ("PATCH", "/api/tasks/started"):
                if Set(input.keys) == ["title", "description"] {
                    task["state"] = "implement-ios"; body = ["task": task]
                } else { status = 409; body = ["error": ["message": "Scope is locked"]] }
            case ("PATCH", "/api/tasks/clear-scope"):
                if input["projectId"] is NSNull, input["workflowId"] is NSNull, input["repos"] as? [String] == [], input["platforms"] == nil {
                    body = ["task": task]
                } else { status = 400; body = ["error": ["message": "Expected explicit null scope"]] }
            case ("POST", "/api/tasks/mobile/messages"):
                if input["feedbackTarget"] as? String == "bdd", input["content"] as? String == "Add offline scenarios" {
                    body = ["task": task, "message": ["id": "message", "taskId": "mobile", "role": "user", "content": "Add offline scenarios", "source": "app", "createdAt": ""]]
                } else { status = 400; body = ["error": ["message": "Missing BDD feedback target"]] }
            default:
                status = 404; body = ["error": ["message": "Unexpected request"]]
            }
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: body)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    private func requestBody() -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }
}
