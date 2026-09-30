import Observation
import SwiftUI

enum AppSection: String, CaseIterable, Identifiable {
    case home, tasks, workflows, settings
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var icon: String {
        switch self { case .home: "house"; case .tasks: "checklist"; case .workflows: "point.3.connected.trianglepath.dotted"; case .settings: "gearshape" }
    }
}

/// Task list filter chips. `active` hides terminal states; the others use the dashboard buckets.
enum TaskFilter: String, CaseIterable, Identifiable {
    case active, todo, inProgress, inReview, failed, all
    var id: String { rawValue }
    var title: String {
        switch self { case .active: "Active"; case .todo: "Todo"; case .inProgress: "In progress"; case .inReview: "In review"; case .failed: "Failed"; case .all: "All" }
    }
    var bucket: DashboardBucket? {
        switch self { case .todo: .todo; case .inProgress: .inProgress; case .inReview: .inReview; case .failed: .failed; case .active, .all: nil }
    }
    init(bucket: DashboardBucket) {
        switch bucket { case .todo: self = .todo; case .inProgress: self = .inProgress; case .inReview: self = .inReview; case .failed: self = .failed; case .done: self = .all }
    }
}

/// UI navigation state shared by the shell, Home and Tasks.
@MainActor @Observable
final class AppRouter {
    var section = AppSection.home
    var taskFilter = TaskFilter.active
    var projectFilterID: String?
    var selectedTaskID: String?
    var showingCreateTask = false

    func openTasks(filter: TaskFilter) { taskFilter = filter; section = .tasks }
    func openTask(_ id: String) { selectedTaskID = id; section = .tasks }
}
