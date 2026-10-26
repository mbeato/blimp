# Phone: a feed of what's new in tech

Date: 2026-10-26. Branch `phone-feed`. Status: design approved in chat, spec waiting for review. Size: L (the
server part M, the phone part M).

## Why

Max wants one place on his phone, like Instagram Reels but for tech only, for what's new across Hacker News,
Reddit, GitHub and release notes, updated every hour. Each card should tell him what a post is without opening it.

blimp is an open-source app for Claude Code sessions, and a news feed has nothing to do with that. So the feed is
**off by default**. It only shows for someone who switches it on.

## Decisions

- **It lives in blimp's phone app,** fed by blimpd. blimpd already runs jobs on a timer and already asks a small,
  fast Claude model for summaries (digests, recaps, names), and the phone already has a link to it. Two other options
  were turned down:
  - A separate program on the server would be one more thing to install and run.
  - The phone can't fetch by itself. iOS doesn't run apps reliably every hour, and the phone has no Claude sign-in.
- **No blimp browser tab.** The phone's browser tabs are a live picture of the server's Chrome, so fast swiping
  through one would lag.
- **Sources:** Hacker News, Reddit, GitHub trending, and release notes and blogs (RSS and Atom).
- **A card:** where it's from, its score and its age; the title; 2–3 plain lines from the small model on what it
  is and why it's interesting; the link's picture if it has one; Open, Comments and Save.
- **What gets in:** each source has a bar (below). An interests list then moves matching cards to the top. The
  model checks the match in the same call that writes the summary. Nothing is dropped by the model, only reordered.
- **Seen cards never come back.** A Saved list keeps the ones you want.
- **Phone only** in this version. Left out: the Mac, notifications for the feed, and sending a post to a session.

## The hourly job (blimpd)

A new module, `src/feed/`, with one file per source and one for the job. It runs once when blimpd starts, then
every hour. It never overlaps itself: a run still going when the hour comes means that hour is skipped. A restart
doesn't fetch again if the last run started less than an hour ago. It catches its own errors, as the digest and
name loops do, so it can't take blimpd (and the sessions) down with it.

### Sources and their bars

Every request has a 10 s limit (`AbortSignal.timeout`, which also covers a connection that never comes up), runs
one at a time, and sends `User-Agent: blimpd/<version> (feed)`.

| Source | What gets in | How it's read |
|---|---|---|
| Hacker News | The front page (30 stories). | Algolia's API: `hn.algolia.com/api/v1/search?tags=front_page`, then `/api/v1/items/<id>` once per new story for its top comments. |
| Reddit | The top 5 posts in each listed subreddit's "rising" list. | Reddit's API with an app-only token (below): `oauth.reddit.com/r/<sub>/rising`, then the post's top comments. Skipped while there's no key. |
| GitHub trending | Today's trending repos (25). | The page `github.com/trending?since=daily`, read with Bun's built-in `HTMLRewriter`. There's no official API. |
| Release notes and blogs | Every post from the last 3 days in each listed feed. | A small RSS 2.0 and Atom reader of our own (title, link, date, text; handles CDATA and the common entities). No new package. |

### Cards

- **One card per link.** Links are compared after removing `utm_*` and other tracking parameters, `www.`, a final
  `/` and the `#` part, and after making `http` into `https`. The same link from two sources is one card with both
  sources and both scores (for example "HN 412 · r/programming 230").
- **What the model reads, per card:**
  - the title and the source;
  - the post's own text: HN or Reddit text, the RSS item's text, or the repo's description and the start of its
    README;
  - for a link post, the linked page's description and its first paragraphs (about 1,500 characters, from the
    first 1 MB of the page);
  - and up to 3 top comments (HN and Reddit).
- **The picture:** the page's `og:image`, or Reddit's preview picture. It's read from the same page fetch.

### Summaries

- New cards go to the small model 10 at a time, through `askClaude` (haiku, no tools, no MCPs, no hooks, nothing
  saved; `names.ts`). Each batch gets a 120 s limit.
- The model answers in JSON: one `{ id, summary, interest }` per card. `interest` is true when the card matches
  something on the interests list.
- **A cap of 6 calls an hour,** so 60 summaries at most. New cards past that wait for the next hour.
- **A card shows only once it has a summary,** or once two tries have failed. After that it shows its title only.
  A wrong or partial answer counts as a failed try for the cards it's missing.
