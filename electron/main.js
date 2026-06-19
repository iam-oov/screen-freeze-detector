// Electron main process for the screensound app (capture.html / capture-spike).
//
// The migration spikes (input injection, Telegram) proved their pieces and are
// now folded into one window: capture + compare + sound + nut.js injection +
// Telegram, with a tray and global start/stop hotkeys (constants.js). nut.js
// does the OS-level input
// injection Chromium can't (webContents.sendInputEvent only reaches our own
// windows); main owns it and the renderer drives it over the preload bridge.
// Zone selection happens in a separate fullscreen overlay window.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { HOTKEYS } = require('./constants.js');
const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  session,
  globalShortcut,
  screen,
  clipboard,
  Tray,
  Menu,
  nativeImage,
} = require('electron');

// Persisted creds live in the user's XDG config dir (mirrors the Python app).
const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'screensound',
);
const ENV_FILE = path.join(CONFIG_DIR, '.env');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

// Telegram creds — real env vars win over the .env files (first-set wins).
function loadEnvFile(p) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const eq = t.indexOf('=');
      const k = t.slice(0, eq).trim();
      if (k in process.env) continue;
      process.env[k] = t
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env — fine, creds can be typed + saved in the UI */
  }
}
loadEnvFile(ENV_FILE); // saved creds win over leftover repo .env files
loadEnvFile(path.join(__dirname, '.env'));
loadEnvFile(path.join(__dirname, '..', '.env'));

let nut = null;
let nutError = null;
try {
  nut = require('@nut-tree-fork/nut-js');
} catch (err) {
  nutError = err.message;
}

// A system tray for the app. Start/Stop reuse the same "hotkey" IPC as the keys.
let tray = null;
let mainWin = null;

function createTray(win) {
  tray = new Tray(
    nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png')),
  );
  tray.setToolTip('screensound');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: () => (win.show(), win.focus()) },
      { type: 'separator' },
      {
        label: `Start monitoring (${HOTKEYS.start})`,
        click: () => win.webContents.send('hotkey', 'start'),
      },
      {
        label: `Stop monitoring (${HOTKEYS.stop})`,
        click: () => win.webContents.send('hotkey', 'stop'),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', () =>
    win.isVisible() ? win.hide() : (win.show(), win.focus()),
  );
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 760,
    height: 800,
    resizable: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Let the Web Audio alert play when monitoring starts via hotkey
      // (no click gesture to satisfy the autoplay policy).
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  mainWin.loadFile(path.join(__dirname, 'capture.html'));

  // Global hotkeys (see constants.js).
  globalShortcut.register(HOTKEYS.start, () =>
    mainWin.webContents.send('hotkey', 'start'),
  );
  globalShortcut.register(HOTKEYS.stop, () =>
    mainWin.webContents.send('hotkey', 'stop'),
  );
  globalShortcut.register(HOTKEYS.select, () =>
    mainWin.webContents.send('hotkey', 'select'),
  );
  createTray(mainWin);
  // Closing the window quits the app (window-all-closed -> app.quit()). The tray
  // can still hide/show the window while it's open.
}

// Fullscreen overlay for zone selection / show / defocus-point. The renderer
// hands us a screenshot (a dataURL from the SAME getDisplayMedia frame it samples
// during monitoring, so the bbox coordinate space matches). Resolves with the
// overlay's result, or null if cancelled/closed.
function openOverlay({
  mode,
  dataURL,
  frameW,
  frameH,
  zones,
  names,
  captures,
  detection,
  current,
}) {
  return new Promise((resolve) => {
    const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
    const overlay = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      backgroundColor: '#000000',
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      skipTaskbar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') overlay.setSimpleFullScreen(true);
    overlay.loadFile(path.join(__dirname, 'overlay.html'));
    overlay.webContents.once('did-finish-load', () => {
      overlay.webContents.send('overlay-init', {
        mode,
        dataURL,
        frameW,
        frameH,
        zones,
        names,
        captures,
        detection,
        current,
      });
    });

    let settled = false;
    const onDone = (_e, result) => {
      settled = true;
      resolve(result);
      if (!overlay.isDestroyed()) overlay.close();
    };
    ipcMain.once('overlay-done', onDone);
    overlay.on('closed', () => {
      ipcMain.removeListener('overlay-done', onDone);
      if (!settled) resolve(null);
    });
  });
}

