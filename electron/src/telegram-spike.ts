// Step-5 spike renderer: prove both Telegram adapters work in Electron —
// TelegramNotifier (sendPhoto multipart) and TelegramPoller (getUpdates long-
// poll + chat_id filter). Creds prefilled from env/.env via the preload bridge.
import { TelegramNotifier, TelegramPoller } from "./telegram.ts";
import type { PixelFrame } from "./domain.ts";

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

const tokenInput = $("token") as HTMLInputElement;
const chatInput = $("chat") as HTMLInputElement;
const sendBtn = $("send") as HTMLButtonElement;
const pollBtn = $("poll") as HTMLButtonElement;
const statusEl = $("status");
const msgEl = $("messages");

const log = (msg: string, cls = ""): void => {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  msgEl.appendChild(line);
};

// A small gradient frame so the Telegram test doesn't depend on screen capture.
function testFrame(w = 240, h = 140): PixelFrame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = Math.floor((x / w) * 255);
      data[o + 1] = Math.floor((y / h) * 255);
      data[o + 2] = 160;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

let poller: TelegramPoller | null = null;

(window as any).spike.getTelegramConfig().then((cfg: { token: string; chatId: string }) => {
  if (cfg.token) tokenInput.value = cfg.token;
  if (cfg.chatId) chatInput.value = cfg.chatId;
  statusEl.textContent = cfg.token ? "creds loaded from env/.env" : "enter token + chat id";
});

sendBtn.addEventListener("click", () => {
  const notifier = new TelegramNotifier(
    tokenInput.value.trim(),
    chatInput.value.trim(),
    (s) => log("notifier: " + s, s.startsWith("sent") ? "ok" : "err"),
  );
  if (!notifier.configured()) {
    log("enter both token and chat id", "err");
    return;
  }
  log("sending test photo...");
  notifier.notifyFrozen(testFrame(), "spike");
});

pollBtn.addEventListener("click", () => {
  if (poller) {
    poller.stop();
    poller = null;
    pollBtn.textContent = "Start poller";
    statusEl.textContent = "poller stopped";
    return;
  }
  poller = new TelegramPoller(tokenInput.value.trim(), chatInput.value.trim(), (text) =>
    log("received: " + text, "ok"),
  );
  if (!poller.configured()) {
    log("enter both token and chat id", "err");
    poller = null;
    return;
  }
  poller.start();
  pollBtn.textContent = "Stop poller";
  statusEl.textContent = "polling — send your bot a message from the configured chat";
});

window.addEventListener("error", (e) => log("JS error: " + e.message, "err"));
