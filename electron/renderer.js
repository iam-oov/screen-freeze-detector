const $ = (id) => document.getElementById(id);
const log = $("log");
const write = (msg, cls) => {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  log.appendChild(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// This window has no DevTools open, so surface every error in the log itself —
// otherwise a failure looks like "nothing happened".
window.addEventListener("error", (e) => write("JS error: " + e.message, "err"));

if (!window.spike) {
  write("preload bridge missing: window.spike is undefined", "err");
}

$("run").addEventListener("click", async () => {
  const btn = $("run");
  btn.disabled = true;
  log.textContent = "";
  const x = parseInt($("x").value, 10);
  const y = parseInt($("y").value, 10);
  const text = $("text").value;

  for (let s = 5; s > 0; s--) {
    write(`focus your target app... ${s}`);
    await sleep(1000);
  }
  write("injecting now");

  try {
    const res = await window.spike.runInjection({ x, y, text });
    res.steps.forEach((step) => write("  ✓ " + step, "ok"));
    if (res.ok) {
      write("RESULT: nut.js injection WORKS ✅", "ok");
    } else {
      write("RESULT: FAILED ❌ — " + res.error, "err");
      write("On macOS: System Settings → Privacy & Security → Accessibility → enable this app.", "err");
    }
  } catch (e) {
    write("RESULT: handler threw — " + (e && e.message ? e.message : e), "err");
  }
  btn.disabled = false;
});
