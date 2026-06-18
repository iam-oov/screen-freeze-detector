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

- **Step 5 (Telegram)** — `src/telegram.ts`: `TelegramNotifier` (sendPhoto via
  fetch + FormData) and `TelegramPoller` (getUpdates long-poll, skips backlog,
  chat_id filter). Try it:

  ```bash
  pnpm start:telegram
  ```

  Creds prefill from `SCREENSOUND_TELEGRAM_TOKEN` / `SCREENSOUND_TELEGRAM_CHAT_ID`
  (real env vars, or `electron/.env`, or the repo's `../.env`). **Send test
  photo** → a gradient image lands on your phone; **Start poller** → message
  your bot from the configured chat and it shows up (other chats are ignored).

- **Step 6 (zone selector)** — ✅ in the capture spike: after Start, **drag a
  rectangle over the live preview** to pick the zone to monitor. The drawn rect
  is mapped from the video's displayed CSS pixels into capture pixels
  (`cssRectToBbox`), so the zone lives in the exact frame `grabRegion` samples —
  no logical-vs-physical (Retina/DPI) mapping needed. Until you draw one it
  watches the centered region. `pnpm test` covers the mapping (3 tests).

  Tradeoff: the preview is scaled down, so small zones are picked coarsely —
  resize the window bigger for precision. A production overlay (fullscreen
  screenshot, draw zones at native resolution) would be more precise but must
  solve the DPI mapping this approach sidesteps.

- **Step 7a (real injector in the live loop)** — the capture spike no longer
  stubs injection: on the freeze edge it asks main (nut.js, via preload) to
  click the zone center + press Enter on the REAL screen. Opt-in via the **Press
  Enter on freeze** checkbox (so a capture test doesn't hijack the mouse).
  `bboxCenterToScreen` converts the zone's physical capture-pixel center into the
  logical screen points nut.js expects — the Retina inverse of the selector.
  `pnpm test` covers it (16 tests). macOS needs Accessibility permission (same
  as the inject spike).

- **Step 7b (real Telegram notifier in the loop)** — the freeze edge now also
  fires the real `TelegramNotifier.notifyFrozen` (sendPhoto, verified in step 5):
  the frozen zone's PNG lands on your phone. Creds load from env/.env via the
  preload bridge; opt-in via the **Send Telegram photo on freeze** checkbox
  (disabled, with a hint, when no creds). Wiring only — no new tests.

- **Step 7c (Telegram remote — reply types into the zone)** — `TelegramPoller`
  is wired back the other way: a chat reply from the configured chat is typed
  into the **last frozen zone** (click its center + type + Enter via nut.js,
  reusing `bboxCenterToScreen`). Opt-in via the **Telegram remote** checkbox,
  which start/stops the poller. The freeze edge records `lastFrozenBbox`; a reply
  before anything froze is ignored with a hint. Wiring only — no new tests.

  With 7a–7c the capture spike now runs the FULL pipeline end-to-end in one
  process: freeze → beep + Enter into the zone + photo to phone, and a phone
  reply → typed back into the zone. All three side effects are opt-in checkboxes.

- **Step 7d-1 (multi-zone)** — the capture spike now monitors MANY zones, not
  one. Each drag adds a `ZoneConfig`/`ZoneState` pair (the domain already took
  parallel arrays), draws a persistent coloured rectangle on the preview, and
  adds a list row showing its live similarity / FROZEN state with a **remove**
  button. The freeze edge fires per-zone (beep + Enter + photo), and a phone
  reply types into whichever zone last froze. The centered-region fallback is
  gone — a real app needs explicit zones. Wiring only — no new tests.

- **Step 7d-2 (settings)** — **Threshold**, **Interval ms** and **Consec frames**
  (the old constants) are now editable inputs, read live: threshold/consec take
  effect on the next tick; changing the interval restarts the tick loop and
  retunes the sound throttle. Defaults 0.99 / 500 / 3. `WebAudioSound` got a
  `setCooldown`. Wiring only — no new tests.

Next (step 7): 7d-3 a tray icon; then drop the SPIKE env switch so this page IS
the app (the inject/telegram spikes are now subsumed). Then step 8: packaging +
signing.
