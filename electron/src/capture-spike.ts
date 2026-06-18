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
import { ScreenCapturer, startCapture, cssRectToBbox, bboxCenterToScreen } from "./capture.ts";
import { WebAudioSound } from "./sound.ts";
import { TelegramNotifier, TelegramPoller } from "./telegram.ts";

// Defaults; the Settings inputs override these live (step 7d-2).
const DEFAULT_THRESHOLD = 0.99; // frames this similar count as "still"
const DEFAULT_CONSEC = 3; // consecutive still frames before FROZEN
const DEFAULT_INTERVAL_MS = 500;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

const video = $("video") as HTMLVideoElement;
const startBtn = $("start") as HTMLButtonElement;
const stage = $("stage");
const sel = $("sel");
const sizeEl = $("size");
const edgeEl = $("edge");
const statusEl = $("status");
const zcountEl = $("zcount");
const zonesEl = $("zones");
const injectChk = $("inject") as HTMLInputElement;
const telegramChk = $("telegram") as HTMLInputElement;
const remoteChk = $("remote") as HTMLInputElement;
const thresholdInput = $("threshold") as HTMLInputElement;
const intervalInput = $("interval") as HTMLInputElement;
const consecInput = $("consec") as HTMLInputElement;
const tgEl = $("tg");
const errEl = $("err");

// Live settings: read the inputs each use, falling back to the defaults.
const num = (el: HTMLInputElement, fallback: number): number => {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
};
const threshold = (): number => num(thresholdInput, DEFAULT_THRESHOLD);
const consec = (): number => Math.max(1, Math.round(num(consecInput, DEFAULT_CONSEC)));
const intervalMs = (): number => Math.max(100, Math.round(num(intervalInput, DEFAULT_INTERVAL_MS)));

const sound = new WebAudioSound(DEFAULT_INTERVAL_MS);

// Interval changes restart the tick loop and retune the sound throttle so the
// beep still fires about once per tick while frozen.
intervalInput.addEventListener("change", () => {
  sound.setCooldown(intervalMs());
  if (timer) {
    clearInterval(timer);
    timer = setInterval(tick, intervalMs());
  }
});

// Step 7d: multi-zone. The domain already takes parallel ZoneConfig[]/ZoneState[]
// arrays; each drawn rectangle becomes one Zone with its own overlay + list row.
const COLORS = ["#39ff14", "#ff5cf0", "#5cc8ff", "#ffd93b", "#ff7a45", "#9b8cff"];
interface Zone {
  config: ZoneConfig;
  state: ZoneState;
  rect: HTMLDivElement; // persistent overlay on the preview
  stEl: HTMLElement; // per-row state text
}
const zones: Zone[] = [];

let capturer: ScreenCapturer | null = null;
let monitor: FreezeMonitor | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let edges = 0;
let zoneSeq = 0; // monotonic so names/colors don't reshuffle on remove

// Step 7a: the injector is now REAL — on the freeze edge it asks main (nut.js,
// via preload) to click the zone center + Enter on the actual screen. Opt-in
// via the checkbox so a capture test doesn't hijack the mouse unexpectedly.
// bboxCenterToScreen converts the zone's physical capture-pixel center into the
// logical screen points nut.js expects (the Retina inverse of the selector).
const injector = {
  inject(bbox?: Bbox): void {
    if (!injectChk.checked || !bbox || !capturer || capturer.frameWidth === 0) return;
    const { x, y } = bboxCenterToScreen(
      bbox,
      capturer.frameWidth,
      capturer.frameHeight,
      window.screen.width,
      window.screen.height,
    );
    void window.spike.runInjection({ x, y, text: "" }); // empty text => just Enter
  },
};
// Step 7b: the real TelegramNotifier (sendPhoto, verified in step 5) is now
// wired into the loop. Step 7c: the TelegramPoller closes the round-trip — a
// chat reply is typed into the LAST frozen zone via the same nut.js bridge.
// Creds come from env/.env via the preload bridge; checkboxes gate both so a
// capture test doesn't spam your phone or hijack the keyboard.
let telegram: TelegramNotifier | null = null;
let poller: TelegramPoller | null = null;
// The zone that last hit the freeze edge — where a phone reply gets typed.
let lastFrozenBbox: Bbox | null = null;

window.spike
  .getTelegramConfig()
  .then(({ token, chatId }: { token: string; chatId: string }) => {
    if (token && chatId) {
      telegram = new TelegramNotifier(token, chatId, (s: string) => (tgEl.textContent = s));
      poller = new TelegramPoller(token, chatId, typeReplyIntoLastZone);
      tgEl.textContent = "configured (tick a box)";
    } else {
      telegramChk.disabled = true;
      remoteChk.disabled = true;
      tgEl.textContent = "no creds (set SCREENSOUND_TELEGRAM_* or electron/.env)";
    }
  });

