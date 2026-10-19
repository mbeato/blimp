import Testing
@testable import BlimpKit

let perm = ["Yes", "Yes, and don't ask again for ls commands", "Yes, and switch to auto mode", "No"]

@Test func numbers() {
    #expect(VoiceAnswer.match("two", choices: perm) == .clear(1))
    #expect(VoiceAnswer.match("Option 3.", choices: perm) == .clear(2))
    #expect(VoiceAnswer.match("the second one", choices: perm) == .clear(1))
    #expect(VoiceAnswer.match("4", choices: perm) == .clear(3))
    #expect(VoiceAnswer.match("seven", choices: perm) == .none)
}

@Test func yesAndNo() {
    #expect(VoiceAnswer.match("Yes", choices: perm) == .clear(0))
    #expect(VoiceAnswer.match("yeah", choices: perm) == .clear(0))
    #expect(VoiceAnswer.match("No.", choices: perm) == .clear(3))
    #expect(VoiceAnswer.match("nope", choices: ["Red", "Green"]) == .none)
}

@Test func labels() {
    #expect(VoiceAnswer.match("yes and switch to auto mode", choices: perm) == .clear(2))
    #expect(VoiceAnswer.match("Green", choices: ["Red", "Green", "Blue"]) == .clear(1))
    #expect(VoiceAnswer.match("I think green please", choices: ["Red", "Green", "Blue"]) == .clear(1))
    #expect(VoiceAnswer.match("dont ask again for ls", choices: perm) == .guess(1))
    #expect(VoiceAnswer.match("purple", choices: ["Red", "Green", "Blue"]) == .none)
    #expect(VoiceAnswer.match("yes and", choices: perm) == .none) // a prefix of two choices: unclear
}

private func isClear(_ m: AnswerMatch) -> Bool { if case .clear = m { return true } else { return false } }

@Test func hedgesAreNeverClear() {
    for heard in ["not yes", "nope yes", "yes wait", "yes but only once", "go ahead no", "no wait"] {
        #expect(!isClear(VoiceAnswer.match(heard, choices: perm)), "\(heard)")
    }
    for heard in ["not red", "anything but green"] {
        #expect(!isClear(VoiceAnswer.match(heard, choices: ["Red", "Green", "Blue"])), "\(heard)")
    }
}

@Test func politeAnswersStayClear() {
    #expect(VoiceAnswer.match("yes please", choices: perm) == .clear(0))
    #expect(VoiceAnswer.match("green please", choices: ["Red", "Green", "Blue"]) == .clear(1))
    #expect(VoiceAnswer.match("option two", choices: perm) == .clear(1))
    #expect(VoiceAnswer.match("I think green", choices: ["Red", "Green", "Blue"]) == .clear(2 - 1))
}

@Test func oddNumbersAreNotNumbers() {
    #expect(VoiceAnswer.match("two one", choices: perm) == .none)
    #expect(VoiceAnswer.match("the one", choices: perm) == .none)
}
