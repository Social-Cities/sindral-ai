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

    private func fixtureTask(state: String, currentStepID: String?, workflow: Workflow?) -> SindralTask {
        SindralTask(id: "task", userId: "user", version: 2, key: "SIN-1", title: "Test", description: "", projectId: nil, outcome: "", acceptanceCriteria: "", state: state, currentStepId: currentStepID, workflowId: workflow?.id, pinnedWorkflow: workflow, repos: [], ticketUrl: nil, prUrl: nil, branch: nil, baseBranch: nil, plan: nil, parentTaskId: nil, sequence: nil, failedStepId: nil, lastError: nil, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
    }
}
