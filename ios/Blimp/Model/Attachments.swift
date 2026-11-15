// The photos and videos picked for a chat's next message (docs/superpowers/specs/2026-11-15-phone-attach-design.md).
// Each is made ready as soon as it's picked: a photo becomes a JPEG at most 2048 px on its long side (Claude can't
// read an iPhone's HEIC), a video an MP4 at 720p of at most 500 MB, and the file is uploaded to blimpd (POST
// /uploads), which saves it in ~/.blimp/uploads. Send then gives the saved paths with the message (ChatModel.send);
// blimpd types each path into the session, and Claude Code attaches the pictures. One per chat, on its ChatModel,
// so what's picked is still there after leaving the chat and coming back.
import AVFoundation
import BlimpKit
import CoreTransferable
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

@Observable @MainActor
final class Attachments {
    enum State: Equatable {
        case working
        /// Uploaded: its path on the server.
        case ready(String)
        /// Words for the person, under the row.
        case failed(String)
    }

    struct Item: Identifiable {
        let id = UUID()
        var thumbnail: UIImage?
        var video = false
        var state = State.working
    }

    /// Where a file comes from, kept so a failed one can be tried again.
    enum Source: Sendable {
        case picked(PhotosPickerItem)
        case photo(UIImage)
        case video(URL)
    }

    private(set) var items: [Item] = []
    @ObservationIgnored private var sources: [UUID: Source] = [:]
    @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private let api: @MainActor () -> API?

    init(api: @escaping @MainActor () -> API?) { self.api = api }

    var isEmpty: Bool { items.isEmpty }
    /// How many more this message takes.
    var room: Int { max(0, Attach.maxFiles - items.count) }
    /// The first failed file's words, if any failed.
    var failure: String? {
        for item in items { if case .failed(let words) = item.state { return words } }
        return nil
    }

    func add(_ picked: [PhotosPickerItem]) { for p in picked.prefix(room) { add(.picked(p)) } }

    func add(_ source: Source) {
        guard room > 0 else { return }
        var item = Item()
        if case .photo(let image) = source { item.thumbnail = image.preparingThumbnail(of: Self.thumbSize(image.size)) }
        if case .video = source { item.video = true }
        items.append(item)
        sources[item.id] = source
        start(item.id, source)
    }

    func remove(_ id: UUID) {
        tasks.removeValue(forKey: id)?.cancel()
        sources[id] = nil
        items.removeAll { $0.id == id }
    }

    func retry(_ id: UUID) {
        guard let source = sources[id], let i = items.firstIndex(where: { $0.id == id }), case .failed = items[i].state else { return }
        items[i].state = .working
        start(id, source)
    }

    /// The files' paths on the server, in the row's order, once every upload has ended; nil if one failed (it
    /// stays in the row, marked, to try again or remove).
    func paths() async -> [String]? {
        for task in Array(tasks.values) { await task.value }
        var paths: [String] = []
        for item in items {
            guard case .ready(let path) = item.state else { return nil }
            paths.append(path)
        }
        return paths
    }

    /// blimpd has the message: the files sent with it leave the row.
    func sent(_ paths: [String]) {
        for item in items {
            if case .ready(let path) = item.state, paths.contains(path) { remove(item.id) }
        }
    }

    private func start(_ id: UUID, _ source: Source) {
        tasks[id] = Task { [weak self] in
            do {
                let made = try await Self.prepare(source)
                defer { try? FileManager.default.removeItem(at: made.file) }
                self?.change(id) {
                    $0.thumbnail = made.thumbnail ?? $0.thumbnail
                    $0.video = made.kind == .video
                }
                try Task.checkCancellation()
                guard let api = self?.api() else { throw APIError.offline }
                // The UI tests' picture has a name of its own, so their uploads can be told apart and removed (stop.sh).
                let name = Self.demo ? "blimp-e2e-photo.jpg" : Attach.name(made.kind, at: .now)
                let path = try await api.upload(file: made.file, name: name)
                self?.change(id) { $0.state = .ready(path) }
            } catch is CancellationError {
            } catch {
                self?.change(id) { $0.state = .failed(Self.words(for: error)) }
            }
        }
    }

