// How long to wait before the next reconnect try.
public enum Backoff {
    public static func delay(attempt: Int) -> Double {
        let steps: [Double] = [1, 2, 5, 10]
        return steps[min(max(attempt, 0), steps.count - 1)]
    }
}
