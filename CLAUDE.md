# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Screen Freeze Detector (screensound) — an **Electron** desktop app (macOS + Linux) that
monitors screen zones and reacts when they freeze (consecutive captures are nearly
identical). Target use case: detecting paused/buffering videos. Beyond an audible alert it
can auto-press Enter on the frozen zone and act as a Telegram remote control: it sends a
zone image to your phone and types your text reply back into the zone. An earlier
Python/tkinter version was removed once the Electron port reached parity (see git history).

The app lives entirely in `electron/`.

## Tech stack

- Electron 43, TypeScript, `pnpm` (Electron 43+ required on Linux: Electron 31's
  Chromium hit a fatal glibc 2.43 assertion when capturing certain monitors through the
  Wayland portal)
- **esbuild** bundles the renderer (`src/capture-spike.ts`, `src/overlay.ts`) to IIFE
  `.js` next to the HTML. There is **no `tsc`**: types are stripped, never type-checked —
  type errors do NOT fail the build (or the tests).
- `@nut-tree-fork/nut-js` for OS-level synthetic input (click-to-focus, then type+Enter,
  Ctrl+C, or Arrow Up/Down) the main process owns; Chromium's `sendInputEvent` only reaches
  our own windows.
- Screen capture treats every monitor as one virtual desktop: `getDisplayMedia` → one
  hidden `<video>` per display → an offscreen canvas the compositor resizes to each
  requested bbox and fills by drawing the intersecting slice of every live display
  (the Electron equivalent of the old `scrot`, generalised past a single screen).
- Web Audio for the alert sound (oscillator beeps; no audio files).
- Telegram Bot API over `fetch` + `FormData`, directly from the renderer.
- `node --test` runs the assert-based `src/*.test.ts` checks (Node type-stripping).

## Run

```bash
cd electron
pnpm install
pnpm start        # builds the renderer, then launches Electron
pnpm test         # node --test over src/**/*.test.ts
pnpm build:renderer  # esbuild bundle only
pnpm dist         # electron-builder (macOS dmg) — run on the Mac
pnpm dist:linux   # electron-builder Linux .deb (version injected from ../VERSION)
```

Or `./build_deb.sh` (repo root) — a thin wrapper over `pnpm dist:linux` that prints the
install command. See `electron/README.md` for native-module build issues and permissions.

## Key files (all under `electron/`)

- `main.js` — main process: window, tray, global hotkeys, all IPC, nut.js input injection,
  and the `.env` (creds) + `settings.json` (preferences) files.
- `preload.js` — `contextBridge` exposing the `window.spike` API to the renderer.
- `capture.html` + `capture-spike.js` (bundled from `src/capture-spike.ts`) — the app
  window. `capture-spike.ts` is the renderer **and the composition root**.
- `overlay.html` + `src/overlay.ts` — the fullscreen overlay for zone selection / capture
  area / show. A generic resizable-rectangle editor (one pointer pipeline).
- `src/domain.ts` — pure domain (see Architecture).
- `src/capture.ts` (`ScreenCapturer`), `src/sound.ts` (`WebAudioSound`),
  `src/telegram.ts` (`TelegramNotifier` + `TelegramPoller`), `src/prefs.ts`
  (`PreferencesStore` + `DiskPreferencesStore`).
- `constants.js` — tunables (see Constants).
- `../VERSION` — plain-text version, read by `main.js` for the window title.

## Architecture

SOLID. A pure domain with adapters injected by the renderer composition root:

- **Domain** (`src/domain.ts`, no OS / Electron / I/O): `ZoneConfig`, `ZoneState`,
  `RMSComparator`, `FreezeMonitor`, and `stateKind` (traffic-light state vs the threshold).
- **Adapters**: `ScreenCapturer` (capture.ts) — an N-stream compositor, one `<video>` per
  monitor, that answers `grabRegion(bbox)` over the union of every display's bounds —
  `WebAudioSound` (sound.ts), `TelegramNotifier` / `TelegramPoller` (telegram.ts),
  `DiskPreferencesStore` (prefs.ts), and nut.js injection living in `main.js` (driven over
  the `run-injection` IPC).
- **Composition root**: `src/capture-spike.ts` wires the adapters, owns the zones table +
  settings UI, and drives the overlay via `main.js`. `main.js` owns the window, tray,
  hotkeys, OS input, and the config/preferences files.
- **Multi-monitor**: every `Bbox` lives in virtual-desktop DIP coordinates — the union of
  `screen.getAllDisplays().bounds`. `planDraws`/`drawnArea`/`unionBounds`/`bboxCenter`
  (capture.ts) are the pure math behind the compositor and nut.js click targeting; a
  single-monitor setup is just the degenerate case (union == the one display).

## Configuration & secrets

- Telegram credentials (`SCREENSOUND_TELEGRAM_TOKEN`, `SCREENSOUND_TELEGRAM_CHAT_ID`) are
  entered in the Settings UI and **auto-saved** to `~/.config/screensound/.env` (mode
  0600); `main.js` loads them at startup. Real env vars win over the `.env`. Never commit a
  token — `.env` is gitignored.
- User preferences (zones with their bboxes + per-zone toggles + capture zone, threshold,
  interval, consec, volume) **auto-save** (debounced) to
  `~/.config/screensound/settings.json` and restore on launch, via the `PreferencesStore`
  port. The disk adapter is meant to be swappable for a remote (per-user) one later.
