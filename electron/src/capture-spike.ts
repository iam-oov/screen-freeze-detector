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
  stateKind,
  type Bbox,
  type PixelFrame,
} from "./domain.ts";
import { ScreenCapturer, startCapture, bboxCenterToScreen } from "./capture.ts";
import { WebAudioSound } from "./sound.ts";
import { TelegramNotifier, TelegramPoller, parseZoneReply } from "./telegram.ts";
import { HOTKEYS, DEFAULTS, ALARM_REPEAT_MS, TELEGRAM_COMMANDS, TELEGRAM_GLOBAL_COMMANDS } from "../constants.js";

const STATE_LABEL = { ok: "OK", warn: "Watching", frozen: "Frozen" } as const;
const KIND_COLOR = { ok: "var(--ok)", warn: "var(--warn-bar)", frozen: "var(--frozen)" } as const;

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
const volumeEl = $("volume") as HTMLInputElement;
const volVal = $("volVal");
const tgBadge = $("tgBadge");
const tgToken = $("tgToken") as HTMLInputElement;
const tgChat = $("tgChat") as HTMLInputElement;
const tgSave = $("tgSave") as HTMLButtonElement;
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
const SVG_ENTER =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 10 4 15l5 5"/><path d="M4 15h11a5 5 0 0 0 5-5V4"/></svg>';
const SVG_TG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
const SVG_CAPTURE =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
const SVG_PLAY =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const SVG_STOP =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';

// --- state -----------------------------------------------------------------
interface Zone {
  config: ZoneConfig;
  state: ZoneState;
  row: HTMLElement;
  thumb: HTMLImageElement;
  dot: HTMLElement;
  simpct: HTMLElement;
  pill: HTMLElement;
  progEl: HTMLElement;
}
const zones: Zone[] = [];
let zoneSeq = 0;

// The alarm cadence is driven by a renderer timer (updateAlarm), not the capture
// loop, so the beep can repeat faster than captures happen. The monitor is given
// a no-op sound to avoid a second beep at the capture rate.
const sound = new WebAudioSound();
const silentMonitorSound = { play(): void {} };

let alarmTimer: ReturnType<typeof setInterval> | null = null;
function anyAlarming(): boolean {
  return zones.some((z) => z.config.enabled && z.config.soundEnabled && z.state.isFrozen);
}
function stopAlarm(): void {
  if (alarmTimer) {
    clearInterval(alarmTimer);
    alarmTimer = null;
  }
}
function updateAlarm(): void {
  if (!anyAlarming()) {
    stopAlarm();
    return;
  }
  if (!alarmTimer) {
    sound.play();
    alarmTimer = setInterval(() => (anyAlarming() ? sound.play() : stopAlarm()), ALARM_REPEAT_MS);
  }
}
let capturer: ScreenCapturer | null = null;
let monitor: FreezeMonitor | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

let telegram: TelegramNotifier | null = null;
let poller: TelegramPoller | null = null;
let lastFrozenBbox: Bbox | null = null;
let selectedZoneName: string | null = null; // last zone tapped in Telegram
let defocusPoint: { x: number; y: number } | null = null;

// --- live settings ---------------------------------------------------------
const num = (el: HTMLInputElement, fallback: number): number => {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
};
const threshold = (): number => num(thresholdEl, DEFAULT_THRESHOLD);
const consec = (): number => Math.max(1, Math.round(num(consecEl, DEFAULT_CONSEC)));
const intervalMs = (): number => Math.max(100, Math.round(num(intervalEl, DEFAULT_INTERVAL_MS)));
const volume = (): number => num(volumeEl, 1);

function paintRange(el: HTMLInputElement): void {
  const min = parseFloat(el.min);
  const max = parseFloat(el.max);
  const pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
  el.style.background = `linear-gradient(to right, var(--dark) 0 ${pct}%, var(--line) ${pct}% 100%)`;
}

