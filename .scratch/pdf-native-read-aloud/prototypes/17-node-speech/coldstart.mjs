/* Cold start of an HTTP speech server the way tts.js runs it:
   spawn -> PORT line -> /voices OK -> first POST /synthesize answered.
   node coldstart.mjs <label> <cmd> [args...]   (3 trials) */
import { spawn } from "node:child_process";
const [label, cmd, ...args] = process.argv.slice(2);
const TEXT = "The parser reads one token at a time.";
for (let trial = 0; trial < 3; trial++) {
  const t0 = performance.now();
  const child = spawn(cmd, args, { env: { ...process.env, BLITZ_TTS_PORT: "0", BLITZ_TTS_THREADS: "8" }, stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise((res) => child.stdout.on("data", (d) => { const m = String(d).match(/PORT (\d+)/); if (m) res(Number(m[1])); }));
  const tPort = performance.now() - t0;
  for (;;) { try { if ((await fetch(`http://127.0.0.1:${port}/voices`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 10)); }
  const tReady = performance.now() - t0;
  const r = await fetch(`http://127.0.0.1:${port}/synthesize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: TEXT, voice: "bf_emma", speed: 1 }) });
  const j = await r.json();
  const tFirst = performance.now() - t0;
  const t1 = performance.now();
  await (await fetch(`http://127.0.0.1:${port}/synthesize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: TEXT, voice: "bf_emma", speed: 1 }) })).json();
  const tWarm = performance.now() - t1;
  console.log(JSON.stringify({ label, trial, port_line_s: +(tPort / 1000).toFixed(2), ready_s: +(tReady / 1000).toFixed(2), first_audio_s: +(tFirst / 1000).toFixed(2), warm_same_sentence_s: +(tWarm / 1000).toFixed(2), spans: j.spans?.length }));
  child.kill("SIGTERM");
  await new Promise((r) => child.on("exit", r));
}
