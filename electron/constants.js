// App-wide tunables — adjust them here. Shared by the main process (require)
// and the renderer (esbuild bundles this same file into capture-spike.js).
module.exports = {
  // Global hotkeys: start/stop monitoring + open the zone selector.
  HOTKEYS: { start: 'F9', stop: 'F10', select: 'F8' },
  // Detection defaults; the sliders/stepper override these live.
  DEFAULTS: { threshold: 0.997, intervalMs: 5000, consec: 4 },
};
