import XCTest
@testable import SindralAI

final class TaskLogicTests: XCTestCase {
    func testHumanStepOffersNonFeedbackActions() throws {
        let workflow = Workflow(
            id: "full", name: "Full", entryStepId: "review",
            steps: [.init(id: "review", type: "human", label: "Review", state: "plan-review"), .init(id: "done", type: "end", label: "Done", state: "done")],
            edges: [.init(from: "review", to: "done", event: "approve", label: "Approve"), .init(from: "review", to: "review", event: "feedback", label: nil)]
        )
        let task = fixtureTask(state: "plan-review", currentStepID: "review", workflow: workflow)
        XCTAssertEqual(task.availableActions(workflows: []).map(\.event), ["approve"])
    }

    func testMobileWorkflowMetadataSurvivesRoundTrip() throws {
        let json = #"{"id":"mobile","name":"Mobile App SDLC","entryStepId":"todo","mobilePlatforms":["ios","android"],"steps":[{"id":"ios","type":"agent","label":"Implement iOS","state":"implement-ios","platform":"ios","resumeSessionKey":"implementation-ios"}],"edges":[]}"#
        let workflow = try JSONDecoder().decode(Workflow.self, from: Data(json.utf8))
        let saved = try JSONDecoder().decode(Workflow.self, from: JSONEncoder().encode(workflow))
        XCTAssertEqual(saved.mobilePlatforms, ["ios", "android"])
        XCTAssertEqual(saved.steps.first?.platform, "ios")
        XCTAssertEqual(saved.steps.first?.resumeSessionKey, "implementation-ios")
    }

    func testFailureAlwaysOffersRecoveryActions() {
        let task = fixtureTask(state: "failure", currentStepID: nil, workflow: nil)
        XCTAssertEqual(task.availableActions(workflows: []).map(\.event), ["troubleshoot", "retry"])
    }

    func testFeedbackIsNeverRenderedAsAButton() {
        let workflow = Workflow(id: "custom", name: "Custom", entryStepId: "gate", steps: [.init(id: "gate", type: "human", label: "Gate", state: "gate"), .init(id: "agent", type: "agent", label: "Revise", state: "revise")], edges: [.init(from: "gate", to: "agent", event: "feedback", label: nil)])
        let task = fixtureTask(state: "gate", currentStepID: "gate", workflow: workflow)
        XCTAssertTrue(task.availableActions(workflows: []).isEmpty)
    }

    func testEveryTaskPlatformCombinationFiltersThePipeline() {
        let platforms = ["ios", "android", "web"]
        var steps: [WorkflowStep] = [.init(id: "todo", type: "human", label: "Todo", state: "todo")]
        steps += platforms.map { .init(id: $0, type: "agent", label: $0, state: $0, platform: $0) }
        steps.append(.init(id: "done", type: "end", label: "Done", state: "done"))
        let ids = ["todo"] + platforms + ["done"]
        let edges = zip(ids, ids.dropFirst()).map { WorkflowEdge(from: $0.0, to: $0.1, event: $0.0 == "todo" ? "start" : "complete") }
        let workflow = Workflow(id: "mobile", name: "Mobile", entryStepId: "todo", steps: steps, edges: edges, mobilePlatforms: ["ios", "android"])
        for mask in 1..<8 {
            let selected = platforms.enumerated().filter { mask & (1 << $0.offset) != 0 }.map(\.element)
            let task = fixtureTask(state: "todo", currentStepID: nil, workflow: workflow, platforms: selected, pinned: false)
            let preview = task.resolvedWorkflow([workflow])!
            XCTAssertEqual(preview.happyPath.map(\.id), ["todo"] + selected + ["done"])
            XCTAssertEqual(preview.mobilePlatforms, selected)
        }
    }

    private func fixtureTask(state: String, currentStepID: String?, workflow: Workflow?, platforms: [String]? = nil, pinned: Bool = true) -> SindralTask {
        SindralTask(id: "task", userId: "user", version: 2, key: "SIN-1", title: "Test", description: "", projectId: nil, outcome: "", acceptanceCriteria: "", state: state, currentStepId: currentStepID, workflowId: workflow?.id, pinnedWorkflow: pinned ? workflow : nil, repos: [], ticketUrl: nil, prUrl: nil, branch: nil, baseBranch: nil, plan: nil, parentTaskId: nil, sequence: nil, failedStepId: nil, lastError: nil, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", platforms: platforms)
    }
}
