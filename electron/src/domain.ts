// Pure domain logic, ported 1:1 from freeze_detector.py (Python).
// No OS, no Electron, no I/O — just the freeze state machine, the RMS image
// comparison, and the edge-trigger orchestration. This is the part that ports
// cleanly precisely because the Python app kept it isolated behind Protocols.

export type Bbox = [number, number, number, number];

// A captured zone as raw pixels — matches a canvas ImageData (RGBA, row-major).
export interface PixelFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray | number[]; // length === width * height * 4
}

// --- ZoneConfig (was a @dataclass) -----------------------------------------

export class ZoneConfig {
  bbox: Bbox;
  name: string;
  enabled: boolean;
  soundEnabled: boolean;
  injectEnabled: boolean;
  // Renderer-gated (not used by checkZones): whether this zone talks to Telegram.
  // Lives here so all per-zone toggles share one config object.
  telegramEnabled: boolean;

  constructor(
    bbox: Bbox,
    name: string,
    enabled = true,
    soundEnabled = true,
    injectEnabled = false,
    telegramEnabled = false,
  ) {
    this.bbox = bbox;
    this.name = name;
    this.enabled = enabled;
    this.soundEnabled = soundEnabled;
    this.injectEnabled = injectEnabled;
    this.telegramEnabled = telegramEnabled;
  }
}

// --- ZoneState: the freeze state machine -----------------------------------

export class ZoneState {
  prevImage: PixelFrame | null = null;
  similarity = 0;
  frozenCount = 0;
  isFrozen = false;

  update(similarity: number, threshold: number, consecRequired: number): void {
    this.similarity = similarity;
    if (similarity >= threshold) {
      this.frozenCount += 1;
    } else {
      this.frozenCount = 0;
    }
    this.isFrozen = this.frozenCount >= consecRequired;
  }

  reset(): void {
    this.prevImage = null;
    this.similarity = 0;
    this.frozenCount = 0;
    this.isFrozen = false;
  }
}

export type StateKind = "ok" | "warn" | "frozen";

// Visual/summary label for a zone: frozen wins, then "warn" once captures are
// near-identical (>= 0.9), else "ok". Distinct from the freeze threshold (~0.997)
// — this is just the at-a-glance color/status.
export function stateKind(s: ZoneState): StateKind {
  if (s.isFrozen) return "frozen";
  if (s.similarity >= 0.9) return "warn";
  return "ok";
}

// --- Image comparison ------------------------------------------------------

export interface ImageComparator {
  computeSimilarity(a: PixelFrame, b: PixelFrame): number;
}

export class RMSComparator implements ImageComparator {
  // Combined RMS of the per-pixel R/G/B differences, mapped to [0,1] similarity
  // (1 = identical). Equivalent to the Python ImageStat per-channel-RMS-then-
  // combine, since every channel has the same pixel count.
  //
  // Equal dimensions are required: in Electron both frames come from drawing the
  // same bbox to a same-size canvas, so the Python resize() safety net is gone.
  computeSimilarity(a: PixelFrame, b: PixelFrame): number {
    if (a.width !== b.width || a.height !== b.height) {
      throw new Error("RMSComparator: frames must have equal dimensions");
    }
    const da = a.data;
    const db = b.data;
    const pixels = a.width * a.height;
    let sumSq = 0;
    for (let i = 0; i < pixels; i++) {
      const o = i * 4;
      const dr = da[o] - db[o];
      const dg = da[o + 1] - db[o + 1];
      const dbl = da[o + 2] - db[o + 2];
      sumSq += dr * dr + dg * dg + dbl * dbl; // alpha ignored, like RGB
    }
    const rms = Math.sqrt(sumSq / (pixels * 3));
    return 1 - rms / 255;
  }
}

// --- FreezeMonitor: edge-trigger orchestration -----------------------------

export interface RegionCapturer {
  grabRegion(bbox: Bbox): PixelFrame; // may throw
}
export interface SoundPlayer {
  play(): void;
}
export interface InputInjector {
  inject(bbox?: Bbox): void;
}
export interface RemoteNotifier {
  notifyFrozen(frame: PixelFrame, zoneName: string): void;
}

export class FreezeMonitor {
  private capturer: RegionCapturer;
  private comparator: ImageComparator;
  private sound: SoundPlayer;
  private injector: InputInjector;
  private notifier: RemoteNotifier;

  constructor(
    capturer: RegionCapturer,
    comparator: ImageComparator,
    sound: SoundPlayer,
    injector: InputInjector,
    notifier: RemoteNotifier,
  ) {
    this.capturer = capturer;
    this.comparator = comparator;
    this.sound = sound;
    this.injector = injector;
    this.notifier = notifier;
  }

  checkZones(
    zones: ZoneConfig[],
    states: ZoneState[],
    threshold: number,
    consecRequired: number,
  ): Array<[number, PixelFrame | null]> {
    const results: Array<[number, PixelFrame | null]> = [];

    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i];
      const state = states[i];
      if (!zone.enabled) {
        results.push([i, null]);
        continue;
      }
      let newImg: PixelFrame;
      try {
        newImg = this.capturer.grabRegion(zone.bbox);
      } catch {
        results.push([i, null]);
        continue;
      }

      if (state.prevImage !== null) {
        const similarity = this.comparator.computeSimilarity(state.prevImage, newImg);
        const wasFrozen = state.isFrozen;
        state.update(similarity, threshold, consecRequired);
        if (state.isFrozen) {
          // Sound plays every frozen tick; Enter + notify fire ONCE on the
          // not-frozen -> frozen edge. Do not collapse these.
          if (zone.soundEnabled) {
            this.sound.play();
          }
          if (!wasFrozen) {
            // Enter is per-zone and opt-in (zone.injectEnabled), like sound.
            if (zone.injectEnabled) {
              this.injector.inject(zone.bbox);
            }
            this.notifier.notifyFrozen(newImg, zone.name);
          }
        }
      }

      state.prevImage = newImg;
      results.push([i, newImg]);
    }

    return results;
  }
}
