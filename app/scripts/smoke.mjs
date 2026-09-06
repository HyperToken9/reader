/*
 * Startup smoke test: launch the packaged renderer inside Electron and assert
 * the window actually came up wired -- speech engine reachable, voice list
 * populated, no console errors. Drives the real app over CDP rather than
 * mocking, because everything interesting here is in the wiring.
 *
 *   npm run build && node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = Number(process.env.BLITZ_SMOKE_CDP_PORT || 9333);
const app = spawn("npx", ["electron", ".", `--remote-debugging-port=${PORT}`], {
  stdio: ["ignore", "pipe", "pipe"],
});
const appLog = [];
app.stdout.on("data", (d) => appLog.push(String(d)));
app.stderr.on("data", (d) => appLog.push(String(d)));

const done = (code, msg) => {
  if (msg) console.log(msg);
  if (app.exitCode === null) app.kill("SIGTERM");
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
  } else if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails.text + " " + (m.params.exceptionDetails.exception?.description ?? ""));
  }
});

await new Promise((r) => ws.on("open", r));
await send("Runtime.enable");

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`${d.text} ${d.exception?.description ?? ""}`.trim());
  }
  return r.result.value;
};

// The engines load in the background; give them the same grace a reader would.
let status = null;
for (let i = 0; i < 60; i++) {
  status = await evaluate("window.blitz.ttsStatus()");
  if (status?.ok) break;
  await new Promise((r) => setTimeout(r, 1000));
}

const checks = [
  ["speech engine ready", status?.ok, status?.error],
  ["voice list populated", await evaluate("document.getElementById('voice').options.length > 1"), "voice <select> is empty"],
  ["viewer mounted", await evaluate("!!document.getElementById('pages')"), "#pages missing"],
  ["layout model reachable", typeof (await evaluate("window.blitz.layoutReady()")) === "boolean", "layoutReady did not answer"],
  ["no console errors", errors.length === 0, errors.join(" | ")],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}
if (failed && appLog.length) console.log("\n--- app output ---\n" + appLog.join("").split("\n").filter((l) => !l.includes("onnxruntime:")).join("\n"));
done(failed ? 1 : 0, failed ? `\n${failed} check(s) failed` : "\nall checks passed");
