# Releasing Snip Pilot

This describes how to ship a release today (no Apple Developer account) and how to
upgrade to a fully signed + notarized build later with **zero code changes** — only a
certificate, a few env vars, and one config flip.

---

## Current state (v0.3.0)

- App icon: `build/icon.png` (electron-builder generates the `.icns` at build time).
- Menu-bar/tray icon: `src/assets/trayTemplate.png` (+ `@2x`), bundled with the app.
- Signing: **ad-hoc** (`scripts/sign-mac-app.sh`, `codesign --sign -`). The app runs,
  but macOS Gatekeeper shows a warning on first launch on other people's machines.
- Notarization: **not yet** (requires a paid Apple Developer account).
- Updates: a user-initiated "Check for Updates…" item in the tray menu. No background
  network calls — it only contacts GitHub when the user clicks it.

---

## Ship a release NOW (unsigned / ad-hoc, GitHub)

1. Build and package the signed-ad-hoc app + DMG:
   ```bash
   npm run dist
   ```
   Output: `release/Snip Pilot-0.3.0-arm64.dmg` and `downloads/SnipPilot-0.3.0-arm64.dmg`
   (+ a `.sha256`).
2. Create a GitHub release tagged `v0.3.0` and upload the DMG (and the `.sha256`).
3. In the release notes, include first-launch instructions for users, because the build
   is not notarized:

   > **First launch:** because this build isn't notarized yet, macOS will warn you.
   > Right-click (or Control-click) **Snip Pilot.app → Open → Open**. You only need to
   > do this once.

That's a legitimate, common way to distribute open-source Mac apps before notarization.

---

## Upgrade to signed + notarized later (the "proper app" path)

The build config already contains the scaffold (`hardenedRuntime`, `entitlements`,
`gatekeeperAssess`, `publish`). When you're ready:

### One-time setup
1. Enroll in the **Apple Developer Program** ($99/year).
2. In Xcode or the developer portal, create a **"Developer ID Application"** certificate
   and install it in your login keychain. Confirm with:
   ```bash
   security find-identity -v -p codesigning
   ```
   You should see a line like `"Developer ID Application: Your Name (TEAMID)"`.
3. Create an **app-specific password** for notarization at appleid.apple.com
   (Sign-In & Security → App-Specific Passwords).

### Configure (no code edits — env + one flip)
1. In `package.json`, change `build.mac.identity` from `null` to your identity string,
   e.g. `"Developer ID Application: Your Name (TEAMID)"`, and add `"notarize": true`
   under `build.mac`.
2. Export credentials in your shell (do NOT commit these):
   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="TEAMID"
   ```
3. Build a real signed + notarized DMG directly with electron-builder (this replaces the
   ad-hoc `npm run dist` path for releases):
   ```bash
   npx electron-builder --mac dmg --arm64 --publish never
   ```
   electron-builder will sign with the hardened runtime + `build/entitlements.mac.plist`,
   submit to Apple's notary service, and staple the ticket.
4. Verify before uploading:
   ```bash
   spctl -a -vvv -t install "release/mac-arm64/Snip Pilot.app"
   xcrun stapler validate "release/Snip Pilot-0.3.0-arm64.dmg"
   ```

### Optional: real auto-update
Once builds are Developer-ID-signed, you can replace the manual "Check for Updates…"
item with full background auto-update:
```bash
npm i electron-updater
```
and use `autoUpdater.checkForUpdatesAndNotify()` in `src/main.js`. Squirrel.Mac requires a
valid Developer ID signature to apply updates, which is why this is gated behind signing.
The `publish` block in `package.json` already points at the GitHub repo, so
`electron-builder --publish always` will upload the update feed.

---

## Notes

- The App Sandbox (Mac App Store) is a separate, larger effort — see `NEXT_VERSION.md` §6.
  The entitlements here are **Hardened Runtime** entitlements for direct distribution, not
  sandbox entitlements.
- Keep `scripts/sign-mac-app.sh` for fast local test builds; it does not need a cert.