function refreshDetectionLabels(): void {
  thrVal.textContent = `${(threshold() * 100).toFixed(1)}%`;
  const s = intervalMs() / 1000;
  intVal.textContent = `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
  paintRange(thresholdEl);
  paintRange(intervalEl);
}

function refreshVolume(): void {
  volVal.textContent = `${Math.round(volume() * 100)}%`;
  paintRange(volumeEl);
  sound.setVolume(volume());
}

thresholdEl.addEventListener("input", refreshDetectionLabels);
intervalEl.addEventListener("input", refreshDetectionLabels);
volumeEl.addEventListener("input", refreshVolume);
intervalEl.addEventListener("change", () => {
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
  const config = new ZoneConfig(bbox, `z${n}`);
  const state = new ZoneState();
  const [x1, y1, x2, y2] = bbox;

  const row = document.createElement("div");
  row.className = "zrow";
  row.innerHTML =
    '<div class="zname"><img class="thumb" alt="" /><span class="zdot"></span><span class="nm"></span></div>' +
    `<span class="zsize">${x2 - x1}×${y2 - y1}</span>` +
    '<div class="zsim"><span class="simpct">—</span></div>' +
    '<span class="zstate"><span class="pill pill-ok">OK</span></span>' +
    '<span class="zprog c-center">—</span>' +
    '<span class="zactive"><label class="switch sm"><input type="checkbox" class="activeChk" checked /><span class="slider"></span></label></span>' +
    `<span class="zactions"><button class="ic snd" title="Sound">${SVG_SOUND}</button><button class="ic ent" title="Press Enter on freeze">${SVG_ENTER}</button><button class="ic tg" title="Send to Telegram on freeze">${SVG_TG}</button><button class="ic cap" title="Set Telegram capture area" style="display:none">${SVG_CAPTURE}</button><button class="ic del" title="Remove">${SVG_TRASH}</button></span>`;

  const q = <T extends Element>(sel: string): T => row.querySelector(sel) as T;
  const zone: Zone = {
    config,
    state,
    row,
    thumb: q<HTMLImageElement>(".thumb"),
    dot: q<HTMLElement>(".zdot"),
    simpct: q<HTMLElement>(".simpct"),
    pill: q<HTMLElement>(".pill"),
    progEl: q<HTMLElement>(".zprog"),
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
  const ent = q<HTMLButtonElement>(".ent");
  const paintEnter = (): void => {
    ent.style.opacity = config.injectEnabled ? "1" : "0.4";
    ent.style.color = config.injectEnabled ? "var(--accent)" : "";
  };
  paintEnter();
  ent.addEventListener("click", () => {
    config.injectEnabled = !config.injectEnabled;
    paintEnter();
    if (config.injectEnabled) injectAlreadyFrozen(zone);
  });
  const snd = q<HTMLButtonElement>(".snd");
  const paintSound = (): void => {
    snd.innerHTML = config.soundEnabled ? SVG_SOUND : SVG_SOUND_OFF;
    snd.style.color = config.soundEnabled ? "var(--accent)" : "";
    snd.style.opacity = config.soundEnabled ? "1" : "0.4";
  };
  paintSound();
  snd.addEventListener("click", () => {
    config.soundEnabled = !config.soundEnabled;
    paintSound();
  });
  const tg = q<HTMLButtonElement>(".tg");
  const cap = q<HTMLButtonElement>(".cap");
  const paintCap = (): void => {
    cap.style.color = config.photoBbox ? "var(--accent)" : "";
    cap.style.opacity = config.photoBbox ? "1" : "0.6";
  };
  const paintTg = (): void => {
    tg.style.opacity = config.telegramEnabled ? "1" : "0.4";
    tg.style.color = config.telegramEnabled ? "var(--accent)" : "";
    cap.style.display = config.telegramEnabled ? "" : "none";
  };
  paintCap();
  paintTg();
  tg.addEventListener("click", () => {
    config.telegramEnabled = !config.telegramEnabled;
    paintTg();
    updateDefocusWarning();
    if (config.telegramEnabled) notifyAlreadyFrozen(zone);
  });
  cap.addEventListener("click", () => openCaptureZone(zone, paintCap));
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
  updateDefocusWarning();
}

// A zone has Telegram enabled but no global defocus point is set. Typed Telegram
// replies would then leave a blinking caret on the focused input, whose pixels
// keep toggling, so the zone never re-freezes. Warn so it isn't forgotten.
// (Only typed replies need it — photo send and the Enter command don't.)
function updateDefocusWarning(): void {
  const needsDefocus = defocusPoint === null && zones.some((z) => z.config.telegramEnabled);
  defocusBtn.classList.toggle("warn", needsDefocus);
  if (defocusPoint) {
    defocusStatus.textContent = `Point at (${defocusPoint.x}, ${defocusPoint.y})`;
    defocusStatus.classList.remove("warn");
  } else {
    defocusStatus.textContent = needsDefocus
      ? "⚠ Set a defocus point — replies won't re-freeze"
      : "No point set";
    defocusStatus.classList.toggle("warn", needsDefocus);
  }
  for (const z of zones) {
    z.row.querySelector(".tg")?.classList.toggle("warn", needsDefocus && z.config.telegramEnabled);
  }
}

function activeCount(): number {
  return zones.filter((z) => z.config.enabled).length;
}

function refreshCounts(): void {
  zCount.textContent = `${activeCount()} active`;
  showBtn.disabled = zones.length <= 1;
  footStatus.textContent = running
    ? `Watching ${activeCount()} of ${zones.length} zones`
    : zones.length
      ? `Idle — ${zones.length} zones ready`
      : "Idle — select zones to begin";
}

// --- monitoring loop -------------------------------------------------------
// Inject text (or just Enter when text is "") into a zone bbox; returns the
// injection promise so callers can confirm once it completes.
function injectInto(bbox: Bbox, text: string, defocus?: { x: number; y: number }): Promise<unknown> {
  if (!capturer || capturer.frameWidth === 0) return Promise.resolve();
  const { x, y } = bboxCenterToScreen(
    bbox,
    capturer.frameWidth,
    capturer.frameHeight,
    window.screen.width,
    window.screen.height,
  );
  return window.spike.runInjection({ x, y, text, defocus });
}

const injector = {
  inject(bbox?: Bbox): void {
    if (bbox) void injectInto(bbox, "");
  },
};

// Serialize Telegram sends so messages arrive in order (buttons before photos,
// confirmations after) instead of racing as fire-and-forget.
let tgQueue: Promise<unknown> = Promise.resolve();
function tgEnqueue(fn: () => Promise<unknown>): void {
  tgQueue = tgQueue.then(fn).catch(() => {});
}
function tgNote(text: string): void {
  const t = telegram;
  if (t) tgEnqueue(() => t.sendNote(text));
}

// Send the frozen-zone chooser + photo to Telegram (serialized). Shared by the
// edge-trigger notifier and the "enabled while already frozen" catch-up. The photo
// comes from the zone's independent capture area (photoBbox) when set, else the
// detection bbox — grabbed fresh (the zone is frozen, so a slightly-later grab is
// fine). Always offer the buttons (even for a single zone) so you can target the
// right zone with one tap. Buttons first, then the screenshot — serialized so order
// is deterministic.
function sendFrozenTelegram(z: Zone): void {
  const tg = telegram;
  if (!tg || !capturer || capturer.frameWidth === 0) return;
  const frozen = zones
    .filter((zz) => zz.state.isFrozen && zz.config.telegramEnabled)
    .map((zz) => zz.config.name);
  let frame: PixelFrame;
  try {
    frame = capturer.grabRegion(z.config.photoBbox ?? z.config.bbox);
  } catch {
    return;
  }
  tgEnqueue(async () => {
    await tg.sendChooser(frozen);
    await tg.notifyFrozen(frame, z.config.name);
  });
}

const notifier = {
  notifyFrozen(frame: PixelFrame, name: string): void {
    const z = zones.find((zz) => zz.config.name === name);
    if (z) {
      z.thumb.src = frameToThumb(frame, 0, 0, frame.width, frame.height);
      lastFrozenBbox = [...z.config.bbox] as Bbox;
    }
    if (z && z.config.telegramEnabled) sendFrozenTelegram(z);
  },
};

// Edge-trigger catch-up: enabling Telegram on a zone that is ALREADY frozen would
// otherwise send nothing (the freeze edge already passed). Refresh the thumb and
// fire the same chooser + photo once.
function notifyAlreadyFrozen(z: Zone): void {
  if (!telegram || !z.config.telegramEnabled || !z.state.isFrozen) return;
  if (!capturer || capturer.frameWidth === 0) return;
  try {
    const thumb = capturer.grabRegion(z.config.bbox);
    z.thumb.src = frameToThumb(thumb, 0, 0, thumb.width, thumb.height);
  } catch {
    /* thumb refresh is best-effort */
  }
  lastFrozenBbox = [...z.config.bbox] as Bbox;
  sendFrozenTelegram(z);
}

// Same edge-trigger catch-up for Enter: enabling inject on an already-frozen zone
// would otherwise never fire (the freeze edge already passed). Press Enter once.
function injectAlreadyFrozen(z: Zone): void {
  if (z.config.injectEnabled && z.state.isFrozen) injector.inject(z.config.bbox);
}

function paintZone(z: Zone): void {
  const s = z.state;
  const pct = s.similarity * 100;
  const kind = stateKind(s, threshold());
  z.simpct.textContent = `${pct.toFixed(1)}%`;
  z.simpct.style.color = KIND_COLOR[kind];
  z.pill.textContent = STATE_LABEL[kind];
  z.pill.className = `pill pill-${kind}`;
  const need = consec();
  z.progEl.textContent = `${Math.min(s.frozenCount, need)}/${need}`;
  z.dot.style.background = KIND_COLOR[kind];
}

function tick(): void {
  if (!monitor || !capturer || capturer.frameWidth === 0 || zones.length === 0) return;
  monitor.checkZones(zones.map((z) => z.config), zones.map((z) => z.state), threshold(), consec());
  for (const z of zones) paintZone(z);
  updateAlarm();
  lastCheck.textContent = new Date().toLocaleTimeString();
  refreshCounts();
}

function setRunning(on: boolean): void {
  running = on;
  toggleBtn.innerHTML = on
    ? `${SVG_STOP}<span>Stop · ${HOTKEYS.stop}</span>`
    : `${SVG_PLAY}<span>Start · ${HOTKEYS.start}</span>`;
  toggleBtn.classList.toggle("is-stopped", !on);
  runBadge.className = `badge ${on ? "badge-ok" : "badge-idle"}`;
  runBadge.innerHTML = `<span class="dot"></span> ${on ? "Running" : "Stopped"}`;
  refreshCounts();
}

async function startMonitoring(): Promise<void> {
  if (timer) return;
  try {
    const cap = await ensureCapture();
    if (!monitor) monitor = new FreezeMonitor(cap, new RMSComparator(), silentMonitorSound, injector, notifier);
    zones.forEach((z) => z.state.reset());
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
  stopAlarm();
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

function bboxEq(a: Bbox, b: Bbox): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

// Apply a resized detection bbox to an existing zone: re-baseline the freeze state
// (the old prevImage is for the old region) and refresh the size label + thumbnail.
function updateZoneBbox(z: Zone, bbox: Bbox, fullFrame: PixelFrame): void {
  z.config.bbox = bbox;
  z.state.reset();
  const [x1, y1, x2, y2] = bbox;
  const size = z.row.querySelector(".zsize");
  if (size) size.textContent = `${x2 - x1}×${y2 - y1}`;
  z.thumb.src = frameToThumb(fullFrame, x1, y1, x2 - x1, y2 - y1);
}

function selectZones(): void {
  void withScreenshot(async (shot) => {
    const res = await window.spike.openOverlay({
      mode: "select",
      dataURL: shot.dataURL,
      frameW: shot.frameW,
      frameH: shot.frameH,
      // Existing zones load editable; the overlay returns them (possibly resized) as
      // `existing` aligned by index, plus any newly drawn `added` ones.
      zones: zones.map((z) => z.config.bbox),
    });
    if (!res) return;
    if (Array.isArray(res.existing)) {
      res.existing.forEach((b: Bbox, i: number) => {
        const z = zones[i];
        if (z && !bboxEq(z.config.bbox, b)) updateZoneBbox(z, b, shot.frame);
      });
    }
    if (Array.isArray(res.added)) for (const b of res.added) addZone(b, shot.frame);
  });
}

function openCaptureZone(z: Zone, onSet: () => void): void {
  void withScreenshot(async (shot) => {
    const res = await window.spike.openOverlay({
      mode: "capture",
      dataURL: shot.dataURL,
      frameW: shot.frameW,
      frameH: shot.frameH,
      detection: z.config.bbox,
      current: z.config.photoBbox,
    });
    if (res && Array.isArray(res.bbox)) {
      z.config.photoBbox = res.bbox;
      onSet();
    }
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
      updateDefocusWarning();
    }
  });
});

// --- Telegram --------------------------------------------------------------
function setTgBadge(connected: boolean): void {
  tgBadge.className = `badge ${connected ? "badge-ok" : "badge-idle"}`;
  tgBadge.innerHTML = `<span class="dot"></span> ${connected ? "Connected" : "Not set"}`;
}

function zoneByName(name: string | null): Zone | null {
  return name ? (zones.find((z) => z.config.name === name) ?? null) : null;
}

// Reply to the chat with one line per zone: name + current state. Global (no
// target zone needed), serialized through the same queue as the other sends.
function sendStatus(): void {
  const t = telegram;
  if (!t) return;
  const body = zones.length
    ? zones
        .map((z) => `${z.config.name}  ${z.config.enabled ? STATE_LABEL[stateKind(z.state, threshold())] : "OFF"}`)
        .join("\n")
    : "No zones";
  tgEnqueue(() => t.sendText(body));
}

// A chat reply: a global command ("/status") replies with the summary; otherwise
// resolve the target zone (explicit "z2:" prefix -> last tapped -> last frozen),
// then run a command word ("enter") or type the message.
async function handleReply(text: string): Promise<void> {
  if (TELEGRAM_GLOBAL_COMMANDS[text.trim().toLowerCase()] === "status") {
    sendStatus();
    return;
  }
  const { zone, message } = parseZoneReply(text, zones.map((z) => z.config.name));
  const target =
    zoneByName(zone)?.config.bbox ?? zoneByName(selectedZoneName)?.config.bbox ?? lastFrozenBbox;
  if (!target || !capturer || capturer.frameWidth === 0) {
    tgEl.textContent = "Reply ignored: no frozen zone yet";
    return;
  }
  const tag = zone ? ` → ${zone}` : "";
  if (TELEGRAM_COMMANDS[message.trim().toLowerCase()] === "enter") {
    await injectInto(target, "");
    tgEl.textContent = `Enter${tag}`;
    tgNote(`✓ Enter${tag}`);
  } else {
    await injectInto(target, message, defocusPoint ?? undefined);
    tgEl.textContent = `Typed${tag}: ${JSON.stringify(message)}`;
    tgNote(`✓ Typed${tag}: ${message}`);
  }
}

// An inline-button tap: press Enter on that zone now AND pre-select it for the
// next typed reply. Returns the toast shown on the button.
function onZoneCallback(code: string): string {
  const z = zoneByName(code);
  if (!z || !capturer || capturer.frameWidth === 0) return "Unknown zone";
  selectedZoneName = code;
  void injectInto(z.config.bbox, "").then(() => tgNote(`✓ Enter → ${code}`));
  return `Enter → ${code} · reply to type`;
}

function applyCreds(token: string, chatId: string): void {
  if (poller) poller.stop();
  if (token && chatId) {
    telegram = new TelegramNotifier(token, chatId, (s: string) => (tgEl.textContent = s));
    poller = new TelegramPoller(token, chatId, handleReply, onZoneCallback);
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
// constants.js DEFAULTS drive the initial control values (the HTML attributes
// are just pre-JS placeholders).
thresholdEl.value = String(DEFAULT_THRESHOLD);
intervalEl.value = String(DEFAULT_INTERVAL_MS);
consecEl.value = String(DEFAULT_CONSEC);
refreshDetectionLabels();
refreshVolume();
refreshEmpty();
setRunning(false);
window.addEventListener("error", (e) => (footStatus.textContent = "JS error: " + e.message));
