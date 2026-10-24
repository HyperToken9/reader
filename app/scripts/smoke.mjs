/*
 * Startup smoke test: launch the packaged renderer inside Electron and assert
 * the window actually came up wired -- speech status answering, voice list
 * populated, no console errors. Drives the real app over CDP rather than
 * mocking, because everything interesting here is in the wiring.
 *
 *   npm run build && node scripts/smoke.mjs
 *
 * Speech is downloaded on the first press of play, so by default this only
 * checks that speech answers. BLITZ_SMOKE_SPEECH=1 also prepares it -- which
 * downloads the ~190 MB of weights into BLITZ_SPEECH_DIR (or the app's
 * userData) if they are not there -- and speaks one sentence through the
 * engine's utilityProcess.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { writeFixturePdf } from "./fixture-pdf.mjs";

const PORT = Number(process.env.BLITZ_SMOKE_CDP_PORT || 9333);
// BLITZ_SMOKE_BIN points at a packaged build (release/linux-unpacked/blitz, or
// the AppImage). Worth running both ways: the asar-packed app has already
// diverged from the source tree once, when Python could not be read out of the
// archive and the shipped app had no voice.
const BIN = process.env.BLITZ_SMOKE_BIN;
// detached: its own process group, so done() can take down the Electron that
// npx (or the AppImage) starts and not just the wrapper. Otherwise the app
// outlives the run, keeps the port, and the next run tests it instead.
const app = BIN
  ? spawn(BIN, [`--remote-debugging-port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"], detached: true })
  : spawn("npx", ["electron", ".", `--remote-debugging-port=${PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
const appLog = [];
app.stdout.on("data", (d) => appLog.push(String(d)));
app.stderr.on("data", (d) => appLog.push(String(d)));

const done = (code, msg) => {
  if (msg) console.log(msg);
  if (app.exitCode === null) {
    try { process.kill(-app.pid, "SIGTERM"); } catch { app.kill("SIGTERM"); }
  }
  process.exit(code);
};

async function target() {
  for (let i = 0; i < 80; i++) {
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
const errors = [];
let id = 0;

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  } else if (m.method === "Runtime.bindingCalled" && m.params.name === "__smokeReject") {
    errors.push(m.params.payload);
  } else if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails.text + " " + (m.params.exceptionDetails.exception?.description ?? ""));
  }
});

await new Promise((r) => ws.on("open", r));
await send("Runtime.enable");
await send("DOM.enable");
// Unhandled rejections don't surface as Runtime.exceptionThrown with a usable
// message -- PDF.js failures arrive minified as "Uncaught (in promise) Bs" --
// so listen for them in the page and read the real name off the reason.
await send("Runtime.addBinding", { name: "__smokeReject" });
await send("Runtime.evaluate", {
  expression: "addEventListener('unhandledrejection', (e) => " +
    "__smokeReject(`${e.reason?.name ?? 'rejection'}: ${e.reason?.message ?? e.reason}`))",
});

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`${d.text} ${d.exception?.description ?? ""}`.trim());
  }
  return r.result.value;
};

// The preload bridge is there before the renderer's module has run; the
// checks below need the page itself up.
for (let i = 0; i < 40 && !(await evaluate("!!window.__spike")); i++) await new Promise((r) => setTimeout(r, 250));

const status = await evaluate("window.blitz.ttsStatus()");

let spoken = null;
if (process.env.BLITZ_SMOKE_SPEECH) {
  const t0 = Date.now();
  const prepared = await evaluate("window.blitz.prepareSpeech()");
  const t1 = Date.now();
  spoken = prepared.ok
    ? await evaluate("window.blitz.synthesize({ text: 'The parser reads one token at a time.', voice: 'bf_emma', speed: 1 })" +
        ".then((r) => ({ ok: true, sr: r.sr, bytes: r.audio_b64.length, words: r.words.length, spans: r.spans.length }), (e) => ({ ok: false, error: e.message }))")
    : prepared;
  console.log(`speech: prepared in ${t1 - t0} ms, first sentence in ${Date.now() - t1} ms`, JSON.stringify(spoken));
}

// Zoom on the home page (39): the keys and the wheel used to zoom the hidden
// reader, so nothing visible happened. Real input events, not calls into the
// app, because the bug was in which listener heard them. Ctrl 0 at the end
// puts the remembered zoom back, since this writes the real userData.
const ctrlKey = async (key, code) => {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, modifiers: 2, key, code, windowsVirtualKeyCode: key === "=" ? 187 : key === "-" ? 189 : 48 });
  }
};
const ctrlWheel = (deltaY) =>
  send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY, modifiers: 2 });
const homeZoom = () => evaluate("Number(document.getElementById('homeInner').style.zoom || 1)");
const zoomState = () => evaluate("({ home: Number(document.getElementById('homeInner').style.zoom || 1), reader: window.__spike.scale, dpr: devicePixelRatio })");
const before = await zoomState();
await ctrlKey("=", "Equal");
const afterKey = await zoomState();
await ctrlWheel(-300);
const afterWheel = await homeZoom();
await ctrlKey("0", "Digit0");
const afterReset = await zoomState();

// Open a real document. This is the check that was missing when a packaged
// build shipped with a Chromium too old for PDF.js 6 (no Uint8Array.toHex):
// the window came up perfectly, and every file silently did nothing.
const fixture = writeFixturePdf(join(tmpdir(), "blitz-smoke-fixture.pdf"));
const root = await send("DOM.getDocument", { depth: 1 });
const input = await send("DOM.querySelector", { nodeId: root.root.nodeId, selector: "#file" });
await send("DOM.setFileInputFiles", { files: [fixture], nodeId: input.nodeId });

let opened = null;
for (let i = 0; i < 40; i++) {
  // `rendered` is the honest signal: the canvas gets its width at the *start*
  // of paintCanvas, so polling canvas.width passes before PDF.js has drawn or
  // built a text layer at all.
  opened = await evaluate(
    "({ pages: document.querySelectorAll('.pdfpage').length," +
    "   rendered: !!window.__spike?.pages.get(1)?.rendered," +
    "   words: document.querySelectorAll('.textLayer span').length })",
  );
  if (opened.pages > 0 && opened.rendered) break;
  await new Promise((r) => setTimeout(r, 500));
}

// The same keys inside a book drive the reader, and only the reader.
const readerBefore = await zoomState();
await ctrlKey("=", "Equal");
const readerAfter = await zoomState();

const checks = [
  ["speech status answers", status?.ok, status?.error],
  ...(spoken ? [["speech speaks a sentence", spoken.ok && spoken.spans > 0 && spoken.bytes > 1000, spoken.error ?? JSON.stringify(spoken)]] : []),
  ["voice list populated", await evaluate("document.getElementById('voice').options.length > 1"), "voice <select> is empty"],
  ["viewer mounted", await evaluate("!!document.getElementById('pages')"), "#pages missing"],
  ["layout model reachable", typeof (await evaluate("window.blitz.layoutReady()")) === "boolean", "layoutReady did not answer"],
  ["PDF opens", opened?.pages > 0, "the file input accepted a PDF and no page appeared"],
  ["first page renders", opened?.rendered, "page 1 never finished rasterising"],
  ["text layer has words", opened?.words > 0, "no spans in the text layer — nothing to highlight"],
  ["ctrl + zooms the home page, not the reader", afterKey.home > before.home && afterKey.reader === before.reader, JSON.stringify({ before, afterKey })],
  ["ctrl+wheel zooms the home page", afterWheel > afterKey.home, `${afterKey.home} → ${afterWheel}`],
  ["ctrl 0 resets the home page", afterReset.home === 1, `zoom ${afterReset.home}`],
  ["ctrl + in a book zooms the reader only", readerAfter.reader > readerBefore.reader && readerAfter.home === readerBefore.home, JSON.stringify({ readerBefore, readerAfter })],
  ["window zoom never moves", [afterKey, afterReset, readerAfter].every((s) => s.dpr === before.dpr), `devicePixelRatio ${before.dpr} → ${readerAfter.dpr}`],
  ["no console errors", errors.length === 0, errors.join(" | ")],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}
if (failed && appLog.length) console.log("\n--- app output ---\n" + appLog.join("").split("\n").filter((l) => !l.includes("onnxruntime:")).join("\n"));
done(failed ? 1 : 0, failed ? `\n${failed} check(s) failed` : "\nall checks passed");
