# blimp for iPhone

This is the iPhone app for blimp. It shows the Claude sessions running on your server. You can read them, type to them, answer their questions and permission prompts (and, in a new folder, whether Claude may trust it), start new ones and end them.

What you type or say stays in the box until you tap Send, and each chat keeps its own words, through the lock and after the app quits. The lock covers the app without closing it: unlocking brings you back to the same chat. One-tap replies ("go", "continue", or the numbers of the options Claude listed) sit above an empty box. When the server can't be reached because Tailscale is off, the app says so.

The drawer on the left (swipe right, or ☰ at the top left of a project's inbox) has a column of your projects down its left side: two letters each, with an amber question mark on one where a session asks you something and a blue dot on one with a new reply. Tap one: its inbox shows, and the drawer stays open with its sessions. Press and hold one and pick Hide to take it off the column (and off the Mac's recent folders); starting a session in that folder from the Mac brings it back. Hide needs a blimpd newer than 0.3.5. At the column's foot are + and Settings. + shows the computer's folders, from your home folder: tap a folder to go in, New Folder makes one, and Open makes the folder you're in a project, first in the column, even one you hid. Open needs a blimpd newer than 0.3.10. Folders in /tmp aren't offered as recent projects. Beside the column are the project's name, New session (which opens the inbox's box ready to type into), and the project's sessions. Opening the drawer hides the keyboard. In a chat, ‹ and the project's name at the top left go back to its inbox. The inbox lists what needs you in that project at the top. Another project's sessions are in its own inbox; a banner still tells you when one starts waiting. You can answer a permission or a simple question right there, without opening the chat. Swipe a row to stop, end or mark it read. Press and hold a row to continue it in a new session. Each row shows its branch and background jobs.

**Notifications.** Once paired, blimp asks whether it may send notifications (iOS asks only once). Then the server tells your phone when a session waits on you, or when a Claude turn of 30 seconds or more ends, even with blimp closed. Tap one to open that session's chat. While blimp is open, none shows: its own banner tells you of a wait, and a light tap of a finish. Opening a chat clears its notifications. Settings has a Notifications switch. The server needs a push key first; the main README says how. Debug builds use Apple's sandbox service and TestFlight builds the production one; each tells blimpd which.

In a chat, with blimpd 0.3: Stop stays above the box while Claude works, and "Stop and send" stops it with a new instruction. Claude's newest reply is never folded, and a "Since you left" line marks what came while you were away. The last few chats stay loaded, so switching back is instant, and after you answer a prompt a chip opens the next session in the project waiting on you. A command in Claude's latest reply gets Run: a sheet shows the whole command first, and once it ended, "Send result to Claude" types the result in. The top right has, from the left, the context gauge, then the speaker that reads replies aloud. Give a Secret is on the Mac only. The drawer's Browser section lists the project's tabs in the server's browser (a dot on ones Claude opened), with New Tab. A tab opens full screen: the page is laid out as a phone's, your fingers scroll, tap and zoom it, and tapping a text field brings the keyboard up. The address, Back, Forward, Reload, Send to Session and Close Tab are at the top. The browser needs a blimpd newer than 0.3.3. From half full, a ring in the top bar shows how full Claude's context is, with Continue in New Session.

It talks to `blimpd`, the small program that runs on your server. The newest features need blimpd 0.3.0. The chat needs 0.2.9 or later. An older blimpd will show the session list but not the chat. The chat then says "This server's blimpd can't show chats yet."

## Update blimpd on your server

Run the installer on the server. It puts the latest release in place and restarts the service. Running sessions keep running.

```
curl -fsSL https://github.com/mbeato/blimp/releases/latest/download/install.sh | sh
```

To try server code that isn't released yet, build blimpd from a checkout instead. Do this on the server, and again after each pull that changes the server code.

1. Go to your checkout of the branch, and get the latest.

```
cd <your checkout>
```

```
git pull
```

2. Build blimpd from it, put it in place of the installed one, and restart the service. One script does all three, in seconds. It keeps the one it replaced as `~/.local/bin/blimpd.prev`.

```
scripts/install-here.sh
```

This is safe. The service uses `KillMode=process`, so running sessions keep running. The Mac app reconnects by itself.

Claude's hooks run this same file, `~/.local/bin/blimpd`. So they use the new code too.

To go back to the release, run the installer again:

```
curl -fsSL https://github.com/mbeato/blimp/releases/latest/download/install.sh | sh
```

## Try it in the simulator (no Tailscale)

The simulator shares your Mac's `127.0.0.1`. So you can reach the server through an SSH tunnel. Nothing is exposed to the network.

In these steps `<you>` is your user name on the server and `<server>` is its SSH name. For Max, that is `mbeato` and `claude1`.

1. Install the tools once. You need Xcode 26 and xcodegen.

