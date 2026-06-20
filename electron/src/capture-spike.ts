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
} from './domain.ts';
import { ScreenCapturer, startCapture, bboxCenterToScreen } from './capture.ts';
import { WebAudioSound } from './sound.ts';
import {
  TelegramNotifier,
  TelegramPoller,
  parseZoneReply,
  parseCtrlc,
  parseUp,
  parseDown,
  parseEnter,
} from './telegram.ts';
import {
  HOTKEYS,
  DEFAULTS,
  ALARM_REPEAT_MS,
  TELEGRAM_COMMANDS,
  ARROW_REPEAT_MAX,
} from '../constants.js';
import {
  DiskPreferencesStore,
  type Prefs,
  type PreferencesStore,
  type ZonePrefs,
} from './prefs.ts';

const STATE_LABEL = { ok: 'OK', warn: 'Watching', frozen: 'Frozen' } as const;
const KIND_COLOR = {
  ok: 'var(--ok)',
  warn: 'var(--warn-bar)',
  frozen: 'var(--frozen)',
} as const;

const DEFAULT_THRESHOLD = DEFAULTS.threshold;
const DEFAULT_CONSEC = DEFAULTS.consec;
const DEFAULT_INTERVAL_MS = DEFAULTS.intervalMs;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

// --- static refs -----------------------------------------------------------
const video = $('video') as HTMLVideoElement;
const verEl = $('ver');
const toggleBtn = $('toggleBtn') as HTMLButtonElement;
const runBadge = $('runBadge');
const cfg = $('cfg');
const cfgHeader = $('cfgHeader');
const thresholdEl = $('threshold') as HTMLInputElement;
const thrNum = $('thrNum') as HTMLInputElement;
const thrMinus = $('thrMinus') as HTMLButtonElement;
const thrPlus = $('thrPlus') as HTMLButtonElement;
const intervalEl = $('interval') as HTMLInputElement;
const intNum = $('intNum') as HTMLInputElement;
const intMinus = $('intMinus') as HTMLButtonElement;
const intPlus = $('intPlus') as HTMLButtonElement;
const consecEl = $('consec') as HTMLInputElement;
const consecMinus = $('consecMinus') as HTMLButtonElement;
const consecPlus = $('consecPlus') as HTMLButtonElement;
const volumeEl = $('volume') as HTMLInputElement;
const volNum = $('volNum') as HTMLInputElement;
const volMinus = $('volMinus') as HTMLButtonElement;
const volPlus = $('volPlus') as HTMLButtonElement;
const tgBadge = $('tgBadge');
const tgToken = $('tgToken') as HTMLInputElement;
const tgChat = $('tgChat') as HTMLInputElement;
const resetBtn = $('resetBtn') as HTMLButtonElement;
const tgEl = $('tg');
const zCount = $('zCount');
const selectBtn = $('selectBtn') as HTMLButtonElement;
const selectLbl = $('selectLbl');
const showBtn = $('showBtn') as HTMLButtonElement;
const zonesEl = $('zones');
const footStatus = $('footStatus');
const lastCheck = $('lastCheck');

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
  simpct: HTMLElement;
  pill: HTMLElement;
  progEl: HTMLElement;
}
const zones: Zone[] = [];

// The alarm cadence is driven by a renderer timer (updateAlarm), not the capture
// loop, so the beep can repeat faster than captures happen. The monitor is given
// a no-op sound to avoid a second beep at the capture rate.
const sound = new WebAudioSound();
const silentMonitorSound = { play(): void {} };

