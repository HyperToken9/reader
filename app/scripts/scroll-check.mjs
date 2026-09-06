/*
 * Measures the two things a reader feels on a big textbook: whether a fast
 * scroll stays smooth, and whether ctrl+wheel zoom keeps the point under the
 * pointer under the pointer.
 *
 *   node scripts/scroll-check.mjs <binary|.> <some.pdf>
 *
 * Not part of `npm run smoke` -- it needs a real multi-hundred-page book, and
 * those are gitignored. Run it by hand against one when touching the scroll or
 * zoom path.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const BIN = process.argv[2] ?? ".";
const PDF = process.argv[3];
const PORT = Number(process.env.BLITZ_CDP_PORT || 9399);
if (!PDF) { console.log("usage: node scripts/scroll-check.mjs <binary|.> <some.pdf>"); process.exit(2); }

const app = BIN === "."
  ? spawn("npx", ["electron", ".", `--remote-debugging-port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] })
  : spawn(BIN, [`--remote-debugging-port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
const log = [];
app.stdout.on("data", (d) => log.push(String(d)));
app.stderr.on("data", (d) => log.push(String(d)));
const done = (code, msg) => { if (msg) console.log(msg); app.kill("SIGTERM"); process.exit(code); };

async function target() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(800) });
      const [t] = (await res.json()).filter((t) => t.type === "page");
      if (t?.webSocketDebuggerUrl) return t;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  done(1, "FAIL: the window never opened");
}

const t = await target();
const ws = new WebSocket(t.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const send = (method, params = {}) => new Promise((r) => {
  const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params }));
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
await new Promise((r) => ws.on("open", r));
await send("Runtime.enable");
await send("DOM.enable");

const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result.value;
};

// The packaged app takes noticeably longer to get a document into the window
// than `npx electron .` does; wait for the DOM rather than assuming it.
for (let i = 0; i < 120; i++) {
  try { if (await ev("!!document.getElementById('file')")) break; } catch { /* no context yet */ }
  await new Promise((r) => setTimeout(r, 250));
}
const root = await send("DOM.getDocument", { depth: 1 });
const input = await send("DOM.querySelector", { nodeId: root.root.nodeId, selector: "#file" });
await send("DOM.setFileInputFiles", { files: [PDF], nodeId: input.nodeId });
let open = null;
for (let i = 0; i < 120; i++) {
  open = await ev("({ pages: document.querySelectorAll('.pdfpage').length, rendered: !!window.__spike?.pages.get(1)?.rendered })");
  if (open.rendered) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (!open?.rendered) done(1, "FAIL: the document never opened");
console.log(`opened ${open.pages} pages`);

// ---- fling ---------------------------------------------------------------
// A dropped frame during a fling is the whole complaint, so measure frames,
// not wall-clock: record every gap between animation frames while scrolling.
await ev(`(() => {
  window.__frames = [];
  let last = performance.now();
  const tick = (t) => { window.__frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})()`);

const CXW = await ev("(() => { const v = document.getElementById('viewer'); const r = v.getBoundingClientRect(); return Math.round(r.left + r.width / 2); })()");
const startTop = await ev("document.getElementById('viewer').scrollTop");
for (let i = 0; i < 40; i++) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: CXW, y: 400, deltaX: 0, deltaY: 900,
  });
  await new Promise((r) => setTimeout(r, 16));
}
await new Promise((r) => setTimeout(r, 500));
const fling = await ev(`(() => {
  const f = window.__frames.slice();
  window.__frames = [];
  const sorted = [...f].sort((a, b) => a - b);
  return { frames: f.length, worst: Math.round(Math.max(...f)),
           p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
           scrolled: Math.round(document.getElementById('viewer').scrollTop) };
})()`);
console.log(`fling: moved ${fling.scrolled - startTop}px, ${fling.frames} frames, p95 ${fling.p95}ms, worst ${fling.worst}ms`);

