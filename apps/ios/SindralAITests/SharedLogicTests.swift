import XCTest
@testable import SindralAI

/// The Swift ports must agree with `packages/shared` (states.ts, workflow.ts, tickets.ts, stateMachine.ts).
final class SharedLogicTests: XCTestCase {
    private let workflow = Workflow(
        id: "wf", name: "WF", entryStepId: "todo",
        steps: [
            .init(id: "todo", type: "human", label: "Todo", state: "todo"),
            .init(id: "plan", type: "agent", label: "Planning", state: "planning"),
            .init(id: "review", type: "human", label: "Plan Review", state: "plan-review"),
            .init(id: "revise", type: "agent", label: "Revise Plan", state: "planning-feedback"),
            .init(id: "gate", type: "human", label: "Gate", state: "gate"),
            .init(id: "done", type: "end", label: "Done", state: "done"),
        ],
        edges: [
            .init(from: "todo", to: "plan", event: "start", label: nil),
            .init(from: "plan", to: "review", event: "complete", label: nil),
            .init(from: "review", to: "revise", event: "feedback", label: nil),
            .init(from: "revise", to: "review", event: "complete", label: nil),
            .init(from: "review", to: "gate", event: "approve", label: nil),
            .init(from: "gate", to: "done", event: "accept", label: nil),
        ]
    )

    func testHappyPathSkipsFeedbackLoops() {
        XCTAssertEqual(workflow.happyPath.map(\.id), ["todo", "plan", "review", "gate", "done"])
    }

    func testDashboardBuckets() {
        XCTAssertEqual(DashboardBucket.of(state: "todo", step: nil), .todo)
        XCTAssertEqual(DashboardBucket.of(state: "wont-do", step: nil), .done)
        XCTAssertEqual(DashboardBucket.of(state: "failure", step: nil), .failed)
        XCTAssertEqual(DashboardBucket.of(state: "plan-review", step: workflow.step("review")), .inProgress)
        XCTAssertEqual(DashboardBucket.of(state: "gate", step: workflow.step("gate")), .inReview)
        XCTAssertEqual(DashboardBucket.of(state: "implement", step: nil), .inProgress)
    }

    func testAgentActivityAndChatFeedback() {
        let planning = fixture(state: "planning", step: "plan")
        XCTAssertTrue(planning.isAgentActive([]))
        XCTAssertFalse(planning.chatTriggersFeedback([]))
        let review = fixture(state: "plan-review", step: "review")
        XCTAssertFalse(review.isAgentActive([]))
        XCTAssertEqual(review.feedbackTarget([])?.id, "revise")
        XCTAssertFalse(fixture(state: "failure", step: "review").chatTriggersFeedback([]))
        XCTAssertTrue(fixture(state: "troubleshoot", step: nil).isAgentActive([]))
    }

    func testStateStyleFallsBackToStepType() {
        XCTAssertEqual(StateStyle.for("in-review").label, "In Review")
        XCTAssertEqual(StateStyle.for("custom-gate", step: workflow.step("gate")).label, "Gate")
        XCTAssertFalse(StateStyle.for("custom-gate", step: workflow.step("gate")).pulses)
        XCTAssertTrue(StateStyle.for("custom-run", step: workflow.step("plan")).pulses)
        XCTAssertEqual(StateStyle.for("my-custom-state").label, "My Custom State")
    }

    func testTicketDetection() {
        XCTAssertEqual(Tickets.detect("https://linear.app/acme/issue/eng-12"), DetectedTicket(provider: .linear, id: "ENG-12"))
        XCTAssertEqual(Tickets.detect(" https://acme.atlassian.net/browse/OPS-7?x=1 "), DetectedTicket(provider: .jira, id: "OPS-7"))
        XCTAssertEqual(Tickets.detect("https://github.com/acme/api/issues/42"), DetectedTicket(provider: .github, id: "api#42"))
        XCTAssertNil(Tickets.detect("https://evil.example/linear.app/acme/issue/ENG-1"))
    }

    func testRepoNormalization() {
        XCTAssertEqual(Tickets.normalizeRepo("https://github.com/acme/api.git"), "acme/api")
        XCTAssertEqual(Tickets.normalizeRepo("github.com/acme/api/"), "acme/api")
        XCTAssertNil(Tickets.normalizeRepo("acme"))
        XCTAssertNil(Tickets.normalizeRepo("../etc"))
    }

    func testEventVariants() {
        XCTAssertEqual(ButtonVariant.forEvent("approve"), .success)
        XCTAssertEqual(ButtonVariant.forEvent("mark-wont-do"), .danger)
        XCTAssertEqual(ButtonVariant.forEvent("troubleshoot"), .warning)
        XCTAssertEqual(ButtonVariant.forEvent("retry"), .ghost)
        XCTAssertEqual(ButtonVariant.forEvent("custom"), .primary)
    }

    func testGitHubOAuthCallbackResult() {
        XCTAssertEqual(
            GitHubOAuthCallbackResult(url: URL(string: "sindral://github/callback?github=connected")!),
            .connected
        )
        XCTAssertEqual(
            GitHubOAuthCallbackResult(url: URL(string: "sindral://github/callback?github=error&github_error=scope")!),
            .failed(reason: "scope")
        )
        XCTAssertNil(GitHubOAuthCallbackResult(url: URL(string: "https://example.com/callback?github=connected")!))
    }

    func testTaskListActiveFilterKeepsParentsWithActiveChildren() {
        let parent = fixture(id: "p", state: "done", step: "done")
        let child = fixture(id: "c", state: "planning", step: "plan", parent: "p")
        let model = TaskListModel(tasks: [parent, child], workflows: [], filter: .active, projectID: nil, search: "")
        XCTAssertEqual(model.rows.map(\.task.id), ["c"])
    }

    private func fixture(id: String = "t", state: String, step: String?, parent: String? = nil) -> SindralTask {
        SindralTask(id: id, userId: "u", version: 1, key: "SIN-1", title: "T", description: "", projectId: nil, outcome: "", acceptanceCriteria: "", state: state, currentStepId: step, workflowId: nil, pinnedWorkflow: workflow, repos: [], ticketUrl: nil, prUrl: nil, branch: nil, baseBranch: nil, plan: nil, parentTaskId: parent, sequence: nil, failedStepId: nil, lastError: nil, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
    }
}
