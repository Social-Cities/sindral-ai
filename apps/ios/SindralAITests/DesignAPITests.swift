import XCTest
@testable import SindralAI

@MainActor
final class DesignAPITests: XCTestCase {
    private func client(base: String = "https://sindral-ai.vercel.app/") async throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DesignURLProtocol.self]
        let urlSession = URLSession(configuration: configuration)
        let app = AppConfiguration(apiURL: URL(string: base)!, supabaseURL: URL(string: "https://auth.example.com")!, supabaseAnonKey: "test")
        let session = SessionStore(configuration: app, urlSession: urlSession, keychain: KeychainStore(service: "ai.sindral.tests.\(UUID().uuidString)"))
        try await session.signIn(email: "person@example.com", password: "test")
        return APIClient(baseURL: app.apiURL, sessionStore: session, urlSession: urlSession)
    }

    func testVercelRoutesAreRootedOnceForOriginAndAPIPrefix() async throws {
        for base in ["https://sindral-ai.vercel.app", "https://sindral-ai.vercel.app/", "https://sindral-ai.vercel.app/api/"] {
            let api = try await client(base: base)
            XCTAssertEqual(try api.url(for: "api/tasks").absoluteString, "https://sindral-ai.vercel.app/api/tasks")
            XCTAssertEqual(try api.url(for: "api/events").absoluteString, "https://sindral-ai.vercel.app/api/events")
            XCTAssertEqual(try api.url(for: "/api/design-previews/task?token=signed").query, "token=signed")
        }
    }

    func testDesignOverviewRevisionAndVersionedApprovalUseAuthenticatedAPI() async throws {
        let api = try await client()
        let overview = try await api.design(taskId: "design-task")
        XCTAssertEqual(overview.revisions.map(\.id), ["revision-1"])
        XCTAssertNil(overview.revisions.first?.designUrl)
        let view = try await api.designRevision(taskId: "design-task", revisionId: "revision-1")
        XCTAssertEqual(view.revision.result.screens.first?.path, "index.html")
        XCTAssertNil(view.revision.result.designUrl)
        XCTAssertTrue(view.revision.canApprove(taskState: "design-review", agentActive: false))
        XCTAssertEqual(view.previewUrls, ["/api/design-previews/design-task?token=signed"])
        let approved = try await api.approveDesign(taskId: "design-task", revisionId: "revision-1", expectedVersion: 7)
        XCTAssertNotNil(approved.approvedAt)
    }

    func testStaleApprovalSurfacesConflictAndKeepsSession() async throws {
        let api = try await client()
        do {
            _ = try await api.approveDesign(taskId: "design-task", revisionId: "revision-1", expectedVersion: 6)
            XCTFail("Expected stale version to be rejected")
        } catch APIError.server(let status, _, let message) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(message, "Design changed; refresh before approving")
        }
        XCTAssertNotNil(api.sessionStore.session)
    }

    func testImplementationCreationSendsApprovedRevisionAndStableRetryKey() async throws {
        let api = try await client()
        let request = DesignHandoffRequest(revisionId: "revision-1", idempotencyKey: "handoff-key")
        for _ in 0..<2 {
            let task = try await api.createTask(title: "Implement design", description: "Scope", ticket: nil,
                repos: ["acme/app"], workflowId: "wf-default", designHandoff: request)
            XCTAssertEqual(task.id, "implementation-task")
        }
    }

    func testWorkflowRoundTripPreservesDesignSessionContinuity() throws {
        let json = #"{"id":"wf-design","name":"App Design","entryStepId":"design","steps":[{"id":"design","type":"agent","label":"Design","state":"designing","engine":"claude","output":"design","resumeSessionKey":"design"}],"edges":[]}"#
        let workflow = try JSONDecoder().decode(Workflow.self, from: Data(json.utf8))
        let roundTrip = try JSONDecoder().decode(Workflow.self, from: JSONEncoder().encode(workflow))
        XCTAssertTrue(roundTrip.isDesign)
        XCTAssertFalse(roundTrip.supportsImplementation)
        XCTAssertEqual(roundTrip.steps.first?.resumeSessionKey, "design")
    }

    func testFrozenInputAndExportRetainFilesAndRevisionMetadata() async throws {
        let api = try await client()
        let overview = try await api.design(taskId: "implementation-task")
        let input = try XCTUnwrap(overview.input)
        XCTAssertEqual(input.revisionId, "revision-1")
        XCTAssertEqual(input.result.files.first?.content, "<h1>App</h1>")
        let document = DesignBundleDocument(result: input.result, revisionID: input.revisionId, approvedAt: input.approvedAt)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: document.data) as? [String: Any])
        XCTAssertEqual(object["revisionId"] as? String, input.revisionId)
        XCTAssertEqual(object["approvedAt"] as? String, input.approvedAt)
        XCTAssertEqual(object["kind"] as? String, "design")
        let result = try JSONDecoder().decode(DesignResult.self, from: document.data)
        XCTAssertEqual(result.files, input.result.files)
        XCTAssertNil(result.designUrl)
    }

    func testPreviewRemainsApprovableWhenOptionalURLIsOmitted() throws {
        let original = previewRevision()
        let data = try JSONEncoder().encode(original)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var result = try XCTUnwrap(object["result"] as? [String: Any])
        result.removeValue(forKey: "designUrl")
        object["result"] = result
        let decoded = try JSONDecoder().decode(DesignRevision.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(decoded.result.designUrl)
        XCTAssertTrue(decoded.canApprove(taskState: "design-review", agentActive: false))
    }

    func testLegacyHostedRevisionStillSupportsApprovalAndExport() throws {
        let revision = previewRevision(designURL: "https://claude.ai/code/artifact/existing")
        XCTAssertTrue(revision.canApprove(taskState: "design-review", agentActive: false))
        let document = DesignBundleDocument(result: revision.result, revisionID: revision.id, approvedAt: nil)
        let exported = try JSONDecoder().decode(DesignResult.self, from: document.data)
        XCTAssertEqual(exported.designUrl, "https://claude.ai/code/artifact/existing")
        XCTAssertEqual(exported.screens, revision.result.screens)
    }

    func testClarificationWithoutScreensCannotBeApproved() {
        let revision = previewRevision(screens: [], specification: "", questions: ["Who will use the app?"])
        XCTAssertFalse(revision.result.hasPreview)
        XCTAssertFalse(revision.canApprove(taskState: "design-review", agentActive: false))
        XCTAssertEqual(revision.result.questions, ["Who will use the app?"])
    }

    func testApprovalWaitsForFinishedGenerationAndSpecification() {
        let revision = previewRevision()
        XCTAssertFalse(revision.canApprove(taskState: "designing", agentActive: true))
        XCTAssertFalse(revision.canApprove(taskState: "design-review", agentActive: true))
        XCTAssertFalse(revision.canApprove(taskState: "done", agentActive: false))
        XCTAssertFalse(previewRevision(specification: " \n ").canApprove(taskState: "design-review", agentActive: false))
        XCTAssertFalse(previewRevision(approvedAt: "2026-10-25T20:00:00Z").canApprove(taskState: "design-review", agentActive: false))
    }

    private func previewRevision(designURL: String? = nil, screens: [DesignScreen] = [.init(name: "Home", path: "index.html")],
                                 specification: String = "Build the app.", questions: [String] = [], approvedAt: String? = nil) -> DesignRevision {
        .init(id: "revision-1", taskId: "design-task", jobId: "job-1",
              result: .init(kind: "design", summary: "App design", designUrl: designURL, specification: specification,
                            questions: questions, screens: screens, files: [], outcome: nil, acceptanceCriteria: nil),
              createdAt: "2026-10-25T20:00:00Z", approvedAt: approvedAt)
    }

    func testImplementationTaskExposesDesignTabWithoutDesignWorkflow() throws {
        #if DEBUG
        var task = try XCTUnwrap(DemoFixtures.detail("t51"))
        XCTAssertFalse(task.hasDesign([DemoFixtures.fullSDLC]))
        task.designInput = .init(sourceTaskId: "design-task", revisionId: "revision-1", approvedAt: "2026-10-25T20:00:00Z")
        let decoded = try JSONDecoder().decode(TaskDetail.self, from: JSONEncoder().encode(task))
        XCTAssertTrue(decoded.hasDesign([DemoFixtures.fullSDLC]))
        #endif
    }
}

