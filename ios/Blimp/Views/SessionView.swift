// A session as a chat: the messages, what Claude is waiting on as buttons, and a box to type into.
// Voice: the mic types (or answers the prompt), the speaker toggle reads new replies and prompts aloud,
// and a banner says when another session starts waiting or finishes. While Claude works, Stop (and Stop and
// send, with text in the box) is pinned above the box. Opened after time away: a "since you left" line, and
// the return card at the top after an hour. The toolbar has the context gauge (from half full) and a menu
// with Recap and Give a Secret; Run is under the commands of Claude's latest reply (ChatExtras.swift).
import AudioToolbox
import BlimpKit
import SwiftUI

struct SessionView: View {
    let name: String
    let onInbox: () -> Void
    /// Shows another session in this one's place: the one Resume started, or a banner's.
    let onOpen: (String) -> Void

    var body: some View {
        ChatScreen(name: name, onInbox: onInbox, onResumed: onOpen)
            .id(name)
    }
}

/// Owns the ChatModel: one still loaded from a recent visit, or a new one, when the screen first appears;
/// its socket closed when the screen goes.
private struct ChatScreen: View {
    let name: String
    let onInbox: () -> Void
    let onResumed: (String) -> Void
    @Environment(Store.self) private var store
    @State private var model: ChatModel?

    var body: some View {
        Group {
            if let model {
                ChatContent(model: model, onInbox: onInbox, onResumed: onResumed)
            } else {
                Color.clear
            }
        }
        .onAppear {
            let m = model ?? ChatModel.warm(name, store: store)
            model = m
            m.open()
        }
        .onDisappear { model?.close() }
    }
}

private struct ChatContent: View {
    let model: ChatModel
    let onInbox: () -> Void
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
    @State private var readAloud = false
    @State private var lastStates: [String: SessionState] = [:]
    @State private var banner: Banner?
    @State private var onScreen = false
    /// This visit's first history has been scrolled to: the end, or the "since you left" line.
    @State private var placed = false
    /// The message the "since you left" line is above, for this visit.
    @State private var since: String?
    @State private var recap: RecapLoad?
    /// Bumped by each ask for a recap and by closing the card, so a late answer to an earlier ask shows nothing.
    @State private var recapAsk = 0
    @State private var confirming: RunConfirm?
    @State private var givingSecret = false
    @State private var secretsGiven = 0

