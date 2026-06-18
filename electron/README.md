# screensound (Electron)

The Electron port of `screensound`. It started as throwaway spikes to prove the
make-or-break feature — **nut.js injecting synthetic input (move + click + type +
Enter) into other apps** — and grew, step by step, into one app: capture +
compare + sound + injection + Telegram, with a tray and F9/F10 hotkeys. The
SPIKE env switch and the separate inject/telegram pages are retired (see git
history); `pnpm start` launches the app (`capture.html`).

## Run it (on the Mac)

```bash
cd electron
pnpm install
pnpm start
```

`pnpm install` builds a native module (`node-gyp`). If it fails, you need Xcode
command line tools: `xcode-select --install`. `pnpm start` bundles the renderer
then launches Electron.

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
  runs it (during `pnpm start` that's **Electron**; in a packaged build it's the
  app itself). Screen capture also needs **Screen Recording** (prompted on first
  Start).

You may need to quit and relaunch after granting.

## Using it

The UI is a light-theme single window: a header (Start/Stop · **F9/F10**), a
collapsible **Configuration** panel (Detection sliders + Telegram), and a
**Watched zones** table. (Hotkeys + detection defaults live in `constants.js`.)

1. Click **Select zones** (or press **F8**) → the app hides itself and opens a
   **fullscreen overlay** of your screen. Drag rectangles (right-click undo, **Enter**
   confirm, **Esc** cancel). Each becomes a row (`z1`, `z2`, …) with a thumbnail,
   similarity bar, state pill, frozen count, and per-zone **Active / Sound / Enter /
   Telegram** toggles (the action icons; pink = on). **Show zones** re-opens the
   overlay read-only.
2. **Start · F9** (header button, hotkey, or tray) begins monitoring; **F10**
   stops. Tune **Similarity threshold / Capture interval / Consecutive frames**
   live.
3. Telegram **Bot token + Chat ID** are editable; **Save** writes
   `~/.config/screensound/.env` and the badge flips to *Connected*. Per zone, the
   **Enter** and **Telegram** toggles decide what fires on freeze (both off by
   default). **Defocus click** sets a point clicked after a typed reply so the
   caret stops blinking.
4. Hold a zone still → it FREEZES: the alert beeps and the enabled side effects
   fire once. Telegram replies (when ≥1 telegram-enabled zone is frozen):
   - **`z2: hello`** → types "hello" into z2; plain text → the last tapped / last
     frozen zone.
   - **`enter`** (any case, or `z2: enter`) → simulates the **Enter key only** (no
     text) — for freezes you just need to advance.
   - With **2+ telegram-enabled zones frozen**, you also get a **chooser** message
     with a button per zone; tapping one sends **Enter** to it and pre-selects it
     for your next reply.

   Closing the window (✕) quits the app; the tray can hide/show it while open.

## Migration progress

- **Step 1 (input injection)** — ✅ confirmed working on macOS (this spike).
- **Step 2 (pure domain → TS)** — ✅ `src/domain.ts` + `src/domain.test.ts`.
  Run: `pnpm test` (11 tests).
- **Step 3 (capture + compare loop)** — capture the screen via `desktopCapturer`
  and run the real domain on the pixels (`pnpm start`).

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
  chat_id filter). Creds load from `SCREENSOUND_TELEGRAM_TOKEN` /
  `SCREENSOUND_TELEGRAM_CHAT_ID` (real env vars, or `electron/.env`, or the
  repo's `../.env`). Now wired into the app (steps 7b/7c), not a standalone page.

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

- **Step 7d-3 (tray)** — the capture app now has a system **tray** icon
  (`tray-icon.png`, a 32×32 generated via node zlib). Menu: Show / Start (F9) /
  Stop (F10) / Quit; Start/Stop reuse the same "hotkey" IPC as the shortcuts.
  Closing the window now **hides** it (the tray keeps the app alive); only Quit
  exits. Gated to the capture spike. Main-process wiring — no tests. (Step 8 must
  ship `tray-icon.png` with the app.)

- **Step 7d-4 (retire the SPIKE switch)** — ✅ done. `main.js` always loads
  `capture.html` (no env branching); F9/F10 + tray + hide-on-close are
  unconditional. Deleted the dead inject/telegram pages (`index.html`,
  `renderer.js`, `telegram.html`, `src/telegram-spike.ts`). `pnpm start` builds
  the renderer and launches the app; `build:renderer` bundles only
  `capture-spike.ts`. Step 7 complete.

- **Step 8 (packaging — personal/unsigned)** — ✅ configured (build runs on the
  Mac; see **Packaging** below). `electron-builder` config in `package.json`:
  unsigned (`mac.identity: null`), DMG target, app icon `assets/icon.png`
  (auto-converted to `.icns` on macOS), `tray-icon.png` bundled, native nut.js
  unpacked from the asar, `.env` excluded from the package. Scripts: `pnpm pack`
  (quick `.app`) / `pnpm dist` (DMG).

- **Redesign (light theme, full UI)** — ✅ the app was rebuilt to a polished
  light-theme design: header + collapsible Configuration (Detection sliders /
  stepper / toggles, editable+savable Telegram creds, defocus click) + a Watched
  zones table (thumbnail, similarity bar, state pill, frozen count, per-zone
  Active + Sound toggles). Zone selection moved to a **fullscreen overlay**
  (`overlay.html` / `src/overlay.ts`) — full-screen precision with the same
  DPI-free `cssRectToBbox` mapping (it grabs the same getDisplayMedia frame the
  monitor samples). Hotkeys + detection defaults centralized in `constants.js`
  (start/stop = **F9/F10**). New main IPC: save creds (to
  `~/.config/screensound/.env`, 0600), open overlay, get version, defocus click
  in `run-injection`. UI text English; version reads `VERSION` (1.6.0).

Optional polish (deferred): Developer ID signing + notarization (stable TCC
permissions, distributable); rename `capture.html` / `capture-spike.ts` (the
"spike" name is now a misnomer); macOS template tray icon.

## Packaging (macOS, personal/unsigned)

Must run **on the Mac** (electron-builder can't cross-build a macOS app from
Linux).

```bash
cd electron
pnpm install
pnpm dist      # -> dist/screensound-0.1.0-<arch>.dmg   (or: pnpm pack for a bare .app)
```

It builds unsigned (no Apple Developer account needed). Gotchas:

- **Gatekeeper**: first launch is blocked — right-click the app → **Open** (or
  `xattr -cr /Applications/screensound.app`). On Apple Silicon electron-builder
  ad-hoc signs so the binary runs.
- **Permissions**: grant **Accessibility** (nut.js input) and **Screen
  Recording** (capture) in System Settings → Privacy & Security. Because the
  build is unsigned, macOS may ask you to **re-grant** after a rebuild (the
  binary identity changes) — that's the tradeoff vs. Developer ID signing.
- The icon (`assets/icon.png`) and `tray-icon.png` are committed, so the build
  has them on a fresh clone.
