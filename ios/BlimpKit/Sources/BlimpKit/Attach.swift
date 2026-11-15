// Photos and videos sent from the chat (docs/superpowers/specs/2026-11-15-phone-attach-design.md): the limits, the
// size a photo is scaled to, the name its upload gets, and how long a message with files may take to be typed. The
// app does the picking, the scaling and the upload (Attachments.swift); blimpd saves the file and types its path
// with the message (uploads.ts, chatsocket.ts).
import Foundation

public enum Attach {
    /// On one message, as blimpd allows (uploads.ts MAX_FILES).
    public static let maxFiles = 10
    /// A photo's long side, in pixels: Claude scales pictures down further anyway.
    public static let maxPhotoSide = 2048
    /// A video, once it's made smaller (720p).
    public static let maxVideoBytes = 500 * 1024 * 1024

    public enum Kind: String, Sendable, Equatable { case photo, video }

    /// A photo's size in pixels once its long side is at most `maxSide`: never larger than it was, never under 1.
    public static func photoSize(width: Int, height: Int, maxSide: Int = maxPhotoSide) -> (width: Int, height: Int) {
        let long = max(width, height)
        guard long > maxSide else { return (max(1, width), max(1, height)) }
        let scale = Double(maxSide) / Double(long)
        return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
    }

    /// "Photo-2026-11-15-at-22.41.07.jpg" or "Video-….mp4": one plain word, so blimpd keeps it as it is
    /// (uploads.ts plainName).
    public static func name(_ kind: Kind, at date: Date, in zone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let two = { (n: Int?) in (n ?? 0) < 10 ? "0\(n ?? 0)" : "\(n ?? 0)" }
        let day = "\(c.year ?? 0)-\(two(c.month))-\(two(c.day))"
        let time = "\(two(c.hour)).\(two(c.minute)).\(two(c.second))"
        return "\(kind == .photo ? "Photo" : "Video")-\(day)-at-\(time).\(kind == .photo ? "jpg" : "mp4")"
    }

    /// How long to wait for blimpd to say a message was typed: 10 s, and 3 s more for each file (blimpd waits
    /// for Claude Code to attach each picture before it types the next part).
    public static func patience(files: Int) -> Double { 10 + 3 * Double(max(0, files)) }
}
