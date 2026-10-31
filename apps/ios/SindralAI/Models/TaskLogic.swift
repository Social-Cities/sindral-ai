import Foundation

/// Swift ports of the pure helpers in `packages/shared` that the UI needs.
enum TaskStates {
    static let terminal: Set<String> = ["done", "wont-do"]
    static let offPath: Set<String> = ["failure", "troubleshoot", "conflict-resolution"]
}

enum DashboardBucket: String, CaseIterable, Identifiable {
    case todo, inProgress = "in-progress", inReview = "in-review", done, failed
    var id: String { rawValue }

    /// Mirrors `dashboardBucket` in `packages/shared/src/states.ts`.
    static func of(state: String, step: WorkflowStep?) -> DashboardBucket {
        if state == "todo" { return .todo }
        if TaskStates.terminal.contains(state) { return .done }
        if state == "failure" { return .failed }
        if state == "in-review" { return .inReview }
        if step?.type == "human" && state != "plan-review" { return .inReview }
        return .inProgress
    }
}

extension Workflow {
    func step(_ id: String?) -> WorkflowStep? {
        guard let id else { return nil }
        return steps.first { $0.id == id }
    }

    /// Entry step followed by `complete` / `start` / first non-feedback edges until an end step.
    var happyPath: [WorkflowStep] {
        var path: [WorkflowStep] = []
        var seen = Set<String>()
        var current = step(entryStepId)
        while let node = current, !seen.contains(node.id) {
            seen.insert(node.id); path.append(node)
            if node.type == "end" { break }
            let outgoing = edges.filter { $0.from == node.id }
            let preferred = outgoing.first { $0.event == "complete" }
                ?? outgoing.first { $0.event == "start" }
                ?? outgoing.first { $0.event != "feedback" && $0.event != "reject" && !seen.contains($0.to) }
            current = step(preferred?.to)
        }
        return path
    }
}

/// The fields every task-shaped model shares, so list rows and detail can use the same logic.
protocol TaskLike {
    var state: String { get }
    var currentStepId: String? { get }
    var workflowId: String? { get }
    var pinnedWorkflow: Workflow? { get }
    var platforms: [String]? { get }
}

extension SindralTask: TaskLike {}
extension TaskDetail: TaskLike {}

extension TaskLike {
    func resolvedWorkflow(_ workflows: [Workflow]) -> Workflow? {
        if let pinnedWorkflow { return pinnedWorkflow }
        guard let live = workflows.first(where: { $0.id == workflowId }) else { return nil }
        return live.mobilePlatforms == nil ? live : live.selectingPlatforms(platforms ?? live.mobilePlatforms ?? [])
    }

    func currentStep(_ workflows: [Workflow]) -> WorkflowStep? {
        guard let workflow = resolvedWorkflow(workflows) else { return nil }
        return workflow.step(currentStepId ?? workflow.entryStepId)
    }

    func bucket(_ workflows: [Workflow]) -> DashboardBucket { .of(state: state, step: currentStep(workflows)) }

    /// Mirrors `isAgentActive` in `packages/shared/src/stateMachine.ts`.
    func isAgentActive(_ workflows: [Workflow]) -> Bool {
        if state == "troubleshoot" || state == "conflict-resolution" { return true }
        guard !["failure", "done", "wont-do"].contains(state), let workflow = resolvedWorkflow(workflows) else { return false }
        return workflow.step(currentStepId)?.type == "agent"
    }

    /// Mirrors `chatTriggersFeedback`: chat on a human step with a `feedback` edge starts a revision.
    func chatTriggersFeedback(_ workflows: [Workflow]) -> Bool { feedbackTarget(workflows) != nil }

    func feedbackTarget(_ workflows: [Workflow]) -> WorkflowStep? {
        guard !["failure", "troubleshoot", "done", "wont-do"].contains(state), let workflow = resolvedWorkflow(workflows),
              let step = workflow.step(currentStepId ?? workflow.entryStepId), step.type == "human",
              let edge = workflow.edges.first(where: { $0.from == step.id && $0.event == "feedback" }) else { return nil }
        return workflow.step(edge.to) ?? step
    }
}

enum TicketProvider: String {
    case linear, jira, github
    var label: String { self == .github ? "GitHub" : rawValue.capitalized }
}

struct DetectedTicket: Equatable { let provider: TicketProvider; let id: String }

