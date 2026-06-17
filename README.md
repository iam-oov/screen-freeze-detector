# Screen Freeze Detector

Monitors specific screen zones and plays an alert sound when any zone freezes (consecutive frames are nearly identical). Designed for detecting not moving screen areas.

![Screen Freeze Detector](screenshots/app.png)

## Features

- Draw N rectangular zones on a screenshot overlay
- Real-time similarity comparison using RMS pixel difference
- Configurable threshold, check interval, and consecutive frame count
- Visual progress bars per zone with color-coded status (green/yellow/red)
- Alert sound generated at runtime (no external audio files needed)
- Optional auto-input on freeze: click the zone center + press Enter (edge-triggered, one fire per freeze event) — useful for auto-confirming prompts in a target window
- Global hotkeys: **F11** start, **F12** stop (work even when app is not focused)
- Dark theme UI

## Requirements

- Linux (X11 — Wayland is not supported by `xdotool`)
- Python >= 3.12
- `scrot` (screen capture)
- `aplay` (sound playback, from `alsa-utils`)
- `python3-tk` (tkinter)
- `xdotool` (only required if you enable the auto-click + Enter feature)

## Quick start

```bash
uv sync
uv run python freeze_detector.py
```

## Usage

1. Click **Select Zones** -- a fullscreen screenshot appears
2. Drag rectangles over the areas you want to monitor
3. Press **Enter** to confirm (Escape to cancel, right-click to undo)
4. Adjust **Threshold**, **Interval**, and **Consec. frames** as needed
5. (Optional) Tick **"Click zone center and press Enter on freeze"** if you want auto-input when a zone freezes
6. Click **Start (F11)** -- monitoring begins
7. When a zone is frozen for the required consecutive frames, an alert sounds (and optionally fires a synthetic click + Enter)
8. Click **Stop (F12)** to stop monitoring

### Auto-input behavior (opt-in)

When the checkbox is enabled, on the transition from "not frozen" to "frozen" the app will:

1. Save the current mouse position
2. Move the cursor to the zone center and click once (forces focus on the window under that point)
3. Send `Enter` via `xdotool` (lands on the now-focused window)
4. Restore the cursor to its original position

Caveats:

- **The click has side effects.** If the zone center overlaps a button, link, or interactive element, the click will trigger it. Draw zones over static content areas (terminal body, video, plain text) when you plan to enable this.
- **Edge-triggered, not level-triggered.** Enter fires exactly once per freeze event, not continuously while frozen. The sound remains level-triggered (with its own cooldown).
- **Click-to-focus WMs only.** Works on GNOME default. On focus-follows-mouse setups the mouse-restore step would steal focus back — unsupported.

## Install as .deb (Ubuntu/Debian)

```bash
bash build_deb.sh
sudo dpkg -i screensound_<version>_amd64.deb
sudo apt install -f  # if dependencies are missing
screensound
```

To uninstall:

```bash
sudo apt remove screensound
```

## Configuration

All defaults are constants at the top of `freeze_detector.py`:

| Constant                     | Default | Description                                    |
| ---------------------------- | ------- | ---------------------------------------------- |
| `DEFAULT_THRESHOLD`          | `0.995` | Similarity threshold to consider a zone frozen |
| `DEFAULT_INTERVAL_MS`        | `5000`  | Milliseconds between each check                |
| `DEFAULT_CONSECUTIVE_FRAMES` | `4`     | Consecutive frozen frames before alerting      |
| `ALERT_FREQUENCY`            | `880`   | Alert beep frequency in Hz                     |
| `ALERT_BEEPS`                | `2`     | Number of beeps per alert                      |
| `ALERT_COOLDOWN`             | `5.0`   | Seconds between repeated alerts                |

## Architecture

Single-file application (`freeze_detector.py`) following SOLID principles:

- **Protocols**: `ScreenCapturer`, `SoundPlayer`, `HotkeyListener`, `ImageComparator`, `InputInjector`
- **Implementations**: `ScrotCapturer`, `AplaySound`, `PynputHotkeys`, `RMSComparator`, `XdotoolEnterInjector`
- **Domain**: `ZoneConfig`, `ZoneState`, `FreezeMonitor`
- **UI**: `ZoneSelector`, `ZoneMonitorWidget`, `FreezeDetectorApp`
- **Composition root**: `main()` wires all dependencies

## License

MIT
