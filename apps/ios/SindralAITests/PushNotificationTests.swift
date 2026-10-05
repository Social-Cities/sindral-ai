import XCTest
@testable import SindralAI

final class PushNotificationTests: XCTestCase {
    func testTaskIDParsesFromTaskNotificationPayload() {
        XCTAssertEqual(PushNotificationPayload.taskID(from: ["taskId": "task-123"]), "task-123")
    }

    func testTaskIDRejectsMissingOrBlankPayload() {
        XCTAssertNil(PushNotificationPayload.taskID(from: ["kind": "needs-input"]))
        XCTAssertNil(PushNotificationPayload.taskID(from: ["taskId": "  \n"]))
    }
}