    private func change(_ id: UUID, _ edit: (inout Item) -> Void) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        edit(&items[i])
    }

    private static func words(for error: Error) -> String {
        switch error {
        case let e as AttachError: e.words
        // A blimpd from before uploads has no such route.
        case APIError.server("not found"): "Update blimpd on the server to send photos and videos."
        case APIError.server(let reason): "Not uploaded: \(reason)"
        case APIError.offline: "Not uploaded: the server can't be reached."
        default: "Not uploaded. Tap it to try again."
        }
    }

    // MARK: - Making a file ready (off the main actor)

    struct Made: @unchecked Sendable {
        let file: URL
        let kind: Attach.Kind
        let thumbnail: UIImage?
    }

    enum AttachError: Error {
        case unreadable, tooBig, videoFailed

        var words: String {
            switch self {
            case .unreadable: "That file couldn't be read."
            case .tooBig: "That video is over 500 MB even at 720p. Trim it in Photos first."
            case .videoFailed: "That video couldn't be made smaller."
            }
        }
    }

    private nonisolated static func prepare(_ source: Source) async throws -> Made {
        switch source {
        case .photo(let image): return try photo(image)
        case .video(let url): return try await video(url)
        case .picked(let item):
            if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
                guard let movie = try await item.loadTransferable(type: PickedMovie.self) else { throw AttachError.unreadable }
                defer { try? FileManager.default.removeItem(at: movie.url) }
                return try await video(movie.url)
            }
            guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { throw AttachError.unreadable }
            return try photo(image)
        }
    }

    private nonisolated static func temp(_ ending: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("blimp-attach-\(UUID().uuidString).\(ending)")
    }

    private nonisolated static func thumbSize(_ size: CGSize) -> CGSize {
        let scale = min(1, 240 / max(size.width, size.height, 1))
        return CGSize(width: max(1, size.width * scale), height: max(1, size.height * scale))
    }

    /// Drawn again at its new size, the right way up, as a JPEG.
    private nonisolated static func photo(_ image: UIImage) throws -> Made {
        let pixels = (width: Int((image.size.width * image.scale).rounded()), height: Int((image.size.height * image.scale).rounded()))
        let size = Attach.photoSize(width: pixels.width, height: pixels.height)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let target = CGSize(width: size.width, height: size.height)
        let data = UIGraphicsImageRenderer(size: target, format: format).jpegData(withCompressionQuality: 0.8) { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        let file = temp("jpg")
        try data.write(to: file)
        return Made(file: file, kind: .photo, thumbnail: image.preparingThumbnail(of: thumbSize(image.size)))
    }

    /// Made smaller, to 720p in an MP4, which any tool on the server reads.
    private nonisolated static func video(_ url: URL) async throws -> Made {
        let asset = AVURLAsset(url: url)
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1280x720) else { throw AttachError.videoFailed }
        let file = temp("mp4")
        do {
            try await export.export(to: file, as: .mp4)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw AttachError.videoFailed
        }
        let bytes = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard bytes <= Attach.maxVideoBytes else {
            try? FileManager.default.removeItem(at: file)
            throw AttachError.tooBig
        }
        let frames = AVAssetImageGenerator(asset: asset)
        frames.appliesPreferredTrackTransform = true
        frames.maximumSize = CGSize(width: 240, height: 240)
        let first = try? await frames.image(at: .zero).image
        return Made(file: file, kind: .video, thumbnail: first.map { UIImage(cgImage: $0) })
    }

    // MARK: - The UI tests' picture

    /// The UI tests launch with -attachDemo YES: the system's photo picker can't be driven, so + adds this picture
    /// instead (larger than a photo is sent at, so it is scaled like one).
    static var demo: Bool { UserDefaults.standard.bool(forKey: "attachDemo") }

    static func demoPhoto() -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 2000), format: format).image { context in
            UIColor.systemRed.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 3000, height: 2000))
        }
    }
}

/// A video from the photo picker: the picker's file is only there while it's handed over, so it is copied.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let ending = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("blimp-picked-\(UUID().uuidString).\(ending)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}
