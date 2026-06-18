// Screen-capture adapter (renderer side). Implements the domain's
// RegionCapturer over a <video> fed by getDisplayMedia + an offscreen canvas.
// This is the Electron equivalent of the Python ScrotCapturer.
import type { Bbox, PixelFrame, RegionCapturer } from "./domain.ts";

export class ScreenCapturer implements RegionCapturer {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("ScreenCapturer: no 2d canvas context");
    this.ctx = ctx;
  }

  // Pixel dimensions of the captured frame (physical pixels — on a Retina Mac
  // this is 2x the logical screen size; zone mapping must account for that).
  get frameWidth(): number {
    return this.video.videoWidth;
  }
  get frameHeight(): number {
    return this.video.videoHeight;
  }

  grabRegion(bbox: Bbox): PixelFrame {
    const [x1, y1, x2, y2] = bbox;
    const w = x2 - x1;
    const h = y2 - y1;
    if (this.canvas.width !== this.video.videoWidth) {
      this.canvas.width = this.video.videoWidth;
    }
    if (this.canvas.height !== this.video.videoHeight) {
      this.canvas.height = this.video.videoHeight;
    }
    this.ctx.drawImage(this.video, 0, 0);
    const img = this.ctx.getImageData(x1, y1, w, h);
    return { width: img.width, height: img.height, data: img.data };
  }
}

// Maps a selection rectangle drawn over the displayed <video> (CSS pixels,
// relative to the element's top-left) into capturer pixel-space — the frame's
// physical pixels, exactly what grabRegion reads. Because the zone is defined
// in the SAME frame we sample, there is no logical-vs-physical (Retina/DPI)
// guesswork: the drawn box and the sampled box share one coordinate system.
// Result is clamped into frame bounds (grabRegion would read out-of-range
// otherwise) and corners are normalised so left<=right, top<=bottom.
export function cssRectToBbox(
  rect: { left: number; top: number; width: number; height: number },
  videoW: number,
  videoH: number,
  dispW: number,
  dispH: number,
): Bbox {
  const sx = videoW / dispW;
  const sy = videoH / dispH;
  const clamp = (v: number, max: number): number => Math.max(0, Math.min(Math.round(v), max));
  const x1 = clamp(rect.left * sx, videoW);
  const y1 = clamp(rect.top * sy, videoH);
  const x2 = clamp((rect.left + rect.width) * sx, videoW);
  const y2 = clamp((rect.top + rect.height) * sy, videoH);
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

// Inverse of cssRectToBbox's concern: a zone bbox lives in capture pixels
// (physical), but nut.js moves the mouse in the screen's LOGICAL points (on a
// Retina display those are half the physical pixels). To click a zone's center
// on the real screen we scale its physical center down by capture/screen ratio.
// ponytail: assumes a single primary screen at origin; multi-monitor needs the
// display's offset + per-display scale.
export function bboxCenterToScreen(
  bbox: Bbox,
  captureW: number,
  captureH: number,
  screenW: number,
  screenH: number,
): { x: number; y: number } {
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  return {
    x: Math.round((cx * screenW) / captureW),
    y: Math.round((cy * screenH) / captureH),
  };
}

// Starts capturing the screen. main.js wires a setDisplayMediaRequestHandler
// that auto-selects the screen, so this resolves without showing a picker.
// On macOS the first call triggers the Screen Recording permission prompt.
export async function startCapture(video: HTMLVideoElement): Promise<ScreenCapturer> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return new ScreenCapturer(video);
}
