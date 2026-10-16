# Signing the Mac app

A signed and notarized app opens on any Mac with no warning. The release workflow signs on its own once six repository secrets exist. This page is how to get them. Do it on your Mac. It takes about 30 minutes, plus Apple's approval wait.

## 1. Join the Apple Developer Program

Enroll at https://developer.apple.com/programs/enroll/ as an individual. It costs $99 a year. Approval can take up to 48 hours.

## 2. Make a Developer ID certificate

This is the certificate for apps you hand out outside the App Store.

1. Open Xcode > Settings > Accounts, and add your Apple ID if it isn't there.
2. Select your team, click Manage Certificates, click +, and choose **Developer ID Application**.
3. Check it's in your keychain: `security find-identity -v -p codesigning`
   It prints a line like `"Developer ID Application: Max Beato (AB12CD34EF)"`. The part in quotes is your **signing identity**. The code in brackets is your **team ID**.

## 3. Export it as a .p12 file

1. Open Keychain Access > login > My Certificates.
2. Right-click "Developer ID Application: …" and choose Export. Save it as `blimp-signing.p12` and set a password. That password is your **certificate password**.
3. Turn it into text for GitHub: `base64 -i blimp-signing.p12 -o blimp-signing.b64`

## 4. Make an app-specific password

Apple's notary service logs in with your Apple ID. It needs a separate password, not your real one.

Go to https://account.apple.com > Sign-In and Security > App-Specific Passwords, and make one named "blimp notarize".

## 5. Add the six secrets to the repo

Each command asks for the value, so no secret ends up in your shell history. Run them in the folder with `blimp-signing.b64`.

- `gh secret set APPLE_CERTIFICATE -R mbeato/blimp < blimp-signing.b64`
- `gh secret set APPLE_CERTIFICATE_PASSWORD -R mbeato/blimp` (the .p12 password from step 3)
- `gh secret set APPLE_SIGNING_IDENTITY -R mbeato/blimp` (the quoted text from step 2, without the quotes)
- `gh secret set APPLE_ID -R mbeato/blimp` (your Apple ID email)
- `gh secret set APPLE_PASSWORD -R mbeato/blimp` (the app-specific password from step 4)
- `gh secret set APPLE_TEAM_ID -R mbeato/blimp` (the code in brackets from step 2)

Then delete `blimp-signing.p12` and `blimp-signing.b64`. The certificate stays in your keychain.

## 6. Check it

Tag a release candidate, for example `v0.2.0-rc.2`. The release notes then say "The Mac app is signed and notarized". The downloaded app opens with no warning, and `spctl -a -vv /Applications/blimp.app` says `source=Notarized Developer ID`.

If any secret is missing, the workflow builds unsigned, as before, and the notes say so.
