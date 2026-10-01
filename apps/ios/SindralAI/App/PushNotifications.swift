import UIKit
import UserNotifications

final class PushNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor static weak var store: AppStore?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
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
        [.banner, .sound, .badge]
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
