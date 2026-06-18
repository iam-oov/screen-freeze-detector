// Renderer for the screensound app (capture.html). Runs the real FreezeMonitor
// over screen captures, drives the light-theme UI (header toggle, detection
// settings, Telegram, watched-zones table), and selects zones via a fullscreen
// overlay window (main process). The inline preview is gone; a hidden <video>
// still feeds the ScreenCapturer.
import {
  FreezeMonitor,
  RMSComparator,
  ZoneConfig,
  ZoneState,
  type Bbox,
  type PixelFrame,
} from "./domain.ts";
import { ScreenCapturer, startCapture, bboxCenterToScreen } from "./capture.ts";
import { WebAudioSound } from "./sound.ts";
import { TelegramNotifier, TelegramPoller } from "./telegram.ts";
import { HOTKEYS, DEFAULTS } from "../constants.js";

const DEFAULT_THRESHOLD = DEFAULTS.threshold;
const DEFAULT_CONSEC = DEFAULTS.consec;
const DEFAULT_INTERVAL_MS = DEFAULTS.intervalMs;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

// --- static refs -----------------------------------------------------------
const video = $("video") as HTMLVideoElement;
const verEl = $("ver");
const toggleBtn = $("toggleBtn") as HTMLButtonElement;
const runBadge = $("runBadge");
const cfg = $("cfg");
const cfgHeader = $("cfgHeader");
const thresholdEl = $("threshold") as HTMLInputElement;
const thrVal = $("thrVal");
const intervalEl = $("interval") as HTMLInputElement;
const intVal = $("intVal");
const consecEl = $("consec") as HTMLInputElement;
const consecMinus = $("consecMinus") as HTMLButtonElement;
const consecPlus = $("consecPlus") as HTMLButtonElement;
const injectChk = $("inject") as HTMLInputElement;
const tgBadge = $("tgBadge");
const tgToken = $("tgToken") as HTMLInputElement;
const tgChat = $("tgChat") as HTMLInputElement;
const tgSave = $("tgSave") as HTMLButtonElement;
const telegramChk = $("telegram") as HTMLInputElement;
const defocusBtn = $("defocusBtn") as HTMLButtonElement;
const defocusStatus = $("defocusStatus");
const tgEl = $("tg");
const zCount = $("zCount");
const selectBtn = $("selectBtn") as HTMLButtonElement;
const selectLbl = $("selectLbl");
const showBtn = $("showBtn") as HTMLButtonElement;
const zonesEl = $("zones");
const footStatus = $("footStatus");
const lastCheck = $("lastCheck");

const SVG_SOUND =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>';
const SVG_SOUND_OFF =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>';
const SVG_TRASH =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';

// --- state -----------------------------------------------------------------
interface Zone {
  config: ZoneConfig;
  state: ZoneState;
  frozenEdges: number;
  row: HTMLElement;
  thumb: HTMLImageElement;
  dot: HTMLElement;
  simfill: HTMLElement;
  simpct: HTMLElement;
  pill: HTMLElement;
  frozenEl: HTMLElement;
}
const zones: Zone[] = [];
let zoneSeq = 0;

const sound = new WebAudioSound(DEFAULT_INTERVAL_MS);
let capturer: ScreenCapturer | null = null;
let monitor: FreezeMonitor | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

let telegram: TelegramNotifier | null = null;
let poller: TelegramPoller | null = null;
let lastFrozenBbox: Bbox | null = null;
let defocusPoint: { x: number; y: number } | null = null;

// --- live settings ---------------------------------------------------------
const num = (el: HTMLInputElement, fallback: number): number => {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
};
const threshold = (): number => num(thresholdEl, DEFAULT_THRESHOLD);
const consec = (): number => Math.max(1, Math.round(num(consecEl, DEFAULT_CONSEC)));
const intervalMs = (): number => Math.max(100, Math.round(num(intervalEl, DEFAULT_INTERVAL_MS)));

function paintRange(el: HTMLInputElement): void {
  const min = parseFloat(el.min);
  const max = parseFloat(el.max);
  const pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
  el.style.background = `linear-gradient(to right, var(--dark) 0 ${pct}%, var(--line) ${pct}% 100%)`;
}

function refreshDetectionLabels(): void {
  thrVal.textContent = `${(threshold() * 100).toFixed(1)}%`;
  intVal.textContent = `${intervalMs()} ms`;
  paintRange(thresholdEl);
  paintRange(intervalEl);
}

