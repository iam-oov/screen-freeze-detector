// Electron main process for the input-injection spike.
//
// Why this spike exists: Chromium/Electron can only inject input into its own
// windows (webContents.sendInputEvent). To click + type into ANOTHER app (the
// frozen video/chat — the whole point of screensound) we need an OS-level
// injector. nut.js is the maintained option. This spike proves it works on the
// target machine BEFORE committing to a full migration. If this fails, the
// migration is not worth it.

const path = require("path");
const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  session,
  globalShortcut,
} = require("electron");

// SPIKE selects which spike window to open: capture | telegram | inject (default).
const SPIKE = process.env.SPIKE || "inject";
const CAPTURE = SPIKE === "capture";
const PAGE = { capture: "capture.html", telegram: "telegram.html" }[SPIKE] || "index.html";
const BIG = SPIKE !== "inject";

// Telegram creds for the telegram spike — real env vars win over electron/.env
// (mirrors the Python config.py loader; electron/.env is gitignored).
function loadEnvFile(p) {
  try {
    for (const line of require("fs").readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const eq = t.indexOf("=");
      const k = t.slice(0, eq).trim();
      if (k in process.env) continue;
      process.env[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — fine, creds can be typed in the UI */
  }
}
loadEnvFile(path.join(__dirname, ".env")); // local override wins (first-set)
loadEnvFile(path.join(__dirname, "..", ".env")); // then the Python repo's .env

// Loaded lazily so the window still opens (and can report the failure) when the
// native module is missing or failed to build.
let nut = null;
let nutError = null;
try {
  nut = require("@nut-tree-fork/nut-js");
} catch (err) {
  nutError = err.message;
}

function createWindow() {
  const win = new BrowserWindow({
    width: BIG ? 720 : 520,
    height: BIG ? 720 : 560,
    resizable: true,
    backgroundColor: "#141422",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Let the Web Audio alert play when monitoring is started via hotkey
      // (no click gesture to satisfy the autoplay policy).
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.loadFile(path.join(__dirname, PAGE));

  if (CAPTURE) {
    // Global F9/F10 start/stop monitoring.
    globalShortcut.register("F9", () => win.webContents.send("hotkey", "start"));
    globalShortcut.register("F10", () => win.webContents.send("hotkey", "stop"));
  }
}

app.whenReady().then(() => {
  // Auto-select the screen so the capture spike's getDisplayMedia() resolves
  // without popping a source picker. macOS still gates the first capture behind
  // the Screen Recording permission prompt.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
      callback(sources.length ? { video: sources[0] } : {});
    });
  });
  createWindow();
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());

// The renderer runs the visible countdown, then calls this. We just do the
// injection and report each step back. Mirrors screensound's _send() flow:
// move to the target point -> click (steal focus) -> type text -> press Enter.
// Telegram creds for the telegram spike, prefilled into its inputs.
ipcMain.handle("get-telegram-config", () => ({
  token: process.env.SCREENSOUND_TELEGRAM_TOKEN || "",
  chatId: process.env.SCREENSOUND_TELEGRAM_CHAT_ID || "",
}));

ipcMain.handle("run-injection", async (_evt, { x, y, text }) => {
  if (!nut) {
    return { ok: false, steps: [], error: nutError || "nut.js not loaded" };
  }
  const { mouse, keyboard, Point, Button, Key } = nut;
  const steps = [];
  try {
    await mouse.setPosition(new Point(x, y));
    steps.push(`moved mouse to (${x}, ${y})`);
    await mouse.click(Button.LEFT);
    steps.push("clicked (focus stolen)");
    await keyboard.type(text);
    steps.push(`typed: ${JSON.stringify(text)}`);
    await keyboard.type(Key.Enter);
    steps.push("pressed Enter");
    return { ok: true, steps };
  } catch (err) {
    // On macOS the most likely cause is missing Accessibility permission.
    return { ok: false, steps, error: String(err && err.message ? err.message : err) };
  }
});
