import SwiftUI
import UIKit

/// Design tokens mirrored from `apps/web/src/index.css`. The app is dark-only.
enum Theme {
    static let background = Color(hex: 0x07070F)
    static let card = Color(hex: 0x0D0D1C)
    static let muted = Color(hex: 0x0A0A18)
    static let secondary = Color(hex: 0x13132A)
    static let input = Color(hex: 0x111126)
    static let border = Color(hex: 0x1C1C30)
    static let borderStrong = Color(hex: 0x2A2A44)
    static let foreground = Color(hex: 0xDDE1EE)
    static let secondaryForeground = Color(hex: 0x8B92A8)
    static let mutedForeground = Color(hex: 0x7B849A)
    static let primary = Color(hex: 0x7C3AED)
    static let accent = Color(hex: 0x818CF8)
    static let success = Color(hex: 0x047857)
    static let warning = Color(hex: 0xF97316)
    static let dangerText = Color(hex: 0xF87171)
    static let dangerFill = Color(hex: 0xEF4444)
    static let emerald = Color(hex: 0x34D399)
    static let amber = Color(hex: 0xFBBF24)
    static let violet = Color(hex: 0xA78BFA)
    static let lavender = Color(hex: 0xC4B5FD)
    static let edge = Color(hex: 0x3A3A5C)

    enum Radius {
        static let control: CGFloat = 10
        static let row: CGFloat = 12
        static let card: CGFloat = 14
        static let auth: CGFloat = 16
    }

    /// Sans text scaled with Dynamic Type from the text style with the closest default size.
    static func font(_ size: CGFloat, _ weight: UIFont.Weight = .regular, relativeTo style: UIFont.TextStyle = .body) -> Font {
        Font(UIFont.systemFont(ofSize: UIFontMetrics(forTextStyle: style).scaledValue(for: size), weight: weight))
    }

    /// Monospaced text for keys, badges, code and meta.
    static func mono(_ size: CGFloat, _ weight: UIFont.Weight = .regular, relativeTo style: UIFont.TextStyle = .caption1) -> Font {
        Font(UIFont.monospacedSystemFont(ofSize: UIFontMetrics(forTextStyle: style).scaledValue(for: size), weight: weight))
    }

    static let pageTitle = font(30, .semibold, relativeTo: .largeTitle)
    static let paneTitle = font(24, .semibold, relativeTo: .title1)
    static let taskTitle = font(22, .semibold, relativeTo: .title2)
    static let body = font(15, relativeTo: .body)
    static let bodyMedium = font(15, .medium, relativeTo: .body)
    static let secondaryBody = font(13, relativeTo: .subheadline)
    static let sectionLabel = font(12, .semibold, relativeTo: .caption1)
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }
}

// MARK: - Status styles

/// Mirrors `getStateStyle` in `packages/shared/src/states.ts`.
struct StateStyle: Hashable {
    let label: String
    let color: Color
    let pulses: Bool

    static let known: [String: StateStyle] = [
        "todo": .init(label: "Todo", color: Color(hex: 0x8B92A8), pulses: false),
        "planning": .init(label: "Planning", color: Color(hex: 0xFBBF24), pulses: true),
        "plan-review": .init(label: "Plan Review", color: Color(hex: 0x38BDF8), pulses: false),
        "planning-feedback": .init(label: "Plan Feedback", color: Color(hex: 0xFB923C), pulses: true),
        "implement": .init(label: "Implementing", color: Color(hex: 0xA78BFA), pulses: true),
        "review-slice": .init(label: "Review Slicer", color: Color(hex: 0x818CF8), pulses: true),
        "adversarial-review": .init(label: "Adversarial Review", color: Color(hex: 0xF472B6), pulses: true),
        "verify": .init(label: "Verifying", color: Color(hex: 0x2DD4BF), pulses: true),
        "in-review": .init(label: "In Review", color: Color(hex: 0x22D3EE), pulses: false),
        "implement-feedback": .init(label: "Impl. Feedback", color: Color(hex: 0xC084FC), pulses: true),
        "conflict-resolution": .init(label: "Resolving Conflict", color: Color(hex: 0xFB923C), pulses: true),
        "merge": .init(label: "Merging", color: Color(hex: 0x34D399), pulses: true),
        "done": .init(label: "Done", color: Color(hex: 0x34D399), pulses: false),
        "wont-do": .init(label: "Won't do", color: Color(hex: 0x8B92A8), pulses: false),
        "failure": .init(label: "Failed", color: Color(hex: 0xF87171), pulses: false),
        "troubleshoot": .init(label: "Troubleshoot", color: Color(hex: 0xFB923C), pulses: true),
    ]

    static func `for`(_ state: String, step: WorkflowStep? = nil) -> StateStyle {
        if let known = known[state] { return known }
        let label = step?.label ?? state.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
        return step?.type == "agent"
            ? .init(label: label, color: Color(hex: 0xA78BFA), pulses: true)
            : .init(label: label, color: Color(hex: 0x38BDF8), pulses: false)
    }
}

/// Status badge: colored mono label with a 7pt dot on an 8% tint.
struct StatusBadge: View {
    let state: String
    var step: WorkflowStep? = nil
    var body: some View {
        let style = StateStyle.for(state, step: step)
        HStack(spacing: 7) {
            PulsingDot(color: style.color, pulses: style.pulses)
            Text(style.label).font(Theme.mono(12, .medium)).lineLimit(1)
        }
        .foregroundStyle(style.color)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(style.color.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Status: \(style.label)")
    }
}

struct PulsingDot: View {
    let color: Color
    var pulses = false
    var size: CGFloat = 7
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dimmed = false
    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
            .opacity(dimmed ? 0.35 : 1)
            .onAppear {
                guard pulses, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1).repeatForever(autoreverses: true)) { dimmed = true }
            }
            .accessibilityHidden(true)
    }
}

