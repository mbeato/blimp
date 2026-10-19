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
