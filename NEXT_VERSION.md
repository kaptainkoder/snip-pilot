# Snip Pilot — v0.3 Change Plan (Proposed)

Target: a polished, signed, **notarized** build distributed via GitHub (DMG). Mac App Store
is deferred to a later milestone (see §6). This is a proposal only — no code has been changed.
Base for all work is the **local uncommitted working copy** (`src/main.js`), not the v0.2.4 release.

Reference grounding: read of `src/main.js` (1,249 lines), `package.json`, and `HANDOFF.md`.

---

## 1. Publishing readiness (gate for any release)

These are the things standing between the current code and a "proper," distributable app.

**Signing & notarization (required)**
- `package.json > build.mac.identity` is currently `null` (ad-hoc/unsigned). Switch to a real
  **Developer ID Application** certificate.
- Enable **hardened runtime** and add a notarization step (`electron-builder` + `notarytool`
  via an `afterSign` hook, or `@electron/notarize`). Without notarization, Gatekeeper blocks the
  app on other machines.
- Add an **entitlements.plist**. For direct distribution the key one is
  `com.apple.security.cs.allow-jit` / disable-library-validation only if needed; screen capture
  works through TCC (permission prompt), not an entitlement, on the Developer ID path.

**Distribution mechanics**
- Add a **DMG target with a designed background + icon layout** (already have `dmg` target; needs art).
- Add an **app icon** (`.icns`). Tray icon is currently empty — see §3.
- Add **auto-update** via `electron-updater` pointed at GitHub Releases, so users get v0.3.1+
  without re-downloading manually. This also gives you a clean publish pipeline.
- Bump version `0.2.4 → 0.3.0`; write release notes; tag and publish via the existing
  `npm run dist` flow once notarization is wired in.

**Legal/store basics (cheap, do now)**
- Ship a short **PRIVACY.md** ("local-first, no network, no telemetry") — it's both true here and
  required if you ever go to MAS. The `onBeforeRequest` filter already blocks all non-local
  traffic, so this is an easy, honest selling point.
- Confirm `LICENSE` (MIT per package.json) is present in the repo root.

---

## 2. Stability & correctness (ship-blockers found in code)

- **Tray icon is invisible.** `createTray()` uses `nativeImage.createEmpty()` (line ~1017), so the
  menu-bar item has no glyph. Add a template PNG/PDF icon. For a menu-bar-centric app this is a
  visible bug.
- **Shortcut-registration failure is silent.** `registerCaptureShortcut()` only does
  `console.error` on failure (line ~139). If `Cmd+2` is taken by another app, the user gets no
  feedback. Surface it in the UI and offer a fallback / re-pick (ties into §3 health indicator).
- **Devtools protocol is allowed in production.** `onBeforeRequest` whitelists `devtools:`
  (line ~1032). Gate devtools off in packaged builds.