thresholdEl.addEventListener("input", refreshDetectionLabels);
intervalEl.addEventListener("input", refreshDetectionLabels);
intervalEl.addEventListener("change", () => {
  sound.setCooldown(intervalMs());
  if (timer) {
    clearInterval(timer);
    timer = setInterval(tick, intervalMs());
  }
});
consecMinus.addEventListener("click", () => {
  consecEl.value = String(Math.max(1, consec() - 1));
});
consecPlus.addEventListener("click", () => {
  consecEl.value = String(consec() + 1);
});

cfgHeader.addEventListener("click", () => cfg.classList.toggle("collapsed"));

// --- capture + thumbnails --------------------------------------------------
function toClamped(d: Uint8ClampedArray | number[]): Uint8ClampedArray {
  return d instanceof Uint8ClampedArray ? d : new Uint8ClampedArray(d);
}

// Draw a region of a frame into a small thumbnail dataURL.
function frameToThumb(frame: PixelFrame, sx: number, sy: number, sw: number, sh: number): string {
  const src = document.createElement("canvas");
  src.width = frame.width;
  src.height = frame.height;
  src.getContext("2d")!.putImageData(new ImageData(toClamped(frame.data), frame.width, frame.height), 0, 0);
  const t = document.createElement("canvas");
  t.width = 76;
  t.height = 56;
  t.getContext("2d")!.drawImage(src, sx, sy, sw, sh, 0, 0, t.width, t.height);
  return t.toDataURL("image/png");
}

function frameToDataURL(frame: PixelFrame): string {
  const c = document.createElement("canvas");
  c.width = frame.width;
  c.height = frame.height;
  c.getContext("2d")!.putImageData(new ImageData(toClamped(frame.data), frame.width, frame.height), 0, 0);
  return c.toDataURL("image/png");
}

async function ensureCapture(): Promise<ScreenCapturer> {
  if (!capturer) capturer = await startCapture(video);
  // wait one frame if dimensions aren't ready yet
  if (capturer.frameWidth === 0) await new Promise((r) => setTimeout(r, 200));
  return capturer;
}

// --- zones table -----------------------------------------------------------
let emptyEl: HTMLElement | null = null;

function refreshEmpty(): void {
  if (zones.length === 0) {
    if (!emptyEl) {
      emptyEl = document.createElement("div");
      emptyEl.className = "zempty";
      emptyEl.textContent = "No zones yet — click “Select zones”.";
      zonesEl.appendChild(emptyEl);
    }
  } else if (emptyEl) {
    emptyEl.remove();
    emptyEl = null;
  }
}

function addZone(bbox: Bbox, fullFrame?: PixelFrame): void {
  const n = ++zoneSeq;
  const config = new ZoneConfig(bbox, `Zone ${n}`);
  const state = new ZoneState();
  const [x1, y1, x2, y2] = bbox;

  const row = document.createElement("div");
  row.className = "zrow";
  row.innerHTML =
    '<div class="zname"><img class="thumb" alt="" /><span class="zdot"></span><span class="nm"></span></div>' +
    `<span class="zsize">${x2 - x1}×${y2 - y1}</span>` +
    '<div class="zsim"><div class="simbar"><div class="simfill"></div></div><span class="simpct">—</span></div>' +
    '<span class="zstate"><span class="pill pill-ok">OK</span></span>' +
    '<span class="zfrozen c-center">0</span>' +
    '<span class="zactive"><label class="switch sm"><input type="checkbox" class="activeChk" checked /><span class="slider"></span></label></span>' +
    `<span class="zactions"><button class="ic snd" title="Sound">${SVG_SOUND}</button><button class="ic del" title="Remove">${SVG_TRASH}</button></span>`;

  const q = <T extends Element>(sel: string): T => row.querySelector(sel) as T;
  const zone: Zone = {
    config,
    state,
    frozenEdges: 0,
    row,
    thumb: q<HTMLImageElement>(".thumb"),
    dot: q<HTMLElement>(".zdot"),
    simfill: q<HTMLElement>(".simfill"),
    simpct: q<HTMLElement>(".simpct"),
    pill: q<HTMLElement>(".pill"),
    frozenEl: q<HTMLElement>(".zfrozen"),
  };
  (q<HTMLElement>(".nm")).textContent = config.name;
  zone.dot.style.background = "var(--ok)";
  if (fullFrame) zone.thumb.src = frameToThumb(fullFrame, x1, y1, x2 - x1, y2 - y1);

  const activeChk = q<HTMLInputElement>(".activeChk");
  activeChk.addEventListener("change", () => {
    config.enabled = activeChk.checked;
    row.style.opacity = config.enabled ? "1" : "0.5";
    refreshCounts();
  });
  const snd = q<HTMLButtonElement>(".snd");
  snd.addEventListener("click", () => {
    config.soundEnabled = !config.soundEnabled;
    snd.innerHTML = config.soundEnabled ? SVG_SOUND : SVG_SOUND_OFF;
    snd.style.color = config.soundEnabled ? "" : "var(--frozen)";
  });
  q<HTMLButtonElement>(".del").addEventListener("click", () => removeZone(zone));

  zonesEl.appendChild(row);
  zones.push(zone);
  refreshEmpty();
  refreshCounts();
}