enum Tickets {
    /// Mirrors `detectTicket` in `packages/shared/src/tickets.ts` (allow-listed hosts only).
    static func detect(_ url: String) -> DetectedTicket? {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if let m = match(#"^https://linear\.app/([a-z0-9-]+)/issue/([A-Z][A-Z0-9]*-\d+)(?:[/?#].*)?$"#, trimmed, caseInsensitive: true) {
            return .init(provider: .linear, id: m[2].uppercased())
        }
        if let m = match(#"^https://([a-z0-9-]+\.atlassian\.net)/browse/([A-Z][A-Z0-9_]*-\d+)(?:[/?#].*)?$"#, trimmed, caseInsensitive: true) {
            return .init(provider: .jira, id: m[2].uppercased())
        }
        if let m = match(#"^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/issues/(\d+)(?:[/?#].*)?$"#, trimmed, caseInsensitive: false) {
            return .init(provider: .github, id: "\(m[2])#\(m[3])")
        }
        return nil
    }

    /// Mirrors `normalizeRepo`: accepts `owner/name`, `github.com/owner/name` or a full URL.
    static func normalizeRepo(_ input: String) -> String? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.replacingOccurrences(of: #"^https?://(www\.)?github\.com/"#, with: "", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: #"^github\.com/"#, with: "", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: #"\.git$"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
        guard s.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil,
              !s.hasPrefix("."), !s.contains("..") else { return nil }
        return s
    }

    private static func match(_ pattern: String, _ string: String, caseInsensitive: Bool) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : []),
              let result = regex.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) else { return nil }
        return (0..<result.numberOfRanges).map { Range(result.range(at: $0), in: string).map { String(string[$0]) } ?? "" }
    }
}

enum Formatters {
    static func date(_ string: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(string)) ?? (try? Date.ISO8601FormatStyle().parse(string))
    }

    /// Compact relative time used in list rows: `4m`, `3h`, `1d`.
    static func shortAgo(_ string: String, now: Date = .now) -> String {
        guard let date = date(string) else { return "" }
        let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes)m" }
        if minutes < 60 * 24 { return "\(minutes / 60)h" }
        return "\(minutes / (60 * 24))d"
    }

    static func time(_ string: String) -> String { date(string)?.formatted(date: .omitted, time: .shortened) ?? "" }
    static func day(_ string: String) -> String { date(string)?.formatted(date: .abbreviated, time: .omitted) ?? string }

    static func greeting(hour: Int) -> String {
        if hour < 5 { return "Good night" }
        if hour < 12 { return "Good morning" }
        if hour < 18 { return "Good afternoon" }
        return "Good evening"
    }
}


/// Pure platform scope helpers shared by task forms and pipeline previews.
enum TaskPlatformSelection {
    static let all = ["ios", "android", "web"]
    static func options(workflow: Workflow?, project _: Project?) -> [String] {
        guard let workflow, workflow.mobilePlatforms != nil else { return [] }
        return all.filter { platform in
            workflow.steps.contains { $0.platform == platform }
        }
    }
    static func values(_ selected: [String]?, workflow: Workflow?, project: Project?) -> [String] {
        let preferred = selected ?? (project?.projectType == "mobile-app" ? project?.platforms : workflow?.mobilePlatforms) ?? []
        return options(workflow: workflow, project: project).filter { preferred.contains($0) }
    }
}

extension Workflow {
    func selectingPlatforms(_ platforms: [String]) -> Workflow {
        guard mobilePlatforms != nil, !platforms.isEmpty else { return self }
        let removed = Set(steps.filter { step in step.platform.map { !platforms.contains($0) } ?? false }.map(\.id))
        func redirect(_ target: String) -> String {
            var target = target
            var seen = Set<String>()
            while removed.contains(target), !seen.contains(target) {
                seen.insert(target)
                guard let next = edges.first(where: { $0.from == target && $0.event == "complete" }) else { break }
                target = next.to
            }
            return target
        }
        var selected = self
        selected.mobilePlatforms = TaskPlatformSelection.all.filter { platforms.contains($0) }
        selected.steps = steps.filter { !removed.contains($0.id) }
        selected.edges = edges.filter { !removed.contains($0.from) }.map { edge in
            var edge = edge; edge.to = redirect(edge.to); return edge
        }
        return selected
    }
}
