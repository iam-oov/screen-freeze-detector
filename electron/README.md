# Electron input-injection spike

Goal: prove that **nut.js can inject synthetic input (move + click + type + Enter)
into other applications on your Mac** — the one feature that does NOT come for
free in Electron and that decides whether migrating `screensound` is worth it.

This is throwaway proof-of-concept code. It is NOT the migration.

## Run it (on the Mac)

```bash
cd electron
npm install
npm start
```

`npm install` builds a native module (`node-gyp`). If it fails, you need Xcode
command line tools: `xcode-select --install`.

If the `@nut-tree-fork/nut-js` version fails to resolve, install the latest:

```bash
npm install @nut-tree-fork/nut-js@latest
```

### pnpm: "Electron failed to install correctly"

pnpm v9+ blocks dependency build scripts by default, so Electron's postinstall
(which downloads the actual binary) never runs — `electron .` then throws
"failed to install correctly". `package.json` already allowlists it via
`pnpm.onlyBuiltDependencies`, but if the package was already cached unbuilt,
force the postinstall:

```bash
pnpm rebuild electron
```

Verify it worked: `node -e "console.log(require('electron'))"` should print a
path ending in `/dist/electron`, not throw.

### Linux: "The SUID sandbox helper binary ... is not configured correctly"

Linux-only (does NOT happen on macOS). Chromium's sandbox helper must be SUID
root. For a throwaway spike, just disable the sandbox:

```bash
pnpm start -- --no-sandbox
```

(The proper fix, if you care: `sudo chown root:root <dist>/chrome-sandbox &&
sudo chmod 4755 <dist>/chrome-sandbox`. Don't ship `--no-sandbox` in a real app.)

## Grant permission (macOS)

Synthetic input requires Accessibility permission. The first run will fail until
you grant it:

- **System Settings → Privacy & Security → Accessibility** → enable the app that
  runs it (during `npm start` that's **Electron**; in a packaged build it's the
  app itself).

You may need to quit and relaunch after granting.

## What success looks like

1. Open TextEdit (or any text field) and note where its text area sits on screen.
2. Put those coordinates in the X / Y fields, hit **Run**.
3. During the 5s countdown, don't touch anything.
4. nut.js clicks that point and types the text + Enter into TextEdit.

Log shows `RESULT: nut.js injection WORKS ✅` → the migration is viable.
Log shows `FAILED ❌` → read the error; usually missing Accessibility permission.

## Migration progress

- **Step 1 (input injection)** — ✅ confirmed working on macOS (this spike).
- **Step 2 (pure domain → TS)** — ✅ `src/domain.ts` + `src/domain.test.ts`.
  Run: `pnpm test` (11 tests).
- **Step 3 (capture + compare loop)** — capture the screen via `desktopCapturer`
  and run the real domain on the pixels:

  ```bash
  pnpm start:capture
  ```

  Click **Start** (or press **F9**; **F10** stops). Hold the screen still → it
  FREEZES and the Web Audio alert beeps each tick; move a window or play a video
  → it breaks. On macOS the first capture prompts for **Screen Recording**
  permission (System Settings → Privacy & Security).

  Note: capture resolution is physical pixels — on a Retina Mac that's 2× the
  logical screen size, so real zone-coordinate mapping must scale for DPI. The
  spike sidesteps this by comparing a centered fraction of the captured frame.

- **Step 4 (sound + global hotkeys)** — ✅ wired into the capture spike above:
  `WebAudioSound` (two 880Hz beeps, cooldown) plays on the freeze via the real
  `FreezeMonitor`; `globalShortcut` F9/F10 start/stop monitoring.

Next: Telegram (notifier + poller), then the real UI + zone selector, then
packaging + signing.