// MARK: - Buttons

enum ButtonVariant {
    case primary, success, danger, warning, ghost, subtle, secondary

    /// Button styling per workflow event, matching `variantForEvent` in the web app.
    static func forEvent(_ event: String) -> ButtonVariant {
        switch event {
        case "start": .primary
        case "approve", "accept", "mark-done": .success
        case "mark-wont-do": .danger
        case "troubleshoot": .warning
        case "retry": .ghost
        default: .primary
        }
    }
}

struct SindralButtonStyle: ButtonStyle {
    var variant: ButtonVariant = .primary
    var height: CGFloat = 44
    var fullWidth = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.font(14, [.subtle, .ghost, .secondary].contains(variant) ? .regular : .semibold))
            .lineLimit(1)
            .padding(.horizontal, 16)
            .frame(minHeight: height)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .foregroundStyle(foreground)
            .background(background, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
            .overlay { RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(border, lineWidth: 1) }
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.control))
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
    }

    private var foreground: Color {
        switch variant {
        case .primary, .success, .warning: .white
        case .danger: Theme.dangerText
        case .ghost: Theme.accent
        case .subtle, .secondary: Theme.secondaryForeground
        }
    }
    private var background: Color {
        switch variant {
        case .primary: Theme.primary
        case .success: Theme.success
        case .warning: Theme.warning
        case .danger: Theme.dangerFill.opacity(0.12)
        case .ghost, .secondary: Theme.secondary
        case .subtle: Theme.card
        }
    }
    private var border: Color {
        switch variant {
        case .primary, .success, .warning: .clear
        case .danger: Theme.dangerFill.opacity(0.19)
        case .ghost, .secondary: Theme.border
        case .subtle: Theme.borderStrong
        }
    }
}

extension ButtonStyle where Self == SindralButtonStyle {
    static func sindral(_ variant: ButtonVariant = .primary, height: CGFloat = 44, fullWidth: Bool = false) -> SindralButtonStyle {
        SindralButtonStyle(variant: variant, height: height, fullWidth: fullWidth)
    }
}

/// 44pt square icon button with a hairline border.
struct IconButtonStyle: ButtonStyle {
    var filled = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(filled ? Color.white : Theme.secondaryForeground)
            .frame(width: 44, height: 44)
            .background(filled ? Theme.primary : Color.clear, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
            .overlay { if !filled { RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(Theme.border) } }
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

// MARK: - Surfaces

extension View {
    /// Rounded surface with a 1pt border.
    func surface(_ fill: Color = Theme.card, radius: CGFloat = Theme.Radius.row, border: Color = Theme.border, dashed: Bool = false) -> some View {
        background(fill, in: RoundedRectangle(cornerRadius: radius))
            .overlay {
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(border, style: StrokeStyle(lineWidth: 1, dash: dashed ? [4, 3] : []))
            }
    }

    /// Dark text field chrome: `input` fill, radius 10, hairline border.
    func fieldChrome(height: CGFloat? = 44, focused: Bool = false) -> some View {
        padding(.horizontal, 14)
            .frame(minHeight: height)
            .background(Theme.input, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
            .overlay { RoundedRectangle(cornerRadius: Theme.Radius.control).strokeBorder(focused ? Theme.accent.opacity(0.4) : Theme.border) }
    }

    func hairline(_ edge: Edge) -> some View {
        overlay(alignment: edge.alignment) {
            Rectangle().fill(Theme.border).frame(width: edge.isHorizontal ? 1 : nil, height: edge.isHorizontal ? nil : 1)
        }
    }

    /// Dark background for system lists and forms.
    func themedList() -> some View {
        scrollContentBackground(.hidden).background(Theme.background)
    }
}

private extension Edge {
    var isHorizontal: Bool { self == .leading || self == .trailing }
    var alignment: Alignment {
        switch self { case .top: .top; case .bottom: .bottom; case .leading: .leading; case .trailing: .trailing }
    }
}

struct SectionLabel: View {
    let text: String
    var size: CGFloat = 12
    var body: some View {
        Text(text.uppercased())
            .font(Theme.font(size, .semibold, relativeTo: .caption1))
            .tracking(size * 0.08)
            .foregroundStyle(Theme.mutedForeground)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Small mono chip (`PR open`, `linked`).
struct MetaChip: View {
    let text: String
    var color: Color = Theme.secondaryForeground
    var body: some View {
        Text(text).font(Theme.mono(11)).foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 5))
    }
}

// MARK: - Logo

/// The "A" glyph from `Logo` in `apps/web/src/components/Layout.tsx` (12×12 viewBox).
struct LogoGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 12
        let o = CGPoint(x: rect.midX - 6 * s, y: rect.midY - 6 * s)
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: o.x + x * s, y: o.y + y * s) }
        var path = Path()
        path.move(to: p(2, 10)); path.addLine(to: p(6, 2)); path.addLine(to: p(10, 10))
        path.move(to: p(3.5, 7.5)); path.addLine(to: p(8.5, 7.5))
        return path
    }
}

struct LogoTile: View {
    var size: CGFloat = 30
    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.27)
            .fill(Theme.primary)
            .frame(width: size, height: size)
            .overlay {
                LogoGlyph().stroke(.white, style: StrokeStyle(lineWidth: 1.5 * size / 24 * 1.2, lineCap: .round, lineJoin: .round))
                    .frame(width: size * 0.55, height: size * 0.55)
            }
            .shadow(color: Theme.primary.opacity(0.25), radius: 9, y: 6)
            .accessibilityHidden(true)
    }
}
