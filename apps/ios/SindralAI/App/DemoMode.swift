#if DEBUG
import SwiftUI

/// Debug-only fixture mode for screenshots and design review.
///
/// Launch with `-SindralDemo YES` to serve sample data through a `URLProtocol` stub. `APIClient`,
/// `SessionStore` and `AppStore` run unchanged; only the transport is replaced. Add
/// `-SindralDemoSignedOut YES` to start on the sign-in screen.
enum DemoMode {
    static var isEnabled: Bool { UserDefaults.standard.bool(forKey: "SindralDemo") }
    static var startsSignedOut: Bool { UserDefaults.standard.bool(forKey: "SindralDemoSignedOut") }
    static var landscape: Bool { UserDefaults.standard.bool(forKey: "SindralDemoLandscape") }
    /// Optional starting point: `-SindralDemoSection tasks -SindralDemoTask t57 -SindralDemoTab chat`.
    static var section: AppSection? { UserDefaults.standard.string(forKey: "SindralDemoSection").flatMap(AppSection.init(rawValue:)) }
    static var taskID: String? { UserDefaults.standard.string(forKey: "SindralDemoTask") }
    static var tab: DetailTab? { UserDefaults.standard.string(forKey: "SindralDemoTab").flatMap(DetailTab.init(rawValue:)) }
    static var settingsPane: String? { UserDefaults.standard.string(forKey: "SindralDemoPane") }
    static var stepID: String? { UserDefaults.standard.string(forKey: "SindralDemoStep") }

    static let configuration = AppConfiguration(
        apiURL: URL(string: "https://demo.sindral.invalid")!,
        supabaseURL: URL(string: "https://auth.sindral.invalid")!,
        supabaseAnonKey: "demo"
    )

