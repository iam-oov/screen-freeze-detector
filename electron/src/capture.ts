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