    private static let bottom = "bottom"
    /// The screen's height (less the keyboard), so Claude's questions can take most of it.
    @State private var screenHeight: CGFloat = 0

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    messages
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
            // A history comes after the screen has laid out, empty (or with a recent visit's messages), so the
            // initial anchor misses it, and the jump in content height reads as "scrolled up". Open at the end,
            // or at "since you left"; after a reconnect, stay at the end only if you were there.
            .onChange(of: model.histories) { old, _ in
                if !placed {
                    place(proxy)
                    return
                }
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
            .safeAreaInset(edge: .top, spacing: 0) { top }
            .overlay(alignment: .top) {
                if let banner {
                    BannerView(banner: banner) { onResumed(banner.name) }.transition(.move(edge: .top).combined(with: .opacity))
                }
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
        .toolbar {
            // The speaker, then Inbox at the far right.
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let meter = ContextText.meter(model.session?.context) {
                    Menu {
                        Section(meter.label) {
                            if canAct {
                                Button("Continue in New Session", systemImage: "arrow.forward.circle") { Task { await model.handOff() } }
                                    .disabled(model.session?.handoff?.state == .writing)
                            }
                        }
                    } label: {
                        ContextRing(meter: meter)
                    }
                    .accessibilityLabel(meter.label)
                    .accessibilityIdentifier("contextGauge")
                }
                if canAct {
                    Menu {
                        Button("Recap", systemImage: "text.alignleft") { loadRecap(auto: false) }
                        Button("Give a Secret…", systemImage: "key") { givingSecret = true }
                    } label: {
                        Label("More", systemImage: "ellipsis.circle")
                    }
                    .accessibilityIdentifier("chatMenu")
                }
                Button(readAloud ? "Stop reading aloud" : "Read aloud",
                       systemImage: readAloud ? "speaker.wave.2" : "speaker.slash") { setReadAloud(!readAloud) }
                InboxButton(action: onInbox)
            }
        }
        .onReturnFromBackground {
            model.reconnectNow()
            // Back after a while with this chat up: on screen again, and the return card if it's been an hour.
            let last = ChatModel.lastShown(model.name)
            ChatModel.markShown(model.name)
            if recap == nil { recapIfDue(last) }
        }
        // On screen with the app in front: Claude's replies are read, here and on the Mac.
        .task(id: SeenKey(conversation: model.session?.sessionId, unread: model.session?.unread == true,
                          looking: onScreen && scenePhase == .active)) {
            guard let id = model.session?.sessionId, model.session?.unread == true, onScreen, scenePhase == .active else { return }
            try? await store.api?.seen(id)
        }
        .onAppear(perform: appeared)
        .onDisappear(perform: disappeared)
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
            if readAloud { Speaker.shared.say(prompt.spoken, id: Self.promptId) }
        }
        .onChange(of: store.sessions) { _, sessions in noticeOthers(sessions) }
        // Leaving the app or locking the phone stops the mic; the words stay in the box, unsent. Not on
        // .inactive: the first-use permission alert makes the app inactive while it waits for an answer.
        .onChange(of: scenePhase) { _, phase in
            if phase == .background, micOn { micUp(.keep) }
            if phase == .background, onScreen { ChatModel.markShown(model.name) }
        }
        .sheet(item: $confirming) { c in
            RunConfirmSheet(command: c.command, folder: runFolder) { Task { await model.run(c.command) } }
        }
        .sheet(isPresented: $givingSecret) {
            SecretSheet { name, value in
                let failed = await model.giveSecret(name: name, value: value)
                if failed == nil { secretsGiven += 1 }
                return failed
            }
        }
        .sensoryFeedback(.success, trigger: secretsGiven)
        .task(id: banner) {
            guard banner != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { banner = nil }
        }
        // Links in Claude's replies: http and https open in Safari on tap, anything else does nothing.
        .environment(\.openURL, OpenURLAction { Inline.safe($0) ? .systemAction : .discarded })
    }

    /// The messages, the newest reply unfolded, the "since you left" line above the first new one; and the
    /// working row where it isn't pinned.
    @ViewBuilder private var messages: some View {
        let newest = ChatFold.newest(model.log.shown)
        ForEach(model.log.shown) { message in
            VStack(alignment: .leading, spacing: 14) {
                if message.id == since { SinceYouLeftLine() }
                MessageRow(message: message, fold: message.id != newest, runs: runs(for: message))
                    .modifier(BeingRead(reading: Speaker.shared.speakingId == message.id))
            }
        }
        if !typable { workingRow }
    }

    /// Over the top of the chat: Reconnecting, and the return card.
    @ViewBuilder private var top: some View {
        VStack(spacing: 0) {
            if model.reconnecting && !model.ended { ReconnectingBar() }
            if let recap {
                RecapCardView(load: recap) {
                    self.recap = nil
                    recapAsk += 1
                }
            }
        }
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
                    PromptBar(prompt: prompt, busy: model.answering || model.answered || model.stopping,
                              highlight: guess?.prompt == prompt ? guess?.pick : nil,
                              maxHeight: max(320, screenHeight * 0.6),
                              onDismiss: prompt.kind == .trust ? nil : { Task { await model.dismiss(prompt) } }) { pick, shown in
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
                workingRow
                chip
                if model.session.flatMap(HandoffText.words) == "Writing handoff" {
                    Text("Writing handoff…").font(.caption).foregroundStyle(.secondary)
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

    /// Claude runs in it and the phone can type into it: Run, Recap, a secret, a handoff.
    private var canAct: Bool { typable && model.session?.isClaude == true }

    /// In the scroll where the phone can't type into the session (no Stop); pinned above the box where it can.
    @ViewBuilder private var workingRow: some View {
        if showsWorking {
            let onStop: (() -> Void)? = typable ? { Task { await model.stop() } } : nil
            let redirect = typable && model.working && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            let onRedirect: (() -> Void)? = redirect ? { stopAndSend() } : nil
            WorkingRow(waiting: !model.working, step: model.log.latestStep, stopping: model.stopping || model.redirecting,
                       onStop: onStop, onStopAndSend: onRedirect)
        }
    }

    /// Where to go next: the session a handoff started, or after an answer here, the next one waiting on you.
    @ViewBuilder private var chip: some View {
        if let s = model.session, s.handoff?.state == .started, let child = s.handoff?.child, s.state != .working {
            ChipButton(words: "Handed off. Open the new session", id: "openHandoff") { onResumed(child) }
        } else if model.answeredHere, model.prompt == nil, let next = NextWaiting.after(model.name, in: store.sessions) {
            ChipButton(words: next.words, id: "nextWaiting") { onResumed(next.session.name) }
        }
    }

    /// Run for Claude's latest reply, where Claude runs and the phone can type to it.
    private func runs(for message: ChatMessage) -> RunContext? {
        guard canAct, let offered = RunStatus.offers(message, in: model.session) else { return nil }
        return RunContext(offered: offered, chat: model) { confirming = RunConfirm(command: $0) }
    }

    /// Where blimpd runs a command: the folder of Claude's latest line, else the session's.
    private var runFolder: String { model.session?.git?.cwd ?? model.session?.dir ?? model.folder }

    /// This visit's first history: at "since you left" (and New, to jump to the end) when there's one, else the end.
    private func place(_ proxy: ScrollViewProxy) {
        placed = true
        let line = SinceYouLeft.first(model.log.shown, lastShown: model.visitFrom, unread: model.unreadAtOpen)
        since = line
        atBottom = line == nil
        unseen = line != nil
        Task { @MainActor in
            if let line {
                proxy.scrollTo(line, anchor: .top)
                unseen = true
            } else {
                proxy.scrollTo(Self.bottom, anchor: .bottom)
            }
        }
    }

    /// The return card by itself: for a Claude session not on screen here for an hour (or ever).
    private func recapIfDue(_ lastShown: Double?) {
        guard model.session?.isClaude == true, RecapCard.due(lastShown: lastShown, now: Date.now.timeIntervalSince1970 * 1000) else { return }
        loadRecap(auto: true)
    }

    /// auto: shows only once it has come, and nothing if it doesn't. From the menu: "…" first, and why if it fails.
    private func loadRecap(auto: Bool) {
        recapAsk += 1
        let ask = recapAsk
        if !auto { recap = .loading }
        Task {
            do {
                let r = try await model.recap(auto: auto)
                if ask == recapAsk { recap = .shown(r) }
            } catch {
                if ask == recapAsk { recap = auto ? nil : .failed(Store.words(for: error)) }
            }
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

    /// Stop and send: the same, after Esc.
    private func stopAndSend() {
        let text = draft
        Task {
            if await model.stopAndSend(text), draft.hasPrefix(text) {
                draft.removeFirst(text.count)
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
    private var readAloudKey: String { "readAloud.\(model.name)" }

    private func appeared() {
        onScreen = true
        recapIfDue(model.visitFrom)
        readAloud = UserDefaults.standard.bool(forKey: readAloudKey)
        if let prompt = model.prompt { promptsSeen.append(prompt) }
        lastStates = Dictionary(store.sessions.map { ($0.name, $0.state) }, uniquingKeysWith: { a, _ in a })
        let key = readAloudKey
        model.onReply = { message in
            guard UserDefaults.standard.bool(forKey: key) else { return }
            Speaker.shared.say(SpokenText.from(markdown: message.text ?? ""), id: message.id)
        }
    }

    /// Only the session on screen speaks or listens.
    private func disappeared() {
        onScreen = false
        ChatModel.markShown(model.name)
        model.onReply = nil
        Speaker.shared.stop()
        if micOn { micUp(.keep) }
    }

    private func setReadAloud(_ on: Bool) {
        readAloud = on
        UserDefaults.standard.set(on, forKey: readAloudKey)
        if !on { Speaker.shared.stop() }
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

/// A one-line way to another session, above the box.
private struct ChipButton: View {
    let words: String
    let id: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(words).lineLimit(1)
                Image(systemName: "chevron.right").font(.caption2)
            }
            .font(.footnote.weight(.semibold))
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .accessibilityIdentifier(id)
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

private struct SeenKey: Equatable {
    let conversation: String?
    let unread: Bool
    let looking: Bool
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
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
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
