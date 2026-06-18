// Step-3/4 spike renderer: capture the screen and run the REAL FreezeMonitor
// (domain) over it, with the Web Audio alert wired to the freeze and F9/F10
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
import { ScreenCapturer, startCapture, cssRectToBbox } from "./capture.ts";
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
const stage = $("stage");
const sel = $("sel");
const simEl = $("sim");
const stateEl = $("state");
const sizeEl = $("size");
const edgeEl = $("edge");
const statusEl = $("status");
const zoneEl = $("zone");
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

// Centered third of the captured frame — the default until the user draws a
// zone. The drawn zone (selectedBbox) is in the same physical-pixel space, so
// switching between them needs no DPI mapping.
function centeredBbox(w: number, h: number): Bbox {
  const rw = Math.floor(w / 3);
  const rh = Math.floor(h / 3);
  const x = Math.floor((w - rw) / 2);
  const y = Math.floor((h - rh) / 2);
  return [x, y, x + rw, y + rh];
}

// Set by dragging over the preview; null = watch the centered region.
let selectedBbox: Bbox | null = null;

// --- Zone selector: drag a rectangle over the live preview -----------------
// The drawn rect is in the <video>'s displayed CSS pixels; cssRectToBbox scales
// it into capture pixels. The overlay div (#sel) is left where it was drawn —
// it visually drifts if the window is resized, but the bbox stays correct
// because it lives in frame pixels, not CSS. ponytail: redraw on resize if it
// bugs you.
const MIN_DRAG = 10; // CSS px; ignore stray clicks
let dragging = false;
let startX = 0;
let startY = 0;

function localPoint(e: PointerEvent): { x: number; y: number } {
  const r = video.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(e.clientX - r.left, r.width)),
    y: Math.max(0, Math.min(e.clientY - r.top, r.height)),
  };
}

function drawSel(left: number, top: number, w: number, h: number): void {
  sel.style.left = `${left}px`;
  sel.style.top = `${top}px`;
  sel.style.width = `${w}px`;
  sel.style.height = `${h}px`;
  sel.style.display = "block";
}

stage.addEventListener("pointerdown", (e) => {
  if (video.videoWidth === 0) return; // preview not started yet
  dragging = true;
  const p = localPoint(e as PointerEvent);
  startX = p.x;
  startY = p.y;
  drawSel(startX, startY, 0, 0);
});

stage.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const p = localPoint(e as PointerEvent);
  drawSel(Math.min(startX, p.x), Math.min(startY, p.y), Math.abs(p.x - startX), Math.abs(p.y - startY));
});

stage.addEventListener("pointerup", (e) => {
  if (!dragging) return;
  dragging = false;
  const p = localPoint(e as PointerEvent);
  const left = Math.min(startX, p.x);
  const top = Math.min(startY, p.y);
  const w = Math.abs(p.x - startX);
  const h = Math.abs(p.y - startY);
  if (w < MIN_DRAG || h < MIN_DRAG) {
    sel.style.display = "none";
    return; // treat as a click, not a zone
  }
  const r = video.getBoundingClientRect();
  selectedBbox = cssRectToBbox({ left, top, width: w, height: h }, video.videoWidth, video.videoHeight, r.width, r.height);
  state.reset(); // fresh freeze streak for the new zone
  const [x1, y1, x2, y2] = selectedBbox;
  zoneEl.textContent = `${x2 - x1}×${y2 - y1} px @ (${x1}, ${y1})`;
});

function tick(): void {
  if (!monitor || !capturer || capturer.frameWidth === 0) return;
  zone.bbox = selectedBbox ?? centeredBbox(capturer.frameWidth, capturer.frameHeight);
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
    statusEl.textContent = "monitoring (F10 to stop)";
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
  statusEl.textContent = "stopped (Start or F9 to begin)";
}

startBtn.addEventListener("click", () => void startMonitoring());
window.spike.onHotkey((which: string) => {
  if (which === "start") void startMonitoring();
  else stopMonitoring();
});
window.addEventListener("error", (e) => {
  errEl.textContent = "JS error: " + e.message;
});
