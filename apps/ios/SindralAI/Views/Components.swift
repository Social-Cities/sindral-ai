import SwiftUI

/// Task list card: key, chips and relative time, then the title and status badge.
struct TaskCard: View {
    let task: SindralTask
    var step: WorkflowStep?
    var projectName: String?
    var selected = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(task.key).font(Theme.mono(12)).foregroundStyle(Theme.mutedForeground)
                if let projectName { MetaChip(text: projectName) }
                if task.prUrl != nil { MetaChip(text: "PR open", color: Theme.secondaryForeground) }
                if task.ticketUrl != nil { MetaChip(text: "linked") }
                Spacer(minLength: 8)
                Text(Formatters.shortAgo(task.updatedAt)).font(Theme.mono(11)).foregroundStyle(Theme.mutedForeground)
            }
            Text(task.title)
                .font(Theme.font(15, .medium))
                .foregroundStyle(Theme.foreground)
                .multilineTextAlignment(.leading)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            StatusBadge(state: task.state, step: step)
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surface(selected ? Theme.secondary : Theme.card, radius: Theme.Radius.row, border: selected ? Theme.primary.opacity(0.4) : Theme.border)
        .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.row))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Minimal Markdown renderer: headings, bullet and numbered lists, fenced code and inline styles.
struct MarkdownText: View {
    let source: String
    var size: CGFloat = 15
    var color: Color = Theme.secondaryForeground

    var body: some View {
        VStack(alignment: .leading, spacing: size * 0.55) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let text, let level):
                    inline(text).font(Theme.font(level == 1 ? size + 5 : size + 2, .semibold)).foregroundStyle(Theme.foreground)
                case .paragraph(let text):
                    inline(text).font(Theme.font(size)).foregroundStyle(color).lineSpacing(size * 0.3)
                case .list(let items, let ordered):
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(ordered ? "\(index + 1)." : "•").font(Theme.font(size)).foregroundStyle(color)
                                inline(item).font(Theme.font(size)).foregroundStyle(color)
                            }
                        }
                    }
                case .code(let text):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(text).font(Theme.mono(size - 2)).foregroundStyle(Theme.foreground).padding(12)
                    }
                    .surface(Theme.input, radius: 8)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private enum Block { case heading(String, Int), paragraph(String), list([String], ordered: Bool), code(String) }

    private var blocks: [Block] {
        var result: [Block] = []
        var paragraph: [String] = []
        var list: [String] = []
        var ordered = false
        var code: [String]?
        func flush() {
            if !paragraph.isEmpty { result.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
            if !list.isEmpty { result.append(.list(list, ordered: ordered)); list = [] }
        }
        for raw in source.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let open = code { result.append(.code(open.joined(separator: "\n"))); code = nil } else { flush(); code = [] }
                continue
            }
            if code != nil { code?.append(raw); continue }
            if line.isEmpty { flush(); continue }
            if let hashes = line.firstIndex(where: { $0 != "#" }), line.hasPrefix("#"), line[hashes] == " " {
                flush(); result.append(.heading(String(line[hashes...]).trimmingCharacters(in: .whitespaces), line.distance(from: line.startIndex, to: hashes)))
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                if !paragraph.isEmpty || (ordered && !list.isEmpty) { flush() }
                ordered = false; list.append(String(line.dropFirst(2)))
            } else if let dot = line.firstIndex(of: "."), line[..<dot].allSatisfy(\.isNumber), !line[..<dot].isEmpty, line[line.index(after: dot)...].hasPrefix(" ") {
                if !paragraph.isEmpty || (!ordered && !list.isEmpty) { flush() }
                ordered = true; list.append(String(line[line.index(dot, offsetBy: 2)...]))
            } else {
                if !list.isEmpty { flush() }
                paragraph.append(line)
            }
        }
        if let open = code { result.append(.code(open.joined(separator: "\n"))) }
        flush()
        return result
    }

    private func inline(_ text: String) -> Text {
        guard var attributed = try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) else { return Text(text) }
        for run in attributed.runs {
            guard let intent = run.inlinePresentationIntent else { continue }
            if intent.contains(.code) {
                attributed[run.range].font = Theme.mono(size - 2)
                attributed[run.range].foregroundColor = Theme.foreground
                attributed[run.range].backgroundColor = Theme.input
            }
            if intent.contains(.stronglyEmphasized) { attributed[run.range].foregroundColor = Theme.foreground }
        }
        return Text(attributed)
    }
}

struct ErrorRetryView: View {
    let error: Error; let retry: () -> Void
    var body: some View {
        ContentUnavailableView { Label("Couldn’t load", systemImage: "exclamationmark.triangle") } description: { Text(error.localizedDescription) } actions: {
            Button("Try again", action: retry).buttonStyle(.sindral(.subtle))
        }
    }
}

/// Centered placeholder used by empty lists and panes.
struct EmptyPane: View {
    let title: String
    var systemImage = "tray"
    var message: String?
    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage).foregroundStyle(Theme.secondaryForeground)
        } description: {
            if let message { Text(message).foregroundStyle(Theme.mutedForeground) }
        }
    }
}

extension String {
    var commaSeparated: [String] { split { $0 == "," || $0.isWhitespace }.map(String.init).filter { !$0.isEmpty } }
}


struct TaskPlatformSelector: View {
    @Binding var selection: [String]?
    let workflow: Workflow?
    let project: Project?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Platforms for this task").font(Theme.bodyMedium)
            ForEach(TaskPlatformSelection.options(workflow: workflow, project: project), id: \.self) { platform in
                Toggle(platform == "ios" ? "iOS" : platform.capitalized, isOn: Binding(get: {
                    TaskPlatformSelection.values(selection, workflow: workflow, project: project).contains(platform)
                }, set: { enabled in
                    let current = TaskPlatformSelection.values(selection, workflow: workflow, project: project)
                    selection = enabled ? current + [platform] : current.filter { $0 != platform }
                }))
            }
            Text("Only selected platforms run, in iOS → Android → Web order. Selection is locked when work starts.")
                .font(Theme.secondaryBody).foregroundStyle(Theme.mutedForeground)
        }
    }
}
