// A session as a chat: the messages, what Claude is waiting on as buttons, and a box to type into.
// Voice: the mic types (or answers the prompt), the speaker toggle reads new replies and prompts aloud,
// and a banner says when another session starts waiting or finishes.
// A swipe sideways goes to the next or previous session in the same project, in Home's order.
import AudioToolbox
import BlimpKit
import SwiftUI

struct SessionView: View {
    let name: String
    @Environment(Store.self) private var store
    /// The session on screen: a swipe or Resume changes it.
    @State private var shown: String
    /// What the pages scroll to; it can be nil for a moment during a swipe, `shown` never is.
    @State private var position: String?
    @State private var pages: [String] = []
    /// The project folder, once the store has listed the session: the pages are that folder's sessions.
    @State private var dir: String?
    /// Each page's chat. Its socket is open while the page is laid out (on screen, or next to it during a swipe).
    @State private var models: [String: ChatModel] = [:]

    init(name: String) {
        self.name = name
        _shown = State(initialValue: name)
        _position = State(initialValue: name)
    }

    var body: some View {
        // The pages come with the first refresh: a scroll view made empty wouldn't start at this session's.
        Group { if !pages.isEmpty { scroller } }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .onChange(of: store.home, initial: true) { refresh() }
            .onChange(of: position) { _, page in
                guard let page, page != shown else { return }
                shown = page
                refresh()
            }
    }