    static var urlSession: URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DemoURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

/// Screenshot helper: iPadOS windowing blocks programmatic rotation in the simulator, so lay the app
/// out at landscape size rotated inside the portrait window. Rotate the captured PNG by 90° to view it.
struct DemoLandscape: ViewModifier {
    let enabled: Bool
    func body(content: Content) -> some View {
        if enabled {
            GeometryReader { proxy in
                let size = CGSize(width: proxy.size.height, height: proxy.size.width)
                content
                    .safeAreaPadding(.top, 24)
                    .frame(width: size.width, height: size.height)
                    .rotationEffect(.degrees(-90))
                    .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
            }
            .ignoresSafeArea()
        } else {
            content
        }
    }
}

final class DemoURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else { return }
        let path = url.path
        if path == "/api/events" {
            // Keep the SSE stream open so the app shows "Live" without reconnect churn.
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            return
        }
        let body = DemoFixtures.response(path: path, method: request.httpMethod ?? "GET")
        let response = HTTPURLResponse(url: url, statusCode: body == nil ? 404 : 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body ?? Data(#"{"error":{"message":"Not in demo fixtures"}}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

enum DemoFixtures {
    static func response(path: String, method: String) -> Data? {
        let encoder = JSONEncoder()
        func json<T: Encodable>(_ value: T) -> Data? { try? encoder.encode(value) }
        switch (method, path) {
        case ("POST", "/auth/v1/token"), ("POST", "/auth/v1/signup"):
            return Data(#"{"access_token":"demo","refresh_token":"demo","expires_in":86400,"user":{"id":"demo-user","email":"luc@example.com"}}"#.utf8)
        case ("GET", "/api/tasks"): return json(["tasks": tasks])
        case ("GET", "/api/workflows"): return json(["workflows": [fullSDLC]])
        case ("GET", "/api/workers"): return json(["workers": workers])
        case ("GET", "/api/me"): return json(["user": Profile(id: "demo-user", email: "luc@example.com", displayName: "Luc")])
        case ("GET", "/api/settings/worker-keys"): return json(["keys": [WorkerKey(id: "key-1", name: "MacBook Pro", keyPrefix: "sk_sindral_7f3a", createdAt: ago(days: 12), lastUsedAt: ago(minutes: 2), revokedAt: nil)]])
        case ("GET", "/api/settings/secrets"):
            return json(["secrets": [
                SecretStatus(provider: "github", configured: true, updatedAt: ago(days: 3), hint: "…9f2c"),
                SecretStatus(provider: "linear", configured: true, updatedAt: ago(days: 8), hint: "…41aa"),
                SecretStatus(provider: "jira", configured: false, updatedAt: nil, hint: nil),
            ]])
        case ("GET", _) where path.hasPrefix("/api/tasks/") && path.hasSuffix("/jobs"): return json(["jobs": [Job]()])
        case ("GET", _) where path.hasPrefix("/api/tasks/") && path.hasSuffix("/diff"): return json(["files": [DiffFile]()])
        case ("GET", _) where path.hasPrefix("/api/tasks/"):
            let id = String(path.dropFirst("/api/tasks/".count))
            return detail(id).flatMap { json(["task": $0]) }
        default: return nil
        }
    }

    static func ago(minutes: Int = 0, hours: Int = 0, days: Int = 0) -> String {
        let date = Date().addingTimeInterval(-TimeInterval(minutes * 60 + hours * 3600 + days * 86_400))
        return ISO8601DateFormatter().string(from: date)
    }

    static let fullSDLC: Workflow = {
        func agent(_ id: String, _ label: String, _ x: Double, _ y: Double, engine: String? = "claude", model: String? = "claude-opus-5", output: String) -> WorkflowStep {
            WorkflowStep(id: id, type: "agent", label: label, state: id, engine: engine, model: model, mode: "high", prompt: "You are the \(label.lowercased()). Work on {{task_title}}.\n\n{{task_description}}", tools: ["read_file", "search_codebase", "list_directory"], permissions: ["read"], output: output, position: .init(x: x, y: y))
        }
        func human(_ id: String, _ label: String, _ x: Double, _ y: Double) -> WorkflowStep {
            WorkflowStep(id: id, type: "human", label: label, state: id, position: .init(x: x, y: y))
        }
        return Workflow(
            id: "wf-default", name: "Full SDLC", description: "Plan → human approval → implement → review.", entryStepId: "todo",
            steps: [
                human("todo", "Todo", 20, 180),
                agent("planning", "Planning Agent", 200, 180, output: "plan"),
                human("plan-review", "Plan Review", 380, 180),
                agent("planning-feedback", "Revise Plan", 380, 40, output: "plan"),
                agent("implement", "Implement Agent", 560, 180, model: "claude-sonnet-5", output: "pr"),
                agent("adversarial-review", "Adversarial Review", 740, 180, output: "review"),
                agent("verify", "Verify & Readiness", 740, 410, output: "verdict"),
                human("in-review", "In Review", 560, 410),
                agent("merge", "Merge Pull Requests", 380, 410, engine: nil, model: nil, output: "merge"),
                WorkflowStep(id: "done", type: "end", label: "Done", state: "done", position: .init(x: 200, y: 410)),
                agent("implement-feedback", "Address Feedback", 560, 570, model: "claude-sonnet-5", output: "pr"),
            ],
            edges: [
                .init(from: "todo", to: "planning", event: "start", label: "Start Planning"),
                .init(from: "planning", to: "plan-review", event: "complete", label: "plan ready"),
                .init(from: "plan-review", to: "planning-feedback", event: "feedback", label: "revise"),
                .init(from: "planning-feedback", to: "plan-review", event: "complete", label: "plan revised"),
                .init(from: "plan-review", to: "implement", event: "approve", label: "Approve Plan"),
                .init(from: "implement", to: "adversarial-review", event: "complete", label: "PR opened"),
                .init(from: "adversarial-review", to: "verify", event: "complete", label: "reviewed"),
                .init(from: "verify", to: "in-review", event: "complete", label: "GO"),
                .init(from: "verify", to: "implement-feedback", event: "reject", label: "NO_GO"),
                .init(from: "in-review", to: "implement-feedback", event: "feedback", label: "changes"),
                .init(from: "implement-feedback", to: "adversarial-review", event: "complete", label: "pushed"),
                .init(from: "in-review", to: "merge", event: "accept", label: "Accept & merge"),
                .init(from: "merge", to: "done", event: "complete", label: "merged"),
            ],
            troubleshootStep: nil, userId: "demo-user", isDefault: true, createdAt: ago(days: 30), updatedAt: ago(days: 2)
        )
    }()

    static let workers = [Worker(id: "w1", name: "MacBook Pro", hostname: "lucs-mbp.local", version: "0.1.0", status: "online", runningJobs: 1, lastSeenAt: ago(minutes: 1))]

    private static func task(_ id: String, key: String, title: String, state: String, step: String?, updated: String, description: String = "", outcome: String = "", criteria: String = "", ticket: String? = nil, pr: String? = nil, parent: String? = nil, sequence: Int? = nil, plan: String? = nil, lastError: String? = nil) -> SindralTask {
        SindralTask(id: id, userId: "demo-user", version: 3, key: key, title: title, description: description, projectId: nil, outcome: outcome, acceptanceCriteria: criteria, state: state, currentStepId: step, workflowId: "wf-default", pinnedWorkflow: nil, repos: ["social-cities/sindral-ai"], ticketUrl: ticket, prUrl: pr, branch: pr == nil ? nil : "sindral/\(key.lowercased())", baseBranch: "main", plan: plan, parentTaskId: parent, sequence: sequence, failedStepId: lastError == nil ? nil : "merge", lastError: lastError, createdAt: ago(days: 4), updatedAt: updated)
    }

    static let tasks: [SindralTask] = [
        task("t51", key: "SIN-51", title: "Add rate limiting to the worker job API", state: "in-review", step: "in-review", updated: ago(minutes: 4),
             description: "Workers poll `/api/worker/jobs` in a tight loop when idle. Add a per-key token bucket and return `429` with **Retry-After** so misbehaving workers back off.",
             outcome: "Worker endpoints are rate limited per worker key, with limits configurable by environment variable.",
             criteria: "- 429 + Retry-After past the limit\n- Worker honours Retry-After\n- Tests cover burst and refill",
             pr: "https://github.com/social-cities/sindral-ai/pull/51"),
        task("t54", key: "SIN-54", title: "Import Jira sub-tasks as Sindral subtasks", state: "implement", step: "implement", updated: ago(minutes: 12),
             description: "When a Jira ticket with sub-tasks is imported, create one Sindral subtask per sub-task, keep their order, and run them in sequence under the parent task.",
             outcome: "Jira sub-tasks appear as ordered Sindral subtasks under the imported parent.",
             criteria: "- Order preserved\n- Re-import doesn't duplicate\n- Parent shows done/total"),
        task("t54a", key: "SIN-54-1", title: "Read sub-tasks from the Jira API", state: "done", step: "done", updated: ago(hours: 2), parent: "t54", sequence: 1),
        task("t54b", key: "SIN-54-2", title: "Create ordered subtasks on import", state: "implement", step: "implement", updated: ago(minutes: 20), parent: "t54", sequence: 2),
        task("t54c", key: "SIN-54-3", title: "Show done/total on the parent card", state: "todo", step: "todo", updated: ago(hours: 3), parent: "t54", sequence: 3),
        task("t57", key: "SIN-57", title: "Surface GitHub PR comments in the chat thread", state: "plan-review", step: "plan-review", updated: ago(hours: 1),
             description: "Review comments left on a Sindral PR should show up in the task's chat thread so feedback lives in one place.",
             ticket: "https://linear.app/social-cities/issue/SIN-57",
             plan: "## Summary\nIngest PR review comments from the existing webhook and store them as chat messages.\n\n## Assumptions\n- The webhook already receives `pull_request_review_comment` events."),
        task("t55", key: "SIN-55", title: "Retry failed merge jobs with backoff", state: "failure", step: "merge", updated: ago(hours: 3), lastError: "merge: GitHub returned 409 — base branch was modified"),
        task("t59", key: "SIN-59", title: "Contrast pass on the Settings page", state: "todo", step: "todo", updated: ago(days: 1)),
        task("t60", key: "SIN-60", title: "Document the worker install script", state: "todo", step: "todo", updated: ago(days: 2)),
        task("t61", key: "SIN-61", title: "Show worker version in Settings", state: "todo", step: "todo", updated: ago(days: 3)),
        task("t48", key: "SIN-48", title: "Add the Artifacts tab", state: "done", step: "done", updated: ago(days: 5)),
    ]

    static func detail(_ id: String) -> TaskDetail? {
        guard let t = tasks.first(where: { $0.id == id }) else { return nil }
        let messages: [Message]
        if id == "t57" {
            messages = [
                .init(id: "m1", taskId: id, role: "system", content: "Planning Agent finished · plan ready", source: "system", externalId: nil, createdAt: ago(minutes: 70)),
                .init(id: "m2", taskId: id, role: "assistant", content: "Here's the plan:\n\n1. Poll PR review comments in the worker after each push\n2. Store them as chat messages with `source: github`\n3. Show a “via GitHub” tag in the thread", source: "agent", externalId: nil, createdAt: ago(minutes: 68)),
                .init(id: "m3", taskId: id, role: "user", content: "Use the webhook instead of polling — we already receive `pull_request_review_comment` events.", source: "app", externalId: nil, createdAt: ago(minutes: 65)),
                .init(id: "m4", taskId: id, role: "system", content: "Revise Plan finished · plan revised", source: "system", externalId: nil, createdAt: ago(minutes: 61)),
                .init(id: "m5", taskId: id, role: "assistant", content: "Updated: step 1 now handles the existing webhook route and dedupes by comment id. Polling is dropped.", source: "github", externalId: nil, createdAt: ago(minutes: 60)),
            ]
        } else {
            messages = []
        }
        let prs = t.prUrl.map { [PullRequest(id: "pr-\(id)", repository: "social-cities/sindral-ai", url: $0, number: 51, branch: t.branch ?? "", baseBranch: "main", status: "open", mergedAt: nil)] } ?? []
        return TaskDetail(id: t.id, userId: t.userId, version: t.version, key: t.key, title: t.title, description: t.description, outcome: t.outcome, acceptanceCriteria: t.acceptanceCriteria, state: t.state, currentStepId: t.currentStepId, workflowId: t.workflowId, pinnedWorkflow: t.pinnedWorkflow, repos: t.repos, ticketUrl: t.ticketUrl, prUrl: t.prUrl, branch: t.branch, baseBranch: t.baseBranch, plan: t.plan, parentTaskId: t.parentTaskId, sequence: t.sequence, failedStepId: t.failedStepId, lastError: t.lastError, createdAt: t.createdAt, updatedAt: t.updatedAt, messages: messages, events: [], artifacts: [], subtasks: tasks.filter { $0.parentTaskId == id }, repositories: [], pullRequests: prs)
    }
}
#endif
