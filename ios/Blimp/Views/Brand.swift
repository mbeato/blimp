// The blimp in the app (docs/superpowers/specs/2026-10-25-brand-refresh-design.md): the mark (the BlimpGlyph asset,
// ink in light mode and silver in dark; BlimpGlyphOnDark, always silver), the wordmark in the system's rounded font,
// the graphite the icon sits on, an empty inbox's flight path, and a gentle drift that stays still with Reduce Motion
// or with UIKit's animations off (the UI tests turn them off, and an endless animation would keep them waiting).
import SwiftUI
import UIKit

enum Brand {
    /// The icon's graphite, top to bottom (#2b2c33 → #0c0c0f).
    static let graphite = LinearGradient(
        colors: [Color(red: 0x2b / 255, green: 0x2c / 255, blue: 0x33 / 255), Color(red: 0x0c / 255, green: 0x0c / 255, blue: 0x0f / 255)],
        startPoint: .top, endPoint: .bottom)
}

/// "blimp" in the system's rounded font, heavy.
struct Wordmark: View {
    var size: CGFloat = 34

    var body: some View {
        Text(verbatim: "blimp").font(.system(size: size, weight: .heavy, design: .rounded))
    }
}

/// The mark, `width` points wide (it's 650 × 300). onDark: the silver one whatever the appearance.
struct BlimpMark: View {
    var width: CGFloat
    var onDark = false

    var body: some View {
        Image(onDark ? "BlimpGlyphOnDark" : "BlimpGlyph")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: width)
            .accessibilityHidden(true)
    }
}

/// An empty inbox's picture: the blimp drifting over a dashed flight path.
struct FlightPath: View {
    var body: some View {
        ZStack {
            Path { p in
                p.move(to: CGPoint(x: 0, y: 70))
                p.addQuadCurve(to: CGPoint(x: 220, y: 70), control: CGPoint(x: 110, y: -10))
            }
            .stroke(.tertiary, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [5, 6]))
            .frame(width: 220, height: 80)
            .offset(y: 24)
            BlimpMark(width: 130).drift(4, every: 4)
        }
        .frame(height: 120)
    }
}

/// Moves its content up and down by `distance` points, once every `period` seconds. Still with Reduce Motion, with
/// UIKit's animations off, or for a distance of 0.
private struct Drift: ViewModifier {
    var distance: CGFloat
    var period: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var up = false

    private var still: Bool { reduceMotion || distance == 0 || !UIView.areAnimationsEnabled }

    func body(content: Content) -> some View {
        content
            .offset(y: still ? 0 : (up ? -distance : distance))
            .animation(still ? nil : .easeInOut(duration: period / 2).repeatForever(autoreverses: true), value: up)
            .onAppear { if !still { up = true } }
    }
}

extension View {
    func drift(_ distance: CGFloat, every period: Double) -> some View {
        modifier(Drift(distance: distance, period: period))
    }
}
