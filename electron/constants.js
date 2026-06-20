module.exports = {
  // Global hotkeys: start/stop monitoring + open the zone selector.
  HOTKEYS: { start: 'F9', stop: 'F10', select: 'F8' },
  // Detection defaults; the sliders/stepper override these live.
  DEFAULTS: { threshold: 0.997, intervalMs: 5000, consec: 4 },
  // Freeze alarm: how often the beep repeats while a zone stays frozen (ms).
  // Decoupled from the capture interval so the alarm can be as urgent as wanted.
  ALARM_REPEAT_MS: 2000,
  // Alarm beep gain at 100% volume (0..1); the volume slider scales this down.
  ALARM_PEAK_GAIN: 0.9,
  // Telegram command words: a message equal to one of these (trim + lowercase,
  // leading "/" optional) runs the action. "enter" is a per-zone reply action
  // (injects Enter into the target zone); the rest are standalone app commands
  // (status summary, start/stop monitoring, zones buttons, defocus click, help).
  // "ss <code>" is handled separately (it takes an argument).
  TELEGRAM_COMMANDS: {
    enter: 'enter',
    status: 'status',
    start: 'start',
    stop: 'stop',
    zones: 'zones',
    defocus: 'defocus',
    help: 'help',
  },
};
