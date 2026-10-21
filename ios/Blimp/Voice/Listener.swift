// Speech to text on the phone: the mic through AVAudioEngine, into SpeechAnalyzer with a SpeechTranscriber
// for the phone's language. No audio leaves the phone. While a box with a mic is on screen, one analyzer is
// made and loaded ahead of the press (warm()), with no mic or audio session, so music keeps playing and no
// orange dot shows; and the mic starts before the analyzer does, its sound waiting in the stream, so the
// first words aren't lost.
import AVFoundation
import Observation
import Speech

enum ListenError: Error {
    /// The microphone or speech recognition is turned off for blimp.
    case denied
    /// This phone or its language can't do speech to text.
    case unavailable
}

@Observable @MainActor
final class Listener {
    /// What has been heard so far, live (words may still change until stop()).
    private(set) var partial = ""
    /// The language's speech model is downloading (first use only).
    private(set) var preparing = false
    private(set) var listening = false

    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var analyzer: SpeechAnalyzer?
    @ObservationIgnored private var input: AsyncStream<AnalyzerInput>.Continuation?
    @ObservationIgnored private var results: Task<Void, Never>?
    @ObservationIgnored private var finished = ""
    @ObservationIgnored private var volatile = ""
    // Bumped by start() and stop(): a start() that stop() overtook gives up at its next step.
    @ObservationIgnored private var round = 0

    static let fixedWords = ["blimp", "blimpd", "zmx", "Claude", "Codex"]

    /// A transcriber and analyzer loaded before the press, for the phone's language.
    private struct Ready {
        let locale: Locale
        let transcriber: SpeechTranscriber
        let analyzer: SpeechAnalyzer
    }

    private static var ready: Ready?
    private static var warming = false
    /// Boxes with a mic on screen.
    private static var users = 0

    /// A box with a mic came on screen: load an analyzer now, if blimp may already listen (never asks).
    static func warm() {
        users += 1
        prepare()
    }

    /// It went: the loaded analyzer goes once no box with a mic is left.
    static func cool() {
        users = max(0, users - 1)
        guard users == 0, let analyzer = ready?.analyzer else { return }
        ready = nil
        Task { await analyzer.cancelAndFinishNow() }
    }

