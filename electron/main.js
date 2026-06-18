// Electron main process for the screensound app (capture.html / capture-spike).
//
// The migration spikes (input injection, Telegram) proved their pieces and are
// now folded into this one window: capture + compare + sound + nut.js injection
// + Telegram, with a tray and F9/F10 hotkeys. nut.js does the OS-level input
// injection Chromium can't (webContents.sendInputEvent only reaches our own
// windows); main owns it and the renderer drives it over the preload bridge.

const path = require("path");
const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  session,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
} = require("electron");

// Telegram creds — real env vars win over electron/.env (mirrors the Python
// config.py loader; electron/.env is gitignored).
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

// Step 7d-3: a system tray for the real app (capture). Start/Stop reuse the same
// "hotkey" IPC as F9/F10. Held in a module ref so it isn't garbage-collected.
let tray = null;
let isQuitting = false;

function createTray(win) {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "tray-icon.png")));
  tray.setToolTip("screensound");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show", click: () => (win.show(), win.focus()) },
      { type: "separator" },
      { label: "Start monitoring (F9)", click: () => win.webContents.send("hotkey", "start") },
      { label: "Stop monitoring (F10)", click: () => win.webContents.send("hotkey", "stop") },
      { type: "separator" },
      { label: "Quit", click: () => ((isQuitting = true), app.quit()) },
    ]),
  );
  // Click toggles the window (macOS shows the menu on click anyway, but this
  // makes the icon useful on Linux too).
  tray.on("click", () => (win.isVisible() ? win.hide() : (win.show(), win.focus())));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 720,
    resizable: true,
    backgroundColor: "#141422",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Let the Web Audio alert play when monitoring is started via hotkey
      // (no click gesture to satisfy the autoplay policy).
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.loadFile(path.join(__dirname, "capture.html"));

  // Global F9/F10 start/stop monitoring.
  globalShortcut.register("F9", () => win.webContents.send("hotkey", "start"));
  globalShortcut.register("F10", () => win.webContents.send("hotkey", "stop"));
  createTray(win);
  // Closing the window hides it (tray keeps the app alive); Quit really exits.
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
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
