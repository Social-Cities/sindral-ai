import AuthenticationServices
import UIKit

enum GitHubOAuthCallbackResult: Equatable {
    case connected
    case failed(reason: String)

    init?(url: URL) {
        guard url.scheme == "sindral", url.host == "github", url.path == "/callback",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let status = components.queryItems?.first(where: { $0.name == "github" })?.value else { return nil }
        if status == "connected" {
            self = .connected
        } else if status == "error" {
            let reason = components.queryItems?.first(where: { $0.name == "github_error" })?.value ?? "exchange"
            self = .failed(reason: reason)
        } else {
            return nil
        }
    }

    var message: String {
        switch self {
        case .connected:
            "GitHub account connected."
        case .failed(let reason):
            switch reason {
            case "credentials": "GitHub rejected the OAuth client credentials. Check the server configuration."
            case "callback": "The GitHub callback URL does not match the OAuth App configuration."
            case "code": "The GitHub authorization code expired or was already used. Try connecting again."
            case "scope": "Repository access was not granted. Reconnect and approve repository access."
            case "state": "The GitHub authorization session expired. Try connecting again."
            case "account": "GitHub could not validate the selected account."
            case "storage": "GitHub authorized successfully, but Sindral could not save the credential."
            case "denied": "GitHub authorization was cancelled or denied."
            case "missing": "GitHub returned an incomplete authorization response. Try connecting again."
            default: "GitHub authorization could not be completed. Try connecting again."
            }
        }
    }

    var isSuccess: Bool { self == .connected }
}

enum GitHubOAuthSessionError: LocalizedError {
    case cancelled, unableToStart, missingCallback

    var errorDescription: String? {
        switch self {
        case .cancelled: "GitHub authorization was cancelled."
        case .unableToStart: "GitHub authorization could not be opened."
        case .missingCallback: "GitHub did not return a valid authorization response."
        }
    }
}

@MainActor
final class GitHubOAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authenticate(at url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "sindral") { [weak self] callbackURL, error in
                Task { @MainActor in
                    self?.session = nil
                    if let callbackURL {
                        continuation.resume(returning: callbackURL)
                    } else if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                        continuation.resume(throwing: GitHubOAuthSessionError.cancelled)
                    } else if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(throwing: GitHubOAuthSessionError.missingCallback)
                    }
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            guard session.start() else {
                self.session = nil
                continuation.resume(throwing: GitHubOAuthSessionError.unableToStart)
                return
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
    }
}
