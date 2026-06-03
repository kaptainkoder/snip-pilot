# Snip Pilot Handoff For Review / UX Polish

Repo: https://github.com/kaptainkoder/SnipPilot---macOS
Current published release: https://github.com/kaptainkoder/SnipPilot---macOS/releases/tag/v0.2.4
Current published commit: `1588097`
Local project path: `/Users/karan/Documents/Codex Projects/Screenshot app`

> **Important: Use the local uncommitted code in `/Users/karan/Documents/Codex Projects/Screenshot app`, not only the GitHub release. The local uncommitted `src/main.js` shelf fix is the version that is currently working fine in manual testing and should be reviewed/polished before packaging or publishing.**

## What Snip Pilot Is

Snip Pilot is a local-first macOS screenshot/snipping app built with Electron. It supports:

- `Cmd+2` normal snip shortcut.
- Local-only storage under `~/Documents/Codex Projects/SnipPilotSnips`.
- `Pending` and `Copied` buckets.
- Left-side floating preview shelf for pending snips.
- Annotation/editing, then auto-copy/close behavior.
- Configurable local storage and shortcut in app Settings.
- Scroll snip exists but should be considered experimental/best-effort.

## Important Current State

The GitHub release/DMG is still `v0.2.4` from commit `1588097`.

However, the version to review/test is the **local uncommitted working copy** at:

`/Users/karan/Documents/Codex Projects/Screenshot app`

This local working copy includes an uncommitted `src/main.js` patch for floating preview persistence. The user confirmed this local uncommitted version is working fine and wants Claude to use it as the base for review/improvement.

Current local git status:

```bash
 M src/main.js
```

Current local diff summary:

```
src/main.js | 85 +++++++++++++++++++++++++++++++++++++++++++++++++++++--------
1 file changed, 74 insertions(+), 11 deletions(-)
```

## Floating Preview Bug Context

User reported:

- Normal snipping works.
- After Mac sleep/lock overnight, the floating preview sometimes did not appear on the current active tab/window.
- In some cases it appeared behind another tab/window.

Desired behavior: the floating preview should appear over whatever window/tab the user is currently using and persist while switching apps/tabs until the user actions it with close/copy/done.

## What The Local Patch Does

In `src/main.js`, the patch:

- Imports `powerMonitor`.
- Adds `shelfWatchdog`.
- Adds `shelfWindowBounds()`.
- Adds `keepShelfAvailableOnCurrentWorkspace()`.
- Makes shelf position based on current display work area.
- Reasserts:
  - `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
  - `setAlwaysOnTop(true, 'screen-saver')`
  - `moveTop()`
- Starts a 1.5s watchdog while pending snips exist.
- Stops watchdog when no pending snips exist.
- Reasserts shelf after:
  - `app activate`
  - `resume`
  - `unlock-screen`
  - display added/removed/metrics changed

Important: A previous attempted `type: 'panel'` / `focusable: false` approach was backed out because it made the shelf disappear after real capture. Do not reintroduce that without careful testing.

## Current Local Test Results

Local patched app was built and installed to:

`/Users/karan/Applications/Snip Pilot.app`

Smoke tests performed:

- `node --check src/main.js` passes.
- App runs only from `/Users/karan/Applications/Snip Pilot.app`.
- Disposable test snip was removed after testing.
- Floating preview appeared with a pending snip.
- Preview stayed visible over Snip Pilot.
- Preview stayed visible over Chrome.
- Preview stayed visible after switching Chrome tabs.

The user has not yet confirmed manual testing after the final local patch. Do not publish/package until user confirms.

## Suggested Claude Review Focus

Please review/opine on:

- Whether the shelf watchdog approach is appropriate or too heavy.
- Whether there is a cleaner Electron/macOS pattern for a non-intrusive floating screenshot shelf.
- Whether `screen-saver` always-on-top level is too aggressive.
- Whether shelf should be on the active display, fixed left display, or last capture display.
- Whether the app should expose a user setting for shelf position/behavior.
- Ways to make the UI smoother:
  - shelf animation
  - less intrusive preview size
  - better close/copy affordance
  - clearer pending/copied state
  - better startup/permission messaging
- Security/privacy implications of clipboard + local storage.
- Whether to add a simple app health indicator for shortcut registration and screen permission.

## Manual Test Flow To Validate Before Publishing

1. Open Snip Pilot from:
   `/Users/karan/Applications/Snip Pilot.app`
2. Press `Cmd+2` and take a snip.
   Expected:
   - One PNG appears in:
     `/Users/karan/Documents/Codex Projects/SnipPilotSnips/Pending`
   - Floating preview appears on the left.
3. Switch to Chrome, Safari, Finder, and another tab.
   Expected:
   - Floating preview stays visible over the active window.
4. Click the floating preview.
   Expected:
   - Editor opens.
5. Close/copy/done the edit.
   Expected:
   - Image is copied to clipboard.
   - Pending item updates or moves appropriately.
   - No `.json` or `.md` sidecar files are created.
6. Sleep/lock Mac, wake/unlock, then switch windows.
   Expected:
   - Existing pending floating preview is still visible or reappears promptly.

## Do Not Do Yet

Do not push, package, or publish a new DMG until the user manually confirms the local patch works.

## Useful Commands

Check current diff:

```bash
git diff -- src/main.js
```

Build/sign local app:

```bash
npm run pack
```

Install local signed app:

```bash
pkill -KILL -f '/Users/karan/Applications/Snip Pilot.app' || true
rm -rf '/Users/karan/Applications/Snip Pilot.app'
ditto 'release/signed-mac-arm64/Snip Pilot.app' '/Users/karan/Applications/Snip Pilot.app'
open '/Users/karan/Applications/Snip Pilot.app'
```

Check pending snips:

```bash
find '/Users/karan/Documents/Codex Projects/SnipPilotSnips/Pending' -maxdepth 1 -type f -name '*.png' -print
```
