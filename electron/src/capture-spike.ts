// Step-3/4 spike renderer: capture the screen and run the REAL FreezeMonitor
// (domain) over it, with the Web Audio alert wired to the freeze and F11/F12
// global hotkeys driving start/stop. This now exercises the full edge-trigger
// orchestration on live pixels.
import {
  FreezeMonitor,
  RMSComparator,
  ZoneConfig,
  ZoneState,
  type Bbox,
  type PixelFrame,
} from "./domain.ts";
import { ScreenCapturer, startCapture } from "./capture.ts";
import { WebAudioSound } from "./sound.ts";

const THRESHOLD = 0.99; // frames this similar count as "still"
const CONSEC = 3; // consecutive still frames before FROZEN
const INTERVAL_MS = 500;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

const video = $("video") as HTMLVideoElement;
const startBtn = $("start") as HTMLButtonElement;
const simEl = $("sim");
const stateEl = $("state");
const sizeEl = $("size");
const edgeEl = $("edge");
const statusEl = $("status");
const errEl = $("err");

const sound = new WebAudioSound(INTERVAL_MS);
const zone = new ZoneConfig([0, 0, 0, 0], "Center");
const state = new ZoneState();
let capturer: ScreenCapturer | null = null;
let monitor: FreezeMonitor | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let edges = 0;

// Sound is real; injection/notify are stubbed (validated in their own spikes).
const noopInjector = { inject(_bbox?: Bbox): void {} };
const notifier = {
  notifyFrozen(_frame: PixelFrame, name: string): void {
    edges += 1;
    edgeEl.textContent = `${edges} (last: ${name})`;
  },
};

// Centered third of the captured frame — avoids logical-vs-physical (Retina)
// pixel mapping, which a real zone selector must handle later.
function centeredBbox(w: number, h: number): Bbox {
  const rw = Math.floor(w / 3);
  const rh = Math.floor(h / 3);
  const x = Math.floor((w - rw) / 2);
  const y = Math.floor((h - rh) / 2);
  return [x, y, x + rw, y + rh];
}

function tick(): void {
  if (!monitor || !capturer || capturer.frameWidth === 0) return;
  zone.bbox = centeredBbox(capturer.frameWidth, capturer.frameHeight);
  monitor.checkZones([zone], [state], THRESHOLD, CONSEC);
  sizeEl.textContent = `capturing ${capturer.frameWidth}×${capturer.frameHeight}`;
  simEl.textContent = `${(state.similarity * 100).toFixed(2)}%  (streak ${state.frozenCount}/${CONSEC})`;
  stateEl.textContent = state.isFrozen ? "FROZEN" : "moving";
  stateEl.className = state.isFrozen ? "frozen" : "ok";
}

async function startMonitoring(): Promise<void> {
  if (timer) return; // already running
  errEl.textContent = "";
  try {
    if (!capturer) capturer = await startCapture(video);
    const cap = capturer;
    if (!monitor) {
      monitor = new FreezeMonitor(cap, new RMSComparator(), sound, noopInjector, notifier);
    }
    state.reset();
    timer = setInterval(tick, INTERVAL_MS);
    statusEl.textContent = "monitoring (F12 to stop)";
  } catch (e) {
    errEl.textContent =
      "capture failed: " +
      (e instanceof Error ? e.message : String(e)) +
      "  (macOS: grant Screen Recording in System Settings)";
  }
}

function stopMonitoring(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  statusEl.textContent = "stopped (Start or F11 to begin)";
}

startBtn.addEventListener("click", () => void startMonitoring());
window.spike.onHotkey((which: string) => {
  if (which === "start") void startMonitoring();
  else stopMonitoring();
});
window.addEventListener("error", (e) => {
  errEl.textContent = "JS error: " + e.message;
});
