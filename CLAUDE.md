# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Screen Freeze Detector (screensound) — a small Python/tkinter app that monitors screen zones and reacts when they freeze (consecutive captures are nearly identical). Target use case: detecting paused/buffering videos. Beyond an audible alert it can auto-press Enter on the frozen zone and act as a Telegram remote control: it sends the frozen zone's image to your phone and types your text reply back into the zone.

## Tech stack

- Python 3.12+ with `uv` as package manager
- tkinter (ttk) for UI with a custom dark theme
- Pillow for image capture (via `scrot` subprocess) and comparison (RMS via `ImageChops`/`ImageStat`)
- pynput for global hotkeys (F11/F12)
- `aplay` for sound playback (WAV generated at runtime with `wave`/`struct`)
- `xdotool` (optional) for synthetic input on freeze — Enter, or typing a Telegram reply. X11 only.
- `.env` / environment variables for configuration — plain stdlib, no config dependency
- Telegram Bot API over stdlib `urllib` (no HTTP dependency)

## Run

```bash
uv sync
uv run python freeze_detector.py
```

There is no test framework; `test_telegram.py` is a plain assert-based check:

```bash
uv run python test_telegram.py
```

## Key files

- `freeze_detector.py` — the application (UI, domain, all infrastructure adapters, `main()`)
- `config.py` — plain-stdlib config: loads env vars + a local `.env`, exposes a `settings` namespace. The single entry point for config, imported by `freeze_detector.py`
- `VERSION` — plain-text single source of truth for the version (see Version management)
- `.env.example` — template for the optional Telegram credentials (`.env` is gitignored)
- `build_deb.sh` — builds the `.deb` package for Ubuntu/Debian
- `pyproject.toml` — uv project; deps (Pillow, pynput). Static `version` field (cosmetic; the `VERSION` file is the real source — see Version management)
- `.python-version` — pinned to 3.12 (3.13 has an XCB/X11 bug with tkinter)
- `test_telegram.py` — assert checks for the multipart encoder and the Telegram chat-id filter

## Architecture

SOLID. Protocols define abstractions; concrete implementations are injected in `main()` (composition root):

- `ScreenCapturer` → `ScrotCapturer` (shells out to `scrot` to avoid X11 conflicts with tkinter)
- `SoundPlayer` → `AplaySound` (generates a WAV in-memory, plays via `aplay`)
- `HotkeyListener` → `PynputHotkeys` (background thread; marshals to the UI via `root.after(0, ...)`)
- `ImageComparator` → `RMSComparator` (pure Pillow, no numpy)
- `InputInjector` → `XdotoolEnterInjector` — synthetic input on a zone. `inject()` presses Enter; `type_text()` types a string then Enter. Both share `_send()`: save mouse → click zone center (forces focus) → run xdotool commands → restore mouse.
- `RemoteNotifier` → `TelegramNotifier` — on freeze, POSTs the zone image to Telegram `sendPhoto` (stdlib `urllib` multipart, fired in a daemon thread). Reports success/failure through an `on_status` callback (wired to the status bar), stderr as fallback.
- `RemoteCommandSource` → `TelegramPoller` — long-polls `getUpdates` in a daemon thread, only obeys messages from the configured `chat_id`, and calls back with the text (typed into the last frozen zone).
- `FreezeMonitor` orchestrates capture + comparison + alerting + Enter injection + Telegram notification.

## Configuration & secrets

- `config.py` loads a local `.env` (a tiny stdlib parser; real environment variables win over `.env`) and exposes a `settings` namespace with `telegram_token` / `telegram_chat_id`. Both optional.
- Telegram credentials: `SCREENSOUND_TELEGRAM_TOKEN`, `SCREENSOUND_TELEGRAM_CHAT_ID`. Copy `.env.example` → `.env` and fill them in. **Never commit `.env` or hardcode a token** — `.env` is gitignored.
- Telegram is opt-in via a Settings checkbox, disabled until both token and chat_id are set. The poller ignores any message not from the configured `chat_id` (so nobody else with the bot can type on this screen).
- Known limitation: the installed `.deb` launcher does not pass env vars, so Telegram config currently only works when run from a shell with `.env`/env present.

## Important constraints

- **Python 3.13 crashes** with tkinter on this system (XCB assertion). Pinned to 3.12 via `.python-version`.
- **Cannot use `mss` or `PIL.ImageGrab`** — both open X11 connections that conflict with tkinter. `scrot` via subprocess is the workaround.
- **`ImageTk` may not be installed** (`python3-pil.imagetk`). The app falls back to PPM conversion for displaying images.
- **Background threads must marshal to the UI via `root.after(0, ...)`** — pynput hotkeys, the poller's `on_command`, and the notifier's `on_status` all do this.
- **Freeze actions are edge-triggered.** `FreezeMonitor` fires `injector.inject(...)` and `notifier.notify_frozen(...)` only on the transition not-frozen → frozen. The sound, in contrast, plays every tick while frozen (its own cooldown throttles it). Do NOT collapse these — firing Enter/photos every tick would spam. Because of the edge trigger, enabling a toggle while a zone is *already* frozen would otherwise do nothing, so the app catches up: `_notify_already_frozen()` / `_inject_already_frozen()` fire once on enable for any currently-frozen zone.
- **`xdotool` input must use XTest global inject (no `--window`).** `--window <id>` uses XSendEvent, which Ghostty and other GPU terminals filter silently. `--clearmodifiers` is required (a residual Shift turns Return into an escape sequence). A synthetic XTest click IS allowed to steal focus (Mutter treats it as real input) where `windowactivate` is rejected by focus-stealing prevention — that is why injection clicks the zone center first. Mouse position is saved/restored around it (works in click-to-focus WMs; focus-follows-mouse is unsupported).
- **Telegram uses long-polling, not a webhook** (no public URL for a desktop app). The poller tracks an `offset` and skips the backlog on start so old messages are never injected.

## Constants

Configurable values live at the top of `freeze_detector.py` as module-level constants: `DEFAULT_THRESHOLD`, `DEFAULT_INTERVAL_MS`, `DEFAULT_CONSECUTIVE_FRAMES`, alert sound params, and theme colors. `VERSION` is read from the `VERSION` file (below), not a constant.

## Version management

The `VERSION` file (plain text, e.g. `1.3.2`) is the source of truth for what ships and runs:

- `freeze_detector.py` reads it at runtime (`Path(__file__).parent / "VERSION"`, with a `0.0.0` fallback) and shows it in the window title.
- `build_deb.sh` reads it with `$(< VERSION)`.

To bump, edit the `VERSION` file. `build_deb.sh` ships `VERSION` alongside `freeze_detector.py` and `config.py`. `pyproject.toml` has its own static `version` field — it is cosmetic (nothing reads it; the project isn't published as a wheel), so it is not wired to `VERSION` and may lag.

## Build .deb

```bash
bash build_deb.sh
```

Reads `VERSION`, creates the package under `/opt/screensound/`, copies `freeze_detector.py`, `config.py`, and `VERSION`, and sets up a venv installing Pillow and pynput in `postinst`.

## Style

- All UI text is in English.
- Dark navy + orange accent theme: `BG #141422`, surfaces `#1c1c30`/`#1e1e34`, inputs `#2a2a44`, `ACCENT #e8651a`; status colors green/yellow/red. Theme colors are module-level constants applied via `setup_theme()` (ttk `clam` theme).
- Zone selection border uses `SELECTION_COLOR` (fluorescent green `#39FF14`).
- A few inline comments in `freeze_detector.py` (the xdotool rationale) are in Spanish; match the surrounding language when editing a given block.
