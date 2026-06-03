# Changelog

## v0.3.0

First polished, packaged release built on the local-first capture/annotate/copy loop.

### Added
- **Visible menu-bar (tray) icon** — replaces the previously empty tray image.
- **User-initiated update check** — "Check for Updates…" in the tray menu compares against
  the latest GitHub release. This is the only time the app touches the network, and only
  when you ask it to.
- **Health indicator** in the main window — shows whether the capture shortcut registered
  and whether Screen Recording is granted, with a one-click link to System Settings.
- **Clipboard auto-clear** setting (off by default) — optionally wipe the clipboard a chosen
  number of minutes after copying a snip.
- **Content protection** on the floating shelf and editor windows, so snips don't leak into
  other apps' screen recordings or screenshots.
- `LICENSE` (MIT), `PRIVACY.md`, unit tests for the scroll-stitching math, and a CI workflow
  (`node --check` + tests).

### Changed
- **Floating shelf reliability** — the shelf reasserts itself over the active window after
  sleep/unlock, display changes, and app activation, and stays put while you switch apps.
- Scrolling snip now clearly **requires the primary display** and tells you so instead of
  capturing the wrong screen on multi-monitor setups.
- DevTools protocol is blocked in packaged builds.
- Build hardening scaffold added (hardened runtime, entitlements, GitHub publish config).
  Builds remain **ad-hoc signed** for now; notarization is a later, credential-only step.

### Notes
- Because this build isn't notarized yet, macOS warns on first launch. Right-click
  **Snip Pilot.app → Open → Open** once. See `RELEASE.md`.
