import Foundation

struct DesignFile: Codable, Hashable, Sendable, Identifiable {
    let path: String
    let contentType: String
    let encoding: String
    let content: String
    let sha256: String
    var id: String { path }
}

struct DesignScreen: Codable, Hashable, Sendable {
    let name: String
    let path: String
}

struct DesignResult: Codable, Hashable, Sendable {
    let kind: String
    let summary: String
    let designUrl: String?
    let specification: String
    let questions: [String]
    let screens: [DesignScreen]
    let files: [DesignFile]
    let outcome: String?
    let acceptanceCriteria: String?
}

struct DesignRevision: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let taskId: String
    let jobId: String
    let result: DesignResult
    let createdAt: String
    let approvedAt: String?
}

struct DesignRevisionSummary: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let taskId: String
    let jobId: String
    let summary: String
    let designUrl: String?
    let screens: [DesignScreen]
    let createdAt: String
    let approvedAt: String?
}

struct DesignInputSummary: Codable, Hashable, Sendable {
    let sourceTaskId: String
    let revisionId: String
    let approvedAt: String
}

struct DesignHandoff: Codable, Hashable, Sendable {
    let sourceTaskId: String
    let revisionId: String
    let approvedAt: String
    let result: DesignResult
}

struct DesignOverview: Codable, Sendable {
    let revisions: [DesignRevisionSummary]
    let checkpointAt: String?
    let input: DesignHandoff?
    let inputPreviewUrls: [String]
}

struct DesignRevisionView: Decodable, Sendable {
    let revision: DesignRevision
    let previewUrls: [String]
}

struct DesignHandoffRequest: Encodable, Sendable {
    let revisionId: String
    let idempotencyKey: String
}

extension Workflow {
    var isDesign: Bool { steps.contains { $0.output == "design" } }
    var supportsImplementation: Bool { steps.contains { ["implementation", "pr", "review-slice"].contains($0.output ?? "") } }
}

extension TaskDetail {
    func hasDesign(_ workflows: [Workflow]) -> Bool {
        designInput != nil || resolvedWorkflow(workflows)?.isDesign == true
    }
}
