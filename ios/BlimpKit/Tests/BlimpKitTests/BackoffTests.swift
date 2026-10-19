import Testing
@testable import BlimpKit

@Test func backoffSteps() {
    #expect((0..<6).map { Backoff.delay(attempt: $0) } == [1, 2, 5, 10, 10, 10])
}
