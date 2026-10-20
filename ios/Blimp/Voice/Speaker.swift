// Reads text aloud with AVSpeechSynthesizer, in the voice picked in Settings (else the best one
// installed for the phone's language). Other audio is ducked while it speaks.
import AVFoundation
import Observation

@Observable @MainActor
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    static let shared = Speaker()

    /// The id given to `say` for what is being read now, so its bubble can show it.
    private(set) var speakingId: String?

    /// false while the app isn't active or is locked: nothing is spoken, and what was speaking stops.
    @ObservationIgnored var allowed = true {
        didSet { if !allowed { stop() } }
    }

    /// true while the mic listens: it stops what's being read, and nothing new is read until it's false.
    @ObservationIgnored var hushed = false {
        didSet { if hushed { stop() } }
    }

    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    // Everything queued, by utterance, with the id it was said for. Holding the utterance keeps its identity unique.
    @ObservationIgnored private var queued: [ObjectIdentifier: (utterance: AVSpeechUtterance, id: String)] = [:]

    static let voiceKey = "voice"

    override private init() {
        super.init()
        synthesizer.delegate = self
    }

    func say(_ text: String, id: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard allowed, !hushed, !text.isEmpty else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.voice
        queued[ObjectIdentifier(utterance)] = (utterance, id)
        synthesizer.speak(utterance)
    }

    func stop() {
        guard !queued.isEmpty || speakingId != nil else { return }
        queued = [:]
        speakingId = nil
        synthesizer.stopSpeaking(at: .immediate)
        deactivate()
    }

    /// The voice from Settings, if it's still installed; else the best one for the phone's language.
    static var voice: AVSpeechSynthesisVoice? {
        if let id = UserDefaults.standard.string(forKey: voiceKey), let v = AVSpeechSynthesisVoice(identifier: id) { return v }
        return installed.first ?? AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
    }

    /// The phone's language's voices, best first: Premium, then Enhanced, then the rest; no novelty or Personal Voice.
    static var installed: [AVSpeechSynthesisVoice] {
        let language = AVSpeechSynthesisVoice.currentLanguageCode()
        return AVSpeechSynthesisVoice.speechVoices()
            .filter {
                $0.language == language && !$0.voiceTraits.contains(.isNoveltyVoice) && !$0.voiceTraits.contains(.isPersonalVoice)
            }
            .sorted { a, b in
                a.quality.rawValue != b.quality.rawValue ? a.quality.rawValue > b.quality.rawValue : a.name < b.name
            }
    }

    private func started(_ key: ObjectIdentifier) {
        if let entry = queued[key] { speakingId = entry.id }
    }

    private func ended(_ key: ObjectIdentifier) {
        guard queued.removeValue(forKey: key) != nil else { return }
        if queued.isEmpty {
            speakingId = nil
            deactivate()
        }
    }

    private func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // The synthesizer calls these on its own queue; only the utterance's identity crosses to the main actor.
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor in self.started(key) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor in self.ended(key) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor in self.ended(key) }
    }
}