// Let the queue settle, then confirm the page it landed on actually renders.
await new Promise((r) => setTimeout(r, 4000));
const CX = await ev("(() => { const v = document.getElementById('viewer'); const r = v.getBoundingClientRect(); return Math.round(r.left + r.width / 2); })()");
const settled = await ev(`(() => {
  const v = document.getElementById('viewer');
  const mid = v.getBoundingClientRect().top + v.clientHeight / 2;
  const el = document.elementFromPoint(${CX}, mid)?.closest('.pdfpage');
  const pn = el ? Number(el.dataset.page) : null;
  return { pn, rendered: !!window.__spike.pages.get(pn)?.rendered };
})()`);
console.log(`settled on page ${settled.pn}, rendered: ${settled.rendered}`);

// ---- ctrl+wheel zoom -----------------------------------------------------
const ANCHOR_Y = 400;
const X = await ev("(() => { const v = document.getElementById('viewer'); const r = v.getBoundingClientRect(); return Math.round(r.left + r.width / 2); })()");
const anchorBefore = await ev(`(() => {
  const el = document.elementFromPoint(${X}, ${ANCHOR_Y})?.closest('.pdfpage');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { pn: Number(el.dataset.page), frac: (${ANCHOR_Y} - r.top) / r.height, scale: window.__spike.scale };
})()`);
for (let i = 0; i < 10; i++) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: X, y: ANCHOR_Y, deltaX: 0, deltaY: -120, modifiers: 2, // ctrl
  });
  await new Promise((r) => setTimeout(r, 30));
}
await new Promise((r) => setTimeout(r, 600));
const anchorAfter = await ev(`(() => {
  const el = document.querySelector('.pdfpage[data-page="${anchorBefore?.pn}"]');
  const r = el.getBoundingClientRect();
  return { scale: window.__spike.scale, y: r.top + ${anchorBefore?.frac} * r.height };
})()`);
const drift = Math.abs(anchorAfter.y - ANCHOR_Y);
console.log(`zoom: ${anchorBefore.scale.toFixed(2)} -> ${anchorAfter.scale.toFixed(2)}, anchor drift ${drift.toFixed(1)}px`);

// The overlay and the text layer are both meant to be page-fraction geometry
// that scales with the page for free (02 §6). If that claim is wrong, the
// first symptom is the text layer no longer covering the page it sits on --
// which is exactly a misplaced highlight.
const layers = await ev(`(() => {
  const el = document.querySelector('.pdfpage[data-page="${anchorBefore?.pn}"]');
  const page = el.getBoundingClientRect();
  const text = el.querySelector('.textLayer').getBoundingClientRect();
  const svg = el.querySelector('.overlay').getBoundingClientRect();
  return { dw: Math.abs(page.width - text.width), dh: Math.abs(page.height - text.height),
           sw: Math.abs(page.width - svg.width), sh: Math.abs(page.height - svg.height) };
})()`);
console.log(`layers: text off by ${layers.dw.toFixed(1)}x${layers.dh.toFixed(1)}px, overlay off by ${layers.sw.toFixed(1)}x${layers.sh.toFixed(1)}px`);

const checks = [
  ["fling scrolls", fling.scrolled - startTop > 5000, `only moved ${fling.scrolled - startTop}px`],
  ["fling stays smooth", fling.p95 < 100, `95th-percentile frame ${fling.p95}ms`],
  ["no frozen frame", fling.worst < 400, `worst frame ${fling.worst}ms`],
  ["renders where it stops", settled.rendered, `page ${settled.pn} never rendered`],
  ["ctrl+wheel zooms", anchorAfter.scale > anchorBefore.scale + 0.05, "scale did not change"],
  ["zoom holds the anchor", drift < 24, `point under the cursor moved ${drift.toFixed(1)}px`],
  ["text layer tracks the page", layers.dw < 2 && layers.dh < 2, `off by ${layers.dw.toFixed(1)}x${layers.dh.toFixed(1)}px`],
  ["overlay tracks the page", layers.sw < 2 && layers.sh < 2, `off by ${layers.sw.toFixed(1)}x${layers.sh.toFixed(1)}px`],
];
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}
done(failed ? 1 : 0, failed ? `\n${failed} check(s) failed` : "\nall checks passed");