let alarmTimer: ReturnType<typeof setInterval> | null = null;
function anyAlarming(): boolean {
  return zones.some(
    (z) => z.config.enabled && z.config.soundEnabled && z.state.isFrozen,
  );
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
    alarmTimer = setInterval(
      () => (anyAlarming() ? sound.play() : stopAlarm()),
      ALARM_REPEAT_MS,
    );
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

// --- live settings ---------------------------------------------------------
const num = (el: HTMLInputElement, fallback: number): number => {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
};
const threshold = (): number => num(thresholdEl, DEFAULT_THRESHOLD);
const consec = (): number =>
  Math.max(1, Math.round(num(consecEl, DEFAULT_CONSEC)));
const intervalMs = (): number =>
  Math.max(100, Math.round(num(intervalEl, DEFAULT_INTERVAL_MS)));
const volume = (): number => num(volumeEl, 1);

function paintRange(el: HTMLInputElement): void {
  const min = parseFloat(el.min);
  const max = parseFloat(el.max);
  const pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
  el.style.background = `linear-gradient(to right, var(--dark) 0 ${pct}%, var(--line) ${pct}% 100%)`;
}

interface NumField {
  slider: HTMLInputElement;
  input: HTMLInputElement;
  minus: HTMLButtonElement;
  plus: HTMLButtonElement;
  toDisplay: (raw: number) => number;
  fromDisplay: (d: number) => number;
  step: number; // in display units
  decimals: number;
  apply: () => void; // side effects (no save)
}

// Wire a slider to a typeable −input+ stepper in display units, synced both ways.
// The slider uses step="any" so typed decimals aren't snapped. Returns a sync()
// that reflects the slider into the input (for defaults/restore).
function wireNumField(f: NumField): () => void {
  const dMin = f.toDisplay(parseFloat(f.slider.min));
  const dMax = f.toDisplay(parseFloat(f.slider.max));
  const clampD = (d: number): number => Math.min(dMax, Math.max(dMin, d));
  const fmt = (d: number): string => clampD(d).toFixed(f.decimals);
  const cur = (): number => f.toDisplay(parseFloat(f.slider.value));
  const commit = (d: number, reformat: boolean): void => {
    f.slider.value = String(f.fromDisplay(clampD(d)));
    paintRange(f.slider);
    if (reformat) f.input.value = fmt(d);
    f.apply();
    scheduleSave();
  };
  f.slider.addEventListener('input', () => commit(cur(), true));
  f.input.addEventListener('input', () => {
    const d = parseFloat(f.input.value);
    if (Number.isFinite(d)) commit(d, false);
  });
  f.input.addEventListener(
    'change',
    () => (f.input.value = fmt(parseFloat(f.input.value) || dMin)),
  );
  f.minus.addEventListener('click', () => commit(cur() - f.step, true));
  f.plus.addEventListener('click', () => commit(cur() + f.step, true));
  return () => {
    f.input.value = fmt(cur());
    paintRange(f.slider);
    f.apply();
  };
}

const numFieldSyncs = [
  wireNumField({
    slider: thresholdEl,
    input: thrNum,
    minus: thrMinus,
    plus: thrPlus,
    toDisplay: (r) => r * 100,
    fromDisplay: (d) => d / 100,
    step: 0.1,
    decimals: 2,
    apply: () => {},
  }),
  wireNumField({
    slider: intervalEl,
    input: intNum,
    minus: intMinus,
    plus: intPlus,
    toDisplay: (r) => r / 1000,
    fromDisplay: (d) => d * 1000,
    step: 0.1,
    decimals: 1,
    apply: () => {
      if (timer) {
        clearInterval(timer);
        timer = setInterval(tick, intervalMs());
      }
    },
  }),
  wireNumField({
    slider: volumeEl,
    input: volNum,
    minus: volMinus,
    plus: volPlus,
    toDisplay: (r) => r * 100,
    fromDisplay: (d) => d / 100,
    step: 5,
    decimals: 0,
    apply: () => sound.setVolume(volume()),
  }),
];
function syncNumFields(): void {
  for (const s of numFieldSyncs) s();
}

consecMinus.addEventListener('click', () => {
  consecEl.value = String(Math.max(1, consec() - 1));
  scheduleSave();
});
consecPlus.addEventListener('click', () => {
  consecEl.value = String(consec() + 1);
  scheduleSave();
});

cfgHeader.addEventListener('click', () => cfg.classList.toggle('collapsed'));

// --- preferences persistence -----------------------------------------------
// Auto-saved (debounced) to disk via the store, restored on launch. Swap the
// store for a remote (OAuth + Postgres) adapter later; the rest stays the same.
const prefsStore: PreferencesStore = new DiskPreferencesStore();
let prefsLoaded = false; // gate saving until the initial load has been applied
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (!prefsLoaded) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void prefsStore.save(collectPrefs()), 400);
}

function collectPrefs(): Prefs {
  return {
    threshold: threshold(),
    intervalMs: intervalMs(),
    consec: consec(),
    volume: volume(),
    zones: zones.map((z) => ({
      name: z.config.name,
      bbox: z.config.bbox,
      enabled: z.config.enabled,
      soundEnabled: z.config.soundEnabled,
      injectEnabled: z.config.injectEnabled,
      telegramEnabled: z.config.telegramEnabled,
      photoBbox: z.config.photoBbox,
    })),
  };
}

