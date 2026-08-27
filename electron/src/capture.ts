// Screen-capture adapter (renderer side). Implements the domain's
// RegionCapturer as an N-stream compositor over one <video> per monitor: every
// bbox lives in virtual-desktop DIP coordinates (the union of all displays),
// and grabRegion draws the intersecting slice of each display's video into
// one canvas sized to the requested bbox. This is the Electron equivalent of
// the Python ScrotCapturer, generalised past a single screen.
import type { Bbox, PixelFrame, RegionCapturer } from "./domain.ts";

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapturedScreen {
  display: DisplayInfo;
  video: HTMLVideoElement;
}

// The per-display geometry planDraws needs — split out from CapturedScreen so
// the planning math stays pure and testable without a real <video> element.
export interface ScreenGeometry {
  display: DisplayInfo;
  videoWidth: number;
  videoHeight: number;
}

// One drawImage call: sx/sy/sw/sh in that display's video-pixel space, dx/dy/
// dw/dh in the destination canvas (bbox-local, i.e. DIP space minus bbox origin).
export interface Draw {
  i: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Which slice of which stream covers which part of the bbox. Source rects are
// scaled per display (videoWidth/height over that display's DIP bounds, so
// HiDPI streams read from the right physical pixels); destination rects stay
// in DIP space, bbox-local. Displays with no live stream are simply absent
// from `screens`, so a straddling bbox with one side missing plans a partial
// set of draws — grabRegion turns that shortfall into a throw.
export function planDraws(bbox: Bbox, screens: ScreenGeometry[]): Draw[] {
  const [bx1, by1, bx2, by2] = bbox;
  const draws: Draw[] = [];
  screens.forEach((s, i) => {
    const d = s.display;
    const ix1 = Math.max(bx1, d.x);
    const iy1 = Math.max(by1, d.y);
    const ix2 = Math.min(bx2, d.x + d.width);
    const iy2 = Math.min(by2, d.y + d.height);
    if (ix2 <= ix1 || iy2 <= iy1) return;
    const scaleX = s.videoWidth / d.width;
    const scaleY = s.videoHeight / d.height;
    draws.push({
      i,
      sx: (ix1 - d.x) * scaleX,
      sy: (iy1 - d.y) * scaleY,
      sw: (ix2 - ix1) * scaleX,
      sh: (iy2 - iy1) * scaleY,
      dx: ix1 - bx1,
      dy: iy1 - by1,
      dw: ix2 - ix1,
      dh: iy2 - iy1,
    });
  });
  return draws;
}

export function drawnArea(draws: Draw[]): number {
  return draws.reduce((sum, d) => sum + d.dw * d.dh, 0);
}

export function unionBounds(displays: DisplayInfo[] | Bounds[]): Bounds {
  if (displays.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x1 = Math.min(...displays.map((d) => d.x));
  const y1 = Math.min(...displays.map((d) => d.y));
  const x2 = Math.max(...displays.map((d) => d.x + d.width));
  const y2 = Math.max(...displays.map((d) => d.y + d.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// A display is "covered" when the currently live screens' draws fully tile
// its own bounds — reuses planDraws/drawnArea instead of an id-based lookup,
// so a single stream that already spans several displays (see
// looksLikeWholeDesktop) correctly counts as covering all of them, and a gap
// between two disjoint live displays correctly still counts as NOT covered.
export function isDisplayCovered(display: DisplayInfo, screens: ScreenGeometry[]): boolean {
  const bbox: Bbox = [display.x, display.y, display.x + display.width, display.y + display.height];
  const draws = planDraws(bbox, screens);
  return drawnArea(draws) >= display.width * display.height;
}

// True when a single stream looks like it already covers the WHOLE virtual
// desktop rather than just the one display it was requested for (e.g. a
// Wayland "Entire screen" portal source). Aspect ratio alone false-positives
// on layouts where the union happens to share a display's aspect (e.g. a 2x2
// grid), so this also requires the stream's width to match the union's width,
// not just one display's.
export function looksLikeWholeDesktop(videoWidth: number, videoHeight: number, union: Bounds): boolean {
  if (videoWidth <= 0 || videoHeight <= 0 || union.width <= 0 || union.height <= 0) return false;
  const aspectMatches = Math.abs(videoWidth / videoHeight - union.width / union.height) < 0.02;
  const widthMatches = Math.abs(videoWidth - union.width) / union.width < 0.05;
  return aspectMatches && widthMatches;
}

// LEFT/RIGHT/TOP/BOTTOM hint for a 2-monitor pick prompt, derived from bounds
// (not array index, which is a no-op for vertically stacked monitors sharing
// the same x). null when the two displays share both axes (e.g. mirrored).
export function twoDisplayDirection(
  d: DisplayInfo,
  other: DisplayInfo,
): "LEFT" | "RIGHT" | "TOP" | "BOTTOM" | null {
  if (d.x !== other.x) return d.x < other.x ? "LEFT" : "RIGHT";
  if (d.y !== other.y) return d.y < other.y ? "TOP" : "BOTTOM";
  return null;
}

// Replaces bboxCenterToScreen: nut.js already operates in virtual-desktop DIP
// coordinates (X11/XTEST semantics span every monitor), so the zone's center
// in bbox-space IS the click point. No screen rescale needed.
export function bboxCenter(bbox: Bbox): { x: number; y: number } {
  return {
    x: Math.round((bbox[0] + bbox[2]) / 2),
    y: Math.round((bbox[1] + bbox[3]) / 2),
  };
}

export class ScreenCapturer implements RegionCapturer {
  screens: CapturedScreen[] = [];
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("ScreenCapturer: no 2d canvas context");
    this.ctx = ctx;
  }

  // Virtual-desktop DIP bounds covered by the currently live streams.
  get bounds(): Bounds {
    return unionBounds(this.screens.map((s) => s.display));
  }

  // 0 unless every live stream has decoded at least one frame — callers use
  // this as the single "capture is ready" guard, same as before multi-screen.
  get frameWidth(): number {
    if (this.screens.length === 0) return 0;
    if (!this.screens.every((s) => s.video.videoWidth > 0)) return 0;
    return this.bounds.width;
  }
  get frameHeight(): number {
    if (this.screens.length === 0) return 0;
    if (!this.screens.every((s) => s.video.videoWidth > 0)) return 0;
    return this.bounds.height;
  }

  grabRegion(bbox: Bbox): PixelFrame {
    const [x1, y1, x2, y2] = bbox;
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 0 || h <= 0) {
      throw new Error("ScreenCapturer: degenerate bbox");
    }
    const geoms: ScreenGeometry[] = this.screens.map((s) => ({
      display: s.display,
      videoWidth: s.video.videoWidth,
      videoHeight: s.video.videoHeight,
    }));
    const draws = planDraws(bbox, geoms);
    if (drawnArea(draws) < w * h) {
      throw new Error("ScreenCapturer: bbox not fully covered by live streams");
    }
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    // Stale pixels from a differently-shaped previous grab are a false-freeze
    // source if a coverage gap ever slips past the check above.
    this.ctx.clearRect(0, 0, w, h);
    for (const d of draws) {
      const video = this.screens[d.i].video;
      this.ctx.drawImage(video, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh);
    }
    const img = this.ctx.getImageData(0, 0, w, h);
    return { width: img.width, height: img.height, data: img.data };
  }

  // Adds a live stream and wires GNOME "Stop sharing" (the track ending) to
  // drop it: a straddling zone then throws instead of reading a frozen frame.
  attach(screen: CapturedScreen): void {
    this.screens.push(screen);
    const track = (screen.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        this.screens = this.screens.filter((s) => s !== screen);
        screen.video.remove();
      };
    }
  }

  // Stops every live stream's tracks, detaches its <video>, and empties
  // `screens` — used both by the manual "Screens" re-pick and before
  // registering a whole-desktop stream in place of the individual displays.
  stopAll(): void {
    for (const s of this.screens) {
      (s.video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
      s.video.remove();
    }
    this.screens = [];
  }
}

// Maps a selection rectangle drawn over the displayed screenshot (CSS pixels,
// relative to the element's top-left) into the sampled frame's pixel-space —
// exactly what grabRegion reads. Because the zone is defined in the SAME frame
// we sample, there is no logical-vs-physical (Retina/DPI) guesswork: the drawn
// box and the sampled box share one coordinate system. Result is clamped into
// frame bounds (grabRegion would read out-of-range otherwise), corners are
// normalised so left<=right/top<=bottom, then shifted by an optional frame
// origin (originX/originY) — needed when the sampled frame doesn't start at
// virtual-desktop (0,0), e.g. a union with a negative-x display.
export function cssRectToBbox(
  rect: { left: number; top: number; width: number; height: number },
  videoW: number,
  videoH: number,
  dispW: number,
  dispH: number,
  originX = 0,
  originY = 0,
): Bbox {
  const sx = videoW / dispW;
  const sy = videoH / dispH;
  const clamp = (v: number, max: number): number => Math.max(0, Math.min(Math.round(v), max));
  const x1 = clamp(rect.left * sx, videoW);
  const y1 = clamp(rect.top * sy, videoH);
  const x2 = clamp((rect.left + rect.width) * sx, videoW);
  const y2 = clamp((rect.top + rect.height) * sy, videoH);
  return [
    Math.min(x1, x2) + originX,
    Math.min(y1, y2) + originY,
    Math.max(x1, x2) + originX,
    Math.max(y1, y2) + originY,
  ];
}

// Acquires one stream for one display: tells main.js which display's source
// to hand back on the NEXT getDisplayMedia call (main.js:'next-capture-display'),
// then requests it. On Wayland the portal decides regardless and this is a
// no-op past marking intent; on platforms with real per-display sources it's
// what makes the picker (or the auto-grant) resolve the right monitor.
export async function captureDisplay(display: DisplayInfo): Promise<CapturedScreen> {
  await window.spike.nextCaptureDisplay(display.id);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(video);
  video.srcObject = stream;
  await video.play();
  return { display, video };
}
