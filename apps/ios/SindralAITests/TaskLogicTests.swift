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

    func testTaskScopeLocksForStartedAndPinnedTasks() {
        XCTAssertTrue(fixtureTask(state: "todo", currentStepID: nil, workflow: nil).canEditScope)
        for state in ["bdd", "planning", "plan-review", "implement-ios", "done", "failure"] {
            XCTAssertFalse(fixtureTask(state: state, currentStepID: nil, workflow: nil).canEditScope)
        }
        let workflow = Workflow(id: "mobile", name: "Mobile", entryStepId: "todo", steps: [], edges: [], mobilePlatforms: ["ios"])
        XCTAssertFalse(fixtureTask(state: "todo", currentStepID: nil, workflow: workflow).canEditScope)
    }

    func testPlatformDefaultsAndOverridesRespectWorkflowSupport() {
        let workflow = Workflow(id: "mobile", name: "Mobile", entryStepId: "todo",
            steps: TaskPlatformSelection.all.map { .init(id: $0, type: "agent", label: $0, state: $0, platform: $0) },
            edges: [], mobilePlatforms: ["ios", "android"])
        let project = Project(projectType: "mobile-app", platforms: ["android", "web"], id: "project", userId: "user", name: "Mobile", description: "", createdAt: "", updatedAt: "", repositories: [])
        XCTAssertEqual(TaskPlatformSelection.values(nil, workflow: workflow, project: project), ["android", "web"])
        XCTAssertEqual(TaskPlatformSelection.values(["web", "ios"], workflow: workflow, project: project), ["ios", "web"])
        XCTAssertEqual(TaskPlatformSelection.values(nil, workflow: workflow, project: nil), ["ios", "android"])
        XCTAssertEqual(TaskPlatformSelection.values([], workflow: workflow, project: project), [])
        XCTAssertEqual(TaskPlatformSelection.values(["windows"], workflow: workflow, project: project), [])
        var general = workflow; general.mobilePlatforms = nil; general.isDefault = true
        XCTAssertEqual(TaskWorkflowSelection.preferred([general, workflow], project: project)?.id, "mobile")
        XCTAssertEqual(TaskWorkflowSelection.preferred([general, workflow], project: nil)?.mobilePlatforms, nil)
        XCTAssertNotNil(TaskWorkflowSelection.preferred([general], project: project))
    }

    func testPinnedWorkflowKeepsScopeWhenLiveWorkflowChanges() {
        let pinned = Workflow(id: "mobile", name: "Pinned", entryStepId: "ios", steps: [.init(id: "ios", type: "agent", label: "iOS", state: "implement-ios", platform: "ios")], edges: [], mobilePlatforms: ["ios"])
        var live = pinned; live.name = "Changed"; live.mobilePlatforms = ["android"]
        let task = fixtureTask(state: "implement-ios", currentStepID: "ios", workflow: pinned, platforms: ["android"])
        XCTAssertEqual(task.resolvedWorkflow([live]), pinned)
    }

    func testPlatformChangesKeepOneClientAndCanonicalOrder() {
        XCTAssertEqual(TaskPlatformSelection.updating(["ios"], platform: "ios", enabled: false), ["ios"])
        XCTAssertEqual(TaskPlatformSelection.updating(["web"], platform: "ios", enabled: true), ["ios", "web"])
        XCTAssertEqual(TaskPlatformSelection.updating(["ios", "web"], platform: "ios", enabled: false), ["web"])
        XCTAssertEqual(TaskPlatformSelection.updating(["ios"], platform: "ios", enabled: true), ["ios"])
        XCTAssertEqual(TaskPlatformSelection.updating(["ios"], platform: "windows", enabled: true), ["ios"])
    }

    func testMobileApprovalRequiresBothPlansIncludingLiveWorkflowResolution() throws {
        let workflow = Workflow(id: "mobile", name: "Mobile", entryStepId: "plan-review", steps: [], edges: [], mobilePlatforms: ["ios"])
        var task = try planTask(plan: "Implementation", workflowID: workflow.id)
        XCTAssertTrue(TaskPlanReview(task: task, workflows: [workflow]).approvalBlocked)
        task.bddPlan = .init(plan: "BDD", scenarios: [.init(id: "S1", given: "a task", when: "it starts", then: "scope is pinned")])
        XCTAssertFalse(TaskPlanReview(task: task, workflows: [workflow]).approvalBlocked)
        XCTAssertEqual(TaskPlanReview(task: task, workflows: [workflow]).approvalLabel, "Approve Both Plans")
        for plan in [nil, "", " \n "] as [String?] {
            var missingImplementation = try planTask(plan: plan, workflowID: workflow.id)
            missingImplementation.bddPlan = task.bddPlan
            XCTAssertTrue(TaskPlanReview(task: missingImplementation, workflows: [workflow]).approvalBlocked)
        }
        let general = try planTask(plan: "Implementation", workflowID: nil)
        XCTAssertFalse(TaskPlanReview(task: general, workflows: []).approvalBlocked)
        XCTAssertEqual(TaskPlanReview(task: general, workflows: []).approvalLabel, "Approve Plan")
    }

    func testBddFeedbackUsesThePlanComposerInsteadOfAnActionButton() {
        let workflow = Workflow(id: "mobile", name: "Mobile", entryStepId: "review",
            steps: [.init(id: "review", type: "human", label: "Review", state: "plan-review")], edges: [
                .init(from: "review", to: "implement-ios", event: "approve", label: "Approve Both Plans"),
                .init(from: "review", to: "planning-feedback", event: "feedback"),
                .init(from: "review", to: "bdd-feedback", event: "bdd-feedback")
            ], mobilePlatforms: ["ios"])
        XCTAssertEqual(fixtureTask(state: "plan-review", currentStepID: "review", workflow: workflow).availableActions(workflows: []).map(\.event), ["approve"])
        XCTAssertTrue(fixtureTask(state: "done", currentStepID: "review", workflow: workflow).availableActions(workflows: []).isEmpty)
    }

    private func planTask(plan: String?, workflowID: String?) throws -> TaskDetail {
        var object: [String: Any] = ["id": "task", "userId": "user", "version": 1, "key": "SIN-1", "title": "Mobile task", "description": "", "outcome": "", "acceptanceCriteria": "", "state": "plan-review", "repos": [], "createdAt": "", "updatedAt": "", "messages": [], "events": [], "artifacts": [], "repositories": [], "pullRequests": []]
        object["plan"] = plan; object["workflowId"] = workflowID
        return try JSONDecoder().decode(TaskDetail.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func fixtureTask(state: String, currentStepID: String?, workflow: Workflow?, platforms: [String]? = nil, pinned: Bool = true) -> SindralTask {
        SindralTask(id: "task", userId: "user", version: 2, key: "SIN-1", title: "Test", description: "", projectId: nil, outcome: "", acceptanceCriteria: "", state: state, currentStepId: currentStepID, workflowId: workflow?.id, pinnedWorkflow: pinned ? workflow : nil, repos: [], ticketUrl: nil, prUrl: nil, branch: nil, baseBranch: nil, plan: nil, parentTaskId: nil, sequence: nil, failedStepId: nil, lastError: nil, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", platforms: platforms)
    }
}