function applyPrefs(p: Prefs): void {
  if (typeof p.threshold === 'number') thresholdEl.value = String(p.threshold);
  if (typeof p.intervalMs === 'number') intervalEl.value = String(p.intervalMs);
  if (typeof p.consec === 'number') consecEl.value = String(p.consec);
  if (typeof p.volume === 'number') volumeEl.value = String(p.volume);
  syncNumFields();
  if (Array.isArray(p.zones)) {
    for (const zp of p.zones) restoreZone(zp);
  }
  refreshEmpty();
  refreshCounts();
}

// --- capture ---------------------------------------------------------------
function toClamped(d: Uint8ClampedArray | number[]): Uint8ClampedArray {
  return d instanceof Uint8ClampedArray ? d : new Uint8ClampedArray(d);
}

function frameToDataURL(frame: PixelFrame): string {
  const c = document.createElement('canvas');
  c.width = frame.width;
  c.height = frame.height;
  c.getContext('2d')!.putImageData(
    new ImageData(toClamped(frame.data), frame.width, frame.height),
    0,
    0,
  );
  return c.toDataURL('image/png');
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
      emptyEl = document.createElement('div');
      emptyEl.className = 'zempty';
      emptyEl.textContent = 'No zones yet — click “Select zones”.';
      zonesEl.appendChild(emptyEl);
    }
  } else if (emptyEl) {
    emptyEl.remove();
    emptyEl = null;
  }
}

function mountZone(config: ZoneConfig): void {
  const state = new ZoneState();
  const [x1, y1, x2, y2] = config.bbox;

  const row = document.createElement('div');
  row.className = 'zrow';
  row.innerHTML =
    '<div class="zname"><span class="nm"></span></div>' +
    `<span class="zsize">${x2 - x1}×${y2 - y1}</span>` +
    '<div class="zsim"><span class="simpct">—</span></div>' +
    '<span class="zstate"><span class="pill pill-ok">OK</span></span>' +
    '<span class="zprog c-center">—</span>' +
    '<span class="zactive"><label class="switch sm"><input type="checkbox" class="activeChk" /><span class="slider"></span></label></span>' +
    `<span class="zactions"><button class="ic snd" title="Sound">${SVG_SOUND}</button><button class="ic ent" title="Press Enter on freeze">${SVG_ENTER}</button><button class="ic tg" title="Send to Telegram on freeze">${SVG_TG}</button><button class="ic cap" title="Set Telegram capture area" style="display:none">${SVG_CAPTURE}</button><button class="ic del" title="Remove">${SVG_TRASH}</button></span>`;

  const q = <T extends Element>(sel: string): T => row.querySelector(sel) as T;
  const zone: Zone = {
    config,
    state,
    row,
    simpct: q<HTMLElement>('.simpct'),
    pill: q<HTMLElement>('.pill'),
    progEl: q<HTMLElement>('.zprog'),
  };
  q<HTMLElement>('.nm').textContent = config.name;

  const activeChk = q<HTMLInputElement>('.activeChk');
  activeChk.checked = config.enabled;
  row.style.opacity = config.enabled ? '1' : '0.5';
  activeChk.addEventListener('change', () => {
    config.enabled = activeChk.checked;
    row.style.opacity = config.enabled ? '1' : '0.5';
    refreshCounts();
    scheduleSave();
  });
  const ent = q<HTMLButtonElement>('.ent');
  const paintEnter = (): void => {
    ent.style.opacity = config.injectEnabled ? '1' : '0.4';
    ent.style.color = config.injectEnabled ? 'var(--accent)' : '';
  };
  paintEnter();
  ent.addEventListener('click', () => {
    config.injectEnabled = !config.injectEnabled;
    paintEnter();
    if (config.injectEnabled) injectAlreadyFrozen(zone);
    scheduleSave();
  });
  const snd = q<HTMLButtonElement>('.snd');
  const paintSound = (): void => {
    snd.innerHTML = config.soundEnabled ? SVG_SOUND : SVG_SOUND_OFF;
    snd.style.color = config.soundEnabled ? 'var(--accent)' : '';
    snd.style.opacity = config.soundEnabled ? '1' : '0.4';
  };
  paintSound();
  snd.addEventListener('click', () => {
    config.soundEnabled = !config.soundEnabled;
    paintSound();
    scheduleSave();
  });
  const tg = q<HTMLButtonElement>('.tg');
  const cap = q<HTMLButtonElement>('.cap');
  const paintCap = (): void => {
    cap.style.color = config.photoBbox ? 'var(--accent)' : '';
    cap.style.opacity = config.photoBbox ? '1' : '0.6';
  };
  const paintTg = (): void => {
    tg.style.opacity = config.telegramEnabled ? '1' : '0.4';
    tg.style.color = config.telegramEnabled ? 'var(--accent)' : '';
    cap.style.display = config.telegramEnabled ? '' : 'none';
  };
  paintCap();
  paintTg();
  tg.addEventListener('click', () => {
    config.telegramEnabled = !config.telegramEnabled;
    paintTg();
    if (config.telegramEnabled) notifyAlreadyFrozen(zone);
    scheduleSave();
  });
  cap.addEventListener('click', () =>
    openCaptureZone(zone, () => {
      paintCap();
      scheduleSave();
    }),
  );
  q<HTMLButtonElement>('.del').addEventListener('click', () =>
    removeZone(zone),
  );

  zonesEl.appendChild(row);
  zones.push(zone);
  refreshEmpty();
  refreshCounts();
}