function removeZone(zone: Zone): void {
  zone.row.remove();
  const i = zones.indexOf(zone);
  if (i >= 0) zones.splice(i, 1);
  refreshEmpty();
  refreshCounts();
}

function activeCount(): number {
  return zones.filter((z) => z.config.enabled).length;
}

function refreshCounts(): void {
  zCount.textContent = `${activeCount()} active`;
  footStatus.textContent = running
    ? `Watching ${activeCount()} of ${zones.length} zones`
    : zones.length
      ? `Idle — ${zones.length} zones ready`
      : "Idle — select zones to begin";
}

// --- monitoring loop -------------------------------------------------------
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
    void window.spike.runInjection({ x, y, text: "" });
  },
};

const notifier = {
  notifyFrozen(frame: PixelFrame, name: string): void {
    const z = zones.find((zz) => zz.config.name === name);
    if (z) {
      z.frozenEdges += 1;
      z.frozenEl.textContent = String(z.frozenEdges);
      z.thumb.src = frameToThumb(frame, 0, 0, frame.width, frame.height);
      lastFrozenBbox = [...z.config.bbox] as Bbox;
    }
    if (telegramChk.checked && telegram) telegram.notifyFrozen(frame, name);
  },
};

function paintZone(z: Zone): void {
  const s = z.state;
  const pct = s.similarity * 100;
  let kind: "ok" | "warn" | "frozen";
  if (s.isFrozen) kind = "frozen";
  else if (s.similarity >= 0.9) kind = "warn";
  else kind = "ok";
  z.simfill.style.width = `${pct.toFixed(1)}%`;
  z.simfill.className = `simfill${kind === "ok" ? "" : " " + kind}`;
  z.simpct.textContent = `${pct.toFixed(1)}%`;
  z.pill.textContent = kind === "frozen" ? "Frozen" : kind === "warn" ? "Watching" : "OK";
  z.pill.className = `pill pill-${kind}`;
  z.dot.style.background = kind === "frozen" ? "var(--frozen)" : kind === "warn" ? "var(--warn-bar)" : "var(--ok)";
}

function tick(): void {
  if (!monitor || !capturer || capturer.frameWidth === 0 || zones.length === 0) return;
  monitor.checkZones(zones.map((z) => z.config), zones.map((z) => z.state), threshold(), consec());
  for (const z of zones) paintZone(z);
  lastCheck.textContent = new Date().toLocaleTimeString();
  refreshCounts();
}

function setRunning(on: boolean): void {
  running = on;
  toggleBtn.textContent = on ? `● Stop · ${HOTKEYS.stop}` : `Start · ${HOTKEYS.start}`;
  toggleBtn.classList.toggle("is-stopped", !on);
  runBadge.className = `badge ${on ? "badge-ok" : "badge-idle"}`;
  runBadge.innerHTML = `<span class="dot"></span> ${on ? "Running" : "Stopped"}`;
  refreshCounts();
}

async function startMonitoring(): Promise<void> {
  if (timer) return;
  try {
    const cap = await ensureCapture();
    if (!monitor) monitor = new FreezeMonitor(cap, new RMSComparator(), sound, injector, notifier);
    zones.forEach((z) => z.state.reset());
    sound.setCooldown(intervalMs());
    timer = setInterval(tick, intervalMs());
    setRunning(true);
  } catch (e) {
    footStatus.textContent =
      "Capture failed (grant Screen Recording): " + (e instanceof Error ? e.message : String(e));
  }
}

function stopMonitoring(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  setRunning(false);
}

toggleBtn.addEventListener("click", () => (running ? stopMonitoring() : void startMonitoring()));
window.spike.onHotkey((which: string) => {
  if (which === "start") void startMonitoring();
  else if (which === "stop") stopMonitoring();
  else if (which === "select") selectZones();
});

// --- overlay-driven zone selection ----------------------------------------
let overlayBusy = false; // guards against stacking overlays (e.g. F8 spam)

