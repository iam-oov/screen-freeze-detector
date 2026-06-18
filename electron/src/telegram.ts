// Telegram adapters, ported from freeze_detector.py. The Python used stdlib
// urllib + a hand-rolled multipart encoder and threads; here fetch + FormData
// are built in. Runs in the renderer (it can fetch api.telegram.org directly
// and already has canvas to encode PNGs).
import type { PixelFrame, RemoteNotifier } from "./domain.ts";

const API = "https://api.telegram.org";

// Encode a captured RGBA frame to a PNG Blob via canvas (Telegram sendPhoto
// wants a file upload).
export function pixelFrameToPngBlob(frame: PixelFrame): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context for PNG encode");
  const data =
    frame.data instanceof Uint8ClampedArray
      ? frame.data
      : new Uint8ClampedArray(frame.data);
  ctx.putImageData(new ImageData(data, frame.width, frame.height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob null"))), "image/png");
  });
}

export class TelegramNotifier implements RemoteNotifier {
  private token: string;
  private chatId: string;
  private onStatus: (s: string) => void;

  constructor(token: string, chatId: string, onStatus: (s: string) => void = () => {}) {
    this.token = token;
    this.chatId = chatId;
    this.onStatus = onStatus;
  }

  configured(): boolean {
    return Boolean(this.token && this.chatId);
  }

  // Edge-triggered by FreezeMonitor. Fire-and-forget, like the Python daemon
  // thread — never blocks the monitor loop.
  notifyFrozen(frame: PixelFrame, zoneName: string): void {
    if (!this.configured()) return;
    void this.send(frame, zoneName);
  }

  private async send(frame: PixelFrame, zoneName: string): Promise<void> {
    try {
      const blob = await pixelFrameToPngBlob(frame);
      const form = new FormData();
      form.append("chat_id", this.chatId);
      form.append("caption", `Frozen: ${zoneName}`);
      form.append("photo", blob, "zone.png");
      const res = await fetch(`${API}/bot${this.token}/sendPhoto`, {
        method: "POST",
        body: form,
      });
      this.onStatus(res.ok ? `sent photo (${zoneName})` : `sendPhoto failed: HTTP ${res.status}`);
    } catch (e) {
      this.onStatus("sendPhoto error: " + (e instanceof Error ? e.message : String(e)));
    }
  }
}

export interface CommandSource {
  start(): void;
  stop(): void;
}

export class TelegramPoller implements CommandSource {
  private token: string;
  private chatId: string;
  private onCommand: (text: string) => void;
  private running = false;
  private offset: number | null = null;

  constructor(token: string, chatId: string, onCommand: (text: string) => void) {
    this.token = token;
    this.chatId = chatId;
    this.onCommand = onCommand;
  }

  configured(): boolean {
    return Boolean(this.token && this.chatId);
  }

  start(): void {
    if (!this.configured() || this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    // The loop exits after the current long-poll returns (up to ~25s).
    this.running = false;
  }

  private async loop(): Promise<void> {
    await this.skipBacklog(); // never inject messages that predate start()
    while (this.running) {
      const updates = await this.getUpdates(25);
      for (const u of updates) {
        this.offset = u.update_id + 1;
        const text = this.commandFrom(u);
        if (text !== null) this.onCommand(text);
      }
    }
  }

  private async skipBacklog(): Promise<void> {
    const updates = await this.getUpdates(0);
    if (updates.length) this.offset = updates[updates.length - 1].update_id + 1;
  }

  private async getUpdates(timeout: number): Promise<any[]> {
    try {
      const params = new URLSearchParams({ timeout: String(timeout) });
      if (this.offset !== null) params.set("offset", String(this.offset));
      const res = await fetch(`${API}/bot${this.token}/getUpdates?${params.toString()}`);
      const data = await res.json();
      return data.ok ? data.result : [];
    } catch {
      return []; // network blips: just retry next loop
    }
  }

  // Only obey messages from the configured chat — nobody else with the bot can
  // type on this screen.
  private commandFrom(update: any): string | null {
    const msg = update.message ?? {};
    const text: string | undefined = msg.text;
    const fromChat = String(msg.chat?.id);
    return text && fromChat === this.chatId ? text : null;
  }
}