- **The post's text is data, not instructions.** It goes inside clearly marked blocks. The model has no tools, so
  a post can't make it run anything. The worst a post can do is change its own summary. The phone shows the summary
  as plain text, never as Markdown or links.

### Order

1. Cards that match your interests first.
2. Then the rest, newest first (by the hour they were first fetched).
3. Within one hour, the sources take turns: HN's #1, GitHub's #1, Reddit's #1, then the #2s, and so on. So no one
   source fills the screen.

The order is decided on the server, so it's in one place and tested once.

### Storage

`<socket dir>/feed.json` (`~/.blimp/feed.json`), written the way the digest and recap files are (to a temp file,
then renamed; mode 600). It holds:

- `cards`: each card's link, title, sources (name, score, comment count, comments link), when it was first
  fetched, its picture, its summary, `interest`, and how many tries failed.
- `seen`: card ids with the time they were seen. Kept 7 days, so a card that's dropped and fetched again
  later still counts as seen.
- `saved`: card ids. A saved card is kept as long as it's saved.
- `runs`: per source, when it last ran and whether it worked, with a short reason if it didn't ("key rejected",
  "no repos on the page", "timed out").
- `lastRun`: when the last run started.

Cards are dropped 3 days after they were first fetched, unless saved.

### Settings

They live in `<socket dir>/config.json`, the file that already holds the names switch. The job reads it on each
tick, so a change works without restarting blimpd.

```json
{
  "feed": {
    "on": true,
    "subreddits": ["programming", "LocalLLaMA", "ClaudeAI", "MachineLearning"],
    "rss": ["https://developer.apple.com/news/rss/news.rss"],
    "interests": ["Claude Code", "iOS and Swift", "Bun", "local models"]
  }
}
```

- `on` missing or not `true` means off. While it's off, nothing is fetched and the phone shows no Feed button.
- A list that's missing gets the default. Subreddits: the four above. RSS: release notes and blogs for Apple
  developer news, OpenAI, Swift.org, Bun and the GitHub changelog. Each default address is checked live while
  building, and any without a working feed is left out. Interests: none, which means no reordering.

### The Reddit key

- Reddit blocks most requests from servers without a key. Max creates a free "script" app on Reddit once, then
  runs `blimpd reddit-key <client id> <secret>`. This works the same way `push-key` does.
- The key is kept in `<socket dir>/reddit.json` (mode 600). No route ever sends it back.
- blimpd gets an app-only token with it (`client_credentials`) and gets a new one when the old one runs out.
- Without a key, the Reddit source is skipped and shows as "no key" on the caught-up card.

## Server routes and events

- `GET /feed` returns `{ on, cards, saved, runs, next }`:
  - `cards`: the unseen ones that are ready to show, in order;
  - `saved`: the saved cards;
  - `runs`: each source's last result;
  - `next`: when the next run starts.
- `POST /feed/seen` with `{ ids }` marks cards seen.
- `POST /feed/saved` with `{ id, saved }` saves a card or unsaves it.
- **The events socket** sends `{ "type": "feed", "on": true, "unseen": 12 }` on connect and whenever `on` or the
  count changes. The phone uses it for the Feed button and its dot. Older phones decode unknown types as `.other`
  (`EventsMessage` in `Models.swift`), so they ignore it. The Mac app must do the same; the plan checks this.
- **The widget key can't read any of this.** It's already limited to `GET /widget`.

## The phone screen

- **Opening it:** a Feed button at the foot of the drawer's project column, next to + and Settings. It shows a dot
  while `unseen` is above 0, and it only appears while `on` is true. It opens full screen over everything, as a
  browser tab does (HomeView), with × at the top left to close it.
- **Moving through it:** one card fills the screen. Swipe up for the next one and down to go back (a paging
  vertical scroll view).
- **A card:**
  - At the top: the source line (source, score, age).
  - Then the title, the summary, and the picture if there is one. The phone loads the picture straight from its
    address, so that site sees the phone's address, the same as when you open the link.
  - At the bottom: Open, Comments and Save.
- **Open and Comments** show the page in Safari inside the app (`SFSafariViewController`). Comments opens the HN
  or Reddit thread. A card from both sources asks which one. A card with no thread (GitHub, RSS) has no Comments
  button. Only `http` and `https` links open.
