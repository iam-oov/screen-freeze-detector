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

- Electron 31, TypeScript, `pnpm`
- **esbuild** bundles the renderer (`src/capture-spike.ts`, `src/overlay.ts`) to IIFE
  `.js` next to the HTML. There is **no `tsc`**: types are stripped, never type-checked —
  type errors do NOT fail the build (or the tests).
- `@nut-tree-fork/nut-js` for OS-level synthetic input (move + click + type + Enter) the
  main process owns; Chromium's `sendInputEvent` only reaches our own windows.
- Screen capture via `getDisplayMedia` → a hidden `<video>` → an offscreen canvas (the
  Electron equivalent of the old `scrot`).
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
```

See `electron/README.md` for native-module build issues and macOS permissions.

## Key files (all under `electron/`)

- `main.js` — main process: window, tray, global hotkeys, all IPC, nut.js input injection,
  and the `.env` (creds) + `settings.json` (preferences) files.
- `preload.js` — `contextBridge` exposing the `window.spike` API to the renderer.
- `capture.html` + `capture-spike.js` (bundled from `src/capture-spike.ts`) — the app
  window. `capture-spike.ts` is the renderer **and the composition root**.
- `overlay.html` + `src/overlay.ts` — the fullscreen overlay for zone selection / capture
  area / show / defocus. A generic resizable-rectangle editor (one pointer pipeline).
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
- **Adapters**: `ScreenCapturer` (capture.ts), `WebAudioSound` (sound.ts),
  `TelegramNotifier` / `TelegramPoller` (telegram.ts), `DiskPreferencesStore` (prefs.ts),
  and nut.js injection living in `main.js` (driven over the `run-injection` IPC).
- **Composition root**: `src/capture-spike.ts` wires the adapters, owns the zones table +
  settings UI, and drives the overlay via `main.js`. `main.js` owns the window, tray,
  hotkeys, OS input, and the config/preferences files.

## Configuration & secrets

- Telegram credentials (`SCREENSOUND_TELEGRAM_TOKEN`, `SCREENSOUND_TELEGRAM_CHAT_ID`) are
  entered in the Settings UI and **auto-saved** to `~/.config/screensound/.env` (mode
  0600); `main.js` loads them at startup. Real env vars win over the `.env`. Never commit a
  token — `.env` is gitignored.
- User preferences (zones with their bboxes + per-zone toggles + capture zone, threshold,
  interval, consec, volume, defocus point) **auto-save** (debounced) to
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
- **nut.js injection** clicks the zone center first (to focus the window under it), pastes
  text via the clipboard (so accented/Unicode chars survive), then Enter; injections are
  serialized. Requires macOS Accessibility permission.
- **Telegram uses long-polling**, tracks an `offset`, and skips the backlog on start.
- **macOS permissions**: Screen Recording (for `getDisplayMedia`) and Accessibility (for
  nut.js). The first capture/injection prompts for them.

## Constants

`electron/constants.js`: `HOTKEYS` (F9 start / F10 stop / F8 select), `DEFAULTS`
(threshold, intervalMs, consec), `ALARM_REPEAT_MS`, `ALARM_PEAK_GAIN`, `TELEGRAM_COMMANDS`
(per-zone reply words, e.g. `enter`), `TELEGRAM_GLOBAL_COMMANDS` (`/status`, `/start`,
`/stop`). Sound waveform params live in `src/sound.ts`; theme colors in `capture.html` CSS.

## Version management

`VERSION` (repo root, plain text) is the source of truth. `electron/main.js` reads it
(`path.join(__dirname, "..", "VERSION")`) for the window title. `electron/package.json` has
its own `version` field (used by electron-builder) — keep it roughly in sync by hand.

## Style

- All UI text is in English. Light theme, pink/red accent (`#f5365c`).
- No comments by default — clean code (clear names, small functions) explains the WHAT.
  Reserve comments for the non-obvious WHY. Don't restate what the code already says.
