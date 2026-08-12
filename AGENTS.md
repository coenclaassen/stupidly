# Agent Notes

## Project Structure

- `extension/` contains the Chrome extension that ships to users.
- `chrome-web-store/` contains listing text and store images. Do not include this in the extension package.
- `scripts/` contains helper scripts.
- `dist/` contains generated packages and is ignored by Git.

## Development

This is a plain Chrome extension. Keep it simple: vanilla HTML, CSS, and JavaScript. Do not add a build system unless there is a clear need.

Load the extension locally from the `extension/` folder.

## Packaging

The Chrome Web Store zip must have `manifest.json` at the zip root.

To create the upload package:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
```

Upload the generated zip from `dist/`.

Do not commit `dist/`.

## Release Checklist

Before publishing:

- Confirm `extension/manifest.json` has the intended version.
- Run syntax checks:
  - `node --check extension/service-worker.js`
  - `node --check extension/settings.js`
  - `node --check extension/blocked.js`
- Run the packaging script.
- Inspect the zip and confirm:
  - `manifest.json` is at the zip root
  - `chrome-web-store/` is not included
  - only extension runtime files are included
- Manually load `extension/` in Chrome and smoke test timers/settings.

## Product Behavior To Preserve

- Site timers count only active foreground tab time.
- If the tab/window loses focus, timers pause.
- Existing settings require the active wait period before editing.
- New rules can be added immediately.
- Invalid edits on existing rules should shake and revert to the saved value.
- The extension badge shows the configured daily limit minutes for the active limited domain.
- User settings and usage stay local in Chrome storage.

## Git

Avoid force-pushing. If `origin/main` has moved, fetch and rebase before pushing.