    private var scroller: some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                ForEach(pages, id: \.self) { page in
                    Group {
                        if let model = models[page] {
                            ChatContent(model: model, active: page == shown, onResumed: resumed)
                                .onAppear { model.open() }
                                .onDisappear { model.close() }
                        }
                    }
                    .containerRelativeFrame([.horizontal, .vertical])
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $position)
        .scrollIndicators(.hidden)
        // one page: no sideways bounce
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        // A long name (blimpd's go up to 40 characters) gets a little smaller to fit, rather than cut off.
        ToolbarItem(placement: .principal) {
            VStack(spacing: 0) {
                Text(title).font(.headline).lineLimit(1).minimumScaleFactor(0.75)
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        if let model = models[shown] {
            ToolbarItem(placement: .topBarTrailing) {
                Button(model.readAloud ? "Stop reading aloud" : "Read aloud",
                       systemImage: model.readAloud ? "speaker.wave.2" : "speaker.slash") {
                    model.readAloud.toggle()
                    if !model.readAloud { Speaker.shared.stop() }
                }
            }
        }
    }

    private var title: String { models[shown]?.title ?? shown }

    /// The folder, and where this session is among its project's when there's more than one ("2 of 3").
    private var subtitle: String {
        let folder = models[shown]?.folder ?? ""
        guard pages.count > 1, let i = pages.firstIndex(of: shown) else { return folder }
        return folder.isEmpty ? "\(i + 1) of \(pages.count)" : "\(folder) · \(i + 1) of \(pages.count)"
    }

    /// The new session takes the ended one's place on screen.
    private func resumed(_ name: String) {
        shown = name
        refresh()
        position = name
    }

    private func refresh() {
        if let s = store.sessions.first(where: { $0.name == shown }) { dir = s.dir }
        pages = store.home.pages(dir: dir, current: shown, previous: pages)
        for page in pages where models[page] == nil { models[page] = ChatModel(name: page, store: store) }
        for page in Array(models.keys) where !pages.contains(page) {
            models[page]?.close()
            models[page] = nil
        }
    }
}

private struct ChatContent: View {
    let model: ChatModel
    /// This page is the one on screen: only it reads aloud, listens, and shows banners.
    let active: Bool
    let onResumed: (String) -> Void
    @Environment(Store.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var atBottom = true
    @State private var unseen = false
    @State private var resuming = false
    // Voice
    @State private var listener = Listener()
    @State private var micOn = false
    /// The last press's stop() is still finishing: a new press waits for it, so nothing is sent twice.
    @State private var micStopping = false
    /// Bumped by each press, so a late failure of an earlier one changes nothing.
    @State private var micRound = 0
    /// Prompts already showing or read: one is read aloud only when it's new (or its choices changed).
    @State private var promptsSeen: [Prompt] = []
    /// What was in the box when the mic started; the words heard go after it.
    @State private var micBase = ""
    /// The answerable prompt showing when the mic started: the words answer it instead of being sent.
    @State private var micPrompt: Prompt?
    @State private var guess: Guess?
    @State private var voiceNote: String?
    @State private var lastStates: [String: SessionState] = [:]
    @State private var banner: Banner?
    @State private var onScreen = false

    private static let bottom = "bottom"
    /// The screen's height (less the keyboard), so Claude's questions can take most of it.
    @State private var screenHeight: CGFloat = 0

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(model.log.shown) { message in
                        MessageRow(message: message)
                            .modifier(BeingRead(reading: Speaker.shared.speakingId == message.id))
                    }
                    workingRow
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .padding(.horizontal)
                .padding(.top, 12)
            }
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            // The keyboard goes as Messages' does: drag the chat down, or tap it (taps on tool lines and
            // links still work).
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(TapGesture().onEnded { hideKeyboard() })
            .onScrollGeometryChange(for: Bool.self) { g in
                g.visibleRect.maxY >= g.contentSize.height - 40
            } action: { _, bottom in
                atBottom = bottom
                if bottom { unseen = false }
            }
            // A history comes after the screen has laid out, empty, so the initial anchor misses it, and
            // the jump in content height reads as "scrolled up". Open at the end; after a reconnect, stay
            // at the end only if you were there.
            .onChange(of: model.histories) { old, _ in
                guard old == 0 || atBottom else { return }
                atBottom = true
                unseen = false
                Task { @MainActor in proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
            // a new or longer last message: follow it if you're at the bottom, else say so
            .onChange(of: model.log.shown.last) { _, last in
                guard last != nil else { return }
                if atBottom { proxy.scrollTo(Self.bottom, anchor: .bottom) } else { unseen = true }
            }
            .onChange(of: showsWorking) {
                if atBottom { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
            .overlay { empty }
            .safeAreaInset(edge: .top, spacing: 0) {
                if model.reconnecting && !model.ended { ReconnectingBar() }
            }
            .overlay(alignment: .top) {
                if let banner { BannerView(banner: banner).transition(.move(edge: .top).combined(with: .opacity)) }
            }
            .animation(.snappy, value: banner)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 8) {
                    if unseen {
                        Button {
                            withAnimation { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                            unseen = false
                        } label: {
                            Label("New", systemImage: "arrow.down").font(.footnote.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .background(.regularMaterial, in: Capsule())
                    }
                    controls
                        .padding(.horizontal)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity)
                        .background(.bar)
                }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { screenHeight = $0 }
        .onReturnFromBackground { model.reconnectNow() }
        .onAppear { if active { appeared() } }
        .onDisappear { if onScreen { disappeared() } }
        .onChange(of: active) { _, on in
            if on { appeared() } else if onScreen { disappeared() }
        }
        .onChange(of: listener.partial) { _, heard in
            if micOn { draft = Self.joined(micBase, heard) }
        }
        // A new prompt, or new choices for the same one: drop the old guess and note, and read it aloud
        // when that's on.
        .onChange(of: model.prompt) { _, prompt in
            guess = nil
            voiceNote = nil
            guard let prompt, !promptsSeen.contains(prompt) else { return }
            promptsSeen.append(prompt)
            if onScreen, model.readAloud { Speaker.shared.say(prompt.spoken, id: Self.promptId) }
        }
        .onChange(of: store.sessions) { _, sessions in noticeOthers(sessions) }
        // Leaving the app or locking the phone stops the mic; the words stay in the box, unsent. Not on
        // .inactive: the first-use permission alert makes the app inactive while it waits for an answer.
        .onChange(of: scenePhase) { _, phase in
            if phase == .background, micOn { micUp(.keep) }
        }
        .task(id: banner) {
            guard banner != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { banner = nil }
        }
        // Links in Claude's replies: http and https open in Safari on tap, anything else does nothing.
        .environment(\.openURL, OpenURLAction { Inline.safe($0) ? .systemAction : .discarded })
    }

    /// What sits under the chat: the end of it, a pointer to the Mac, or the prompt and the input box.
    @ViewBuilder private var controls: some View {
        if model.ended {
            VStack(spacing: 8) {
                Text("Session ended").font(.headline)
                if model.canResume {
                    Button("Resume") { Task { await resume() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(resuming)
                }
                errorLine
            }
        } else if model.noChat {
            Text("This server's blimpd can't show chats yet. Update it (see the README).").foregroundStyle(.secondary)
        } else if model.starting {
            ProgressView()
        } else if model.macOnly {
            Text("Open on Mac to use this session").foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if let prompt = model.prompt {
                    PromptBar(prompt: prompt, busy: model.answering || model.answered,
                              highlight: guess?.prompt == prompt ? guess?.pick : nil,
                              maxHeight: max(320, screenHeight * 0.6)) { pick, shown in
                        guess = nil
                        Task { await model.answer(pick, to: shown) }
                    } onAnswers: { draft, shown in
                        Task { await model.answer(draft, to: shown) }
                    }
                    Divider()
                } else if model.waitingUnknown {
                    Text("Claude is waiting. Open it on the Mac to answer.").font(.callout).foregroundStyle(.secondary)
                    Divider()
                }
                if listener.preparing {
                    Text("Getting speech ready…").font(.caption).foregroundStyle(.secondary)
                } else if let voiceNote {
                    Text(voiceNote).font(.caption).foregroundStyle(.secondary)
                }
                errorLine
                InputBar(
                    text: $draft, sending: model.sendingText, listening: micOn || micStopping, onSend: send,
                    onMicDown: micDown, onMicUp: micUp)
            }
        }
    }

    /// The working row: while Claude works, or waits on something only the Mac can answer.
    private var showsWorking: Bool { model.working || (typable && model.waitingUnknown) }
    /// The input box shows (controls' last case), and so does Stop on the working row.
    private var typable: Bool { !model.ended && !model.noChat && !model.starting && !model.macOnly }

    @ViewBuilder private var workingRow: some View {
        if showsWorking {
            let onStop: (() -> Void)? = typable ? { Task { await model.stop() } } : nil
            WorkingRow(waiting: !model.working, step: model.log.latestStep, stopping: model.stopping, onStop: onStop)
        }
    }

    private func hideKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    @ViewBuilder private var errorLine: some View {
        if let error = model.lastError {
            Text(error).font(.caption).foregroundStyle(.red)
        }
    }

    @ViewBuilder private var empty: some View {
        if model.log.shown.isEmpty && !showsWorking && !model.ended && !model.macOnly && !model.noChat && !model.starting {
            if !model.loaded {
                ProgressView()
            } else {
                Text("No messages yet.").foregroundStyle(.secondary)
            }
        }
    }

    /// The box clears only once blimpd has the text; anything typed meanwhile stays.
    private func send() {
        let text = draft
        Task {
            if await model.send(text), draft.hasPrefix(text) {
                draft.removeFirst(text.count)
            }
        }
    }

    // MARK: - Voice

    private static let promptId = "prompt"

    private func appeared() {
        onScreen = true
        if let prompt = model.prompt { promptsSeen.append(prompt) }
        lastStates = Dictionary(store.sessions.map { ($0.name, $0.state) }, uniquingKeysWith: { a, _ in a })
        model.onReply = { [weak model] message in
            guard model?.readAloud == true else { return }
            Speaker.shared.say(SpokenText.from(markdown: message.text ?? ""), id: message.id)
        }
    }

    /// Only the session on screen speaks or listens.
    private func disappeared() {
        onScreen = false
        model.onReply = nil
        Speaker.shared.stop()
        if micOn { micUp(.keep) }
    }

    private var vocabulary: [String] {
        [model.folder] + store.sessions.flatMap { [$0.title, URL(fileURLWithPath: $0.dir).lastPathComponent] }
    }

    private func micDown() {
        guard !micOn, !micStopping else { return }
        Speaker.shared.hushed = true
        voiceNote = nil
        guess = nil
        micOn = true
        micRound += 1
        let round = micRound
        micBase = draft
        if let p = model.prompt, p.singleChoice { micPrompt = p } else { micPrompt = nil }
        let words = vocabulary
        Task {
            do {
                try await listener.start(vocabulary: words)
            } catch is CancellationError {
                // let go before it was ready
            } catch {
                // The note shows even if the press already ended (the first denial comes after the alert).
                voiceNote = (error as? ListenError) == .denied
                    ? "Turn on Microphone and Speech Recognition for blimp in Settings > Apps > blimp."
                    : "This iPhone can't listen right now."
                guard micOn, round == micRound else { return }
                micOn = false
                Speaker.shared.hushed = false
                draft = micBase
            }
        }
    }

    private func micUp(_ release: MicRelease) {
        guard micOn else { return }
        micOn = false
        let base = micBase
        let asked = micPrompt
        micPrompt = nil
        micStopping = true
        Task {
            let heard = await listener.stop()
            micStopping = false
            Speaker.shared.hushed = false
            let words = Self.joined(base, heard)
            if release == .keep {
                draft = words
            } else if let now = model.prompt, now.at != asked?.at {
                // Claude asked something that isn't what the words answer (it came up while listening, or
                // the phone can't answer it): typing now would land on its prompt. Keep the words, send nothing.
                draft = words
                if !heard.isEmpty { voiceNote = "Claude asked something. Nothing was sent." }
            } else if let asked {
                draft = base
                if !heard.isEmpty { answerByVoice(heard, to: asked) }
            } else {
                draft = words
                if !heard.isEmpty { send() }
            }
        }
    }

    /// Only a clear match is sent. A guess is marked and waits for a tap; anything else asks again.
    /// The words are matched against the choices as they were when the mic started, and only while
    /// the prompt is still exactly that (the options can change under the same wait).
    private func answerByVoice(_ heard: String, to asked: Prompt) {
        guard model.prompt == asked else {
            voiceNote = "The question changed. Nothing was sent."
            return
        }
        switch VoiceAnswer.match(heard, choices: asked.choices) {
        case .clear(let pick):
            Task { await model.answer(pick, to: asked) }
        case .guess(let pick):
            guess = Guess(prompt: asked, pick: pick)
        case .none:
            voiceNote = "Didn't catch which one. Tap a button or try again."
        }
    }

    private static func joined(_ base: String, _ heard: String) -> String {
        guard !base.isEmpty, !heard.isEmpty else { return base + heard }
        return base.last!.isWhitespace ? base + heard : base + " " + heard
    }

    /// Another session newly waiting or finished, while this screen is up and the app is open: a banner and a sound.
    private func noticeOthers(_ sessions: [Session]) {
        var next: [String: SessionState] = [:]
        for s in sessions where s.name != model.name {
            next[s.name] = s.state
            guard onScreen, scenePhase == .active, let before = lastStates[s.name], before != s.state else { continue }
            switch s.state {
            case .waiting: show(Banner(name: s.name, text: "\(s.title) is waiting", waiting: true))
            case .done: show(Banner(name: s.name, text: "\(s.title) finished", waiting: false))
            case .working, .unknown: break
            }
        }
        lastStates = next
    }

    private func show(_ b: Banner) {
        banner = b
        AudioServicesPlaySystemSound(1007)
    }

    private func resume() async {
        resuming = true
        defer { resuming = false }
        if let name = await model.resume() { onResumed(name) }
    }
}

private struct ReconnectingBar: View {
    var body: some View {
        Text("Reconnecting…")
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(.bar)
    }
}

/// A spoken answer's guess, for the prompt it was heard for: shown only while that prompt is.
private struct Guess: Equatable {
    let prompt: Prompt
    let pick: Int
}

private struct Banner: Equatable, Hashable {
    let name: String
    let text: String
    let waiting: Bool
}

/// Slides in at the top; a tap opens that session.
private struct BannerView: View {
    let banner: Banner

    var body: some View {
        NavigationLink(value: SessionRoute(name: banner.name)) {
            HStack(spacing: 8) {
                if banner.waiting { Circle().fill(.orange).frame(width: 8, height: 8) }
                Text(banner.text).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .padding(.horizontal)
        .padding(.top, 6)
    }
}

/// The reply being read aloud is marked; a tap on it stops the reading.
private struct BeingRead: ViewModifier {
    let reading: Bool

    func body(content: Content) -> some View {
        if reading {
            content
                .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 12).inset(by: -6))
                .overlay(alignment: .topTrailing) {
                    Image(systemName: "speaker.wave.2.fill").font(.caption).foregroundStyle(.secondary).offset(x: 4, y: -4)
                }
                .contentShape(Rectangle())
                .onTapGesture { Speaker.shared.stop() }
                .accessibilityHint("Being read aloud. Tap to stop.")
        } else {
            content
        }
    }
}
