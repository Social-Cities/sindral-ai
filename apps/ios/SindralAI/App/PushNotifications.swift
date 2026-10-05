import UIKit
import UserNotifications

final class PushNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor static weak var store: AppStore?
    @MainActor static weak var router: AppRouter?
    @MainActor private static var pendingTaskID: String?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        if let userInfo = launchOptions?[.remoteNotification] as? [AnyHashable: Any],
           let taskID = PushNotificationPayload.taskID(from: userInfo) {
            Task { @MainActor in Self.handleNotification(taskID: taskID) }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in await Self.store?.registerPushToken(token) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("Remote notification registration failed:", error.localizedDescription)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let userInfo = notification.request.content.userInfo
        if PushNotificationPayload.taskID(from: userInfo) != nil {
            await MainActor.run {
                _ = Task { await Self.store?.refreshTasks() }
            }
        }
        return [.banner, .sound, .badge]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        guard let taskID = PushNotificationPayload.taskID(from: userInfo) else { return }
        await MainActor.run { Self.handleNotification(taskID: taskID) }
    }

    @MainActor static func configure(store: AppStore, router: AppRouter) {
        Self.store = store
        Self.router = router
        if let taskID = pendingTaskID {
            pendingTaskID = nil
            router.openTask(taskID)
        }
    }

    @MainActor static func clearSession() {
        store = nil
        router = nil
        pendingTaskID = nil
    }

    @MainActor private static func handleNotification(taskID: String) {
        _ = Task { await store?.refreshTasks() }
        if let router {
            router.openTask(taskID)
        } else {
            pendingTaskID = taskID
        }
    }
}

enum PushNotificationPayload {
    static func taskID(from userInfo: [AnyHashable: Any]) -> String? {
        guard let taskID = userInfo["taskId"] as? String else { return nil }
        let trimmed = taskID.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension AppStore {
    func requestPushNotifications() async {
        guard session.session != nil else { return }
        let center = UNUserNotificationCenter.current()
        do {
            let settings = await center.notificationSettings()
            switch settings.authorizationStatus {
            case .notDetermined:
                guard try await center.requestAuthorization(options: [.alert, .badge, .sound]) else { return }
            case .authorized, .provisional, .ephemeral:
                break
            case .denied:
                return
            @unknown default:
                return
            }
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            present(error)
        }
    }

    func registerPushToken(_ token: String) async {
        guard session.session != nil else { return }
        do { _ = try await api.registerPushDevice(token: token, environment: pushEnvironment) }
        catch { print("Push token registration failed:", error.localizedDescription) }
    }

    private var pushEnvironment: String {
        Bundle.main.object(forInfoDictionaryKey: "SindralPushEnvironment") as? String ?? "sandbox"
    }
}
