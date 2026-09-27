import SwiftUI

struct StatusPill: View {
    let state: String
    var body: some View {
        Text(state.replacingOccurrences(of: "-", with: " ").capitalized)
            .font(.caption2.monospaced()).fontWeight(.semibold).padding(.horizontal, 8).padding(.vertical, 4)
            .foregroundStyle(color).background(color.opacity(0.13), in: Capsule())
            .accessibilityLabel("Status: \(state)")
    }
    private var color: Color {
        switch state { case "done": .green; case "failure": .red; case "todo": .secondary; case "plan-review", "in-review": .orange; default: .indigo }
    }
}

struct TaskRow: View {
    let task: SindralTask
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack { Text(task.key).font(.caption.monospaced()).foregroundStyle(.secondary); Spacer(); StatusPill(state: task.state) }
            Text(task.title).font(.headline).lineLimit(2)
            if !task.description.isEmpty { Text(task.description).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
            if !task.repos.isEmpty { Label(task.repos.joined(separator: ", "), systemImage: "shippingbox").font(.caption).foregroundStyle(.secondary).lineLimit(1) }
        }.padding(.vertical, 4)
    }
}

struct ErrorRetryView: View {
    let error: Error; let retry: () -> Void
    var body: some View { ContentUnavailableView { Label("Couldn’t load", systemImage: "exclamationmark.triangle") } description: { Text(error.localizedDescription) } actions: { Button("Try again", action: retry) } }
}

extension String {
    var commaSeparated: [String] { split { $0 == "," || $0.isWhitespace }.map(String.init).filter { !$0.isEmpty } }
}
