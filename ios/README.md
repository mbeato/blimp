# blimp for iPhone

This is the iPhone app for blimp. It shows the Claude sessions running on your server. You can read them, type to them, answer their questions and permission prompts (and, in a new folder, whether Claude may trust it), start new ones and end them.

It talks to `blimpd`, the small program that runs on your server. The chat features need a blimpd from the phone-chat branch, or the next release. An older blimpd will show the session list but not the chat. The chat then says "This server's blimpd can't show chats yet."

## Put this branch's blimpd on your server

Do this once, on the server, and again after each pull that changes the server code. Released blimpd (0.2.6 and older) has no chat. Its hooks also don't record what Claude is asking. So every chat would fail.

1. Go to where the phone-chat branch is checked out, and get the latest. For Max, that is `~/blimp-phone`.

```
cd ~/blimp-phone
```

```
git pull
```

2. Build blimpd from it.

```
~/.bun/bin/bun build src/main.ts --compile --outfile /tmp/blimpd
```

3. Put it in place of the installed one.

```
install -m 755 /tmp/blimpd ~/.local/bin/blimpd
```

4. Restart the service.

```
systemctl --user restart blimpd
```

This is safe. The service uses `KillMode=process`, so running sessions keep running. The Mac app reconnects by itself.

Claude's hooks run this same file, `~/.local/bin/blimpd`. So from now on, they record what Claude asks, and the phone shows it as buttons.

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

4. In your blimp folder on the Mac, switch to the phone-chat branch. Then build the project and open it.

```
git fetch origin && git checkout phone-chat && git pull
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

A real phone cannot reach `127.0.0.1` on your Mac. It needs Tailscale. That is the next step (step 4 in `docs/superpowers/specs/2026-10-19-phone-app-design.md`).

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

## Check list

`docs/PHONE-CHECKLIST.md` lists what to try by hand.