- **Seen:** a card counts as seen once it has been on screen for at least 1 second and you move to another card
  or close the feed. The phone sends seen ids as they happen. While offline it keeps them and sends them when the
  link is back. Cards you've seen stay in the screen's list until you close it, so you can swipe back.
- **The end:** after the last card, an "All caught up" card shows:
  - the time of the next update;
  - any source whose last run failed, with when and why ("Reddit didn't load at 2:00: key rejected");
  - and a link to Saved with its count.
- **Saved:** a list opened from the top right. Each row shows the title and the source. Tap a row to see its card.
  Swipe a row away to unsave it.
- **When the server can't be reached:** the cards already loaded stay readable, and the usual connecting bar shows.

Code: `Feed.swift` in BlimpKit (card types, decoding with the same lenient per-element decode the events use, the
seen rule, the caught-up text, the Comments choice) and `FeedView.swift` in the app's Views.

## When things go wrong

| What | What happens |
|---|---|
| A source is down, blocked or times out | That source is skipped for this hour; the others still load. The caught-up card names it. |
| GitHub changes its trending page | Finding no repos counts as a failure ("no repos on the page"), shown the same way. |
| The Reddit key is wrong or has expired | Reddit is skipped and the card says "key rejected". |
| The model fails, times out or answers badly | Those cards wait and are tried again next hour. After 2 failed tries they show with their title only. |
| Many new cards at once (the first run) | The cap of 6 calls an hour holds; the rest wait for the next hours. |
| blimpd restarts | Cards, seen and saved are in `feed.json`. No new fetch if the last run started less than an hour ago. |
| `feed.json` is missing or broken | It's treated as empty; the next run fills it. |
| The feed is switched off | The job stops fetching; the phone's Feed button goes away. `feed.json` stays, so switching it back on keeps seen and saved. |

## Testing

**Server** (`bun test`, no internet). Saved copies of real responses go in `test/fixtures/feed/`: HN's front page
and an item, Reddit's rising list and a comments page, GitHub's trending page, an RSS feed, an Atom feed and an
article page. Each source's reader is tested against them. The job is tested with a fake fetch and a fake model,
the same way `digests.test.ts` does it. The tests cover:

- links that should match do (tracking parameters, `www.`, `http`) and ones that shouldn't don't;
- duplicates merge into one card with both sources;
- batches of 10, and the cap of 6 calls an hour;
- a bad answer leads to a retry, then the title only after 2 tries;
- interest matches come first, then newest, then sources taking turns;
- the 3-day cleanup keeps saved cards; seen ids are dropped after 7 days;
- seen cards never come back;
- a failed source is recorded with its reason and doesn't stop the others;
- off means no fetches;
- a restart within the hour doesn't fetch;
- the routes: seen, saved, and the widget key being refused;
- the events message when the count changes.

**Phone.** BlimpKit unit tests (`FeedTests.swift`) cover:

- decoding, including one bad card not blanking the rest;
- the seen rule;
- the caught-up text with and without failures;
- the Comments choice.

One UI test on the demo server (`ios/e2e/setup.ts` gets a feed fixture) opens the Feed, swipes, saves a card and
finds it in Saved.

**Docs.** A Feed section in `docs/DESIGN.md`. In the README: that the feed is off by default, how to switch it on,
and the Reddit key.

## Done when

- The feed is switched on on the server for a full day, runs every hour, and every source failure in that day shows
  on the caught-up card.
- On Max's phone, swiping between cards feels instant and Open loads the page in the app.

## Risks

- **Reddit's API access.** Reddit has tightened who gets API keys. Building starts by checking that a new script
  app's key works straight away. If it doesn't, the rest ships and Reddit waits.
- **GitHub trending has no API.** If the page changes, the reader breaks. The failure shows on the caught-up card
  instead of failing without anyone noticing, and the fix is the reader alone.
- **Summary quality from short inputs.** A link post whose page blocks servers leaves the model with the title and
  the comments only. That's acceptable for a first version; check it during the first day on.
- **Model use.** At most 6 haiku calls an hour on Max's own Claude sign-in. The cap is a constant, easy to change.

## Later

- The feed on the Mac.
- Sending a card to a Claude session ("try this library").
- Editing the subreddits, feeds and interests from the phone's Settings.
- A notification when a card matches your interests strongly.