function nextZoneCode(): string {
  const used = new Set(zones.map((z) => z.config.name));
  let n = 1;
  while (used.has(`z${n}`)) n++;
  return `z${n}`;
}

function addZone(bbox: Bbox): void {
  mountZone(new ZoneConfig(bbox, nextZoneCode()));
  scheduleSave();
}

function restoreZone(zp: ZonePrefs): void {
  mountZone(
    new ZoneConfig(
      zp.bbox,
      zp.name,
      zp.enabled,
      zp.soundEnabled,
      zp.injectEnabled,
      zp.telegramEnabled,
      zp.photoBbox,
    ),
  );
}

function removeZone(zone: Zone): void {
  zone.row.remove();
  const i = zones.indexOf(zone);
  if (i >= 0) zones.splice(i, 1);
  refreshEmpty();
  refreshCounts();
  scheduleSave();
}

function activeCount(): number {
  return zones.filter((z) => z.config.enabled).length;
}

function refreshCounts(): void {
  zCount.textContent = `${activeCount()} active`;
  showBtn.disabled = zones.length === 0;
  toggleBtn.disabled = !running && activeCount() === 0;
  footStatus.textContent = running
    ? `Watching ${activeCount()} of ${zones.length} zones`
    : zones.length
      ? `Idle — ${zones.length} zones ready`
      : 'Idle — select zones to begin';
}

// --- monitoring loop -------------------------------------------------------
function zoneScreenPoint(bbox: Bbox): { x: number; y: number } | null {
  if (!capturer || capturer.frameWidth === 0) return null;
  return bboxCenterToScreen(
    bbox,
    capturer.frameWidth,
    capturer.frameHeight,
    window.screen.width,
    window.screen.height,
  );
}

function injectInto(bbox: Bbox, text: string): Promise<unknown> {
  const p = zoneScreenPoint(bbox);
  if (!p) return Promise.resolve();
  return window.spike.runInjection({ x: p.x, y: p.y, text });
}

function interruptZone(bbox: Bbox): Promise<unknown> {
  const p = zoneScreenPoint(bbox);
  if (!p) return Promise.resolve();
  return window.spike.runInjection({ x: p.x, y: p.y, ctrlC: true });
}

// Click the zone's center to give the window under it input focus (no Enter).
function focusZone(bbox: Bbox): Promise<unknown> {
  const p = zoneScreenPoint(bbox);
  if (!p) return Promise.resolve();
  return window.spike.runInjection({ x: p.x, y: p.y, clickOnly: true });
}

function sendArrow(
  bbox: Bbox,
  key: 'up' | 'down',
  count: number,
): Promise<unknown> {
  const p = zoneScreenPoint(bbox);
  if (!p) return Promise.resolve();
  // Drop focus off the zone afterward (like a typed reply) so it can re-freeze.
  return window.spike
    .runInjection({ x: p.x, y: p.y, arrowKey: key, arrowCount: count })
    .then(() => window.spike.focusApp());
}

