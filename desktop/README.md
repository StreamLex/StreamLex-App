# Relay desktop app (Electron)

Wraps the existing local bridge into a double-click app. The bridge still serves
`/control` and `/overlay` on `localhost:4455`, so your **OBS browser source keeps
working unchanged** — the app is just a friendly launcher + window around it.

## Run it in development
```bash
npm install        # first time only (downloads Electron)
npm start          # launches the app (also runs the bridge)
```

## Build installers
```bash
npm run dist       # builds for your current OS into ./dist
```
- Windows → `dist/Relay-Setup-<version>.exe` (NSIS installer)
- macOS   → `dist/Relay-<version>.dmg`
- Linux   → `dist/Relay-<version>.AppImage`

## Releasing with auto-update (CI)
1. In `package.json` → `build.publish`, set `owner`/`repo` to your GitHub repo.
2. Add code-signing secrets to the repo (see `.github/workflows/build.yml`):
   - Windows: `WIN_CSC_LINK` (base64 of your `.pfx`) + `WIN_CSC_KEY_PASSWORD`
   - macOS: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
3. Tag a release: `git tag v0.1.0 && git push --tags`.
   CI builds signed installers for Windows + macOS and publishes a GitHub Release.
   The app checks that release feed on launch and self-updates (electron-updater).

## Where user data lives
The app sets `RELAY_DATA_DIR` to Electron's `userData` folder, so the API key
(`relay.env`) and overlay config (`relay-config.json`) are written there — the
installed app folder stays read-only. Nothing else about the bridge changes.

## Own-voice speech engine (whisper.cpp)
The browser Web Speech API doesn't work inside Electron, so own-voice captions use
a bundled **whisper.cpp** engine instead ([whisper-engine.js](whisper-engine.js)).
On first launch the app downloads a small CPU binary (~4 MB) and a voice model
(`base`, ~148 MB) into the user-data folder, runs `whisper-server` (loads the model
once), and the Control window streams each spoken phrase to it for transcription.
A toast shows the one-time download progress; **Go live** is enabled once it's ready.

- Model is set by `WHISPER_MODEL` in `main.js` (`tiny` / `base` / `small`).
- Today this path is **Windows x64**; other platforms report unsupported and fall
  back to the "Open Control in browser" menu item. (macOS/Linux prebuilt binaries
  are a follow-up.)

## Icons
Add `icon.ico` / `icon.icns` / `icon.png` to `desktop/build/` before shipping —
see `desktop/build/ICONS.md`. Builds work without them (default Electron icon).