app.whenReady().then(() => {
  // Auto-select the screen so getDisplayMedia() resolves without a source picker.
  // macOS still gates the first capture behind the Screen Recording prompt.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback(sources.length ? { video: sources[0] } : {});
    });
  });
  createWindow();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

// --- IPC ------------------------------------------------------------------

ipcMain.handle('get-telegram-config', () => ({
  token: process.env.SCREENSOUND_TELEGRAM_TOKEN || '',
  chatId: process.env.SCREENSOUND_TELEGRAM_CHAT_ID || '',
}));

// Persist creds to ~/.config/screensound/.env (0600), like the Python app.
ipcMain.handle('save-telegram-config', (_e, { token, chatId }) => {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const body =
      `SCREENSOUND_TELEGRAM_TOKEN=${token}\n` +
      `SCREENSOUND_TELEGRAM_CHAT_ID=${chatId}\n`;
    fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
    process.env.SCREENSOUND_TELEGRAM_TOKEN = token;
    process.env.SCREENSOUND_TELEGRAM_CHAT_ID = chatId;
    return { ok: true, path: ENV_FILE };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('get-settings', () => {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('save-settings', (_e, data) => {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('get-version', () => {
  try {
    return fs
      .readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8')
      .trim();
  } catch {
    return app.getVersion();
  }
});

ipcMain.handle('open-overlay', (_e, params) => openOverlay(params));

ipcMain.handle('set-window-visible', (_e, visible) => {
  if (!mainWin) return;
  if (visible) {
    mainWin.show();
    mainWin.focus();
  } else {
    mainWin.hide();
  }
});

// Move to the target point -> click (steal focus) -> paste text -> Enter, then an
// optional defocus click (drops the blinking caret so the zone can re-freeze).
async function doInjection({ x, y, text, defocus }) {
  if (!nut) {
    return { ok: false, steps: [], error: nutError || 'nut.js not loaded' };
  }
  const { mouse, keyboard, Point, Button, Key } = nut;
  const steps = [];
  try {
    await mouse.setPosition(new Point(x, y));
    steps.push(`moved mouse to (${x}, ${y})`);
    await mouse.click(Button.LEFT);
    steps.push('clicked (focus stolen)');
    if (text) {
      // Paste via the clipboard instead of keyboard.type: nut.js drops accented /
      // non-ASCII characters (they go through dead keys). Set the clipboard, send
      // the OS paste chord, then restore the user's previous clipboard.
      const prevClip = clipboard.readText();
      clipboard.writeText(text);
      const pasteMod =
        process.platform === 'darwin' ? Key.LeftCmd : Key.LeftControl;
      await keyboard.pressKey(pasteMod, Key.V);
      await keyboard.releaseKey(pasteMod, Key.V);
      steps.push(`pasted: ${JSON.stringify(text)}`);
      await new Promise((r) => setTimeout(r, 150));
      clipboard.writeText(prevClip);
    }
    await keyboard.type(Key.Enter);
    steps.push('pressed Enter');
    if (defocus && typeof defocus.x === 'number') {
      await mouse.setPosition(new Point(defocus.x, defocus.y));
      await mouse.click(Button.LEFT);
      steps.push(`defocus click at (${defocus.x}, ${defocus.y})`);
    }
    return { ok: true, steps };
  } catch (err) {
    // On macOS the most likely cause is missing Accessibility permission.
    return {
      ok: false,
      steps,
      error: String(err && err.message ? err.message : err),
    };
  }
}

// Serialize injections: each request waits for the previous to finish, so a new
// one (e.g. tapping a 2nd zone before a long reply finishes) never interleaves on
// the shared keyboard/mouse/clipboard and splits a message.
let injectionChain = Promise.resolve();
ipcMain.handle('run-injection', (_evt, params) => {
  const run = injectionChain.then(() => doInjection(params));
  injectionChain = run.catch(() => {});
  return run;
});
