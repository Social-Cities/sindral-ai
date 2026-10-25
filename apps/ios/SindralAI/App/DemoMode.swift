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
        case ("GET", "/api/workflows"): return json(["workflows": [fullSDLC, designWorkflow]])
        case ("GET", "/api/projects"): return json(["projects": [Project]()])
        case ("GET", "/api/github/catalog"): return json(GitHubCatalog(connected: true, source: "oauth", repositories: [], owners: []))
        case ("GET", "/api/tasks/d1/design"):
            let revision = designRevision
            return json(DesignOverview(revisions: [.init(id: revision.id, taskId: revision.taskId, jobId: revision.jobId, summary: revision.result.summary,
                designUrl: revision.result.designUrl, screens: revision.result.screens, createdAt: revision.createdAt, approvedAt: revision.approvedAt)],
                checkpointAt: ago(minutes: 1), input: nil, inputPreviewUrls: []))
        case ("GET", "/api/tasks/d1/design/revisions/demo-revision"):
            return json(DemoRevisionResponse(revision: designRevision, previewUrls: ["/api/design-previews/d1?token=demo"]))
        case ("POST", "/api/tasks/d1/design/approve"):
            designLock.withLock { designApproved = true }
            return json(["revision": designRevision])
        case ("GET", "/api/workers"): return json(["workers": workers])
        case ("GET", "/api/me"): return json(["user": Profile(id: "demo-user", email: "luc@example.com", displayName: "Luc")])
        case ("GET", "/api/settings/worker-keys"): return json(["keys": [WorkerKey(id: "key-1", name: "MacBook Pro", keyPrefix: "sk" + "_sindral_7f3a", createdAt: ago(days: 12), lastUsedAt: ago(minutes: 2), revokedAt: nil)]])
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
            id: "wf-default", name: "Full SDLC", description: "Plan → human approval → implement → slice for review → review.", entryStepId: "todo",
            steps: [
                human("todo", "Todo", 20, 180),
                agent("planning", "Planning Agent", 200, 180, output: "plan"),
                human("plan-review", "Plan Review", 380, 180),
                agent("planning-feedback", "Revise Plan", 380, 40, output: "plan"),
                agent("implement", "Implement Agent", 560, 180, model: "claude-sonnet-5", output: "implementation"),
                agent("review-slice", "Review Slicer", 740, 180, model: "claude-opus-5", output: "review-slice"),
                agent("adversarial-review", "Adversarial Review", 920, 180, output: "review"),
                agent("verify", "Verify & Readiness", 920, 410, output: "verdict"),
                human("in-review", "In Review", 740, 410),
                agent("merge", "Merge Pull Requests", 560, 410, engine: nil, model: nil, output: "merge"),
                WorkflowStep(id: "done", type: "end", label: "Done", state: "done", position: .init(x: 380, y: 410)),
                agent("implement-feedback", "Address Feedback", 740, 570, model: "claude-sonnet-5", output: "review-slice"),
            ],
            edges: [
                .init(from: "todo", to: "planning", event: "start", label: "Start Planning"),
                .init(from: "planning", to: "plan-review", event: "complete", label: "plan ready"),
                .init(from: "plan-review", to: "planning-feedback", event: "feedback", label: "revise"),
                .init(from: "planning-feedback", to: "plan-review", event: "complete", label: "plan revised"),
                .init(from: "plan-review", to: "implement", event: "approve", label: "Approve Plan"),
                .init(from: "implement", to: "review-slice", event: "complete", label: "implemented"),
                .init(from: "review-slice", to: "adversarial-review", event: "complete", label: "PR opened"),
                .init(from: "adversarial-review", to: "verify", event: "complete", label: "reviewed"),
                .init(from: "verify", to: "in-review", event: "complete", label: "GO"),
                .init(from: "verify", to: "implement-feedback", event: "reject", label: "NO_GO"),
                .init(from: "in-review", to: "implement-feedback", event: "feedback", label: "changes"),
                .init(from: "implement-feedback", to: "adversarial-review", event: "complete", label: "sliced"),
                .init(from: "in-review", to: "merge", event: "accept", label: "Accept & merge"),
                .init(from: "merge", to: "done", event: "complete", label: "merged"),
            ],
            troubleshootStep: nil, userId: "demo-user", isDefault: true, createdAt: ago(days: 30), updatedAt: ago(days: 2)
        )
    }()

    static let workers = [Worker(id: "w1", name: "MacBook Pro", hostname: "lucs-mbp.local", version: "0.1.0", status: "online", runningJobs: 1, lastSeenAt: ago(minutes: 1))]

    private static func task(_ id: String, key: String, title: String, state: String, step: String?, updated: String, description: String = "", outcome: String = "", criteria: String = "", ticket: String? = nil, pr: String? = nil, plan: String? = nil, lastError: String? = nil, workflowID: String = "wf-default") -> SindralTask {
        SindralTask(id: id, userId: "demo-user", version: 3, key: key, title: title, description: description, projectId: nil, outcome: outcome, acceptanceCriteria: criteria, state: state, currentStepId: step, workflowId: workflowID, pinnedWorkflow: nil, repos: ["social-cities/sindral-ai"], ticketUrl: ticket, prUrl: pr, branch: pr == nil ? nil : "sindral/\(key.lowercased())", baseBranch: "main", plan: plan, parentTaskId: nil, sequence: nil, failedStepId: lastError == nil ? nil : "merge", lastError: lastError, createdAt: ago(days: 4), updatedAt: updated)
    }

    static let tasks: [SindralTask] = [
        task("d1", key: "SIN-62", title: "Design a calmer workspace", state: "design-review", step: "design-review", updated: ago(minutes: 1),
             description: "A focused workspace for reviewing agent work, decisions and next steps.", workflowID: "wf-design"),
        task("t51", key: "SIN-51", title: "Add rate limiting to the worker job API", state: "in-review", step: "in-review", updated: ago(minutes: 4),
             description: "Workers poll `/api/worker/jobs` in a tight loop when idle. Add a per-key token bucket and return `429` with **Retry-After** so misbehaving workers back off.",
             outcome: "Worker endpoints are rate limited per worker key, with limits configurable by environment variable.",
             criteria: "- 429 + Retry-After past the limit\n- Worker honours Retry-After\n- Tests cover burst and refill",
             pr: "https://github.com/social-cities/sindral-ai/pull/51"),
        task("t54", key: "SIN-54", title: "Split completed work into reviewable commits", state: "review-slice", step: "review-slice", updated: ago(minutes: 12),
             description: "After the implementation agent finishes, rewrite the branch into ordered commits and produce a commit-by-commit guide for reviewers.",
             outcome: "Each ticket lands as one PR with a readable commit sequence and review guide.",
             criteria: "- Net behavior is unchanged\n- Commits are ordered logically\n- Review guide explains each commit"),
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
        return TaskDetail(id: t.id, userId: t.userId, version: t.version, key: t.key, title: t.title, description: t.description, projectId: t.projectId, outcome: t.outcome, acceptanceCriteria: t.acceptanceCriteria, state: t.state, currentStepId: t.currentStepId, workflowId: t.workflowId, pinnedWorkflow: t.pinnedWorkflow, repos: t.repos, ticketUrl: t.ticketUrl, prUrl: t.prUrl, branch: t.branch, baseBranch: t.baseBranch, plan: t.plan, parentTaskId: t.parentTaskId, sequence: t.sequence, failedStepId: t.failedStepId, lastError: t.lastError, createdAt: t.createdAt, updatedAt: t.updatedAt, messages: messages, events: [], artifacts: artifacts(for: id), repositories: [], pullRequests: prs)
    }

    static func artifacts(for id: String) -> [Artifact] {
        guard id == "t51" else { return [] }
        let guide = """
        {"summary":"The branch was split into three ordered commits so reviewers can read policy, worker behavior, and tests separately.","slices":[{"repository":"social-cities/sindral-ai","commit":"8e72c44","title":"Add worker rate-limit policy","summary":"Introduces configurable token bucket limits and shared retry metadata.","files":["apps/server/src/config.ts","apps/server/src/rateLimit.ts"],"reviewNotes":"Start here to confirm the limit semantics."},{"repository":"social-cities/sindral-ai","commit":"bb91d2a","title":"Apply limits to worker polling","summary":"Checks the bucket before issuing jobs and returns 429 with Retry-After when exhausted.","files":["apps/server/src/routes/worker.ts","apps/worker/src/poll.ts"]},{"repository":"social-cities/sindral-ai","commit":"ce48119","title":"Cover burst and refill behavior","summary":"Adds server and worker tests for burst limits, refill timing, and Retry-After handling.","files":["apps/server/src/routes/worker.test.ts","apps/worker/src/poll.test.ts"]}]}
        """
        return [
            Artifact(id: "artifact-slices-t51", taskId: id, jobId: "job-review-slice", name: "review-slices.json", contentType: "application/json", content: guide, byteSize: guide.utf8.count, downloadUrl: nil, createdAt: ago(minutes: 8)),
            Artifact(id: "artifact-review-t51", taskId: id, jobId: "job-review", name: "adversarial-review.md", contentType: "text/markdown", content: "## Findings\nNo blocking findings.\n\n## Residual risk\nRate-limit windows should be watched after rollout to confirm production worker cadence.", byteSize: 126, downloadUrl: nil, createdAt: ago(minutes: 6)),
        ]
    }

    static let designWorkflow = Workflow(id: "wf-design", name: "App Design", description: "Design, review and approve an app.", entryStepId: "todo",
        steps: [
            .init(id: "todo", type: "human", label: "Design brief", state: "todo"),
            .init(id: "design", type: "agent", label: "Create design", state: "designing", engine: "claude", model: "claude-opus-5", mode: "high", prompt: "Design {{task_description}}", output: "design", resumeSessionKey: "design"),
            .init(id: "design-review", type: "human", label: "Review design", state: "design-review"),
            .init(id: "design-revise", type: "agent", label: "Revise design", state: "design-revising", engine: "claude", model: "claude-opus-5", mode: "high", prompt: "Revise {{feedback}}", output: "design", resumeSessionKey: "design"),
            .init(id: "done", type: "end", label: "Approved design", state: "done"),
        ], edges: [
            .init(from: "todo", to: "design", event: "start", label: "Start designing"),
            .init(from: "design", to: "design-review", event: "complete"),
            .init(from: "design-review", to: "design-revise", event: "feedback"),
            .init(from: "design-revise", to: "design-review", event: "complete"),
            .init(from: "design-review", to: "done", event: "accept", label: "Finish design"),
        ])

    private struct DemoRevisionResponse: Encodable { let revision: DesignRevision; let previewUrls: [String] }
    private static let designLock = NSLock()
    private nonisolated(unsafe) static var designApproved = false
    static var designRevision: DesignRevision {
        .init(id: "demo-revision", taskId: "d1", jobId: "demo-job", result: .init(kind: "design",
            summary: "A quieter command center with a clear daily focus, concise task cards, and a dedicated review queue.",
            designUrl: nil, specification: "## Workspace\nUse a warm neutral canvas, violet accents, and generous spacing.\n\n## Screens and flows\n- Home highlights the current focus and the next review.\n- Tasks show state, owner, and a concise description.\n- Review surfaces the approved design and implementation scope.\n\n## Responsive behavior\nUse a single column on iPhone and a sidebar on iPad.\n\n## Interaction states\nProvide loading, empty, error, and offline states for every data view.",
            questions: [], screens: [.init(name: "Workspace", path: "index.html")],
            files: [.init(path: "index.html", contentType: "text/html", encoding: "utf8", content: designHTML, sha256: "demo")],
            outcome: nil, acceptanceCriteria: nil), createdAt: ago(minutes: 2),
            approvedAt: designLock.withLock { designApproved } ? ago(minutes: 1) : nil)
    }

    static let designHTML = """
    <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>*{box-sizing:border-box}body{margin:0;background:#f6f5f2;color:#24242e;font:15px -apple-system,sans-serif;padding:28px 22px}header{display:flex;justify-content:space-between;align-items:center;font-weight:650}.logo{background:#7257c7;color:white;border-radius:9px;padding:8px 11px}small{font-size:10px;letter-spacing:1.5px;color:#76727f}h1{font-size:34px;line-height:1.08;letter-spacing:-1.3px;margin:18px 0 12px}p{color:#797482;line-height:1.6}.focus{background:#eae5f6;border-radius:18px;padding:22px;margin:26px 0}h2{font-size:21px;letter-spacing:-.5px;margin:12px 0}.pill{display:inline-block;background:white;border-radius:20px;padding:7px 11px;color:#7257c7;font-size:11px}.row{padding:16px 0;border-bottom:1px solid #e4e1e8;display:flex;gap:14px;align-items:center}.dot{width:9px;height:9px;border-radius:50%;background:#977bd3}.meta{font-size:11px;color:#8c8595;margin-top:6px}</style></head>
    <body><header><span><span class="logo">s</span> &nbsp; sindral</span><span>◉</span></header><div style="margin-top:38px"><small>YOUR WORKSPACE</small><h1>Room for<br>your next idea.</h1><p>Make space for the work that matters.</p></div><div class="focus"><small>TODAY’S FOCUS</small><h2>A calmer command center</h2><p>One clear place to review, decide,<br>and keep things moving.</p><span class="pill">Ready for your review ↗</span></div><small>IN MOTION · 2</small><div class="row"><span class="dot"></span><div>Refine the onboarding flow<div class="meta">Design · Ready for review</div></div></div><div class="row"><span class="dot" style="background:#5ba58d"></span><div>Build the workspace shell<div class="meta">Implementation · In progress</div></div></div></body></html>
    """
}
#endif
