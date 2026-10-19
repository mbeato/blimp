# blimp for iPhone

This is the iPhone app for blimp. It shows the Claude sessions running on your server. You can read them, type to them, answer their questions and permission prompts, start new ones and end them.

It talks to `blimpd`, the small program that runs on your server. The chat features need a blimpd from the phone-chat branch, or the next release. An older blimpd will show the session list but not the chat.

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

4. Build the project and open it.

```
cd ios && xcodegen generate && open Blimp.xcodeproj
```

5. In Xcode, pick an iPhone simulator and press Run.

6. On the Pair screen, paste this link. Put your token in place of `<token>`.

```
blimp://pair?url=http%3A%2F%2F127.0.0.1%3A7425&token=<token>
```

The app opens the home screen. The first launch asks for Face ID. In the simulator, use Features, Face ID, Enrolled, then Matching Face. Or use the passcode.

## The real phone

A real phone cannot reach `127.0.0.1` on your Mac. It needs Tailscale. That is the next step (step 4 in `docs/superpowers/specs/2026-10-19-phone-app-design.md`).

## Check list

`docs/PHONE-CHECKLIST.md` lists what to try by hand.