- Telegram is opt-in per zone. The poller only obeys messages from the configured
  `chat_id`.

## Important constraints

- **The live renderer is `src/capture-spike.ts`** (bundled to `capture-spike.js`, loaded by
  `capture.html`). `src/capture.ts` is the `ScreenCapturer`, not the renderer.
- **No `tsc` gate** — esbuild strips types; `node --test` type-strips too. Type errors
  won't fail anything, so rely on runtime checks and the tests.
- **Freeze actions are edge-triggered.** `FreezeMonitor` fires Enter injection and the
  Telegram notify only on the not-frozen → frozen transition. The audible alarm is
  **decoupled**: a renderer timer (`updateAlarm`) beeps every `ALARM_REPEAT_MS` while any
  zone is frozen, independent of the capture interval (the monitor gets a no-op sound).
  Because actions are edge-triggered, enabling a toggle on an *already-frozen* zone would
  do nothing, so the app catches up once: `notifyAlreadyFrozen` / `injectAlreadyFrozen`.
- **nut.js injection** (in `main.js`, over `run-injection`) always clicks the zone center
  first to focus it, then does one of: paste text (via clipboard, so accented/Unicode
  survives) + Enter; Ctrl+C; Arrow Up/Down ×N; or click-only (just take focus). A 120ms
  settle after the focus click keeps the first key from being dropped; injections are
  serialized. Needs macOS Accessibility / Linux X11; the packaged Linux app runs `--no-sandbox`.
- **Defocus = focus our own window.** Dropping input focus off a zone (after a typed reply
  or the `defocus` command, and after `up`/`down`) is `mainWin.focus()` over the `focus-app`
  IPC — there is no configured dead-point. Keep the app window off the watched zones, since
  focusing raises it to the front.
- **Telegram uses long-polling**, tracks an `offset`, and skips the backlog on start.
- **macOS permissions**: Screen Recording (for `getDisplayMedia`) and Accessibility (for
  nut.js). The first capture/injection prompts for them.
- **One portal pick per monitor per app session.** The `xdg-desktop-portal` (Wayland/GNOME)
  grants exactly one monitor per `getDisplayMedia()` call and never reports which one —
  `ensureCapture` acquires one stream per display in left-to-right order, prompting with a
  `window.confirm` (position + resolution, never `label` — it's an empty string on this
  rig) only when `get-displays`' `needsPicker` says the portal didn't disclose which source
  matches which display. Cancelling a prompt degrades gracefully: already-captured displays
  keep working, zones on the rest read `—` (never a false "Frozen"); the `Screens` button
  (capture.html) drops every live stream and re-acquires as the escape hatch for a
  wrong-order pick.
- **DIP vs physical px.** `ScreenCapturer` scales each display's video pixels to its DIP
  bounds (`videoWidth / bounds.width`), so HiDPI just works from the live stream — except
  nut.js injection, which assumes `scaleFactor === 1` (true on this rig); an X11 setup with
  OS-level scaling would need physical-px conversion in `doInjection` (see the comment
  above `mouse.setPosition` in `main.js`).
- **The overlay window spans whatever frame it's given** (`frameX/frameY/frameW/frameH` in
  the `open-overlay` params, falling back to the primary display's bounds) — on this rig
  that's the full 2-monitor virtual desktop under XWayland, not just one screen.
- **Pre-existing `settings.json` zones migrate coordinate-space-only, no schema change.**
  Zones selected on the primary/leftmost monitor keep identical bboxes; zones selected via
  the old single-monitor portal pick on a secondary display are off by that display's
  offset (e.g. +1920 on this rig) and need re-selecting. An out-of-union restored bbox
  throws in `grabRegion` (shows `—`), it does not crash.

## Constants

`electron/constants.js`: `HOTKEYS` (F10 toggle monitoring; zone selection is button-only),
`DEFAULTS` (threshold, intervalMs, consec), `ALARM_REPEAT_MS`, `ALARM_PEAK_GAIN`,
`ARROW_REPEAT_MAX` (cap for the `up`/`down` commands), and `TELEGRAM_COMMANDS` — one map of
command words (`status`, `start`, `stop`, `zones`, `defocus`, `help`, `enter`), matched with
or without a leading `/`. The zone-prefixed action commands (`z2 ctrlc`, `z2 up [n]`,
`z2 down [n]`, `z2 enter`) are parsed in `src/telegram.ts` (`parseCtrlc` / `parseArrow` /
`parseEnter`). Sound waveform params live in `src/sound.ts`; theme colors in `capture.html` CSS.

## Version management

`VERSION` (repo root, plain text) is the source of truth. `electron/main.js` reads it
(`path.join(__dirname, "..", "VERSION")`) for the window title, and the Linux `.deb` build
injects it (`electron-builder -c.extraMetadata.version=$(cat ../VERSION)`, in the
`dist:linux` script). `electron/package.json` has its own `version` field — keep it roughly
in sync by hand, but the `.deb` always takes `VERSION`. Bump by editing `VERSION`.

## Style

- All UI text is in English. Light theme, pink/red accent (`#f5365c`).
- No comments by default — clean code (clear names, small functions) explains the WHAT.
  Reserve comments for the non-obvious WHY. Don't restate what the code already says.
- **Documentation lives in a file-header comment only, never on functions.** When a module
  deserves documentation, put one comment block at the top of the file describing its role
  and contract; do not add docstrings above (or inside) functions. Same bar as comments:
  the non-obvious WHY or contract, not a restatement of what the code says.
