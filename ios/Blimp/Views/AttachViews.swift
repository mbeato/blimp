// Photos and videos in a chat (docs/superpowers/specs/2026-11-15-phone-attach-design.md): the row of what's picked
// for the next message, above the box (AttachRow); the camera (CameraPicker); and a file you sent, on your side of
// the chat (SentFile): a picture as a small picture that opens full screen, anything else as a row with its name.
import BlimpKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// What's picked for the next message: each as a small picture, with a spinner while it's made ready and uploaded,
/// a retry mark if that failed (and why, under the row), and × to take it off.
struct AttachRow: View {
    let attachments: Attachments

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(attachments.items) { tile($0) }
                }
                .padding(.top, 6)
                .padding(.trailing, 6)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            // A swipe on the row scrolls it and doesn't pull the drawer.
            .scrollsSideways()
            if let failure = attachments.failure {
                Text(failure).font(.caption).foregroundStyle(.red).accessibilityIdentifier("attachFailure")
            }
        }
    }

    private func tile(_ item: Attachments.Item) -> some View {
        ZStack {
            if let thumbnail = item.thumbnail {
                Image(uiImage: thumbnail).resizable().scaledToFill()
            } else {
                Image(systemName: item.video ? "film" : "photo").foregroundStyle(.secondary)
            }
            switch item.state {
            case .working:
                Color.black.opacity(0.35)
                ProgressView().tint(.white)
            case .failed:
                Color.black.opacity(0.35)
                Button { attachments.retry(item.id) } label: {
                    Image(systemName: "arrow.clockwise").font(.body.weight(.semibold)).foregroundStyle(.white).frame(width: 64, height: 64)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Try again")
            case .ready:
                if item.video {
                    Image(systemName: "play.fill").font(.footnote).foregroundStyle(.white).shadow(radius: 2)
                }
            }
        }
        .frame(width: 64, height: 64)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .topTrailing) {
            Button { attachments.remove(item.id) } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.7))
            }
            .buttonStyle(.plain)
            .offset(x: 6, y: -6)
            .accessibilityLabel("Remove")
            .accessibilityIdentifier("attachRemove")
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(item.video ? "Video" : "Photo")
        .accessibilityValue(Self.value(item.state))
        .accessibilityIdentifier("attachTile")
    }

    private static func value(_ state: Attachments.State) -> String {
        switch state {
        case .working: "Uploading"
        case .ready: "Ready"
        case .failed: "Not uploaded"
        }
    }
}

/// The camera, for a photo or a video: hands over what was taken, or nil for Cancel.
struct CameraPicker: UIViewControllerRepresentable {
    let onDone: (Attachments.Source?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        picker.videoQuality = .typeHigh
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onDone: (Attachments.Source?) -> Void

        init(onDone: @escaping (Attachments.Source?) -> Void) { self.onDone = onDone }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let movie = info[.mediaURL] as? URL {
                onDone(.video(movie))
            } else if let image = info[.originalImage] as? UIImage {
                onDone(.photo(image))
            } else {
                onDone(nil)
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onDone(nil) }
    }
}

/// A photo or a video you sent (a `file` message: blimpd found it in ~/.blimp/uploads), on your side of the chat.
/// A picture Claude Code attached shows as a small picture, loaded from blimpd when it comes on screen; a tap shows
/// it full screen. Anything else (a video) is a row with its name. Once blimpd no longer keeps it (30 days): greyed.
struct SentFile: View {
    let message: ChatMessage
    @Environment(Store.self) private var store
    @State private var picture: UIImage?
    @State private var failed = false
    @State private var open = false

    private var gone: Bool { message.gone == true }
    private var isPicture: Bool { message.image == true && !gone && !failed }

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            if isPicture {
                Group {
                    if let picture {
                        Image(uiImage: picture).resizable().scaledToFit()
                    } else {
                        ProgressView().frame(width: 120, height: 90).background(.quaternary)
                    }
                }
                .frame(maxWidth: 220, maxHeight: 220, alignment: .trailing)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .contentShape(RoundedRectangle(cornerRadius: 14))
                .onTapGesture { if picture != nil { open = true } }
                .accessibilityLabel("Photo you sent, \(message.name ?? "")")
                .accessibilityAddTraits(.isImage)
                .accessibilityIdentifier("message.file")
                .task(id: message.file) { await load() }
                .fullScreenCover(isPresented: $open) {
                    if let picture { PictureView(picture: picture) { open = false } }
                }
            } else {
                label.accessibilityIdentifier("message.file")
            }
        }
    }

    private var label: some View {
        HStack(spacing: 8) {
            Image(systemName: Self.symbol(for: message.name ?? ""))
            VStack(alignment: .leading, spacing: 1) {
                Text(message.name ?? "File").font(.subheadline.weight(.medium)).lineLimit(1).truncationMode(.middle)
                if gone { Text("No longer kept").font(.caption) }
            }
        }
        .foregroundStyle(Color(.systemBackground))
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Color.primary, in: RoundedRectangle(cornerRadius: 18))
        .opacity(gone ? 0.5 : 1)
        .accessibilityElement(children: .combine)
    }

    private static func symbol(for name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "mp4", "mov", "m4v": "film"
        case "jpg", "jpeg", "png", "gif", "webp", "heic": "photo"
        default: "doc"
        }
    }

    private func load() async {
        guard let path = message.file, picture == nil else { return }
        if let kept = SentPictures.cache.object(forKey: path as NSString) {
            picture = kept
            return
        }
        guard let api = store.api, let data = try? await api.file(path: path), let image = UIImage(data: data) else {
            if !Task.isCancelled { failed = true }
            return
        }
        // Small enough for a chat row: the full picture is asked for again only if this one is dropped.
        let shown = await image.byPreparingThumbnail(ofSize: CGSize(width: 1200, height: 1200 * image.size.height / max(image.size.width, 1))) ?? image
        SentPictures.cache.setObject(shown, forKey: path as NSString)
        picture = shown
    }
}

/// The pictures already loaded for the chat, by their path on the server, while the app runs.
@MainActor
enum SentPictures {
    static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 40
        return cache
    }()
}

/// A picture full screen, on black: pinch to zoom, × to go back.
struct PictureView: View {
    let picture: UIImage
    let onClose: () -> Void
    @State private var zoom: CGFloat = 1

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()
            Image(uiImage: picture)
                .resizable()
                .scaledToFit()
                .scaleEffect(zoom)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .gesture(MagnifyGesture().onChanged { zoom = min(max($0.magnification, 1), 5) }.onEnded { _ in withAnimation { zoom = 1 } })
                .accessibilityIdentifier("pictureFull")
            Button(action: onClose) {
                Image(systemName: "xmark").font(.title3).foregroundStyle(.white).frame(width: 44, height: 44)
            }
            .padding(.horizontal, 8)
            .accessibilityLabel("Close")
            .accessibilityIdentifier("pictureClose")
        }
    }
}