    private static func prepare() {
        guard users > 0, ready == nil, !warming,
              AVAudioApplication.shared.recordPermission == .granted,
              SFSpeechRecognizer.authorizationStatus() == .authorized else { return }
        warming = true
        Task {
            defer { Self.warming = false }
            guard SpeechTranscriber.isAvailable,
                  let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) else { return }
            let made = Self.transcriber(for: locale)
            // A model still to download is start()'s job: it says "Getting speech ready…".
            guard await AssetInventory.status(forModules: [made]) == .installed else { return }
            let analyzer = SpeechAnalyzer(modules: [made], options: nil)
            try? await analyzer.prepareToAnalyze(in: nil)
            guard Self.users > 0, Self.ready == nil else {
                await analyzer.cancelAndFinishNow()
                return
            }
            Self.ready = Ready(locale: locale, transcriber: made, analyzer: analyzer)
        }
    }

    /// The loaded analyzer, if it's for `locale`; it's this press's now.
    private static func takeReady(for locale: Locale) -> Ready? {
        guard let r = ready else { return nil }
        ready = nil
        if r.locale == locale { return r }
        let analyzer = r.analyzer
        Task { await analyzer.cancelAndFinishNow() }
        return nil
    }

    private static func transcriber(for locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
    }

    /// Starts listening. `vocabulary` is words it should know (folder names, titles).
    func start(vocabulary: [String]) async throws {
        await teardown()
        round += 1
        let mine = round
        partial = ""
        finished = ""
        volatile = ""

        guard await Self.permitted() else { throw ListenError.denied }
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
        else { throw ListenError.unavailable }
        try check(mine)

        let warm = Self.takeReady(for: locale)
        let transcriber = warm?.transcriber ?? Self.transcriber(for: locale)
        if warm == nil, await AssetInventory.status(forModules: [transcriber]) != .installed {
            preparing = true
            defer { preparing = false }
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await request.downloadAndInstall()
            }
        }
        try check(mine)

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement)  // .duckOthers is refused with .record; it silences others anyway
        try session.setActive(true)
        let engine = AVAudioEngine()
        self.engine = engine
        do {
            let micFormat = engine.inputNode.outputFormat(forBus: 0)
            guard micFormat.sampleRate > 0, micFormat.channelCount > 0,
                  let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: micFormat),
                  let converter = AVAudioConverter(from: micFormat, to: format)
            else { throw ListenError.unavailable }
            try check(mine)

            // The mic first: what's said while the analyzer starts waits in the stream.
            let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
            input = continuation
            engine.inputNode.installTap(
                onBus: 0, bufferSize: 4096, format: micFormat,
                block: Self.tap(MicFeed(converter: converter, format: format, out: continuation)))
            engine.prepare()
            try engine.start()

            let analyzer = warm?.analyzer ?? SpeechAnalyzer(modules: [transcriber], options: nil)
            self.analyzer = analyzer
            let context = AnalysisContext()
            context.contextualStrings = [.general: Self.words(vocabulary)]
            try? await analyzer.setContext(context)  // a hint only: listen without it rather than not at all
            try check(mine)  // a stop() during that await already tore down: store nothing more

            let heard = transcriber.results
            results = Task { [weak self] in
                do {
                    for try await result in heard {
                        self?.take(String(result.text.characters), final: result.isFinal)
                    }
                } catch {
                    // the analysis ended (stop(), or an error): what was heard stays
                }
            }
            try check(mine)
            try await analyzer.start(inputSequence: stream)
            try check(mine)
        } catch {
            // overtaken by stop() (which already tore down), or a real failure
            if mine == round { await teardown() }
            throw error
        }
        listening = true
    }

    /// Stops listening and returns everything heard (empty if it never got going).
    func stop() async -> String {
        round += 1
        let mine = round
        let analyzer = self.analyzer, results = self.results
        self.analyzer = nil
        self.results = nil
        let hadAudio = stopAudio()
        // The last words are finalized once the input ends; two seconds at most for that and the last results.
        let timeout = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            await analyzer?.cancelAndFinishNow()
            results?.cancel()
        }
        if let analyzer { try? await analyzer.finalizeAndFinishThroughEndOfInput() }
        await results?.value
        timeout.cancel()
        let text = Self.joined(finished, volatile).trimmingCharacters(in: .whitespacesAndNewlines)
        if mine == round {
            listening = false
            partial = text
            if hadAudio { Self.deactivate() }
        }
        Self.prepare()  // for the next press
        return text
    }

    /// Ends everything at once, keeping nothing.
    private func teardown() async {
        let hadAudio = stopAudio()
        if let analyzer {
            self.analyzer = nil
            await analyzer.cancelAndFinishNow()
        }
        results?.cancel()
        results = nil
        listening = false
        if hadAudio { Self.deactivate() }
    }

    /// Stops the mic and ends the analyzer's input; true if the mic had been set up.
    private func stopAudio() -> Bool {
        input?.finish()
        input = nil
        guard let engine else { return false }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        return true
    }

    private static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func check(_ mine: Int) throws {
        if mine != round { throw CancellationError() }
    }

    private func take(_ text: String, final: Bool) {
        if final {
            finished = Self.joined(finished, text)
            volatile = ""
        } else {
            volatile = text
        }
        partial = Self.joined(finished, volatile).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func joined(_ a: String, _ b: String) -> String {
        guard let last = a.last, let first = b.first, !last.isWhitespace, !first.isWhitespace else { return a + b }
        return a + " " + b
    }

    private static func words(_ vocabulary: [String]) -> [String] {
        var seen = Set<String>()
        return (fixedWords + vocabulary)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
    }

    /// Asks for the microphone and speech recognition the first time; later it answers at once.
    nonisolated private static func permitted() async -> Bool {
        guard await AVAudioApplication.requestRecordPermission() else { return false }
        let status: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { done in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
        }
        return status == .authorized
    }

    /// Made outside the main actor: AVAudioEngine calls the tap on its own audio thread.
    nonisolated private static func tap(_ feed: MicFeed) -> AVAudioNodeTapBlock {
        { buffer, _ in feed.feed(buffer) }
    }
}

/// Turns the mic's buffers into the analyzer's format and hands them on.
// @unchecked: after the tap is installed only the engine's audio thread uses it, one buffer at a time.
private final class MicFeed: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let format: AVAudioFormat
    private let out: AsyncStream<AnalyzerInput>.Continuation
    private var pending: AVAudioPCMBuffer?

    init(converter: AVAudioConverter, format: AVAudioFormat, out: AsyncStream<AnalyzerInput>.Continuation) {
        converter.primeMethod = .none  // no lead-in samples, so the times stay in step with the mic
        self.converter = converter
        self.format = format
        self.out = out
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard capacity > 0, let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        pending = buffer
        var error: NSError?
        // The converter may ask more than once; it gets this one buffer, then "no data for now".
        let status = converter.convert(to: converted, error: &error) { _, inputStatus in
            guard let next = self.next() else {
                inputStatus.pointee = .noDataNow
                return nil
            }
            inputStatus.pointee = .haveData
            return next
        }
        if status != .error, converted.frameLength > 0 {
            out.yield(AnalyzerInput(buffer: converted))
        }
    }

    private func next() -> AVAudioPCMBuffer? {
        defer { pending = nil }
        return pending
    }
}
