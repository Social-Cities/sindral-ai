import AuthenticationServices
import Foundation
import Observation
import UIKit

struct AuthSession: Codable, Hashable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Date
    let user: AuthUser

    enum CodingKeys: String, CodingKey { case accessToken = "access_token", refreshToken = "refresh_token", expiresIn = "expires_in", user }

    init(accessToken: String, refreshToken: String, expiresAt: Date, user: AuthUser) {
        self.accessToken = accessToken; self.refreshToken = refreshToken; self.expiresAt = expiresAt; self.user = user
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try values.decode(String.self, forKey: .accessToken)
        refreshToken = try values.decode(String.self, forKey: .refreshToken)
        expiresAt = Date().addingTimeInterval(TimeInterval(try values.decode(Int.self, forKey: .expiresIn)))
        user = try values.decode(AuthUser.self, forKey: .user)
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(accessToken, forKey: .accessToken); try values.encode(refreshToken, forKey: .refreshToken)
        try values.encode(max(0, Int(expiresAt.timeIntervalSinceNow)), forKey: .expiresIn); try values.encode(user, forKey: .user)
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
    private let keychain = KeychainStore(service: "ai.sindral.ios.auth")
    private let sessionAccount = "session"
    private let urlSession: URLSession

    init(configuration: AppConfiguration, urlSession: URLSession = .shared) {
        self.configuration = configuration; self.urlSession = urlSession
        do {
            if let data = try keychain.load(account: sessionAccount) { session = try JSONDecoder().decode(AuthSession.self, from: data) }
        } catch { errorMessage = "The saved session could not be restored." }
        isRestoring = false
    }

    var user: AuthUser? { session?.user }

    func signIn(email: String, password: String) async throws {
        try await authenticate(path: "token?grant_type=password", body: ["email": email, "password": password])
    }

    func signUp(email: String, password: String) async throws -> Bool {
        let response: SignUpResponse = try await authRequest(path: "signup", body: ["email": email, "password": password])
        if let access = response.accessToken, let refresh = response.refreshToken, let user = response.user {
            try setSession(.init(accessToken: access, refreshToken: refresh, expiresAt: Date().addingTimeInterval(TimeInterval(response.expiresIn ?? 3600)), user: user))
            return false
        }
        return true
    }

    func signInWithGitHub() async throws {
        var components = URLComponents(url: configuration.supabaseURL.appending(path: "auth/v1/authorize"), resolvingAgainstBaseURL: false)!
        components.queryItems = [.init(name: "provider", value: "github"), .init(name: "redirect_to", value: "sindral://auth-callback")]
        guard let url = components.url else { throw AuthError.invalidCallback }
        let callback = try await WebAuthSession.start(url: url, callbackScheme: "sindral")
        guard let fragment = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.fragment else { throw AuthError.invalidCallback }
        let values = fragment.split(separator: "&").reduce(into: [String: String]()) { output, pair in
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if parts.count == 2 { output[parts[0]] = parts[1].removingPercentEncoding ?? parts[1] }
        }
        guard let access = values["access_token"], let refresh = values["refresh_token"] else { throw AuthError.invalidCallback }
        let user: AuthUser = try await userForToken(access)
        let expires = TimeInterval(values["expires_in"].flatMap(Int.init) ?? 3600)
        try setSession(.init(accessToken: access, refreshToken: refresh, expiresAt: Date().addingTimeInterval(expires), user: user))
    }

    func validAccessToken() async throws -> String {
        guard let current = session else { throw AuthError.notAuthenticated }
        if current.expiresAt.timeIntervalSinceNow > 60 { return current.accessToken }
        try await authenticate(path: "token?grant_type=refresh_token", body: ["refresh_token": current.refreshToken])
        guard let token = session?.accessToken else { throw AuthError.notAuthenticated }
        return token
    }

    func signOut() {
        session = nil
        try? keychain.delete(account: sessionAccount)
    }

    private func authenticate(path: String, body: [String: String]) async throws {
        let next: AuthSession = try await authRequest(path: path, body: body)
        try setSession(next)
    }

    private func setSession(_ next: AuthSession) throws {
        try keychain.save(JSONEncoder().encode(next), account: sessionAccount)
        session = next; errorMessage = nil
    }

    private func authRequest<T: Decodable>(path: String, body: [String: String]) async throws -> T {
        var request = URLRequest(url: configuration.supabaseURL.appending(path: "auth/v1/\(path)"))
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

    private func userForToken(_ token: String) async throws -> AuthUser {
        var request = URLRequest(url: configuration.supabaseURL.appending(path: "auth/v1/user"))
        request.setValue(configuration.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw AuthError.invalidResponse }
        return try JSONDecoder().decode(AuthUser.self, from: data)
    }
}

private struct SignUpResponse: Codable {
    let accessToken: String?; let refreshToken: String?; let expiresIn: Int?; let user: AuthUser?
    enum CodingKeys: String, CodingKey { case accessToken = "access_token", refreshToken = "refresh_token", expiresIn = "expires_in", user }
}

enum AuthError: LocalizedError {
    case notAuthenticated, invalidResponse, invalidCallback, server(String)
    var errorDescription: String? {
        switch self {
        case .notAuthenticated: "Please sign in again."
        case .invalidResponse: "The authentication service returned an invalid response."
        case .invalidCallback: "GitHub sign-in did not complete."
        case .server(let message): message
        }
    }
}

@MainActor
private final class WebAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
    static func start(url: URL, callbackScheme: String) async throws -> URL {
        let owner = WebAuthSession()
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { url, error in
                owner.session = nil
                if let error { continuation.resume(throwing: error) }
                else if let url { continuation.resume(returning: url) }
                else { continuation.resume(throwing: AuthError.invalidCallback) }
            }
            owner.session = session; session.presentationContextProvider = owner; session.prefersEphemeralWebBrowserSession = false
            session.start()
        }
    }
}
