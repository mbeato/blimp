// The live panel's Live Activity type, in both the app (which starts a panel and hands blimpd its tokens) and the
// widget extension (which draws it). Its name is the attributes-type blimpd's push-to-start names (src/live.ts), and
// its content is BlimpKit's LiveState, blimpd's content-state. It has no stored properties: blimpd sends attributes {}.
import ActivityKit
import BlimpKit

struct BlimpActivityAttributes: ActivityAttributes {
    typealias ContentState = LiveState
}
