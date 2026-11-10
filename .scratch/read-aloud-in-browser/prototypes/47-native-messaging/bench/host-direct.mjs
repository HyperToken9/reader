// PROTOTYPE 47: talk to the native host exactly as Chrome does (spawn the
// launcher, length-prefixed JSON on stdio), without a browser.
//
//   node bench/host-direct.mjs rtf             warm RTF, Blitz's bench definition
//   node bench/host-direct.mjs exact REF.json  every corpus sentence vs the in-process reference
//   node bench/host-direct.mjs idle            host RSS and CPU, loaded and idle for 60 s
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(join(root, "corpus/sentences.json"), "utf8"));
const [mode, arg] = process.argv.slice(2);

function startHost() {
  const t0 = performance.now();
  const p = spawn(join(root, "host/launcher.sh"), ["chrome-extension://agdejbojbbncecmipiedhfefmpkmcmba/"], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = Buffer.alloc(0);
  const waiters = [];
  const inbox = [];
  p.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      if (n > 1024 * 1024) throw new Error(`message of ${n} bytes breaks Chrome's 1 MB cap`);
      const m = JSON.parse(buf.toString("utf8", 4, 4 + n));
      m._at = performance.now();
      m._bytes = n;
      buf = buf.subarray(4 + n);
      const w = waiters.findIndex((w) => w.pred(m));
      if (w >= 0) waiters.splice(w, 1)[0].res(m);
      else inbox.push(m);
    }
  });
  const next = (pred) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((res) => waiters.push({ pred, res }));
  };
  const send = (m) => {
    const b = Buffer.from(JSON.stringify(m));
    const h = Buffer.alloc(4);
    h.writeUInt32LE(b.length);
    p.stdin.write(Buffer.concat([h, b]));
  };
  return { p, t0, next, send };
}

async function speak(h, id, text) {
  const t = performance.now();
  h.send({ op: "speak", id, text });
  const start = await h.next((m) => m.id === id && (m.type === "start" || m.type === "error"));
  if (start.type === "error") throw new Error(start.error);
  const parts = [];
  let maxBytes = 0;
  for (let k = 0; k < start.nchunks; k++) {
    const c = await h.next((m) => m.id === id && m.type === "chunk" && m.seq === k);
    maxBytes = Math.max(maxBytes, c._bytes);
    parts.push(Buffer.from(c.pcm, "base64"));
  }
  const end = await h.next((m) => m.id === id && m.type === "end");
  const pcm = Buffer.concat(parts);
  return { start, pcm, hostSha: end.sha, sha: createHash("sha256").update(pcm).digest("hex"), firstMs: start._at - t, totalMs: end._at - t, maxBytes };
}

function procStat(pid) {
  // utime+stime in clock ticks (100/s), RSS in kB, for the node process (the launcher execs it).
  const st = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return { cpuTicks: Number(st[11]) + Number(st[12]), rssKB: Number(/VmRSS:\s+(\d+)/.exec(status)[1]), threads: Number(/Threads:\s+(\d+)/.exec(status)[1]) };
}

const h = startHost();
const ready = await h.next((m) => m.type === "ready" || m.type === "error");
if (ready.type === "error") throw new Error(ready.error);
console.log(JSON.stringify({ event: "ready", spawnToReadyMs: +(ready._at - h.t0).toFixed(0), loadMs: ready.loadMs, threads: ready.threads }));

if (mode === "rtf") {
  // Blitz's own bench (scripts/speech-parity.mjs --bench): the first six corpus
  // sentences, four passes, the first pass discarded as warm-up.
  let synth = 0, wall = 0, audio = 0;
  for (let rep = 0; rep < 4; rep++)
    for (const s of corpus.slice(0, 6)) {
      const r = await speak(h, `${rep}:${s.id}`, s.text);
      if (rep === 0) continue;
      synth += r.start.synthMs / 1000;
      wall += r.totalMs / 1000;
      audio += r.start.samples / r.start.sr;
    }
  console.log(JSON.stringify({ event: "rtf", threads: ready.threads, engineRTF: +(synth / audio).toFixed(3), endToEndRTF: +(wall / audio).toFixed(3), audio_s: +audio.toFixed(1) }));
} else if (mode === "exact") {
  const ref = JSON.parse(readFileSync(arg, "utf8"));
  let same = 0, pcmSame = 0, spansSame = 0, n = 0, maxBytes = 0, transport = 0;
  const diffs = [];
  for (const s of corpus) {
    if (!ref[s.id]) continue;
    n++;
    const r = await speak(h, s.id, s.text);
    maxBytes = Math.max(maxBytes, r.maxBytes);
    transport += r.sha === r.hostSha;
    const a = r.sha === ref[s.id].sha;
    const b = JSON.stringify([r.start.words, r.start.spans]) === JSON.stringify([ref[s.id].words, ref[s.id].spans]);
    pcmSame += a;
    spansSame += b;
    same += a && b;
    if (!(a && b)) diffs.push({ id: s.id, pcm: a, spans: b });
  }
  console.log(JSON.stringify({ event: "exact", sentences: n, pcmArrivedAsHostMadeIt: transport, identical: same, pcmIdentical: pcmSame, spansIdentical: spansSame, largestMessageBytes: maxBytes, spanDiffs: diffs.filter((d) => !d.spans).map((d) => d.id) }));
} else if (mode === "idle") {
  const pid = (await (h.send({ op: "stats" }), h.next((m) => m.type === "stats"))).pid;
  const loaded = procStat(pid);
  await speak(h, "w", corpus[2].text);
  const afterSpeak = procStat(pid);
  const a = procStat(pid);
  const t = performance.now();
  await new Promise((r) => setTimeout(r, 60_000));
  const b = procStat(pid);
  const idleCpuPct = ((b.cpuTicks - a.cpuTicks) / 100 / ((performance.now() - t) / 1000)) * 100;
  console.log(JSON.stringify({ event: "idle", pid, rssLoadedMB: +(loaded.rssKB / 1024).toFixed(0), rssAfterSpeakMB: +(afterSpeak.rssKB / 1024).toFixed(0), rssIdleMB: +(b.rssKB / 1024).toFixed(0), threads: b.threads, idleCpuPct: +idleCpuPct.toFixed(2), idleCpuTicks60s: b.cpuTicks - a.cpuTicks }));
}
h.p.stdin.end();
