// Telegram adapters, ported from freeze_detector.py. The Python used stdlib
// urllib + a hand-rolled multipart encoder and threads; here fetch + FormData
// are built in. Runs in the renderer (it can fetch api.telegram.org directly
// and already has canvas to encode PNGs).
import type { PixelFrame, RemoteNotifier } from "./domain.ts";

const API = "https://api.telegram.org";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Resolve a chat reply to a target zone code. "z2: hi" -> { zone: "z2", message:
// "hi" } when "z2" is a known code (case-insensitive); otherwise { zone: null,
// message: text }. Only an exact code prefix routes, so a normal reply that just
// happens to contain a colon isn't misrouted.
export function parseZoneReply(
  text: string,
  codes: string[],
): { zone: string | null; message: string } {
  const m = text.match(/^([^:]+):([\s\S]*)$/);
  if (m) {
    const prefix = m[1].trim().toLowerCase();
    const hit = codes.find((c) => c.toLowerCase() === prefix);
    if (hit) return { zone: hit, message: m[2].trim() };
  }
  return { zone: null, message: text };
}

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
  // Returns the send promise so callers can order messages (no more out-of-order
  // arrivals from racing fire-and-forget sends).
  notifyFrozen(frame: PixelFrame, zoneName: string): Promise<void> {
    if (!this.configured()) return Promise.resolve();
    return this.send(frame, zoneName);
  }

  // Multi-zone chooser: one inline-keyboard button per frozen, telegram-enabled
  // zone (button text + callback_data = the zone code).
  sendChooser(codes: string[]): Promise<void> {
    if (!this.configured() || codes.length === 0) return Promise.resolve();
    return this.sendChooserMessage(codes);
  }

  // A short italic note back to the chat (e.g. action confirmations).
  sendNote(text: string): Promise<void> {
    if (!this.configured()) return Promise.resolve();
    return this.sendMessageHtml(`<i>${escapeHtml(text)}</i>`);
  }

  private async sendMessageHtml(html: string): Promise<void> {
    try {
      const form = new FormData();
      form.append("chat_id", this.chatId);
      form.append("text", html);
      form.append("parse_mode", "HTML");
      await fetch(`${API}/bot${this.token}/sendMessage`, { method: "POST", body: form });
    } catch {
      /* best effort */
    }
  }

  private async sendChooserMessage(codes: string[]): Promise<void> {
    try {
      const n = codes.length;
      const form = new FormData();
      form.append("chat_id", this.chatId);
      form.append("text", `${n} zone${n === 1 ? "" : "s"} frozen — tap to send Enter, then reply to type:`);
      // 4 buttons per row (Telegram allows up to 8) so the chooser stays compact.
      const PER_ROW = 4;
      const rows: { text: string; callback_data: string }[][] = [];
      for (let i = 0; i < codes.length; i += PER_ROW) {
        rows.push(codes.slice(i, i + PER_ROW).map((c) => ({ text: c, callback_data: c })));
      }
      form.append("reply_markup", JSON.stringify({ inline_keyboard: rows }));
      const res = await fetch(`${API}/bot${this.token}/sendMessage`, { method: "POST", body: form });
      this.onStatus(res.ok ? `sent chooser (${codes.length})` : `chooser failed: HTTP ${res.status}`);
    } catch (e) {
      this.onStatus("chooser error: " + (e instanceof Error ? e.message : String(e)));
    }
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
  private onCallback: (code: string) => string | void;
  private running = false;
  private offset: number | null = null;

  constructor(
    token: string,
    chatId: string,
    onCommand: (text: string) => void,
    onCallback: (code: string) => string | void = () => {},
  ) {
    this.token = token;
    this.chatId = chatId;
    this.onCommand = onCommand;
    this.onCallback = onCallback;
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
        if (text !== null) {
          this.onCommand(text);
          continue;
        }
        const cb = this.callbackFrom(u);
        if (cb !== null) {
          const toast = this.onCallback(cb.data);
          void this.answerCallbackQuery(cb.id, toast || "");
        }
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

  // Inline-button tap from the configured chat -> { id, data }.
  private callbackFrom(update: any): { id: string; data: string } | null {
    const cq = update.callback_query;
    if (!cq) return null;
    const fromChat = String(cq.message?.chat?.id);
    return cq.data && fromChat === this.chatId ? { id: cq.id, data: cq.data } : null;
  }

  // Ack a button tap so it stops spinning; optional toast text.
  private async answerCallbackQuery(id: string, text: string): Promise<void> {
    try {
      const form = new FormData();
      form.append("callback_query_id", id);
      if (text) form.append("text", text);
      await fetch(`${API}/bot${this.token}/answerCallbackQuery`, { method: "POST", body: form });
    } catch {
      /* best effort */
    }
  }
}
