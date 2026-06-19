// Fullscreen overlay renderer for zone selection / capture-area / show / defocus.
//
// The win-win: the overlay shows the captured screenshot at FULL screen size
// (max interactive precision) and maps geometry with cssRectToBbox/bboxToCss using
// the image's natural-vs-displayed dimensions — no DPI API, no devicePixelRatio
// guessing. The screenshot comes from the SAME getDisplayMedia frame the monitor
// samples, so the resulting bbox is in the exact pixel space grabRegion reads.
//
// Every rectangle (newly drawn OR pre-existing) is editable: drag a handle to
// resize, drag the body to move, drag empty space to draw a new one. ONE pointer
// pipeline drives all rect modes (select + capture); modes differ only in data.
import { cssRectToBbox, type Bbox } from "./capture.ts";

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};
const shot = $("shot") as HTMLImageElement;
const bar = $("bar");
const dot = $("dot");

type CssRect = { left: number; top: number; width: number; height: number };
type Tag = number | "new" | "capture"; // existing-zone index | newly drawn | the capture rect
type EditRect = { el: HTMLElement; tag: Tag; css: CssRect };

let mode = "select";
let frameW = 0;
let frameH = 0;
let existingCount = 0; // number of pre-existing zones loaded (select mode)
const edits: EditRect[] = []; // editable rects (with resize handles)
let defocusPoint: { x: number; y: number } | null = null;

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const INSTR: Record<string, string> = {
  select: "Drag to draw · drag a handle to resize, the body to move · Right-click: undo new · <b>Enter</b>: confirm · <b>Esc</b>: cancel",
  capture: "Drag the Telegram capture area · resize with handles · <b>Enter</b>: confirm · <b>Esc</b>: cancel",
  show: "Showing watched zones · click or <b>Esc</b> to close",
  defocus: "Click the defocus point · <b>Enter</b>: confirm · <b>Esc</b>: cancel",
};

window.spike.onOverlayInit(
  (data: {
    mode: string;
    dataURL: string;
    frameW: number;
    frameH: number;
    zones?: Bbox[];
    captures?: (Bbox | null)[];
    detection?: Bbox;
    current?: Bbox | null;
  }) => {
    mode = data.mode;
    frameW = data.frameW;
    frameH = data.frameH;
    shot.src = data.dataURL;
    bar.innerHTML = INSTR[mode] ?? INSTR.select;
    if (mode === "select" && Array.isArray(data.zones)) {
      existingCount = data.zones.length;
      data.zones.forEach((b, i) => edits.push(makeRect(bboxToCss(b), i)));
      renumber();
    } else if (mode === "capture") {
      if (data.detection) drawStatic(bboxToCss(data.detection), "detection", "ref");
      if (data.current) edits.push(makeRect(bboxToCss(data.current), "capture"));
    } else if (mode === "show" && Array.isArray(data.zones)) {
      data.zones.forEach((b, i) => drawStatic(bboxToCss(b), `z${i + 1}`, ""));
      if (Array.isArray(data.captures)) {
        data.captures.forEach((b, i) => {
          if (b) drawStatic(bboxToCss(b), `zc${i + 1}`, "cap");
        });
      }
    }
  },
);

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

function toBbox(c: CssRect): Bbox {
  const d = disp();
  return cssRectToBbox(c, frameW, frameH, d.w, d.h);
}

// A non-interactive rect: "" = green detection, "cap" = blue capture (show mode),
// "ref" = dashed accent (the detection reference in capture mode).
function drawStatic(c: CssRect, label: string, cls: string): void {
  const el = document.createElement("div");
  el.className = cls ? `rect ${cls}` : "rect";
  el.style.cssText = `left:${c.left}px;top:${c.top}px;width:${c.width}px;height:${c.height}px`;
  el.innerHTML = `<span class="tag">${label}</span>`;
  document.body.appendChild(el);
}

// An editable rect: 8 resize handles + a label, positioned by layout().
function makeRect(c: CssRect, tag: Tag): EditRect {
  const el = document.createElement("div");
  el.className = "rect edit";
  for (const pos of HANDLES) {
    const h = document.createElement("div");
    h.className = "handle";
    h.dataset.pos = pos;
    el.appendChild(h);
  }
  const tagEl = document.createElement("span");
  tagEl.className = "tag";
  el.appendChild(tagEl);
  document.body.appendChild(el);
  const r: EditRect = { el, tag, css: c };
  layout(r);
  return r;
}

function layout(r: EditRect): void {
  r.el.style.left = `${r.css.left}px`;
  r.el.style.top = `${r.css.top}px`;
  r.el.style.width = `${r.css.width}px`;
  r.el.style.height = `${r.css.height}px`;
}

function renumber(): void {
  if (mode !== "select") return;
  edits.forEach((r, i) => {
    const t = r.el.querySelector(".tag");
    if (t) t.textContent = `z${i + 1}`;
  });
}

