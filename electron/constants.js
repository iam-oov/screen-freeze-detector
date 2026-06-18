module.exports = {
  // Global hotkeys: start/stop monitoring + open the zone selector.
  HOTKEYS: { start: 'F9', stop: 'F10', select: 'F8' },
  // Detection defaults; the sliders/stepper override these live.
  DEFAULTS: { threshold: 0.997, intervalMs: 5000, consec: 4 },
  // Telegram text commands: a reply equal to one of these words (trimmed,
  // case-insensitive) runs the action instead of being typed. Add more here.
  TELEGRAM_COMMANDS: { enter: 'enter' }, // "enter" -> simulate the Enter key only
};
