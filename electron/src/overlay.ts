// Fullscreen overlay renderer for zone selection / show / defocus-point.
//
// The win-win: the overlay shows the captured screenshot at FULL screen size
// (max interactive precision) and maps the drag with cssRectToBbox using the
// image's natural-vs-displayed dimensions — no DPI API, no devicePixelRatio
// guessing. The screenshot comes from the SAME getDisplayMedia frame the monitor
// samples, so the resulting bbox is in the exact pixel space grabRegion reads.
import { cssRectToBbox, type Bbox } from "./capture.ts";

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};
const shot = $("shot") as HTMLImageElement;
const bar = $("bar");
const sel = $("sel");
const dot = $("dot");

type CssRect = { left: number; top: number; width: number; height: number };

let mode = "select";
let frameW = 0;
let frameH = 0;
const picked: Bbox[] = [];
let defocusPoint: { x: number; y: number } | null = null;

const INSTR: Record<string, string> = {
  select: "Drag to draw zones · Right-click: undo · <b>Enter</b>: confirm · <b>Esc</b>: cancel",
  show: "Showing watched zones · click or <b>Esc</b> to close",
  defocus: "Click the defocus point · <b>Enter</b>: confirm · <b>Esc</b>: cancel",
};

window.spike.onOverlayInit((data: { mode: string; dataURL: string; frameW: number; frameH: number; zones?: Bbox[] }) => {
  mode = data.mode;
  frameW = data.frameW;
  frameH = data.frameH;
  shot.src = data.dataURL;
  bar.innerHTML = INSTR[mode] ?? INSTR.select;
  if (mode === "show" && Array.isArray(data.zones)) {
    data.zones.forEach((b, i) => drawRect(bboxToCss(b), i + 1));
  }
});

// Displayed size of the screenshot (img fills the viewport; screenshot aspect ==
// screen aspect, so no distortion). Falls back to the window before img layout.
function disp(): { w: number; h: number } {
  return { w: shot.clientWidth || window.innerWidth, h: shot.clientHeight || window.innerHeight };
}

function bboxToCss(b: Bbox): CssRect {
  const d = disp();
  const sx = d.w / frameW;
  const sy = d.h / frameH;
  return { left: b[0] * sx, top: b[1] * sy, width: (b[2] - b[0]) * sx, height: (b[3] - b[1]) * sy };
}

function drawRect(c: CssRect, n: number): void {
  const r = document.createElement("div");
  r.className = "rect";
  r.style.cssText = `left:${c.left}px;top:${c.top}px;width:${c.width}px;height:${c.height}px`;
  r.innerHTML = `<span class="tag">${n}</span>`;
  document.body.appendChild(r);
}

// --- drag to select --------------------------------------------------------
const MIN = 8; // CSS px; ignore stray clicks
let dragging = false;
let startX = 0;
let startY = 0;

function pt(e: PointerEvent): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(e.clientX, window.innerWidth)),
    y: Math.max(0, Math.min(e.clientY, window.innerHeight)),
  };
}

document.addEventListener("pointerdown", (e) => {
  const p = pt(e as PointerEvent);
  if (mode === "defocus") {
    // Overlay covers the logical screen at (0,0), so click CSS coords ARE the
    // logical screen points nut.js needs — no conversion.
    defocusPoint = { x: Math.round(p.x), y: Math.round(p.y) };
    dot.style.left = `${p.x}px`;
    dot.style.top = `${p.y}px`;
    dot.style.display = "block";
    return;
  }
  if (mode !== "select") return;
  dragging = true;
  startX = p.x;
  startY = p.y;
  sel.style.cssText = `left:${startX}px;top:${startY}px;width:0;height:0;display:block`;
});

document.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const p = pt(e as PointerEvent);
  sel.style.left = `${Math.min(startX, p.x)}px`;
  sel.style.top = `${Math.min(startY, p.y)}px`;
  sel.style.width = `${Math.abs(p.x - startX)}px`;
  sel.style.height = `${Math.abs(p.y - startY)}px`;
});

document.addEventListener("pointerup", (e) => {
  if (!dragging) return;
  dragging = false;
  sel.style.display = "none";
  const p = pt(e as PointerEvent);
  const left = Math.min(startX, p.x);
  const top = Math.min(startY, p.y);
  const w = Math.abs(p.x - startX);
  const h = Math.abs(p.y - startY);
  if (w < MIN || h < MIN) return;
  const d = disp();
  const bbox = cssRectToBbox({ left, top, width: w, height: h }, frameW, frameH, d.w, d.h);
  picked.push(bbox);
  drawRect({ left, top, width: w, height: h }, picked.length);
});

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (mode !== "select" || picked.length === 0) return;
  picked.pop();
  const rects = document.querySelectorAll(".rect");
  if (rects.length) rects[rects.length - 1].remove();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.spike.overlayDone(null);
  } else if (e.key === "Enter") {
    if (mode === "select") window.spike.overlayDone({ zones: picked });
    else if (mode === "defocus") window.spike.overlayDone(defocusPoint ? { point: defocusPoint } : null);
    else window.spike.overlayDone(null);
  }
});

// Show mode: any click dismisses.
document.addEventListener("click", () => {
  if (mode === "show") window.spike.overlayDone(null);
});
