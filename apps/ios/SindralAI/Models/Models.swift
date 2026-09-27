import Foundation

enum JSONValue: Codable, Hashable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var prettyPrinted: String {
        guard let data = try? JSONEncoder().encode(self),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return "" }
        return String(decoding: pretty, as: UTF8.self)
    }
}

struct WorkflowPosition: Codable, Hashable, Sendable { var x: Double; var y: Double }

struct WorkflowStep: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var type: String
    var label: String
    var state: String
    var engine: String?
    var model: String?
    var mode: String?
    var prompt: String?
    var tools: [String]?
    var permissions: [String]?
    var output: String?
    var position: WorkflowPosition?
}

struct WorkflowEdge: Codable, Identifiable, Hashable, Sendable {
    var from: String
    var to: String
    var event: String
    var label: String?
    var id: String { "\(from):\(event):\(to)" }
}

struct Workflow: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var description: String?
    var entryStepId: String
    var steps: [WorkflowStep]
    var edges: [WorkflowEdge]
    var troubleshootStep: WorkflowStep?
    var userId: String?
    var isDefault: Bool?
    var createdAt: String?
    var updatedAt: String?
}

struct Message: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let taskId: String
    let role: String
    let content: String
    let source: String
    let externalId: String?
    let createdAt: String
}

struct TaskEvent: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let taskId: String
    let type: String
    let fromState: String?
    let toState: String?
    let stepId: String?
    let detail: [String: JSONValue]?
    let createdAt: String
}

struct Artifact: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let taskId: String
    let jobId: String?
    let name: String
    let contentType: String
    let content: String?
    let byteSize: Int
    let downloadUrl: String?
    let createdAt: String
}

struct TaskRepository: Codable, Identifiable, Hashable, Sendable {
    let id: String; let repository: String; let branch: String; let baseBranch: String?; let mergeMethod: String
}

struct PullRequest: Codable, Identifiable, Hashable, Sendable {
    let id: String; let repository: String; let url: String; let number: Int; let branch: String; let baseBranch: String; let status: String; let mergedAt: String?
}

struct SindralTask: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let userId: String
    let version: Int
    let key: String
    var title: String
    var description: String
    let outcome: String
    let acceptanceCriteria: String
    let state: String
    let currentStepId: String?
    let workflowId: String?
    let pinnedWorkflow: Workflow?
    let repos: [String]
    let ticketUrl: String?
    let prUrl: String?
    let branch: String?
    let baseBranch: String?
    let plan: String?
    let parentTaskId: String?
    let sequence: Int?
    let failedStepId: String?
    let lastError: String?
    let createdAt: String
    let updatedAt: String
}

struct TaskDetail: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let userId: String
    let version: Int
    let key: String
    var title: String
    var description: String
    let outcome: String
    let acceptanceCriteria: String
    let state: String
    let currentStepId: String?
    let workflowId: String?
    let pinnedWorkflow: Workflow?
    let repos: [String]
    let ticketUrl: String?
    let prUrl: String?
    let branch: String?
    let baseBranch: String?
    let plan: String?
    let parentTaskId: String?
    let sequence: Int?
    let failedStepId: String?
    let lastError: String?
    let createdAt: String
    let updatedAt: String
    let messages: [Message]
    let events: [TaskEvent]
    let artifacts: [Artifact]
    let subtasks: [SindralTask]
    let repositories: [TaskRepository]
    let pullRequests: [PullRequest]

    var summary: SindralTask { SindralTask(id: id, userId: userId, version: version, key: key, title: title, description: description, outcome: outcome, acceptanceCriteria: acceptanceCriteria, state: state, currentStepId: currentStepId, workflowId: workflowId, pinnedWorkflow: pinnedWorkflow, repos: repos, ticketUrl: ticketUrl, prUrl: prUrl, branch: branch, baseBranch: baseBranch, plan: plan, parentTaskId: parentTaskId, sequence: sequence, failedStepId: failedStepId, lastError: lastError, createdAt: createdAt, updatedAt: updatedAt) }
}

struct Worker: Codable, Identifiable, Hashable, Sendable {
    let id: String; let name: String; let hostname: String; let version: String; let status: String; let runningJobs: Int; let lastSeenAt: String
}
struct WorkerKey: Codable, Identifiable, Hashable, Sendable {
    let id: String; let name: String; let keyPrefix: String; let createdAt: String; let lastUsedAt: String?; let revokedAt: String?
}
struct SecretStatus: Codable, Identifiable, Hashable, Sendable {
    let provider: String; let configured: Bool; let updatedAt: String?; let hint: String?; var id: String { provider }
}
struct TicketImport: Codable, Hashable, Sendable { let provider: String; let id: String; let title: String; let description: String; let url: String }
struct Profile: Codable, Hashable, Sendable { let id: String; let email: String?; let displayName: String? }

struct Job: Codable, Identifiable, Hashable, Sendable {
    let id: String; let taskId: String; let kind: String; let stepId: String?; let status: String; let workerId: String?; let attempt: Int; let result: JSONValue?; let error: String?; let createdAt: String; let finishedAt: String?
}
struct JobLog: Codable, Identifiable, Hashable, Sendable { let id: String; let type: String; let message: String; let createdAt: String }
struct DiffFile: Codable, Identifiable, Hashable, Sendable { let filename: String; let status: String; let additions: Int; let deletions: Int; let patch: String?; var id: String { filename } }

struct TaskAction: Identifiable, Hashable { let event: String; let label: String; var id: String { event } }

extension SindralTask {
    func workflow(from workflows: [Workflow]) -> Workflow? { pinnedWorkflow ?? workflows.first { $0.id == workflowId } }
    func availableActions(workflows: [Workflow]) -> [TaskAction] {
        if state == "failure" { return [.init(event: "troubleshoot", label: "Troubleshoot"), .init(event: "retry", label: "Retry step")] }
        guard state != "troubleshoot", let workflow = workflow(from: workflows),
              let step = workflow.steps.first(where: { $0.id == (currentStepId ?? workflow.entryStepId) }), step.type == "human" else { return [] }
        return workflow.edges.filter { $0.from == step.id && $0.event != "feedback" }.map { .init(event: $0.event, label: $0.label ?? $0.event.replacingOccurrences(of: "-", with: " ").capitalized) }
    }
}