// Run a zone-prefixed Telegram command: resolve the zone, ensure capture, do the
// action, and report to the UI + chat. Shared by ctrlc / up / enter.
async function runZoneAction(
  code: string,
  name: string,
  action: (bbox: Bbox) => Promise<unknown>,
): Promise<void> {
  const z = zoneByName(code);
  if (!z) {
    tgNote(`Unknown zone: ${code}`);
    return;
  }
  try {
    await ensureCapture();
  } catch (e) {
    tgNote('Capture failed: ' + (e instanceof Error ? e.message : String(e)));
    return;
  }
  if (!capturer || capturer.frameWidth === 0) {
    tgNote('No capture yet — try again');
    return;
  }
  await action(z.config.bbox);
  const label = `${name} → ${z.config.name}`;
  tgEl.textContent = label;
  tgNote(`✓ ${label}`);
}

const injector = {
  inject(bbox?: Bbox): void {
    if (bbox) void injectInto(bbox, '');
  },
};

let tgQueue: Promise<unknown> = Promise.resolve();
function tgEnqueue(fn: () => Promise<unknown>): void {
  tgQueue = tgQueue.then(fn).catch(() => {});
}
function tgNote(text: string): void {
  const t = telegram;
  if (t) tgEnqueue(() => t.sendNote(text));
}

let freezeBatch: { frame: PixelFrame; name: string }[] | null = null;

function sendFrozenTelegram(z: Zone): void {
  const tg = telegram;
  if (!tg || !capturer || capturer.frameWidth === 0) return;
  let frame: PixelFrame;
  try {
    frame = capturer.grabRegion(z.config.photoBbox ?? z.config.bbox);
  } catch {
    return;
  }
  if (freezeBatch) {
    freezeBatch.push({ frame, name: z.config.name });
    return;
  }
  // Microtask, not sync: lets checkZones' mid-loop notifyFrozen calls settle
  // every zone's state first, so all messages share one button set.
  freezeBatch = [{ frame, name: z.config.name }];
  queueMicrotask(() => {
    const events = freezeBatch ?? [];
    freezeBatch = null;
    const codes = zones
      .filter((zz) => zz.state.isFrozen && zz.config.telegramEnabled)
      .map((zz) => zz.config.name);
    for (const ev of events)
      tgEnqueue(() => tg.sendFrozen(ev.frame, ev.name, codes));
  });
}

const notifier = {
  notifyFrozen(frame: PixelFrame, name: string): void {
    const z = zones.find((zz) => zz.config.name === name);
    if (z) lastFrozenBbox = [...z.config.bbox] as Bbox;
    if (z && z.config.telegramEnabled) sendFrozenTelegram(z);
  },
};

function notifyAlreadyFrozen(z: Zone): void {
  if (!telegram || !z.config.telegramEnabled || !z.state.isFrozen) return;
  lastFrozenBbox = [...z.config.bbox] as Bbox;
  sendFrozenTelegram(z);
}

function injectAlreadyFrozen(z: Zone): void {
  if (z.config.injectEnabled && z.state.isFrozen)
    injector.inject(z.config.bbox);
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
}

function tick(): void {
  if (!monitor || !capturer || capturer.frameWidth === 0 || zones.length === 0)
    return;
  monitor.checkZones(
    zones.map((z) => z.config),
    zones.map((z) => z.state),
    threshold(),
    consec(),
  );
  for (const z of zones) paintZone(z);
  updateAlarm();
  lastCheck.textContent = new Date().toLocaleTimeString();
  refreshCounts();
}

function setRunning(on: boolean): void {
  running = on;
  toggleBtn.innerHTML = on
    ? `${SVG_STOP}<span>Stop · ${HOTKEYS.toggle}</span>`
    : `${SVG_PLAY}<span>Start · ${HOTKEYS.toggle}</span>`;
  toggleBtn.classList.toggle('is-stopped', !on);
  runBadge.className = `badge ${on ? 'badge-ok' : 'badge-idle'}`;
  runBadge.innerHTML = `<span class="dot"></span> ${on ? 'Running' : 'Stopped'}`;
  refreshCounts();
}

