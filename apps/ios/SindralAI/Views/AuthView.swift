import SwiftUI

struct AuthView: View {
    @Environment(SessionStore.self) private var session
    @State private var mode = 0
    @State private var email = ""
    @State private var password = ""
    @State private var isBusy = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Mode", selection: $mode) { Text("Sign in").tag(0); Text("Create account").tag(1) }.pickerStyle(.segmented)
                    TextField("Email", text: $email).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                    SecureField("Password", text: $password).textContentType(mode == 0 ? .password : .newPassword)
                    if let message { Text(message).font(.footnote).foregroundStyle(message.hasPrefix("Check") ? .green : .red) }
                    Button(mode == 0 ? "Sign in" : "Create account") { Task { await submit() } }
                        .disabled(isBusy || email.isEmpty || password.count < 6)
                    Button("Continue with GitHub") { Task { await github() } }.disabled(isBusy)
                } footer: { Text("Agents run on your own connected worker. Credentials stay in the iOS Keychain.") }
            }
            .navigationTitle("Sindral AI")
            .overlay { if isBusy { ProgressView().controlSize(.large) } }
        }
    }

    private func submit() async {
        isBusy = true; message = nil; defer { isBusy = false }
        do {
            if mode == 0 { try await session.signIn(email: email, password: password) }
            else if try await session.signUp(email: email, password: password) { message = "Check your inbox to confirm your email, then sign in." }
        } catch { message = error.localizedDescription }
    }
    private func github() async { isBusy = true; message = nil; defer { isBusy = false }; do { try await session.signInWithGitHub() } catch { message = error.localizedDescription } }
}
