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
  // Telegram text commands: a reply equal to one of these words (trimmed,
  // case-insensitive) runs the action instead of being typed. Add more here.
  TELEGRAM_COMMANDS: { enter: 'enter' }, // "enter" -> simulate the Enter key only
  // Global Telegram commands: a reply equal to one of these (trimmed,
  // case-insensitive) runs a chat-wide action instead of targeting a zone.
  TELEGRAM_GLOBAL_COMMANDS: { '/status': 'status' }, // "/status" -> reply with the zones summary
};
