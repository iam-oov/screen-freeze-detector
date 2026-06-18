// Sound adapter (renderer side). Implements the domain's SoundPlayer with Web
// Audio — the Electron equivalent of the Python AplaySound (generated WAV +
// aplay). Same alert: two 880Hz beeps. FreezeMonitor calls play() every frozen
// tick; the cooldown here throttles it, exactly like the Python version.
import type { SoundPlayer } from "./domain.ts";

const FREQ = 880; // ALERT_FREQUENCY
const DURATION = 0.15; // ALERT_DURATION (s per beep)
const BEEPS = 2; // ALERT_BEEPS
const GAP = 0.1; // ALERT_GAP (s between beeps)
const PEAK = 0.2; // gain peak (keep it gentle)

export class WebAudioSound implements SoundPlayer {
  private ctx: AudioContext;
  private cooldownMs: number;
  private lastPlay = 0;

  constructor(cooldownMs = 500) {
    this.ctx = new AudioContext();
    this.cooldownMs = cooldownMs;
  }

  setCooldown(cooldownMs: number): void {
    this.cooldownMs = cooldownMs;
  }

  play(): void {
    const now = performance.now();
    if (now - this.lastPlay < this.cooldownMs) return;
    this.lastPlay = now;
    if (this.ctx.state === "suspended") void this.ctx.resume();

    let t = this.ctx.currentTime;
    for (let i = 0; i < BEEPS; i++) {
      this.beep(t);
      t += DURATION + GAP;
    }
  }

  private beep(start: number): void {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = FREQ;
    // Short attack/release envelope so the beeps don't click.
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(PEAK, start + 0.01);
    gain.gain.setValueAtTime(PEAK, start + DURATION - 0.01);
    gain.gain.linearRampToValueAtTime(0, start + DURATION);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(start);
    osc.stop(start + DURATION);
  }
}
