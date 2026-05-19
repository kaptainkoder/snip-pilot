# Snip Pilot

Snip Pilot is a local-first macOS desktop app for fast snipping, floating quick access, annotation, scrolling capture, and clipboard handoff. It is designed for people who want to capture UI feedback while working and paste the result into a chat, issue, document, or agent workflow without uploading anything to a hosted service.

## Features

- Global `Cmd+2` snip shortcut while the app is running.
- Press `Cmd+2` once for a normal snip, or press `Cmd+2` twice quickly for a scrolling snip.
- Native macOS drag-to-snip capture.
- Floating quick-access stack for pending snips.
- Full editor opened by clicking a floating snip.
- Annotation tools: pen, highlighter, line, arrow, rectangle, circle, redaction, numbered step marker, text box, eraser, undo, and reset.
- Text entry directly on the snip canvas.
- Object-aware eraser for removing annotations without damaging screenshot pixels.
- Auto-copy to clipboard when the editor is closed.
- Best-effort scrolling capture that stitches repeated scroll frames into one tall PNG.
- Clean local library grouped by date with filters for all, today, week, and month.
- Local-only storage with no backend, telemetry, analytics, CDN assets, or auto-upload.

## Local Storage

Snips are stored in a single local folder:

```text
~/Documents/SnipPilotSnips/
  Pending/
  Copied/
```

You can override the storage directory:

```sh
SNIP_PILOT_STORAGE_DIR="/path/to/SnipPilotSnips" npm start
```

Storage behavior:

- New snips are auto-saved as one PNG in `Pending`.
- Closing the editor saves the edited PNG and copies it to the clipboard.
- The floating snip remains in `Pending` so it can be reopened and edited again.
- Clicking the small `x` on a floating snip copies it and moves it into `Copied`.
- `Discard` deletes a pending snip completely.
- No JSON, Markdown, cloud sync, or hidden sidecar files are written by the app.

## Privacy And Security

- Everything runs locally on your Mac.
- Renderer windows use a restrictive Content Security Policy.
- External navigation and popups are blocked.
- Renderer permission requests are denied.
- Network requests are blocked except local `file:`, `data:`, and developer-tool URLs.
- Clipboard writes are local macOS clipboard writes. Other local apps with clipboard access may be able to read copied images.
- Screen Recording permission is required by macOS for screenshot apps.
- Scrolling capture may require Accessibility permission because it sends Page Down keystrokes to the active app.
- Snips are not encrypted at rest. Anyone with access to your macOS account or backups that include the storage folder may be able to read them.

## Install And Run

```sh
npm install
npm start
```

## Package The Desktop App

```sh
npm run pack
```

The packaged macOS app is created under:

```text
release/mac-arm64/Snip Pilot.app
```

## Use It

1. Start Snip Pilot.
2. Press `Cmd+2` once or click `New snip`.
3. Drag a region.
4. Click the floating snip to edit.
5. Add annotations.
6. Click `Copy & close` or close the editor window.
7. Paste the copied image wherever you need it.

For scrolling capture:

1. Press `Cmd+2` twice quickly or click `Scroll snip`.
2. Drag the scrollable region.
3. Keep the target app/window in place while Snip Pilot captures several Page Down steps.
4. The stitched image appears as a pending snip.

## Limitations

- Scrolling capture is best-effort. macOS does not expose a universal scrolling screenshot API for every app.
- The target app must respond to Page Down or equivalent scroll input.
- Highly dynamic pages, sticky headers, lazy-loaded content, and animations can reduce stitch quality.
- If Accessibility permission is not granted, scrolling capture may capture repeated identical frames.

## Development Notes

- Source lives in `src/`.
- Generated app bundles, local snips, and dependencies are ignored by Git.
- The app currently targets macOS.
