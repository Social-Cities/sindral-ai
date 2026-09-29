import SwiftUI

/// Sign in / Create account. GitHub login was removed from iOS on purpose (commit e064cdd), so the
/// GitHub is connected after sign-in for repository access, so authentication stays email/password only.
struct AuthView: View {
    @Environment(SessionStore.self) private var session
    @State private var mode = Mode.signIn
    @State private var email = ""
    @State private var password = ""
    @State private var isBusy = false
    @State private var message: String?
    @State private var confirmationSent = false
    @FocusState private var focused: Field?

    private enum Mode: String, CaseIterable { case signIn = "Sign in", create = "Create account" }
    private enum Field { case email, password }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                HStack(spacing: 14) {
                    LogoTile(size: 36)
                    Text("Sindral AI").font(Theme.font(22, .semibold, relativeTo: .title2)).foregroundStyle(Theme.foreground)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)

                VStack(spacing: 0) {
                    tabStrip
                    VStack(alignment: .leading, spacing: 18) {
                        field("Email", focus: .email) {
                            TextField("", text: $email, prompt: Text(verbatim: "you@company.com").foregroundStyle(Theme.mutedForeground))
                                .textContentType(.emailAddress).keyboardType(.emailAddress)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .submitLabel(.next).onSubmit { focused = .password }
                        }
                        field("Password", focus: .password) {
                            SecureField("", text: $password, prompt: Text(verbatim: "••••••••").foregroundStyle(Theme.mutedForeground))
                                .textContentType(mode == .signIn ? .password : .newPassword)
                                .submitLabel(.go).onSubmit { Task { await submit() } }
                        }
                        if let message {
                            Text(message).font(Theme.font(14)).foregroundStyle(Theme.dangerText).fixedSize(horizontal: false, vertical: true)
                        } else if mode == .create {
                            Text(confirmationSent ? "Check your inbox to confirm your email, then sign in." : "After you create the account, check your inbox to confirm your email, then sign in.")
                                .font(Theme.font(14)).foregroundStyle(Theme.emerald).fixedSize(horizontal: false, vertical: true)
                        }
                        Button { Task { await submit() } } label: {
                            ZStack {
                                Text(mode.rawValue).opacity(isBusy ? 0 : 1)
                                if isBusy { ProgressView().tint(.white) }
                            }
                        }
                        .buttonStyle(.sindral(.primary, height: 48, fullWidth: true))
                        .disabled(isBusy || email.isEmpty || password.count < 6)
                        .keyboardShortcut(.return, modifiers: .command)
                    }
                    .padding(24)
                }
                .surface(Theme.card, radius: Theme.Radius.auth)

                Text("Tasks move from todo to PR via AI agents running on your own machine.")
                    .font(Theme.font(13)).foregroundStyle(Theme.mutedForeground)
                    .multilineTextAlignment(.center).padding(.horizontal, 12)
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, 16)
            .padding(.vertical, 60)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .defaultScrollAnchor(.center)
        .background(Theme.background.ignoresSafeArea())
    }

    private var tabStrip: some View {
        HStack(spacing: 0) {
            ForEach(Mode.allCases, id: \.self) { item in
                let selected = mode == item
                Button { mode = item; message = nil } label: {
                    Text(item.rawValue)
                        .font(Theme.font(15, selected ? .medium : .regular))
                        .foregroundStyle(selected ? Theme.foreground : Theme.mutedForeground)
                        .frame(maxWidth: .infinity).frame(height: 52)
                        .overlay(alignment: .bottom) { if selected { Rectangle().fill(Theme.accent).frame(height: 2) } }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
            }
        }
        .hairline(.bottom)
    }

    private func field<Content: View>(_ label: String, focus: Field, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(Theme.font(13, .medium)).foregroundStyle(Theme.secondaryForeground)
            content()
                .font(Theme.font(16))
                .foregroundStyle(Theme.foreground)
                .focused($focused, equals: focus)
                .fieldChrome(height: 48, focused: focused == focus)
                .accessibilityLabel(label)
        }
    }

    private func submit() async {
        guard !isBusy, !email.isEmpty, password.count >= 6 else { return }
        isBusy = true; message = nil; defer { isBusy = false }
        do {
            if mode == .signIn { try await session.signIn(email: email, password: password) }
            else if try await session.signUp(email: email, password: password) { confirmationSent = true }
        } catch { message = error.localizedDescription }
    }
}
