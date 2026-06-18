// Minimal, safe bridge: the renderer can ask the main process to run the
// injection, nothing else. contextIsolation stays on (Electron default).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spike", {
  runInjection: (params) => ipcRenderer.invoke("run-injection", params),
});
