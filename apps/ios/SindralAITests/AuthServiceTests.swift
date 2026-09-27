import XCTest
@testable import SindralAI

@MainActor
final class AuthServiceTests: XCTestCase {
    func testPasswordGrantIsEncodedAsAQueryParameter() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AuthURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let appConfiguration = AppConfiguration(
            apiURL: URL(string: "https://api.example.com")!,
            supabaseURL: URL(string: "https://project.supabase.co")!,
            supabaseAnonKey: "publishable-key"
        )
        let store = SessionStore(configuration: appConfiguration, urlSession: session)

        do {
            try await store.signIn(email: "person@example.com", password: "password")
            XCTFail("Expected the fixture authentication response to fail")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Invalid login credentials")
        }
    }
}

private final class AuthURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let components = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
        let hasPasswordGrant = components?.queryItems?.contains(.init(name: "grant_type", value: "password")) == true
        let isCorrectPath = components?.path == "/auth/v1/token"
        let status = hasPasswordGrant && isCorrectPath ? 400 : 404
        let body = hasPasswordGrant && isCorrectPath
            ? #"{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}"#
            : #"{"message":"Invalid authentication route"}"#
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
