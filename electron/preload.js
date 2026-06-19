// Safe bridge between the renderer and main. contextIsolation stays on.
// The main window uses the top group; the overlay window uses the bottom two.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spike", {
  // --- main window ---------------------------------------------------------
  runInjection: (params) => ipcRenderer.invoke("run-injection", params),
  // Global F11/F12 (registered in main) -> 'start'/'stop'.
  onHotkey: (callback) => ipcRenderer.on("hotkey", (_e, which) => callback(which)),
  getTelegramConfig: () => ipcRenderer.invoke("get-telegram-config"),
  saveTelegramConfig: (params) => ipcRenderer.invoke("save-telegram-config", params),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (data) => ipcRenderer.invoke("save-settings", data),
  getVersion: () => ipcRenderer.invoke("get-version"),
  // Opens the fullscreen overlay; resolves with the result:
  //   select  -> { zones: Bbox[] } | null
  //   defocus -> { point: {x,y} }  | null
  //   show    -> null
  openOverlay: (params) => ipcRenderer.invoke("open-overlay", params),
  setWindowVisible: (visible) => ipcRenderer.invoke("set-window-visible", visible),

  // --- overlay window ------------------------------------------------------
  onOverlayInit: (callback) => ipcRenderer.on("overlay-init", (_e, data) => callback(data)),
  overlayDone: (result) => ipcRenderer.send("overlay-done", result),
});