/// Rejects incorrect routes, authorization, approval versions and handoff bodies.
private final class DesignURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else { return }
        var status = 200
        let body: [String: Any]
        let input = requestBody()
        if url.path == "/auth/v1/token" {
            body = ["access_token": "test-access", "refresh_token": "test-refresh", "expires_in": 3600, "user": ["id": "user", "email": "person@example.com"]]
        } else if request.value(forHTTPHeaderField: "Authorization") != "Bearer test-access" {
            status = 403; body = ["error": ["message": "Missing bearer token"]]
        } else {
            switch (request.httpMethod ?? "GET", url.path) {
            case ("GET", "/api/tasks/design-task/design"):
                var summary = Self.revision
                summary.removeValue(forKey: "result")
                summary["summary"] = "App design"; summary["screens"] = Self.result["screens"]
                summary["designUrl"] = Self.result["designUrl"]
                body = ["revisions": [summary], "checkpointAt": NSNull(), "input": NSNull(), "inputPreviewUrls": []]
            case ("GET", "/api/tasks/design-task/design/revisions/revision-1"):
                body = ["revision": Self.revision, "previewUrls": ["/api/design-previews/design-task?token=signed"]]
            case ("POST", "/api/tasks/design-task/design/approve"):
                if input["expectedVersion"] as? Int == 7, input["revisionId"] as? String == "revision-1" {
                    var revision = Self.revision; revision["approvedAt"] = "2026-10-25T20:00:00Z"
                    body = ["revision": revision]
                } else {
                    status = 409; body = ["error": ["code": "CONFLICT", "message": "Design changed; refresh before approving"]]
                }
            case ("GET", "/api/tasks/implementation-task/design"):
                body = ["revisions": [], "checkpointAt": NSNull(), "inputPreviewUrls": ["/api/design-previews/implementation-task?token=signed"],
                        "input": ["sourceTaskId": "design-task", "revisionId": "revision-1", "approvedAt": "2026-10-25T20:00:00Z", "result": Self.result]]
            case ("POST", "/api/tasks"):
                let handoff = input["designHandoff"] as? [String: String]
                if handoff?["revisionId"] == "revision-1", handoff?["idempotencyKey"] == "handoff-key", input["workflowId"] as? String == "wf-default", input["repos"] as? [String] == ["acme/app"] {
                    body = ["task": ["id": "implementation-task", "userId": "user", "version": 1, "key": "SIN-1", "title": "Implement design", "description": "Scope", "outcome": "", "acceptanceCriteria": "", "state": "todo", "repos": ["acme/app"], "createdAt": "2026-10-25T20:00:00Z", "updatedAt": "2026-10-25T20:00:00Z"]]
                } else { status = 400; body = ["error": ["message": "Incorrect handoff payload"]] }
            default: status = 404; body = ["error": ["message": "Incorrect API route"]]
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

    private static var result: [String: Any] {
        ["kind": "design", "summary": "App design", "designUrl": NSNull(), "specification": "Build the approved app.", "questions": [],
         "screens": [["name": "Home", "path": "index.html"]],
         "files": [["path": "index.html", "contentType": "text/html", "encoding": "utf8", "content": "<h1>App</h1>", "sha256": String(repeating: "a", count: 64)]]]
    }
    private static var revision: [String: Any] {
        ["id": "revision-1", "taskId": "design-task", "jobId": "job-1", "result": result, "createdAt": "2026-10-25T20:00:00Z", "approvedAt": NSNull()]
    }
}
