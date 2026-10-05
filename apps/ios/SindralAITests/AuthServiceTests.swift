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

    func testSessionEncodingPreservesAbsoluteExpiration() throws {
        let expiresAt = Date(timeIntervalSince1970: 4_102_444_800)
        let session = AuthSession(
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresAt: expiresAt,
            user: AuthUser(id: "user-id", email: "person@example.com")
        )

        let data = try JSONEncoder().encode(session)
        let decoded = try JSONDecoder().decode(AuthSession.self, from: data)

        XCTAssertEqual(decoded.expiresAt.timeIntervalSince1970, expiresAt.timeIntervalSince1970, accuracy: 0.001)
    }

    func testExpiredSessionRefreshIsSharedAcrossConcurrentCallers() async throws {
        RefreshURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RefreshURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let appConfiguration = AppConfiguration(
            apiURL: URL(string: "https://api.example.com")!,
            supabaseURL: URL(string: "https://project.supabase.co")!,
            supabaseAnonKey: "publishable-key"
        )
        let store = SessionStore(
            configuration: appConfiguration,
            urlSession: session,
            keychain: KeychainStore(service: "ai.sindral.tests.\(UUID().uuidString)")
        )

        try await store.signIn(email: "person@example.com", password: "password")

        async let first = store.validAccessToken()
        async let second = store.validAccessToken()
        async let third = store.validAccessToken()

        let tokens = try await [first, second, third]
        XCTAssertEqual(tokens, ["fresh-access-token", "fresh-access-token", "fresh-access-token"])
        XCTAssertEqual(RefreshURLProtocol.refreshCount, 1)
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

private final class RefreshURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var _refreshCount = 0

    static var refreshCount: Int {
        lock.withLock { _refreshCount }
    }

    static func reset() {
        lock.withLock { _refreshCount = 0 }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let components = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
        let grant = components?.queryItems?.first(where: { $0.name == "grant_type" })?.value
        let body: String
        if grant == "password" {
            body = authBody(accessToken: "expired-access-token", refreshToken: "refresh-token", expiresIn: 0)
        } else if grant == "refresh_token" {
            Self.lock.withLock { Self._refreshCount += 1 }
            body = authBody(accessToken: "fresh-access-token", refreshToken: "next-refresh-token", expiresIn: 3600)
        } else {
            body = #"{"msg":"Unsupported grant"}"#
        }
        let status = grant == "password" || grant == "refresh_token" ? 200 : 400
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private func authBody(accessToken: String, refreshToken: String, expiresIn: Int) -> String {
        """
        {"access_token":"\(accessToken)","refresh_token":"\(refreshToken)","expires_in":\(expiresIn),"user":{"id":"user-id","email":"person@example.com"}}
        """
    }
}
