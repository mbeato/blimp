import Foundation
import Testing
@testable import BlimpKit

private func question(_ text: String, _ labels: [String], multi: Bool = false) -> Question {
    Question(question: text, header: nil, multiSelect: multi, options: labels.map { QuestionOption(label: $0, description: nil) })
}

private let three = [
    question("Which pet?", ["Cat", "Dog"]),
    question("Which toppings?", ["Cheese", "Ham", "Olives"], multi: true),
    question("Which drink?", ["Tea", "Coffee"]),
]

private func json(_ c: ChatCommand?) throws -> String {
    let enc = JSONEncoder()
    enc.outputFormatting = .sortedKeys
    return String(decoding: try enc.encode(c), as: UTF8.self)
}

@Test func aSingleChoicePickMovesOnAndMultiChoiceWaitsForNext() {
    var d = QuestionDraft(questions: three)
    #expect(d.position == "1 of 3")
    d.pick(1)
    #expect(d.step == 1)
    d.next() // nothing ticked yet: stays
    #expect(d.step == 1)
    d.pick(0)
    d.pick(2)
    d.pick(0) // untick
    #expect(d.isPicked(2) && !d.isPicked(0))
    d.next()
    #expect(d.position == "3 of 3")
    d.type("oat   milk\n")
    #expect(d.done && d.reviews && d.position == nil)
    #expect(d.answer(0) == "Dog")
    #expect(d.answer(1) == "Olives")
    #expect(d.answer(2) == "oat milk")
}

@Test func backAndEditKeepWhatWasPicked() {
    var d = QuestionDraft(questions: three)
    d.pick(0)
    d.pick(1)
    d.back()
    #expect(d.step == 0 && d.isPicked(0))
    d.pick(1) // a new pick replaces it
    #expect(d.answer(0) == "Dog" && d.step == 1 && d.isPicked(1))
    d.type("pineapple") // multi-choice: the text goes with the ticks and waits for Next
    #expect(d.step == 1 && d.isPicked(1))
    d.next()
    d.pick(0)
    #expect(d.done)
    #expect(d.answer(1) == "Ham, pineapple")
    d.edit(2)
    #expect(d.step == 2 && !d.done)
}

@Test func theCommandCarriesEveryAnswerAndThePickedLabels() throws {
    var d = QuestionDraft(questions: three)
    #expect(d.command(id: "a", at: 5) == nil) // not done
    d.pick(1)
    d.pick(2)
    d.pick(0)
    d.type("  pine apple ")
    d.next()
    d.type("oat milk")
    #expect(try json(d.command(id: "a1", at: 5)) ==
        #"{"answers":[{"picks":[1]},{"picks":[2,0],"text":"pine apple"},{"picks":[],"text":"oat milk"}],"at":5,"id":"a1","labels":[["Dog"],["Olives","Cheese"],[]],"type":"answer"}"#)
}

@Test func oneQuestionIsDoneWithoutAReview() {
    var d = QuestionDraft(questions: [question("Which fruits?", ["Apple", "Banana"], multi: true)])
    #expect(d.position == nil && !d.reviews)
    d.pick(1)
    d.next()
    #expect(d.done)
    #expect(d.command(id: "x", at: 1) == ChatCommand.answers(id: "x", at: 1, answers: [QuestionAnswer(picks: [1], text: nil)], labels: [["Banana"]]))
}

@Test func onlyOneSingleChoiceQuestionOrAPermissionIsAnsweredByASinglePick() throws {
    let decode = { (s: String) in try JSONDecoder().decode(Prompt.self, from: Data(s.utf8)) }
    let opt = #"{"label":"a"},{"label":"b"}"#
    #expect(try decode(#"{"kind":"permission","answerable":true,"at":1,"options":["Yes","No"]}"#).singleChoice)
    #expect(try decode(#"{"kind":"question","answerable":true,"at":1,"questions":[{"question":"q","multiSelect":false,"options":[\#(opt)]}]}"#).singleChoice)
    #expect(try !decode(#"{"kind":"question","answerable":true,"at":1,"questions":[{"question":"q","multiSelect":true,"options":[\#(opt)]}]}"#).singleChoice)
    #expect(try !decode(#"{"kind":"question","answerable":true,"at":1,"questions":[{"question":"q","multiSelect":false,"options":[\#(opt)]},{"question":"r","multiSelect":false,"options":[\#(opt)]}]}"#).singleChoice)
    #expect(try !decode(#"{"kind":"question","answerable":false,"at":1,"questions":[{"question":"q","multiSelect":false,"options":[\#(opt)]}]}"#).singleChoice)
}