function clearEdits(): void {
  for (const r of edits) r.el.remove();
  edits.length = 0;
}

// --- drag pipeline: draw / move / resize -----------------------------------
const MIN = 8; // CSS px; ignore stray clicks and enforce a minimum size
let action: "none" | "draw" | "move" | "resize" = "none";
let activeIdx = -1;
let resizeHandle = "se";
let startCss: CssRect = { left: 0, top: 0, width: 0, height: 0 };
let startX = 0;
let startY = 0;

function pt(e: PointerEvent): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(e.clientX, window.innerWidth)),
    y: Math.max(0, Math.min(e.clientY, window.innerHeight)),
  };
}

function startAction(a: "draw" | "move" | "resize", idx: number, p: { x: number; y: number }): void {
  action = a;
  activeIdx = idx;
  startCss = { ...edits[idx].css };
  startX = p.x;
  startY = p.y;
}

function applyMove(s: CssRect, dx: number, dy: number): CssRect {
  const left = Math.max(0, Math.min(s.left + dx, window.innerWidth - s.width));
  const top = Math.max(0, Math.min(s.top + dy, window.innerHeight - s.height));
  return { left, top, width: s.width, height: s.height };
}

function applyResize(s: CssRect, pos: string, dx: number, dy: number): CssRect {
  let left = s.left;
  let top = s.top;
  let right = s.left + s.width;
  let bottom = s.top + s.height;
  if (pos.includes("w")) left = Math.min(left + dx, right - MIN);
  if (pos.includes("e")) right = Math.max(right + dx, left + MIN);
  if (pos.includes("n")) top = Math.min(top + dy, bottom - MIN);
  if (pos.includes("s")) bottom = Math.max(bottom + dy, top + MIN);
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(window.innerWidth, right);
  bottom = Math.min(window.innerHeight, bottom);
  return { left, top, width: right - left, height: bottom - top };
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
  if (mode !== "select" && mode !== "capture") return;
  const tgt = e.target as HTMLElement;
  if (tgt.classList.contains("handle")) {
    const idx = edits.findIndex((r) => r.el === tgt.parentElement);
    if (idx >= 0) {
      resizeHandle = tgt.dataset.pos ?? "se";
      startAction("resize", idx, p);
      return;
    }
  }
  const host = tgt.closest(".rect.edit");
  if (host) {
    const idx = edits.findIndex((r) => r.el === host);
    if (idx >= 0) {
      startAction("move", idx, p);
      return;
    }
  }
  // Empty space: draw a new rect. Capture mode keeps a single rect, so replace it.
  if (mode === "capture") clearEdits();
  edits.push(makeRect({ left: p.x, top: p.y, width: 0, height: 0 }, mode === "capture" ? "capture" : "new"));
  renumber();
  startAction("draw", edits.length - 1, p);
});

document.addEventListener("pointermove", (e) => {
  if (action === "none" || activeIdx < 0) return;
  const p = pt(e as PointerEvent);
  const r = edits[activeIdx];
  if (action === "draw") {
    r.css = {
      left: Math.min(startX, p.x),
      top: Math.min(startY, p.y),
      width: Math.abs(p.x - startX),
      height: Math.abs(p.y - startY),
    };
  } else if (action === "move") {
    r.css = applyMove(startCss, p.x - startX, p.y - startY);
  } else {
    r.css = applyResize(startCss, resizeHandle, p.x - startX, p.y - startY);
  }
  layout(r);
});

document.addEventListener("pointerup", () => {
  if (action === "none") return;
  if (action === "draw") {
    const r = edits[activeIdx];
    if (r.css.width < MIN || r.css.height < MIN) {
      r.el.remove();
      edits.splice(activeIdx, 1);
      renumber();
    }
  }
  action = "none";
  activeIdx = -1;
});

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (mode !== "select") return;
  for (let i = edits.length - 1; i >= 0; i--) {
    if (edits[i].tag === "new") {
      edits[i].el.remove();
      edits.splice(i, 1);
      renumber();
      break; // only undo NEW rects, never the pre-existing zones
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.spike.overlayDone(null);
  } else if (e.key === "Enter") {
    if (mode === "select") {
      const existing: Bbox[] = [];
      for (let i = 0; i < existingCount; i++) {
        const r = edits.find((x) => x.tag === i);
        if (r) existing[i] = toBbox(r.css);
      }
      const added = edits.filter((x) => x.tag === "new").map((x) => toBbox(x.css));
      window.spike.overlayDone({ existing, added });
    } else if (mode === "capture") {
      const r = edits.find((x) => x.tag === "capture");
      window.spike.overlayDone(r ? { bbox: toBbox(r.css) } : null);
    } else if (mode === "defocus") {
      window.spike.overlayDone(defocusPoint ? { point: defocusPoint } : null);
    } else {
      window.spike.overlayDone(null);
    }
  }
});

document.addEventListener("click", () => {
  if (mode === "show") window.spike.overlayDone(null);
});