// Type a chat reply into the last frozen zone: click its center (steal focus) +
// type the text + Enter, via nut.js (main). Reuses bboxCenterToScreen — the same
// physical->logical mapping the freeze-Enter uses.
function typeReplyIntoLastZone(text: string): void {
  if (!lastFrozenBbox || !capturer || capturer.frameWidth === 0) {
    tgEl.textContent = "reply ignored: no frozen zone yet";
    return;
  }
  const { x, y } = bboxCenterToScreen(
    lastFrozenBbox,
    capturer.frameWidth,
    capturer.frameHeight,
    window.screen.width,
    window.screen.height,
  );
  void window.spike.runInjection({ x, y, text });
  tgEl.textContent = `typed reply: ${JSON.stringify(text)}`;
}

remoteChk.addEventListener("change", () => {
  if (remoteChk.checked) poller?.start();
  else poller?.stop();
});

const notifier = {
  notifyFrozen(frame: PixelFrame, name: string): void {
    edges += 1;
    edgeEl.textContent = `${edges} (last: ${name})`;
    const z = zones.find((z) => z.config.name === name);
    if (z) lastFrozenBbox = [...z.config.bbox] as Bbox; // where to type a reply
    if (telegramChk.checked && telegram) telegram.notifyFrozen(frame, name);
  },
};

// Add a zone from a finished drag: bbox in capture pixels, cssRect in the
// preview's CSS pixels (for the persistent overlay). Creates the overlay + a
// list row with a remove button.
function addZone(bbox: Bbox, cssRect: { left: number; top: number; width: number; height: number }): void {
  const n = ++zoneSeq;
  const color = COLORS[(n - 1) % COLORS.length];
  const config = new ZoneConfig(bbox, `Zone ${n}`);
  const state = new ZoneState();

  const rect = document.createElement("div");
  rect.className = "zrect";
  rect.style.cssText = `left:${cssRect.left}px;top:${cssRect.top}px;width:${cssRect.width}px;height:${cssRect.height}px;border-color:${color}`;
  stage.appendChild(rect);

  const row = document.createElement("div");
  row.className = "zrow";
  const [x1, y1, x2, y2] = bbox;
  row.innerHTML =
    `<span class="sw" style="background:${color}"></span>` +
    `<span class="nm">${config.name}</span>` +
    `<span style="color:var(--muted)">${x2 - x1}×${y2 - y1}px</span>` +
    `<span class="st ok">idle</span>` +
    `<button type="button">remove</button>`;
  const stEl = row.querySelector(".st") as HTMLElement;
  const zone: Zone = { config, state, rect, stEl };
  (row.querySelector("button") as HTMLButtonElement).addEventListener("click", () => removeZone(zone, row));
  zonesEl.appendChild(row);

  zones.push(zone);
}

function removeZone(zone: Zone, row: HTMLElement): void {
  zone.rect.remove();
  row.remove();
  const i = zones.indexOf(zone);
  if (i >= 0) zones.splice(i, 1);
}

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
  sel.style.display = "none"; // the persistent .zrect takes over
  if (w < MIN_DRAG || h < MIN_DRAG) return; // treat as a click, not a zone
  const r = video.getBoundingClientRect();
  const bbox = cssRectToBbox({ left, top, width: w, height: h }, video.videoWidth, video.videoHeight, r.width, r.height);
  addZone(bbox, { left, top, width: w, height: h });
});

function tick(): void {
  if (!monitor || !capturer || capturer.frameWidth === 0 || zones.length === 0) return;
  monitor.checkZones(zones.map((z) => z.config), zones.map((z) => z.state), threshold(), consec());
  let frozen = 0;
  for (const z of zones) {
    const s = z.state;
    z.stEl.textContent = `${(s.similarity * 100).toFixed(1)}%  ${s.isFrozen ? "FROZEN" : "moving"}`;
    z.stEl.className = `st ${s.isFrozen ? "frozen" : "ok"}`;
    if (s.isFrozen) frozen += 1;
  }
  sizeEl.textContent = `capturing ${capturer.frameWidth}×${capturer.frameHeight}`;
  zcountEl.textContent = `${zones.length} (${frozen} frozen)`;
}

async function startMonitoring(): Promise<void> {
  if (timer) return; // already running
  errEl.textContent = "";
  try {
    if (!capturer) capturer = await startCapture(video);
    const cap = capturer;
    if (!monitor) {
      monitor = new FreezeMonitor(cap, new RMSComparator(), sound, injector, notifier);
    }
    zones.forEach((z) => z.state.reset());
    sound.setCooldown(intervalMs());
    timer = setInterval(tick, intervalMs());
    statusEl.textContent =
      zones.length === 0 ? "monitoring — draw a zone on the preview" : "monitoring (F10 to stop)";
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
