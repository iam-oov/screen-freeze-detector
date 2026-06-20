// Telegram adapters. fetch + FormData talk to the Bot API directly from the
// renderer (which can fetch api.telegram.org and has canvas to encode PNGs).
import type { PixelFrame } from "./domain.ts";

const API = "https://api.telegram.org";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Inline-keyboard rows, 4 buttons per row (Telegram allows up to 8). The prefix
// goes into callback_data so the tap handler can tell button kinds apart (e.g.
// "ss:z2" requests a state photo, bare "z2" sends Enter).
export function buttonRows(
  codes: string[],
  prefix = "",
): { text: string; callback_data: string }[][] {
  const PER_ROW = 4;
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < codes.length; i += PER_ROW) {
    rows.push(codes.slice(i, i + PER_ROW).map((c) => ({ text: c, callback_data: prefix + c })));
  }
  return rows;
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

// "<code> ctrlc" or "<code>: ctrlc" -> the zone code (a bare "ctrlc" -> null).
// Ctrl+C is destructive, so it requires an explicit zone code.
export function parseCtrlc(text: string): string | null {
  const m = text.trim().match(/^([^\s:]+)[:\s]\s*ctrlc$/i);
  return m ? m[1] : null;
}

// "<code> up" / "<code>: up [n]" -> { zone, count } (count defaults to 1). Like
// parseCtrlc, an explicit zone is required (a bare "up" -> null).
export function parseUp(text: string): { zone: string; count: number } | null {
  const m = text.trim().match(/^([^\s:]+)[:\s]\s*up(?:\s+(\d+))?$/i);
  if (!m) return null;
  return { zone: m[1], count: m[2] ? parseInt(m[2], 10) : 1 };
}

// "<code> enter" / "<code>: enter" -> the zone code. A bare "enter" -> null; it
// stays handled as the selected/last-zone reply word (see TELEGRAM_COMMANDS).
export function parseEnter(text: string): string | null {
  const m = text.trim().match(/^([^\s:]+)[:\s]\s*enter$/i);
  return m ? m[1] : null;
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

export class TelegramNotifier {
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

  // Validate the creds in one silent call (no message sent): getChat checks the
  // token AND that the chat_id is reachable by the bot.
  async verify(): Promise<
    | { status: "ok" }
    | { status: "bad-token" }
    | { status: "bad-chat" }
    | { status: "offline"; error: string }
  > {
    try {
      const res = await fetch(
        `${API}/bot${this.token}/getChat?chat_id=${encodeURIComponent(this.chatId)}`,
      );
      const data = await res.json();
      if (data.ok) return { status: "ok" };
      return { status: data.error_code === 401 ? "bad-token" : "bad-chat" };
    } catch (e) {
      return { status: "offline", error: e instanceof Error ? e.message : String(e) };
    }
  }

  async sendPhoto(frame: PixelFrame, caption: string, replyMarkup?: object): Promise<void> {
    if (!this.configured()) return;
    try {
      const blob = await pixelFrameToPngBlob(frame);
      const form = new FormData();
      form.append("chat_id", this.chatId);
      form.append("caption", caption);
      form.append("photo", blob, "zone.png");
      if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
      const res = await fetch(`${API}/bot${this.token}/sendPhoto`, { method: "POST", body: form });
      this.onStatus(res.ok ? `sent (${caption})` : `sendPhoto failed: HTTP ${res.status}`);
    } catch (e) {
      this.onStatus("send error: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  // Combined freeze message: zone photo + caption + a button per frozen,
  // telegram-enabled zone (tapping one sends Enter to that zone).
  sendFrozen(frame: PixelFrame, zoneName: string, codes: string[]): Promise<void> {
    const markup = codes.length ? { inline_keyboard: buttonRows(codes) } : undefined;
    return this.sendPhoto(frame, `Frozen: ${zoneName}`, markup);
  }

  // A text message with one inline button per code (callback_data = prefix+code).
  async sendButtons(text: string, codes: string[], prefix = ""): Promise<void> {
    if (!this.configured() || !codes.length) return;
    try {
      const form = new FormData();
      form.append("chat_id", this.chatId);
      form.append("text", text);
      form.append("reply_markup", JSON.stringify({ inline_keyboard: buttonRows(codes, prefix) }));
      await fetch(`${API}/bot${this.token}/sendMessage`, { method: "POST", body: form });
    } catch {
      /* best effort */
    }
  }

  // A short italic note back to the chat (e.g. action confirmations).
  sendNote(text: string): Promise<void> {
    if (!this.configured()) return Promise.resolve();
    return this.sendMessageHtml(`<i>${escapeHtml(text)}</i>`);
  }

  // A monospaced block back to the chat (e.g. the zones summary) so columns align.
  sendText(text: string): Promise<void> {
    if (!this.configured()) return Promise.resolve();
    return this.sendMessageHtml(`<pre>${escapeHtml(text)}</pre>`);
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
