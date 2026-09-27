import Foundation

struct AppConfiguration: Sendable {
    let apiURL: URL
    let supabaseURL: URL
    let supabaseAnonKey: String

    static func fromBundle(_ bundle: Bundle = .main) throws -> AppConfiguration {
        func value(_ key: String) throws -> String {
            guard let value = bundle.object(forInfoDictionaryKey: key) as? String,
                  !value.isEmpty,
                  !value.contains("$(") else {
                throw ConfigurationError.missing(key)
            }
            return value
        }
        guard let apiURL = URL(string: try value("SindralAPIURL")) else { throw ConfigurationError.invalidURL("SindralAPIURL") }
        guard let supabaseURL = URL(string: try value("SupabaseURL")) else { throw ConfigurationError.invalidURL("SupabaseURL") }
        return AppConfiguration(apiURL: apiURL, supabaseURL: supabaseURL, supabaseAnonKey: try value("SupabaseAnonKey"))
    }
}

enum ConfigurationError: LocalizedError {
    case missing(String)
    case invalidURL(String)

    var errorDescription: String? {
        switch self {
        case .missing(let key): "Set \(key) in apps/ios/Config/Debug.xcconfig."
        case .invalidURL(let key): "\(key) is not a valid URL."
        }
    }
}
