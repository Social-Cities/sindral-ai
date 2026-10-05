import Foundation
import Observation

struct AuthSession: Codable, Hashable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Date
    let user: AuthUser

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresAt = "expires_at"
        case expiresIn = "expires_in"
        case user
    }

    init(accessToken: String, refreshToken: String, expiresAt: Date, user: AuthUser) {
        self.accessToken = accessToken; self.refreshToken = refreshToken; self.expiresAt = expiresAt; self.user = user
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try values.decode(String.self, forKey: .accessToken)
        refreshToken = try values.decode(String.self, forKey: .refreshToken)
        user = try values.decode(AuthUser.self, forKey: .user)
        if let timestamp = try values.decodeIfPresent(Double.self, forKey: .expiresAt) {
            expiresAt = Date(timeIntervalSince1970: timestamp)
        } else {
            expiresAt = Date().addingTimeInterval(TimeInterval(try values.decode(Int.self, forKey: .expiresIn)))
        }
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(accessToken, forKey: .accessToken); try values.encode(refreshToken, forKey: .refreshToken)
        try values.encode(expiresAt.timeIntervalSince1970, forKey: .expiresAt)
        try values.encode(max(0, Int(expiresAt.timeIntervalSinceNow)), forKey: .expiresIn)
        try values.encode(user, forKey: .user)
    }
}

struct AuthUser: Codable, Hashable, Sendable { let id: String; let email: String? }
private struct AuthErrorBody: Codable { let msg: String?; let errorDescription: String?; enum CodingKeys: String, CodingKey { case msg; case errorDescription = "error_description" } }

@MainActor @Observable
final class SessionStore {
    private(set) var session: AuthSession?
    private(set) var isRestoring = true
    private(set) var errorMessage: String?

    private let configuration: AppConfiguration
    private let keychain: KeychainStore
    private let sessionAccount = "session"
    private let urlSession: URLSession
    private var refreshTask: Task<AuthSession, Error>?

    init(configuration: AppConfiguration, urlSession: URLSession = .shared, keychain: KeychainStore = KeychainStore(service: "ai.sindral.app.auth")) {
        self.configuration = configuration; self.urlSession = urlSession; self.keychain = keychain
        do {
            if let data = try keychain.load(account: sessionAccount) { session = try JSONDecoder().decode(AuthSession.self, from: data) }
        } catch { errorMessage = "The saved session could not be restored." }
        isRestoring = false
    }

    var user: AuthUser? { session?.user }

    func signIn(email: String, password: String) async throws {
        try await authenticate(path: "token", queryItems: [.init(name: "grant_type", value: "password")], body: ["email": email, "password": password])
    }

    func signUp(email: String, password: String) async throws -> Bool {
        let response: SignUpResponse = try await authRequest(path: "signup", body: ["email": email, "password": password])
        if let access = response.accessToken, let refresh = response.refreshToken, let user = response.user {
            try setSession(.init(accessToken: access, refreshToken: refresh, expiresAt: Date().addingTimeInterval(TimeInterval(response.expiresIn ?? 3600)), user: user))
            return false
        }
        return true
    }

    func validAccessToken(forceRefresh: Bool = false) async throws -> String {
        guard let current = session else { throw AuthError.notAuthenticated }
        if !forceRefresh, current.expiresAt.timeIntervalSinceNow > 60 { return current.accessToken }
        return try await refreshSession().accessToken
    }

    func signOut() {
        session = nil
        try? keychain.delete(account: sessionAccount)
    }

    private func authenticate(path: String, queryItems: [URLQueryItem] = [], body: [String: String]) async throws {
        let next: AuthSession = try await authRequest(path: path, queryItems: queryItems, body: body)
        try setSession(next)
    }

    private func refreshSession() async throws -> AuthSession {
        if let refreshTask { return try await refreshTask.value }
        guard let current = session else { throw AuthError.notAuthenticated }
        let refreshToken = current.refreshToken
        let task = Task<AuthSession, Error> { [configuration, urlSession] in
            try await Self.authRequest(
                configuration: configuration,
                urlSession: urlSession,
                path: "token",
                queryItems: [.init(name: "grant_type", value: "refresh_token")],
                body: ["refresh_token": refreshToken]
            )
        }
        refreshTask = task
        defer { refreshTask = nil }
        let next = try await task.value
        try setSession(next)
        return next
    }

    private func setSession(_ next: AuthSession) throws {
        try keychain.save(JSONEncoder().encode(next), account: sessionAccount)
        session = next; errorMessage = nil
    }

    private func authRequest<T: Decodable>(path: String, queryItems: [URLQueryItem] = [], body: [String: String]) async throws -> T {
        try await Self.authRequest(configuration: configuration, urlSession: urlSession, path: path, queryItems: queryItems, body: body)
    }

    private static func authRequest<T: Decodable>(configuration: AppConfiguration, urlSession: URLSession, path: String, queryItems: [URLQueryItem] = [], body: [String: String]) async throws -> T {
        var components = URLComponents(url: configuration.supabaseURL.appending(path: "auth/v1/\(path)"), resolvingAgainstBaseURL: false)
        if !queryItems.isEmpty { components?.queryItems = queryItems }
        guard let url = components?.url else { throw AuthError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"; request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(configuration.supabaseAnonKey, forHTTPHeaderField: "apikey")
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AuthError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? JSONDecoder().decode(AuthErrorBody.self, from: data)
            throw AuthError.server(body?.msg ?? body?.errorDescription ?? "Authentication failed")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private struct SignUpResponse: Codable {
    let accessToken: String?; let refreshToken: String?; let expiresIn: Int?; let user: AuthUser?
    enum CodingKeys: String, CodingKey { case accessToken = "access_token", refreshToken = "refresh_token", expiresIn = "expires_in", user }
}

enum AuthError: LocalizedError {
    case notAuthenticated, invalidResponse, server(String)
    var errorDescription: String? {
        switch self {
        case .notAuthenticated: "Please sign in again."
        case .invalidResponse: "The authentication service returned an invalid response."
        case .server(let message): message
        }
    }
}
