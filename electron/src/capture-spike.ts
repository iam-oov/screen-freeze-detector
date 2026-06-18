// Step-3 spike renderer: capture the screen, compare consecutive frames with
// the REAL domain (RMSComparator + ZoneState), and show a live freeze readout.
// Proves the capture + compare + state-machine loop works on real pixels.
import { RMSComparator, ZoneState, type Bbox } from "./domain.ts";
import { ScreenCapturer, startCapture } from "./capture.ts";

const THRESHOLD = 0.99; // frames this similar count as "still"
const CONSEC = 3; // consecutive still frames before declaring FROZEN
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
const errEl = $("err");

const cmp = new RMSComparator();
const state = new ZoneState();
let capturer: ScreenCapturer | null = null;

// A centered region of the captured frame — sidesteps logical-vs-physical pixel
// (Retina) coordinate mapping, which a real zone selector must handle later.
function centeredBbox(w: number, h: number): Bbox {
  const rw = Math.floor(w / 3);
  const rh = Math.floor(h / 3);
  const x = Math.floor((w - rw) / 2);
  const y = Math.floor((h - rh) / 2);
  return [x, y, x + rw, y + rh];
}

function tick(): void {
  if (!capturer) return;
  const bbox = centeredBbox(capturer.frameWidth, capturer.frameHeight);
  const frame = capturer.grabRegion(bbox);
  sizeEl.textContent = `capturing ${capturer.frameWidth}×${capturer.frameHeight}, region ${frame.width}×${frame.height}`;

  if (state.prevImage) {
    const sim = cmp.computeSimilarity(state.prevImage, frame);
    state.update(sim, THRESHOLD, CONSEC);
    simEl.textContent = `${(sim * 100).toFixed(2)}%  (streak ${state.frozenCount}/${CONSEC})`;
    stateEl.textContent = state.isFrozen ? "FROZEN" : "moving";
    stateEl.className = state.isFrozen ? "frozen" : "ok";
  }
  state.prevImage = frame;
}

startBtn.addEventListener("click", async () => {
  errEl.textContent = "";
  startBtn.disabled = true;
  try {
    capturer = await startCapture(video);
    setInterval(tick, INTERVAL_MS);
    stateEl.textContent = "started — hold still to freeze, move a window to break it";
  } catch (e) {
    errEl.textContent = "capture failed: " + (e instanceof Error ? e.message : String(e));
    errEl.textContent += "  (macOS: grant Screen Recording in System Settings)";
    startBtn.disabled = false;
  }
});

window.addEventListener("error", (e) => {
  errEl.textContent = "JS error: " + e.message;
});
