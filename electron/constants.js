// App-wide tunables — adjust them here. Shared by the main process (require)
// and the renderer (esbuild bundles this same file into capture-spike.js).
module.exports = {
  // Global start/stop monitoring hotkeys.
  HOTKEYS: { start: "F9", stop: "F10" },
  // Detection defaults; the sliders/stepper override these live.
  DEFAULTS: { threshold: 0.99, intervalMs: 500, consec: 3 },
};