```
brew install xcodegen
```

2. Open a tunnel. It forwards blimpd's private socket to port 7425 on your Mac only. Leave it running in its own terminal tab.

```
ssh -N -L 7425:/home/<you>/.blimp/blimpd.sock <server>
```

Max: `ssh -N -L 7425:/home/mbeato/.blimp/blimpd.sock claude1`

3. Get the token. It is the password blimpd checks. It is a file on the server.

```
ssh <server> cat .blimp/token
```

Max: `ssh claude1 cat .blimp/token`

4. In your blimp folder on the Mac, get the latest. Then build the project and open it.

```
git pull
```

```
cd ios && xcodegen generate && open Blimp.xcodeproj
```

5. In Xcode, pick an iPhone simulator and press Run.

6. On the Pair screen, paste this link. Put your token in place of `<token>`.

```
blimp://pair?url=http%3A%2F%2F127.0.0.1%3A7425&token=<token>
```

The app opens the home screen. The first launch, with nothing paired yet, doesn't ask for Face ID. The next launch does. In the simulator, use Features, Face ID, Enrolled, then Matching Face. Or use the passcode.

Or give the phone its own token instead of the Mac's. On the server, run:

```
blimpd pair --url http://127.0.0.1:7425
```

It prints a QR code and a link. Paste the link. `blimpd pair --revoke` takes that token away again; the Mac keeps working.

## Pair by QR code

On a real iPhone, the Pair screen has a Scan QR code button. The simulator has no camera, so it doesn't show the button there.

1. On the server, run `blimpd pair`. It makes the phone's own token, the first time, and prints a QR code and the same link as text.

```
blimpd pair
```

2. On the iPhone, open blimp, tap Scan QR code and allow the camera. Point it at the code in the terminal. The app checks the link with the server and saves it in the iPhone's Keychain, the same as a pasted link.

`blimpd pair` takes the server's address from Tailscale. Until Tailscale is set up on the server it stops with "Install Tailscale … or pass --url". Then give the address yourself with `--url`.

Run `blimpd pair` again to show the same code again. Run `blimpd pair --revoke` to cut the phone off. The Mac keeps working.

## The real phone

A real phone cannot reach `127.0.0.1` on your Mac. It reaches the server over Tailscale instead. Put Tailscale on the server and on the iPhone, on the same tailnet. Then pair by QR code (above): `blimpd pair` puts the server's Tailscale address in the link. How the server takes the phone's requests over Tailscale: the Connection part of `docs/superpowers/specs/2026-10-19-phone-app-design.md`.

## TestFlight

A release tag (`v*`), or a manual run of the "iOS" workflow (`gh workflow run iOS -R mbeato/blimp --ref <branch>`), builds the app and uploads it to TestFlight, once four repository secrets are set. Without them the "iOS" workflow says "Not uploaded" in a notice and passes. You do these steps once.

1. Join the Apple Developer Program with your Apple Account: https://developer.apple.com/programs/

2. Find your Team ID. On https://developer.apple.com/account, open Membership details. The Team ID is 10 letters and digits.

3. Register the app's bundle id. On https://developer.apple.com/account/resources/identifiers, press +, pick App IDs, then App. Description: blimp. Bundle ID: Explicit, `dev.blimp.phone`. Press Continue, then Register.

