// What a notification from blimpd carries for the app (blimpd's src/push/payload.ts): its session, whether it's an
// ask or a finish, and for a permission with buttons the wait's `at` with the pick and label Yes and No answer with.
// The phone's device token goes to blimpd as hex (POST /push/device).
import Foundation

public struct PushNote: Equatable, Sendable {
    public enum Kind: String, Sendable {
        case ask, finish
    }

    public struct Choice: Equatable, Sendable {
        public let pick: Int
        public let label: String

        public init(pick: Int, label: String) {
            self.pick = pick
            self.label = label
        }
    }

    public let session: String
    public let kind: Kind
    /// A permission's wait and its Yes and No, all three or none: blimpd sends none for a question, a plan or a
    /// risky command.
    public let at: Double?
    public let yes: Choice?
    public let no: Choice?

    /// From a notification's userInfo; nil if it isn't one of blimpd's.
    public init?(_ info: [AnyHashable: Any]) {
        guard let session = info["session"] as? String, !session.isEmpty,
              let kind = (info["kind"] as? String).flatMap(Kind.init(rawValue:)) else { return nil }
        self.session = session
        self.kind = kind
        if let at = Self.number(info["at"]), let yes = Self.choice(info["yes"]), let no = Self.choice(info["no"]) {
            self.at = at
            self.yes = yes
            self.no = no
        } else {
            at = nil
            yes = nil
            no = nil
        }
    }

    private static func number(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        return nil
    }

    private static func choice(_ v: Any?) -> Choice? {
        guard let d = v as? [AnyHashable: Any], let pick = number(d["pick"]), pick >= 0, pick == pick.rounded(),
              let label = d["label"] as? String else { return nil }
        return Choice(pick: Int(pick), label: label)
    }
}

public enum DeviceToken {
    /// The token as blimpd takes it: lowercase hex, two digits a byte.
    public static func hex(_ data: Data) -> String {
        let digits = Array("0123456789abcdef")
        return String(data.flatMap { [digits[Int($0 >> 4)], digits[Int($0 & 0x0f)]] })
    }
}
