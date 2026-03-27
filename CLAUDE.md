# CLAUDE.md

## Project overview

Screen Freeze Detector (screensound) -- a single-file Python/tkinter app that monitors screen zones and alerts when they freeze. Target use case: detecting paused/buffering YouTube videos.

## Tech stack

- Python 3.12+ with `uv` as package manager
- tkinter (ttk) for UI with custom dark theme
- Pillow for image capture (via `scrot` subprocess) and comparison (RMS via `ImageChops`)
- pynput for global hotkeys (F11/F12)
- `aplay` for sound playback (WAV generated at runtime with `wave`/`struct`)

## Key files

- `freeze_detector.py` -- entire application (single file, ~800 lines)
- `build_deb.sh` -- builds `.deb` package for Ubuntu/Debian
- `pyproject.toml` -- uv project config with Pillow and pynput dependencies
- `.python-version` -- pinned to 3.12 (3.13 has XCB/X11 bug with tkinter)

## Architecture

SOLID principles applied. Protocols define abstractions; concrete implementations are injected in `main()`:

- `ScreenCapturer` -> `ScrotCapturer` (uses `scrot` subprocess to avoid X11 conflicts with tkinter)
- `SoundPlayer` -> `AplaySound` (generates WAV in-memory, plays via `aplay`)
- `HotkeyListener` -> `PynputHotkeys` (background thread, uses `root.after(0, ...)` for thread safety)
- `ImageComparator` -> `RMSComparator` (pure Pillow, no numpy needed)
- `FreezeMonitor` orchestrates capture + comparison + alerting

## Important constraints

- **Python 3.13 crashes** with tkinter on this system (XCB assertion error). Pinned to 3.12 via `.python-version`.
- **Cannot use `mss` or `PIL.ImageGrab`** for screen capture -- both open X11 connections that conflict with tkinter. `scrot` via subprocess is the workaround.
- **`ImageTk` is not installed** (`python3-pil.imagetk`). The app falls back to PPM conversion for displaying images in tkinter.
- **pynput callbacks run in a background thread**. All tkinter updates must go through `root.after(0, callback)`.

## Constants

All configurable values live at the top of `freeze_detector.py` as module-level constants: `VERSION`, `DEFAULT_THRESHOLD`, `DEFAULT_INTERVAL_MS`, `DEFAULT_CONSECUTIVE_FRAMES`, alert sound params, and theme colors.

## Version management

`VERSION` in `freeze_detector.py` is the single source of truth. `build_deb.sh` reads it automatically. It is also displayed in the window title.

## Build .deb

```bash
bash build_deb.sh
```

The script reads `VERSION` from `freeze_detector.py`, creates the package structure under `/opt/screensound/`, and sets up a venv with deps in `postinst`.

## Style

- All UI text is in English
- Dark theme using custom teal palette (`#36BFB1`, `#2C736C`, `#94F2E9`, `#25403B`, `#260101`)
- Zone selection border uses `SELECTION_COLOR` (fluorescent green `#39FF14`)