4. Make the app record. In App Store Connect (https://appstoreconnect.apple.com), open Apps, press +, then New App. Platform: iOS. Name: blimp. (The name has to be free on the App Store. If it is taken, use another, like "blimp for Claude". The name under the icon on the phone stays "blimp".) Language: English. Bundle ID: `dev.blimp.phone`. SKU: `blimp-phone`. User Access: Full Access. Press Create.

5. Make an API key. In App Store Connect, open Users and Access, then Integrations, then App Store Connect API, then Team Keys. The first time, press Request Access and accept. Press + (Generate API Key). Name: blimp CI. Access: Admin. (App Manager can't make the distribution certificate that cloud signing needs, so the first upload would fail.) Press Generate.

6. Download the key. It is a file named `AuthKey_<key id>.p8`. You can download it only once. Copy the Key ID from the key's row and the Issuer ID from above the list.

7. Add the four secrets to the repository. Run these in Terminal on your Mac, with your values in place of the `<…>` parts.

```
gh secret set APP_STORE_CONNECT_KEY_ID -R mbeato/blimp --body "<key id>"
```

```
gh secret set APP_STORE_CONNECT_ISSUER_ID -R mbeato/blimp --body "<issuer id>"
```

```
base64 -i ~/Downloads/AuthKey_<key id>.p8 | gh secret set APP_STORE_CONNECT_KEY -R mbeato/blimp
```

```
gh secret set APPLE_TEAM_ID -R mbeato/blimp --body "<team id>"
```

8. Keep the `.p8` file somewhere safe, or delete it. The secret has it now.

The icon is `Blimp/Assets.xcassets/AppIcon.appiconset/AppIcon.png`, drawn from `ios/app-icon.svg` (the Mac icon's blimp on a full black square; RGB, no transparency, which the App Store requires).

After that, each release tag uploads a build. The build number is the workflow's run number. The build shows in App Store Connect under TestFlight once Apple has processed it (often 10 to 30 minutes). Add yourself as an internal tester there, and install it on the iPhone with the TestFlight app.

## The e2e test on your own Mac

The iOS workflow's end-to-end test (app-e2e) can run on Max's MacBook Pro, on three self-hosted runners labeled `blimp-e2e` (`mbp-a`, `mbp-b`, `mbp-c`), one per shard. Otherwise it runs on GitHub's Macs. The Mac starts from what the last run left (the simulators, the compiled app), so a run there takes minutes less than on a fresh GitHub Mac.

- Off by default: runs go to GitHub's Macs. A manual run can pick `mac`; `gh variable set E2E_ON_MAC --body true -R mbeato/blimp` sends the owner's own pushes and manual runs there too (the repo is public, so nobody else's). On the first try (Xcode 27.1, the iOS 27.1 simulator, a busy laptop) the tests ran up to twice as slow as on GitHub's Macs, and the Face ID lock tests failed: iOS 27 still lets the UI tests see Home under the lock cover.
- Every run has the core tests (what reaches Claude's sessions, the sessions' lifecycle, the lock). The layout and gesture tests run only from Run workflow with "layout" ticked, before a release (README.md, Releasing).
- Whether the Mac is online comes from the `RUNNERS_TOKEN` secret: a fine-grained token for this repo with Administration: Read-only. Without it, the owner's runs wait for the Mac. To set it, make the token on GitHub (Settings > Developer settings > Fine-grained tokens), then run `gh secret set RUNNERS_TOKEN -R mbeato/blimp` and paste it.
- On the Mac: the runners are in `~/actions-runner/{a,b,c}`, each a login item (`~/Library/LaunchAgents/actions.runner.mbeato-blimp.mbp-*.plist`) that starts when you log in. Each shard has its own simulator (`blimp-e2e-a` …, booted for a run and shut down after; not wiped, only blimp's app and the Keychain are reset, since a boot after a wipe took 2 min against 10 s. If one ever gets into a bad state: `xcrun simctl erase blimp-e2e-a`) and its compiled app in `~/Library/Caches/blimp-e2e.noindex/<shard>/dd` (`.noindex`: Spotlight skips it).
- Once per Xcode update, in Terminal on the Mac: `sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch && sudo DevToolsSecurity -enable && sudo automationmodetool enable-automationmode-without-authentication` (UI tests then run without asking for a password).
- To stop them for a while: `for s in a b c; do launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/actions.runner.mbeato-blimp.mbp-$s.plist; done` (runs go to GitHub's Macs once the runners show offline). To remove them for good: `cd ~/actions-runner/<shard> && ./svc.sh uninstall && ./config.sh remove --token <a removal token from gh api -X POST repos/mbeato/blimp/actions/runners/remove-token -q .token>`.

## Widgets

Long-press the home screen or the lock screen, tap Edit and Add Widget, and pick blimp. Home screen: small (the counts), medium (4 sessions) and large (about 9). Lock screen: the line above the clock, a circle (the needs-you count, else the working count) and a rectangle (the counts and the top two titles). They show every project's sessions, the hidden projects' left out: ? needs you, ✓ new (finished, not read yet), ● working. A tap on a session opens its chat.

They need blimpd newer than 0.3.11 ("Update blimpd for widgets" otherwise) and the app opened once after pairing ("Open blimp to set up its widgets"). blimpd tells them to reload when what they show changes, and the phone decides when they do: expect minutes, not seconds. When the phone can't reach the server, a widget shows what it last had, greyed, with "as of". Open the app once after adding the first widget, so blimpd gets the widgets' push token.

The widgets are an app extension, `dev.blimp.phone.widgets`, sharing the App Group `group.dev.blimp.phone` with the app. CI's App Store Connect key (Admin) registers both when it signs. If a TestFlight upload fails on them, register them once on https://developer.apple.com/account/resources/identifiers: press +, pick App Groups, Description: blimp, Identifier: `group.dev.blimp.phone`, Continue, Register. Then press +, pick App IDs, then App, Description: blimp widgets, Bundle ID: Explicit, `dev.blimp.phone.widgets`, tick App Groups and Push Notifications, Continue, Register. Then open the `dev.blimp.phone` App ID, tick App Groups, and save. Then run the TestFlight upload again.

## Check list

`docs/PHONE-CHECKLIST.md` lists what to try by hand.