- **Scroll capture only ever uses the primary display.** `capturePrimaryDisplay()` and the scroll
  frame windows are pinned to `screen.getPrimaryDisplay()`. On a multi-monitor setup scroll snips
  on a secondary display will be wrong. Either fix to the active display or clearly gate the
  feature (it's labeled experimental).
- **No tests.** Add at least: `node --check` in CI, plus unit tests around the stitching math
  (`findOverlap`, `compareFramePair`, `stitchScrollFrames`) since that's the most fragile logic.
- Add a lightweight **CI workflow** (lint + `node --check` + build) on push/PR.

---

## 3. First-run, permissions & a health indicator

The handoff explicitly asks for this; the building blocks already exist in code.

- **First-run onboarding.** `appConfig.configured` already tracks setup state and `appInfo()`
  returns `setupRequired`. Build a real first-run screen: pick storage folder, confirm shortcut,
  and walk the user through granting **Screen Recording**.
- **Health indicator.** You already compute `screenRecordingStatus()` and `shortcutRegistered`.
  Surface both as a small status row (green/amber) in the main window: "Shortcut Cmd+2 ✓",
  "Screen Recording ✓". One-click deep-link to System Settings on failure (you have the help text
  in `screenRecordingHelp()` — turn it into an actionable button).
- **Capture-failure UX.** `startSnip` currently throws to a `dialog.showErrorBox`. Make the
  permission case a friendly inline panel rather than a raw error dialog.

---

## 4. Floating shelf — UX smoothing (the heart of the handoff)

The current watchdog approach **works and should stay as the base**. Refinements, lightest-touch
first:

- **Reduce watchdog cost.** The 1.5s `setInterval` (`startShelfWatchdog`) is pragmatic but blunt.
  You already reassert on the right events (`activate`, `resume`, `unlock-screen`, display changes
  via `reassertShelfWindowSoon`). Consider lengthening the interval (e.g. 3–4s) or making it a
  self-healing check that only acts when the shelf has actually fallen behind, rather than calling
  `moveTop()` unconditionally every tick. Keep it as a safety net, not the primary mechanism.
- **`'screen-saver'` always-on-top is aggressive.** It sits above almost everything including some
  system UI. Recommend dropping to `'floating'` or `'normal'`+reassert, and only escalating to
  `screen-saver` if testing shows the shelf gets buried. Make the level the single knob you tune.
- **Do NOT reintroduce `type:'panel'` / `focusable:false`** blindly — the handoff notes it broke
  visibility after capture. If you want a true non-activating panel later, prototype it behind a
  flag with the full manual test flow.
- **Animation.** Add a slide-in/fade for the shelf and per-item enter/exit. Purely renderer-side
  (CSS transitions in `shelf.html`), no main-process risk.
- **Less intrusive footprint.** Current shelf is a fixed 340px-wide column (`shelfWindowBounds`).
  Offer a compact thumbnail-strip mode and/or a collapse toggle; remember the choice in config.
- **Clearer affordances.** Per-thumbnail hover controls for Copy / Edit / Discard, a pending-count
  badge, and a clear visual distinction between Pending and Copied states.
- **Position setting.** Expose shelf position/behavior in Settings (left/right, active vs. fixed
  vs. last-capture display, always-on-top level). The handoff calls this out directly; the bounds
  logic is already centralized in `shelfWindowBounds()` so it's a contained change.

---

## 5. Privacy & security

The current posture is already strong — worth preserving and advertising:

- **Keep the good parts:** `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`,
  `setWindowOpenHandler` deny, `will-navigate` lockdown, permission handler denies all, and the
  network kill-switch in `onBeforeRequest`. This is a clean baseline.
- **Extend `setContentProtection(true)`** (currently only on the scroll windows) to the **shelf and
  editor** windows so snips containing sensitive content don't leak into other screen recordings.
- **Clipboard awareness.** Copy paths write images/text to the system clipboard (expected), but
  that clipboard is readable by any app. Consider a setting to auto-clear after N minutes, and make
  the behavior explicit in onboarding/privacy doc.
- **At-rest storage.** Snips are plaintext PNGs in `~/Documents/...`. Fine for local-first, but
  document it; optionally offer a "store in Application Support (hidden)" mode.
- **Reaffirm zero-network** in PRIVACY.md — the code backs the claim, which is a real
  differentiator.

---

## 6. Mac App Store (later milestone — not v0.3)

Captured here so it isn't forgotten. MAS requires the App Sandbox, which conflicts with three
current design choices:

1. `execFile('/usr/sbin/screencapture', …)` — not allowed sandboxed. Rewrite capture on
   `desktopCapturer` / ScreenCaptureKit.
2. `globalShortcut.register('Command+2')` — system-wide hotkeys are restricted/often rejected.
   May need a different interaction model or an entitlement justification.
3. Writing arbitrary `~/Documents` folders — needs **security-scoped bookmarks** for the
   user-chosen directory.

Plus: Apple Distribution cert + provisioning profile, `mas` electron-builder target, and full
sandbox entitlements. Treat as a dedicated effort after v0.3 ships.

---

## Suggested sequencing for v0.3

1. **Unblock release:** signing + hardened runtime + notarization + icon + tray-icon fix. (§1, §3 icon)
2. **Trust & feedback:** health indicator, first-run permission flow, surfaced shortcut failures. (§3)
3. **Shelf polish:** always-on-top level tuning, animation, affordances, position setting. (§4)
4. **Privacy hardening:** content protection on shelf/editor, PRIVACY.md, clipboard setting. (§5)
5. **Correctness:** multi-display scroll fix or gating, stitching tests, CI. (§2)
6. **Publish:** auto-update wiring, release notes, tag v0.3.0.

Nothing here changes the core capture/annotate/copy loop — it hardens and smooths it.
