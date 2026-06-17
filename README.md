# Screen Freeze Detector

Monitors specific screen zones and reacts when any zone freezes (consecutive captures are nearly identical). Designed for spotting non-moving areas — e.g. a paused or buffering video. On freeze it can beep, auto-press Enter on the zone, and act as a Telegram remote control: it sends the frozen zone's image to your phone, and your text reply gets typed back into the zone.

![Screen Freeze Detector](screenshots/app.png)

## Features

- Draw N rectangular zones on a screenshot overlay
- Real-time similarity comparison using RMS pixel difference
- Configurable threshold, check interval, and consecutive frame count
- Visual progress bars per zone with color-coded status (green/yellow/red)
- Per-zone **Enabled** and **Sound** toggles — alert sound generated at runtime (no external audio files)
- Optional auto-input on freeze: click the zone center + press Enter (edge-triggered, one fire per freeze event)
- Optional Telegram remote control: get the frozen zone's image on your phone and reply with text that gets typed into the zone
- Global hotkeys: **F11** start, **F12** stop (work even when app is not focused)
- Dark theme UI

## Requirements

- Linux (X11 — Wayland is not supported by `xdotool`)
- Python >= 3.12
- `scrot` (screen capture)
- `aplay` (sound playback, from `alsa-utils`)
- `python3-tk` (tkinter)
- `xdotool` (only for the auto-Enter and Telegram-typing features)
- A Telegram bot token + chat id (only for the Telegram feature — see below)

Python deps (Pillow, pynput) are handled by `uv` / the `.deb` installer.

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
5. Per zone, toggle **Enabled** and **Sound** as you like
6. (Optional) tick **"Click zone center and press Enter on freeze"** for auto-input
7. (Optional) tick **"Send zone image to Telegram on freeze"** (needs credentials — see below)
8. Click **Start (F11)** -- monitoring begins
9. Click **Stop (F12)** to stop monitoring

### Auto-input behavior (opt-in)

On the transition from "not frozen" to "frozen", the app saves the mouse position, clicks the zone center (to focus the window under it), sends the input via `xdotool`, and restores the mouse.

Caveats:

- **The click has side effects.** If the zone center overlaps a button, link, or interactive element, the click will trigger it. Draw zones over static content areas (video, plain text) when you enable this.
- **Edge-triggered, not level-triggered.** Input fires exactly once per freeze event, not continuously. The sound remains level-triggered (with its own cooldown). Enabling a toggle while a zone is already frozen fires once immediately.
- **Click-to-focus WMs only.** Works on GNOME default. Focus-follows-mouse setups are unsupported.

## Telegram remote control (optional)

On freeze, the frozen zone's image is sent to your Telegram chat; replying with text types that text into the **last frozen zone** (+ Enter).

Setup:

1. Create a bot: message **@BotFather** → `/newbot` → copy the **token**.
2. Get your **chat id**: send any message to your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`.
   (Note: the number before the `:` in the token is the *bot's* id, not yours.)
3. Configure credentials:
   ```bash
   cp .env.example .env
   # edit .env and set the two values
   ```
4. Run the app, then tick **"Send zone image to Telegram on freeze"**.

Security & behavior:

- `.env` is gitignored — never commit your token.
- The poller only obeys messages from your configured `chat_id`; everyone else is ignored.
- Receiving works via long-polling (no public URL needed); old messages are skipped on enable.
- Send/receive errors (bad token or chat id) surface in the status bar instead of failing silently.
- Replies target the most recently frozen zone.

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

Note: the `.deb` launcher does not pass env vars, so the Telegram feature currently needs to be run from a shell with `.env` present.

## Configuration

App defaults are constants at the top of `freeze_detector.py`:

| Constant                     | Default | Description                                    |
| ---------------------------- | ------- | ---------------------------------------------- |
| `DEFAULT_THRESHOLD`          | `0.997` | Similarity threshold to consider a zone frozen |
| `DEFAULT_INTERVAL_MS`        | `5000`  | Milliseconds between each check                |
| `DEFAULT_CONSECUTIVE_FRAMES` | `4`     | Consecutive frozen frames before alerting      |
| `ALERT_FREQUENCY`            | `880`   | Alert beep frequency in Hz                     |
| `ALERT_BEEPS`                | `2`     | Number of beeps per alert                      |
| `ALERT_COOLDOWN`             | `5.0`   | Seconds between repeated alerts                |

Telegram credentials come from the environment / `.env` (see `.env.example`):

| Variable                       | Description              |
| ------------------------------ | ------------------------ |
| `SCREENSOUND_TELEGRAM_TOKEN`   | Bot token from BotFather |
| `SCREENSOUND_TELEGRAM_CHAT_ID` | Your chat id             |

The version comes from the `VERSION` file — the source for the window title and `build_deb.sh`. To bump it, edit `VERSION`. (`pyproject.toml` has a separate static `version` field that nothing consumes.)

## Architecture

`freeze_detector.py` holds the app; `config.py` holds the typed settings. SOLID — Protocols with injected implementations:

- **Protocols**: `ScreenCapturer`, `SoundPlayer`, `HotkeyListener`, `ImageComparator`, `InputInjector`, `RemoteNotifier`, `RemoteCommandSource`
- **Implementations**: `ScrotCapturer`, `AplaySound`, `PynputHotkeys`, `RMSComparator`, `XdotoolEnterInjector` (Enter + `type_text`), `TelegramNotifier` (send image), `TelegramPoller` (receive text)
- **Domain**: `ZoneConfig`, `ZoneState`, `FreezeMonitor`
- **UI**: `ZoneSelector`, `ZoneMonitorWidget`, `FreezeDetectorApp`
- **Config**: `config.settings` (env + `.env`, stdlib)
- **Composition root**: `main()` wires all dependencies

## License

MIT
