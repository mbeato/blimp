# Phone browser: use the server's browser tabs from the iPhone

Date: 2026-10-22. Status: approved, being built (branch phone-browser). Size: M.

## Problem

The server browser (v0.3) is on the Mac only. Max wants it on the phone too, and not as a desktop
page shrunk onto a phone screen. It should feel like a phone browser: phone layout, real touches,
the phone's keyboard.

## Decisions

- **Chrome acts like a phone while the phone uses the tab.** Phone width, mobile layout, touch on,
  and a phone user agent (Chrome on Android, same version). Sites that pick their page by user
  agent switch on the next load.
- **The screen used last sets the tab's size.** A size or any input from a view makes it the
  tab's owner; its size and mode go on the tab, and the last owner's phone settings come off. When
  the owner closes its view, the newest view still open takes over. So the Mac's desktop layout comes
  back as soon as the phone leaves.
- **Touches are passed on as touches** (`Input.dispatchTouchEvent`). Chrome does the scrolling,
  the glide after a fast swipe, taps and pinch zoom.
- **The keyboard comes up by itself.** After a tap, blimpd says whether a text field has focus.
- **On the phone, the tabs are in the drawer,** in a Browser section under New session: this
  project's tabs, a dot on ones a session opened, + for a new tab, swipe to close. A tab opens full
  screen over the chat.
- **Not now:** copying out of the page, file uploads and downloads, opening chat links in this
  browser.

## Spike (2026-10-22, Chromium 156 on claude1)

- Two CDP sessions on one tab: the last `Emulation.setDeviceMetricsOverride` wins. When the
  session that set it detaches, the page goes back to Chrome's default size, not the other
  session's. So blimpd must apply the next owner's size itself.
- `Input.dispatchTouchEvent` (with `Emulation.setTouchEmulationEnabled`) scrolls, and a fast swipe
  keeps gliding after the touch ends (321 px at release, 589 px 1.5 s later). No glide is needed on
  the phone.
- A tap on an input focuses it. `setUserAgentOverride({ userAgent: "" })`,
  `setTouchEmulationEnabled({ enabled: false })` and `clearDeviceMetricsOverride` put the page
  back to desktop.

## Server (`src/browser/view.ts`)

Views of one tab share a little state: the tab's views and its owner.

- `{ type: "size", width, height, scale, mobile? }`: `mobile: true` is the phone. The view keeps
  its size and becomes the owner.
- Becoming owner (a size, or any input from a view that isn't owner): the old owner's overrides
  are cleared (on its own CDP session), then this view's are set: metrics (`mobile`), and for a
  phone, touch emulation (5 points) and the phone user agent. Every view's screencast restarts at
  the new size.
- Owner closes: the newest remaining view with a size becomes owner.
- `{ type: "touch", event: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points:
  [{ x, y, id }] }` → `Input.dispatchTouchEvent`; counts as input (light frames while busy).
- After a `touchEnd`, once Chrome has handled it: `{ type: "focus", editable }`. `editable`: the
  focused element is a text input, a textarea, or contenteditable.
- The phone user agent: `userAgentFor`'s version, `Mozilla/5.0 (Linux; Android 10; K)
  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<major>.0.0.0 Mobile Safari/537.36`.

`findChrome` also finds Playwright's Chromium on macOS (`chrome-mac*/…/Chromium`), so the
simulator e2e on GitHub's Mac has a browser.

## Phone

- **Tabs.** The events socket already sends `{ type: "browser", tabs }`; the phone reads it.
  `POST /browser/tabs` and `DELETE /browser/tabs/<id>` for + and close.
- **Browser screen** (full screen over the chat):
  - Top bar: × (back to the chat), the address (tap to edit; a typed word is a Google search, as on
    the Mac), and ••• (Back, Forward, Reload, Keyboard, Send to Session, Close Tab).
  - The page: JPEG frames drawn at the page's size in points, scaled to fit the width when another
    screen owns the size. Each frame is acked once drawn.
  - Sends its size (points, scale 2, `mobile: true`) on open and when its area changes (rotation,
    the keyboard).
  - Touches: every finger's point in page coordinates. Begin/move/end/cancel.
  - Typing: a hidden text field holds the keyboard. Typed text → `text`, delete → Backspace key,
    return → Enter key. `focus` `editable: true` brings it up, `false` puts it away.
  - Page dialogs (alert, confirm, prompt) show as phone alerts.
  - Lost link: the last picture stays, greyed, with "Reconnecting"; tries again (1, 2, 5, 10 s).
    "Tab closed" goes back to the chat.
  - Leaving (×, the lock, the app going to the background) closes the view.
  - Send to Session: `Browser tab <id> (<url>)` goes into the chat box of the session it came from
    (as on the Mac).

## Testing

- **Server (`bun test`, real Chromium):** phone mode lays the page out as a phone; the Mac's size
  comes back when the phone view closes, and input from the Mac takes the size back; a swipe
  scrolls; a tap on an input sends `focus` `editable: true`; the phone user agent string.
- **BlimpKit (`swift test`, GitHub):** the `browser` events message, the touch and size messages,
  mapping a point on screen to the page, typed address → URL.
- **Simulator (GitHub `app-e2e`):** the drawer lists a tab; opening it shows a picture; a tap on
  the page reaches it.
- **Phone checklist (Max):** scrolling on Wi-Fi and cellular, typing, a page dialog, the Mac going
  back to desktop when the phone leaves.
