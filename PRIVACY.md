# Snip Pilot Privacy

Snip Pilot is **local-first** and designed to make zero background network calls.
This document describes exactly what the app does and does not do with your data.

## What stays on your Mac

- **Your snips** are saved as plain PNG files in a folder you choose (default:
  `~/Documents/SnipPilotSnips`, in `Pending/` and `Copied/`).
- **Your settings** live in a single local `config.json` under the app's user-data
  directory. Nothing is uploaded.
- Snip Pilot writes **no `.json` or `.md` sidecar files** next to your images, and
  proactively removes any it finds in the snip folders.

## No telemetry, no background network

- Snip Pilot has a network kill-switch: the app's session blocks every request whose
  protocol is not `file:` or `data:` (see `onBeforeRequest` in `src/main.js`). There is
  no analytics, no crash reporting, and no phone-home.
- The **only** time the app touches the network is when you explicitly click
  **"Check for Updates…"** in the menu-bar menu. That request goes to the GitHub
  Releases API to compare version numbers, and nothing about you or your snips is sent.

## Clipboard

- Copying a snip writes the image to the system clipboard (that is the point of the
  feature). The macOS clipboard is readable by other apps while it holds that image.
- Snip Pilot offers an optional **auto-clear** setting: after a snip is copied, the app
  can clear the clipboard after a number of minutes you choose. It is **off by default**.

## Screen capture & permissions

- Capturing the screen uses the system `screencapture` tool and requires macOS
  **Screen Recording** permission, which you grant in System Settings. Snip Pilot does
  not record audio or video.
- The floating shelf and the editor window enable macOS **content protection**, so the
  snips they show do not leak into other apps' screen recordings or screenshots.

## At-rest storage

Snips are stored unencrypted as PNGs in the folder you choose, so they inherit that
folder's protection. If you need stronger protection, store them in an encrypted volume
or your account's FileVault-protected home directory.

## Distribution

Builds published on GitHub are currently signed ad-hoc (not yet notarized). See
`RELEASE.md` for first-launch instructions and the path to a notarized build.
