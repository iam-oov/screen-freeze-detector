// Sound adapter (renderer side). Implements the domain's SoundPlayer with Web
// Audio — the Electron equivalent of the Python AplaySound (generated WAV +
// aplay). Same alert: two 880Hz beeps. The renderer's alarm timer calls play()
// at a fixed cadence (ALARM_REPEAT_MS) while a zone stays frozen.
import type { SoundPlayer } from "./domain.ts";
import { ALARM_PEAK_GAIN } from "../constants.js";

const FREQ = 880;
const DURATION = 0.15; // seconds per beep
const BEEPS = 2;
const GAP = 0.1; // seconds between beeps

export class WebAudioSound implements SoundPlayer {
  private ctx: AudioContext;
  private volume = 1; // 0..1, scales the beep gain (global notification volume)

  constructor() {
    this.ctx = new AudioContext();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  // The caller controls cadence (the renderer's alarm timer), so play() just
  // emits one beep burst each call.
  play(): void {
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
    const peak = ALARM_PEAK_GAIN * this.volume;
    // Short attack/release envelope so the beeps don't click.
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.01);
    gain.gain.setValueAtTime(peak, start + DURATION - 0.01);
    gain.gain.linearRampToValueAtTime(0, start + DURATION);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(start);
    osc.stop(start + DURATION);
  }
}