async function startMonitoring(): Promise<void> {
  if (timer || activeCount() === 0) return;
  try {
    const cap = await ensureCapture();
    if (!monitor)
      monitor = new FreezeMonitor(
        cap,
        new RMSComparator(),
        silentMonitorSound,
        injector,
        notifier,
      );
    zones.forEach((z) => z.state.reset());
    timer = setInterval(tick, intervalMs());
    setRunning(true);
  } catch (e) {
    footStatus.textContent =
      'Capture failed (grant Screen Recording): ' +
      (e instanceof Error ? e.message : String(e));
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

toggleBtn.addEventListener('click', () =>
  running ? stopMonitoring() : void startMonitoring(),
);
window.spike.onHotkey((which: string) => {
  if (which === 'toggle') {
    if (running) stopMonitoring();
    else void startMonitoring();
  }
});

// --- overlay-driven zone selection ----------------------------------------
let overlayBusy = false; // guards against stacking overlays (e.g. rapid clicks)

async function withScreenshot<T>(
  use: (shot: {
    dataURL: string;
    frameW: number;
    frameH: number;
  }) => Promise<T>,
): Promise<T | null> {
  if (overlayBusy) return null;
  overlayBusy = true;
  try {
    const cap = await ensureCapture();
    await window.spike.setWindowVisible(false);
    await new Promise((r) => setTimeout(r, 200));
    const frame = cap.grabRegion([0, 0, cap.frameWidth, cap.frameHeight]);
    const shot = {
      dataURL: frameToDataURL(frame),
      frameW: cap.frameWidth,
      frameH: cap.frameHeight,
    };
    return await use(shot);
  } catch (e) {
    footStatus.textContent =
      'Capture failed: ' + (e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    await window.spike.setWindowVisible(true);
    overlayBusy = false;
  }
}

function bboxEq(a: Bbox, b: Bbox): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function updateZoneBbox(z: Zone, bbox: Bbox): void {
  z.config.bbox = bbox;
  z.state.reset();
  const [x1, y1, x2, y2] = bbox;
  const size = z.row.querySelector('.zsize');
  if (size) size.textContent = `${x2 - x1}×${y2 - y1}`;
  scheduleSave();
}

function selectZones(): void {
  void withScreenshot(async (shot) => {
    const res = await window.spike.openOverlay({
      mode: 'select',
      dataURL: shot.dataURL,
      frameW: shot.frameW,
      frameH: shot.frameH,
      zones: zones.map((z) => z.config.bbox),
      names: zones.map((z) => z.config.name),
    });
    if (!res) return;
    if (Array.isArray(res.existing)) {
      res.existing.forEach((b: Bbox, i: number) => {
        const z = zones[i];
        if (z && !bboxEq(z.config.bbox, b)) updateZoneBbox(z, b);
      });
    }
    if (Array.isArray(res.added)) for (const b of res.added) addZone(b);
  });
}

function openCaptureZone(z: Zone, onSet: () => void): void {
  void withScreenshot(async (shot) => {
    const res = await window.spike.openOverlay({
      mode: 'capture',
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

selectBtn.addEventListener('click', selectZones);

showBtn.addEventListener('click', () => {
  void withScreenshot(async (shot) => {
    await window.spike.openOverlay({
      mode: 'show',
      dataURL: shot.dataURL,
      frameW: shot.frameW,
      frameH: shot.frameH,
      zones: zones.map((z) => z.config.bbox),
      names: zones.map((z) => z.config.name),
      captures: zones.map((z) => z.config.photoBbox),
    });
  });
});

// --- Telegram --------------------------------------------------------------
type TgBadgeState = 'idle' | 'checking' | 'ok' | 'error';
function setTgBadge(state: TgBadgeState, label: string): void {
  const cls =
    state === 'ok' ? 'badge-ok' : state === 'error' ? 'badge-err' : 'badge-idle';
  tgBadge.className = `badge ${cls}`;
  tgBadge.innerHTML = `<span class="dot"></span> ${label}`;
}

function zoneByName(name: string | null): Zone | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  return zones.find((z) => z.config.name.toLowerCase() === lower) ?? null;
}

function sendStatus(): void {
  const t = telegram;
  if (!t) return;
  const header = running ? 'Monitoring' : 'Paused';
  const zoneLines = zones.length
    ? zones
        .map(
          (z) =>
            `${z.config.name}  ${z.config.enabled ? STATE_LABEL[stateKind(z.state, threshold())] : 'OFF'}`,
        )
        .join('\n')
    : 'No zones';
  tgEnqueue(() => t.sendText(`${header}\n${zoneLines}`));
}

async function sendZoneState(code: string): Promise<void> {
  const t = telegram;
  if (!t) return;
  const z = zoneByName(code);
  if (!z) {
    tgNote(`Unknown zone: ${code}`);
    return;
  }
  // Establish capture on demand so remote queries work without monitoring
  // running (getDisplayMedia is auto-granted via setDisplayMediaRequestHandler).
  try {
    await ensureCapture();
  } catch (e) {
    tgNote('Capture failed: ' + (e instanceof Error ? e.message : String(e)));
    return;
  }
  if (!capturer || capturer.frameWidth === 0) {
    tgNote('No capture yet — try again');
    return;
  }
  let frame: PixelFrame;
  try {
    frame = capturer.grabRegion(z.config.photoBbox ?? z.config.bbox);
  } catch {
    tgNote(`Capture failed: ${code}`);
    return;
  }
  const state = z.config.enabled
    ? STATE_LABEL[stateKind(z.state, threshold())]
    : 'OFF';
  tgEnqueue(() => t.sendPhoto(frame, `${code} · ${state}`));
}

function sendHelp(): void {
  const t = telegram;
  if (!t) return;
  const lines = [
    'Commands (/ optional):',
    'status        zones + state',
    'start / stop  monitoring',
    'zones         buttons per zone',
    'ss <code>     zone state photo',
    'defocus       drop zone focus',
    'help          this list',
    '',
    'z1: text   type into a zone',
    'z1: enter  press Enter',
    'z1: ctrlc  send Ctrl+C',
    'z1: up [n] Arrow Up (n times)',
    'z1: down [n] Arrow Down (n times)',
  ];
  tgEnqueue(() => t.sendText(lines.join('\n')));
}

function sendZoneButtons(): void {
  const t = telegram;
  if (!t) return;
  const codes = zones.map((z) => z.config.name);
  if (!codes.length) {
    tgNote('No zones');
    return;
  }
  tgEnqueue(() => t.sendButtons('Tap a zone for its current state:', codes, 'ss:'));
}

async function runDefocus(): Promise<void> {
  try {
    await window.spike.focusApp();
    tgNote('✓ Defocus');
  } catch (e) {
    tgNote('Defocus failed: ' + (e instanceof Error ? e.message : String(e)));
  }
}

async function handleReply(text: string): Promise<void> {
  // Commands work with or without a leading "/", normalized (trim + lowercase)
  // like the "enter" reply word.
  const norm = text.trim().replace(/^\//, '');
  const ss = /^ss\b\s*(\S*)/i.exec(norm);
  if (ss) {
    if (ss[1]) sendZoneState(ss[1]);
    else tgNote('Usage: ss <zone>');
    return;
  }
  // 'enter' is excluded here: it's a per-zone reply action handled below, not a
  // standalone command (a bare "enter" presses Enter on the selected zone).
  const cmd = TELEGRAM_COMMANDS[norm.toLowerCase()];
  if (cmd && cmd !== 'enter') {
    if (cmd === 'help') {
      sendHelp();
      return;
    }
    if (cmd === 'zones') {
      sendZoneButtons();
      return;
    }
    if (cmd === 'defocus') {
      runDefocus();
      return;
    }
    if (cmd === 'start') await startMonitoring();
    else if (cmd === 'stop') stopMonitoring();
    sendStatus(); // reply with the (possibly updated) state
    return;
  }
  // Zone-prefixed action commands ("z2 up" / "z2: up") — require an explicit zone.
  // (A bare "enter" stays handled below as the selected/last-zone reply word.)
  const ctrlcZone = parseCtrlc(norm);
  if (ctrlcZone) {
    await runZoneAction(ctrlcZone, 'Ctrl+C', interruptZone);
    return;
  }
  const up = parseUp(norm);
  if (up) {
    const n = Math.min(Math.max(up.count, 1), ARROW_REPEAT_MAX);
    await runZoneAction(up.zone, `Up ×${n}`, (bbox) => sendArrow(bbox, 'up', n));
    return;
  }
  const down = parseDown(norm);
  if (down) {
    const n = Math.min(Math.max(down.count, 1), ARROW_REPEAT_MAX);
    await runZoneAction(down.zone, `Down ×${n}`, (bbox) => sendArrow(bbox, 'down', n));
    return;
  }
  const enterZone = parseEnter(norm);
  if (enterZone) {
    await runZoneAction(enterZone, 'Enter', (bbox) => injectInto(bbox, ''));
    return;
  }
  const { zone, message } = parseZoneReply(
    text,
    zones.map((z) => z.config.name),
  );
  const targetZone =
    zoneByName(zone) ??
    zoneByName(selectedZoneName) ??
    (lastFrozenBbox
      ? (zones.find((z) => bboxEq(z.config.bbox, lastFrozenBbox)) ?? null)
      : null);
  const target = targetZone?.config.bbox ?? lastFrozenBbox;
  if (!target || !capturer || capturer.frameWidth === 0) {
    const msg = 'No target zone — tap a zone first, or reply "z2: <text>"';
    tgEl.textContent = msg;
    tgNote(msg);
    return;
  }
  const tag = targetZone ? ` → ${targetZone.config.name}` : '';
  if (TELEGRAM_COMMANDS[message.trim().toLowerCase()] === 'enter') {
    await injectInto(target, '');
    tgEl.textContent = `Enter${tag}`;
    tgNote(`✓ Enter${tag}`);
  } else {
    await injectInto(target, message);
    void window.spike.focusApp();
    tgEl.textContent = `Typed${tag}: ${JSON.stringify(message)}`;
    tgNote(`✓ Typed${tag}: ${message}`);
  }
}

function onZoneCallback(data: string): string {
  // "ss:<code>" (the /zones buttons) sends the zone's state photo and clicks the
  // zone to focus it; a bare code (the freeze chooser) sends Enter + pre-selects.
  if (data.startsWith('ss:')) {
    const code = data.slice(3);
    const z = zoneByName(code);
    if (!z) return 'Unknown zone';
    selectedZoneName = code; // a following typed reply targets this zone
    void sendZoneState(code).then(() => focusZone(z.config.bbox));
    return `${code} · sent + focus`;
  }
  const z = zoneByName(data);
  if (!z || !capturer || capturer.frameWidth === 0) return 'Unknown zone';
  selectedZoneName = data;
  void injectInto(z.config.bbox, '').then(() => tgNote(`✓ Enter → ${data}`));
  return `Enter → ${data} · reply to type`;
}

function applyCreds(token: string, chatId: string): void {
  if (poller) poller.stop();
  if (token && chatId) {
    telegram = new TelegramNotifier(
      token,
      chatId,
      (s: string) => (tgEl.textContent = s),
    );
    poller = new TelegramPoller(token, chatId, handleReply, onZoneCallback);
    poller.start(); // remote control is on whenever creds are set
    setTgBadge('checking', 'Checking…');
    void verifyCreds(telegram);
  } else {
    telegram = null;
    poller = null;
    setTgBadge('idle', 'Not set');
  }
}

async function verifyCreds(notifier: TelegramNotifier): Promise<void> {
  const r = await notifier.verify();
  if (notifier !== telegram) return; // creds changed during the check — ignore
  if (r.status === 'ok') setTgBadge('ok', 'Connected');
  else if (r.status === 'bad-token') setTgBadge('error', 'Bad token');
  else if (r.status === 'bad-chat') setTgBadge('error', 'Bad chat ID');
  else setTgBadge('error', 'Offline');
}

let credsTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCredsSave(): void {
  if (credsTimer) clearTimeout(credsTimer);
  credsTimer = setTimeout(() => {
    const token = tgToken.value.trim();
    const chatId = tgChat.value.trim();
    void window.spike.saveTelegramConfig({ token, chatId });
    applyCreds(token, chatId);
  }, 400);
}
[tgToken, tgChat].forEach((el) =>
  el.addEventListener('input', scheduleCredsSave),
);

resetBtn.addEventListener('click', () => {
  if (
    !window.confirm(
      'Reset all settings to defaults? This removes all watched zones.',
    )
  )
    return;
  stopMonitoring();
  for (const z of zones) z.row.remove();
  zones.length = 0;
  thresholdEl.value = String(DEFAULT_THRESHOLD);
  intervalEl.value = String(DEFAULT_INTERVAL_MS);
  consecEl.value = String(DEFAULT_CONSEC);
  volumeEl.value = '1';
  syncNumFields();
  refreshEmpty();
  refreshCounts();
  scheduleSave();
});

// --- init ------------------------------------------------------------------
window.spike.getVersion().then((v: string) => (verEl.textContent = v));
window.spike
  .getTelegramConfig()
  .then(({ token, chatId }: { token: string; chatId: string }) => {
    tgToken.value = token;
    tgChat.value = chatId;
    applyCreds(token, chatId);
  });
selectLbl.textContent = 'Select zones';
thresholdEl.value = String(DEFAULT_THRESHOLD);
intervalEl.value = String(DEFAULT_INTERVAL_MS);
consecEl.value = String(DEFAULT_CONSEC);
syncNumFields();
refreshEmpty();
setRunning(false);
void prefsStore.load().then((saved) => {
  if (saved) applyPrefs(saved);
  prefsLoaded = true; // only now do user changes start persisting
});
window.addEventListener(
  'error',
  (e) => (footStatus.textContent = 'JS error: ' + e.message),
);
