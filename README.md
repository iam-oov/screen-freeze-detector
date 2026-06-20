# Screen Freeze Detector

Monitors specific screen zones and reacts when any zone freezes (consecutive
captures are nearly identical). Designed for spotting non-moving areas — e.g. a
paused or buffering video. On freeze it can beep, auto-press Enter on the zone,
and act as a Telegram remote control: it sends the zone's image to your phone,
and your text reply gets typed back into the zone.

![Screen Freeze Detector](screenshots/app.png)

## Features

- Draw N rectangular, resizable zones on a fullscreen screenshot overlay
- Real-time similarity comparison (RMS pixel difference)
- Threshold / interval / consecutive-frames / volume controls — each a slider
  **and** a typeable numeric stepper (decimals supported)
- Per-zone traffic-light status: green below the threshold, yellow at/above it,
  red when frozen
- Per-zone toggles: Active, Sound, Press-Enter-on-freeze, Send-to-Telegram
- Independent Telegram **capture zone** per zone — photograph a different area
  than the one being watched for freezes
- Telegram remote control: zone image on freeze, tap-to-target buttons, typed
  replies, per-zone key actions (Enter / Ctrl+C / Arrow Up·Down), and app
  commands (status, start, stop, zones, ss, defocus, help)
- Preferences (zones, settings) auto-save and restore on launch
- Global hotkey: **F10** toggle monitoring (select zones via the button)
- System tray, reset-to-defaults, global notification volume

## Run

The app lives in `electron/`:

```bash
cd electron
pnpm install
pnpm start
```

To build an installable **Linux `.deb`** (output in `electron/dist/`):

```bash
./build_deb.sh   # repo root; version comes from the VERSION file
sudo apt install electron/dist/screensound-electron_<version>_amd64.deb
```

## Telegram remote control (optional)

On freeze, the frozen zone's image is sent to your chat; replying with text types
it into the target zone (+ Enter). Setup:

1. Create a bot: message **@BotFather** → `/newbot` → copy the **token**.
2. Get your **chat id**: send any message to the bot, open
   `https://api.telegram.org/bot<TOKEN>/getUpdates`, copy `chat.id`.
3. Enter the token and chat id in the app's **Settings** (auto-saved), or copy
   `.env.example` → `.env` and fill them in.

The poller only obeys messages from your configured `chat_id`; it uses
long-polling (no public URL) and skips old messages on start.

### Commands

Send these to the bot — the leading `/` is optional. Zone actions need the zone
code first (`z2 …` or `z2: …`):

- `status` — zones + monitoring summary; `start` / `stop` — toggle monitoring
- `zones` — a button per zone (tap → its state photo, and focus that zone)
- `ss <code>` — that zone's current state photo
- `defocus` — bring the app to front (drop input focus off a zone)
- `help` — command list
- `z2: <text>` — type text into z2 (+ Enter); `enter` — press Enter (`z2 enter`,
  or the selected/last zone)
- `z2 ctrlc` — Ctrl+C; `z2 up [n]` / `z2 down [n]` — arrow key, n times (max 5)

## Configuration

- Tunables live in [`electron/constants.js`](electron/constants.js): hotkeys,
  detection defaults, alarm cadence/gain, Telegram command words.
- Telegram credentials (`SCREENSOUND_TELEGRAM_TOKEN`,
  `SCREENSOUND_TELEGRAM_CHAT_ID`) auto-save to `~/.config/screensound/.env`
  (mode 0600).
- User preferences auto-save to `~/.config/screensound/settings.json`.
- The version comes from the `VERSION` file at the repo root (read by
  `electron/main.js`). Bump it by editing `VERSION`.

## License

MIT