async function withScreenshot<T>(use: (shot: { dataURL: string; frameW: number; frameH: number; frame: PixelFrame }) => Promise<T>): Promise<T | null> {
  if (overlayBusy) return null;
  overlayBusy = true;
  try {
    const cap = await ensureCapture();
    // Hide our window FIRST, then let the live capture catch up, so the
    // screenshot shows the desktop behind us — not the screensound window.
    await window.spike.setWindowVisible(false);
    await new Promise((r) => setTimeout(r, 200));
    const frame = cap.grabRegion([0, 0, cap.frameWidth, cap.frameHeight]);
    const shot = { dataURL: frameToDataURL(frame), frameW: cap.frameWidth, frameH: cap.frameHeight, frame };
    return await use(shot);
  } catch (e) {
    footStatus.textContent = "Capture failed: " + (e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    await window.spike.setWindowVisible(true);
    overlayBusy = false;
  }
}

function selectZones(): void {
  void withScreenshot(async (shot) => {
    const res = await window.spike.openOverlay({
      mode: "select",
      dataURL: shot.dataURL,
      frameW: shot.frameW,
      frameH: shot.frameH,
    });
    if (res && Array.isArray(res.zones)) for (const b of res.zones) addZone(b, shot.frame);
  });
}

selectBtn.addEventListener("click", selectZones);

showBtn.addEventListener("click", () => {
  void withScreenshot(async (shot) => {
    await window.spike.openOverlay({
      mode: "show",
      dataURL: shot.dataURL,
      frameW: shot.frameW,
      frameH: shot.frameH,
      zones: zones.map((z) => z.config.bbox),
    });
  });
});

defocusBtn.addEventListener("click", () => {
  void withScreenshot(async (shot) => {
    const res = await window.spike.openOverlay({
      mode: "defocus",
      dataURL: shot.dataURL,
      frameW: shot.frameW,
      frameH: shot.frameH,
    });
    if (res && res.point) {
      defocusPoint = res.point;
      defocusStatus.textContent = `Point at (${res.point.x}, ${res.point.y})`;
    }
  });
});

// --- Telegram --------------------------------------------------------------
function setTgBadge(connected: boolean): void {
  tgBadge.className = `badge ${connected ? "badge-ok" : "badge-idle"}`;
  tgBadge.innerHTML = `<span class="dot"></span> ${connected ? "Connected" : "Not set"}`;
}

function typeReplyIntoLastZone(text: string): void {
  if (!lastFrozenBbox || !capturer || capturer.frameWidth === 0) {
    tgEl.textContent = "Reply ignored: no frozen zone yet";
    return;
  }
  const { x, y } = bboxCenterToScreen(
    lastFrozenBbox,
    capturer.frameWidth,
    capturer.frameHeight,
    window.screen.width,
    window.screen.height,
  );
  void window.spike.runInjection({ x, y, text, defocus: defocusPoint ?? undefined });
  tgEl.textContent = `Typed reply: ${JSON.stringify(text)}`;
}

function applyCreds(token: string, chatId: string): void {
  if (poller) poller.stop();
  if (token && chatId) {
    telegram = new TelegramNotifier(token, chatId, (s: string) => (tgEl.textContent = s));
    poller = new TelegramPoller(token, chatId, typeReplyIntoLastZone);
    poller.start(); // remote control is on whenever creds are set
    setTgBadge(true);
  } else {
    telegram = null;
    poller = null;
    setTgBadge(false);
  }
}

tgSave.addEventListener("click", () => {
  const token = tgToken.value.trim();
  const chatId = tgChat.value.trim();
  if (!token || !chatId) {
    tgEl.textContent = "Both bot token and chat ID are required.";
    return;
  }
  void window.spike
    .saveTelegramConfig({ token, chatId })
    .then((r: { ok: boolean; path?: string; error?: string }) => {
      if (r.ok) {
        applyCreds(token, chatId);
        tgEl.textContent = `Saved to ${r.path}`;
      } else {
        tgEl.textContent = `Save failed: ${r.error}`;
      }
    });
});

// --- init ------------------------------------------------------------------
window.spike.getVersion().then((v: string) => (verEl.textContent = v));
window.spike.getTelegramConfig().then(({ token, chatId }: { token: string; chatId: string }) => {
  tgToken.value = token;
  tgChat.value = chatId;
  applyCreds(token, chatId);
});
selectLbl.textContent = `Select zones · ${HOTKEYS.select}`;
refreshDetectionLabels();
refreshEmpty();
setRunning(false);
window.addEventListener("error", (e) => (footStatus.textContent = "JS error: " + e.message));
