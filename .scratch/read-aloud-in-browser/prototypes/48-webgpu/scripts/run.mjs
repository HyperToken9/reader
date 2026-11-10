// PROTOTYPE 48 (throwaway): the harness. Launches its own Chrome with a throwaway profile,
// loads the unpacked extension, and runs one experiment. Results go to out/<exp>-<tag>.json.
//
//   node scripts/run.mjs <exp> [--ep webgpu|wasm] [--pp high-performance|low-power]
//        [--threads 4] [--reps 3] [--headed] [--profile <name>] [--fresh] [--tag x]
//   exp: bench | durations | ttfa | drift | survive | phon | coi
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { homedir, loadavg } from "node:os";

const here = new URL("..", import.meta.url).pathname;
const TMP = "/home/homefree/.claude/jobs/ec2bb647/tmp";
const args = process.argv.slice(2);
const exp = args[0];
const opt = (k, d) => (args.includes("--" + k) ? args[args.indexOf("--" + k) + 1] : d);
const flag = (k) => args.includes("--" + k);
const ep = opt("ep", "webgpu"), pp = opt("pp", "high-performance"), threads = Number(opt("threads", 4)), reps = Number(opt("reps", 3));
const headed = flag("headed");
const profile = `${TMP}/chrome48-${opt("profile", "main")}`;
const model = opt("model", "fp16"); // fp32: the 326 MB kokoro-v1.0.onnx (also has `duration`), for GPUs without shader-f16
const tag = opt("tag", `${ep}${ep === "webgpu" ? "-" + pp : "-t" + threads}${model === "fp32" ? "-fp32" : ""}${headed ? "-headed" : ""}`);
if (flag("fresh")) rmSync(profile, { recursive: true, force: true });
mkdirSync(here + "out", { recursive: true });

// Headless Chrome 157 on this machine only gets a hardware WebGPU adapter with these
// (see gpu_probe.mjs); headed needs --enable-unsafe-webgpu --enable-features=Vulkan.
const GPU_FLAGS = headed
  ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan"]
  : ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan", "--use-vulkan=native"];

const ref = existsSync(here + "out/ref_node.json") ? JSON.parse(readFileSync(here + "out/ref_node.json", "utf8")) : { phon: {}, sents: [] };
const corpus = JSON.parse(readFileSync(here + "corpus/sentences.json", "utf8"));
const benchTexts = corpus.filter((s) => s.book === "bench").map((s) => s.text);

/* ---------- a local server: the test page, and the model files (standing in for GitHub) ---------- */
const FILES = {
  "/model/kokoro-v1.0.fp16.onnx": homedir() + "/.config/blitz/speech/kokoro-v1.0.fp16.onnx",
  "/model/kokoro-v1.0.onnx": homedir() + "/.local/share/blitz-tts/kokoro/kokoro-v1.0.onnx",
  "/model/voices-v1.0.bin": homedir() + "/.config/blitz/speech/voices-v1.0.bin",
};
const srv = createServer((q, r) => {
  const h = { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin", "cache-control": "no-store" };
  if (FILES[q.url]) {
    r.writeHead(200, { ...h, "content-type": "application/octet-stream", "content-length": statSync(FILES[q.url]).size });
    return createReadStream(FILES[q.url]).pipe(r);
  }
  r.writeHead(200, { ...h, "content-type": "text/html" });
  r.end("<!doctype html><title>p48 page</title><p>PROTOTYPE 48 test page</p>");
}).listen(Number(opt("port", 48480))); // fixed: the port is part of the Cache Storage key
const PORT = srv.address().port;
const INIT = { ep, powerPreference: pp, threads, modelUrl: `http://localhost:${PORT}/model/${model === "fp32" ? "kokoro-v1.0.onnx" : "kokoro-v1.0.fp16.onnx"}`, voicesUrl: `http://localhost:${PORT}/model/voices-v1.0.bin` };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = () => ({ at: new Date().toISOString(), uptime: execFileSync("uptime").toString().trim(), loadavg: loadavg().map((x) => +x.toFixed(2)) });

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: !headed,
    userDataDir: profile,
    pipe: true,
    protocolTimeout: 3600000, // durations runs for many minutes in one evaluate
    enableExtensions: [opt("ext", here + "extension")], // --ext: e.g. a copy without COEP/COOP
    args: ["--no-first-run", "--no-default-browser-check", "--mute-audio", ...GPU_FLAGS],
  });
  const swT = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/sw.js"), { timeout: 20000 });
  const sw = await swT.worker();
  const extId = new URL(swT.url()).host;
  return { browser, sw, extId };
}
async function offscreenPage(browser, extId) {
  const t = await browser.waitForTarget((t) => t.url() === `chrome-extension://${extId}/offscreen.html`, { timeout: 20000 });
  const p = await t.asPage();
  await p.waitForFunction(() => !!window.P48, { timeout: 20000 });
  return p;
}
async function openOffscreen(ctx, reasons) {
  if (reasons) await ctx.sw.evaluate((r) => self.setReasons(r), reasons);
  const o = await ctx.sw.evaluate(() => self.ensureOffscreen());
  const off = await offscreenPage(ctx.browser, ctx.extId);
  off.on("console", (m) => m.type() === "error" && console.error("[offscreen]", m.text()));
  return { o, off };
}

/* ---------- process memory: PSS of every process of this profile, and the GPU's own counters ---------- */
function memory() {
  const out = { byType: {}, totalPssMB: 0, gpu: {} };
  // the browser process carries the profile path; every other Chrome process descends from it
  const procs = {};
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").split(" "); // Chrome children rewrite argv into one string
      const ppid = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1];
      procs[pid] = { cmd, ppid };
    } catch {}
  }
  const root = Object.keys(procs).find((p) => procs[p].cmd[0] === "/opt/google/chrome/chrome" && procs[p].cmd.some((a) => a.includes(profile)) && !procs[p].cmd.some((a) => a.startsWith("--type=")));
  const mine = (p) => { for (let i = 0; p && i < 10; i++, p = procs[p]?.ppid) if (p === root) return true; return false; };
  for (const pid of Object.keys(procs)) {
    const cmd = procs[pid].cmd;
    if (!root || !mine(pid)) continue;
    const type = (cmd.find((a) => a.startsWith("--type=")) ?? "--type=browser").slice(7) + (cmd.includes("--extension-process") ? "(extension)" : "");
    let pss = 0;
    try { pss = Number(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+)/m)[1]) / 1024; } catch {}
    out.byType[type] = +((out.byType[type] ?? 0) + pss).toFixed(1);
    out.totalPssMB += pss;
    if (type === "gpu-process") {
      out.gpuPid = Number(pid);
      // amdgpu (and other DRM drivers) publish per-client memory in fdinfo
      let vram = 0, gtt = 0;
      const seen = new Set();
      try {
        for (const fd of readdirSync(`/proc/${pid}/fdinfo`)) {
          const s = readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8");
          const id = s.match(/drm-client-id:\s+(\d+)/)?.[1];
          if (!id || seen.has(id)) continue; // one client may sit behind several fds
          seen.add(id);
          vram += Number(s.match(/drm-memory-vram:\s+(\d+)/)?.[1] ?? 0);
          gtt += Number(s.match(/drm-memory-gtt:\s+(\d+)/)?.[1] ?? 0);
        }
      } catch {}
      out.gpu.drmVramMB = +(vram / 1024).toFixed(1);
      out.gpu.drmGttMB = +(gtt / 1024).toFixed(1);
    }
  }
  out.totalPssMB = +out.totalPssMB.toFixed(1);
  try {
    const t = execFileSync("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]).toString();
    const table = execFileSync("nvidia-smi").toString();
    const row = table.split("\n").find((l) => out.gpuPid && l.includes(` ${out.gpuPid} `));
    out.gpu.nvidiaRow = row?.trim();
    out.gpu.nvidiaMB = row ? Number(row.match(/(\d+)MiB/)?.[1]) : null;
    out.gpu.nvidiaCompute = t.trim();
  } catch {}
  return out;
}

const save = (name, data) => {
  writeFileSync(here + `out/${name}.json`, JSON.stringify(data, null, 1));
  console.log(`-> out/${name}.json`);
};

/* ---------- experiments ---------- */
const exps = {};

// COI + WebGPU visibility inside the offscreen document, no model.
exps.speak1 = async () => {
  const ctx = await launch();
  ctx.browser.on("targetcreated", (t) => console.error("target", t.type(), t.url()));
  let r = await speakFromPage(ctx, [benchTexts[0]], "table", 60000);
  console.log(JSON.stringify(r.marks));
  r = await speakFromPage(ctx, [benchTexts[1]], "table", 60000);
  console.log(JSON.stringify(r.marks));
  await ctx.browser.close();
};

exps.mem = async () => {
  const ctx = await launch();
  await openOffscreen(ctx, ["WORKERS"]);
  console.log(JSON.stringify(memory()));
  if (flag("ps")) console.log(execFileSync("sh", ["-c", "ps -eo pid,ppid,rss,args | grep -i [c]hrome | cut -c1-180"]).toString());
  await ctx.browser.close();
};

exps.coi = async () => {
  const ctx = await launch();
  const { off } = await openOffscreen(ctx);
  const r = await off.evaluate(async () => ({ crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer, gpu: !!navigator.gpu, adapter: !!(await navigator.gpu?.requestAdapter()), hw: navigator.hardwareConcurrency }));
  console.log(r);
  await ctx.browser.close();
  return r;
};

async function loaded(ctx) {
  const { o, off } = await openOffscreen(ctx, ["WORKERS"]); // AUDIO_PLAYBACK alone is closed after 30 s with no audio
  await off.evaluate((t) => window.P48.setTable(t), ref.phon);
  const info = await off.evaluate((i) => window.P48.init(i), INIT);
  return { off, info, offscreen: o };
}

exps.bench = async () => {
  const ctx = await launch();
  const { off, info } = await loaded(ctx);
  console.error("init:", JSON.stringify(info));
  const firstRun = await off.evaluate((x) => window.P48.bench([x], 1), benchTexts[0]); // first-ever run (shader compile etc.)
  const warmup = await off.evaluate((x) => window.P48.bench(x, 1), benchTexts);
  const runs = await off.evaluate((x, n) => window.P48.bench(x, n), benchTexts, reps);
  const mem = memory();
  const jsMem = await off.evaluate(() => window.P48.memory());
  const r = { exp: "bench", tag, env: env(), info, firstRun, warmup, runs, warmRtf: runs.map((x) => x.rtf), mem, jsMem };
  console.log(JSON.stringify({ tag, warmRtf: r.warmRtf, firstRunMs: firstRun[0].ms, sessionMs: Math.round(info.sessionMs), adapter: info.adapter, coi: info.crossOriginIsolated, threads: info.numThreadsEffective, pss: mem.totalPssMB, gpu: mem.gpu, load: r.env.loadavg }));
  save(`bench-${tag}`, r);
  await ctx.browser.close();
};

exps.durations = async () => {
  const ctx = await launch();
  const { off, info } = await loaded(ctx);
  const sents = await off.evaluate((c) => window.P48.durations(c), corpus);
  // compare with the Node engine
  let durSame = 0, runsSame = 0, nRuns = 0, maxFrameDiff = 0, spanSame = 0, maxSpanMs = 0, tokSame = 0, tokN = 0;
  const spanDiffs = [];
  sents.forEach((s, i) => {
    const r = ref.sents[i];
    let all = r.runs.length === s.runs.length;
    s.runs.forEach((run, j) => {
      nRuns++;
      const rr = r.runs[j];
      if (!rr || rr.n !== run.n) return (all = false);
      let same = true;
      run.duration.forEach((d, k) => {
        tokN++;
        const diff = Math.abs(d - rr.duration[k]);
        if (diff === 0) tokSame++;
        else same = false;
        maxFrameDiff = Math.max(maxFrameDiff, diff);
      });
      if (same) runsSame++;
      else all = false;
    });
    if (all) durSame++;
    const sameWords = JSON.stringify(s.spans.map((x) => x.words)) === JSON.stringify(r.spans.map((x) => x.words));
    if (sameWords && s.spans.length === r.spans.length) {
      let m = 0;
      s.spans.forEach((x, k) => (m = Math.max(m, Math.abs(x.start - r.spans[k].start), Math.abs(x.end - r.spans[k].end))));
      spanDiffs.push(m * 1000);
      if (m === 0) spanSame++;
      maxSpanMs = Math.max(maxSpanMs, m * 1000);
    }
  });
  spanDiffs.sort((a, b) => a - b);
  const summary = {
    sentencesDurationsIdentical: `${durSame}/${sents.length}`,
    onnxRunsIdentical: `${runsSame}/${nRuns}`,
    tokensIdentical: `${tokSame}/${tokN}`,
    maxFrameDiff,
    spansIdentical: `${spanSame}/${sents.length}`,
    sameWordGrouping: `${spanDiffs.length}/${sents.length}`,
    spanDiffMs: { p50: spanDiffs[Math.floor(spanDiffs.length / 2)]?.toFixed(1), p95: spanDiffs[Math.floor(spanDiffs.length * 0.95)]?.toFixed(1), max: maxSpanMs.toFixed(1) },
  };
  console.log(tag, JSON.stringify(summary));
  save(`durations-${tag}`, { exp: "durations", tag, env: env(), info, summary, sents });
  await ctx.browser.close();
};

// Through the real path: content script -> SW -> offscreen -> audio, timed from the page.
async function speakFromPage(ctx, texts, phon = "table", timeoutMs = 600000) {
  const page = await ctx.browser.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  await sleep(300);
  // phonemes from Node's espeak-ng 1.52 travel with the request (only what these texts need)
  const table = {};
  if (phon === "table") for (const t of texts) for (const x of [t, ...(t.match(/\S+/gu) ?? [])]) table[x] = ref.phon[x];
  await page.evaluate((payload) => window.postMessage({ p48: "speak", payload }, "*"), { texts, init: INIT, phon, table });
  await page.waitForFunction(() => /"type":"(done|error)"/.test(document.documentElement.dataset.p48 ?? ""), { timeout: timeoutMs, polling: 500 }).catch(async (e) => {
    const l = await page.evaluate(() => document.documentElement.dataset.p48);
    writeFileSync(here + "out/speak-timeout-log.json", l ?? "null");
    console.error("page log (full in out/speak-timeout-log.json):", l?.slice(0, 300));
    throw e;
  });
  const log = JSON.parse(await page.evaluate(() => document.documentElement.dataset.p48));
  await page.close();
  const done = log.events.find((e) => e.type === "done" || e.type === "error");
  if (done.type === "error") throw new Error(done.error);
  return { log, marks: done.marks };
}

exps.ttfa = async () => {
  // cold: brand-new profile, nothing cached, no offscreen document
  rmSync(profile, { recursive: true, force: true });
  let ctx = await launch();
  const cold = await speakFromPage(ctx, [benchTexts[0]]);
  const warm = [];
  for (const t of [benchTexts[0], benchTexts[1], benchTexts[0]]) warm.push((await speakFromPage(ctx, [t])).marks);
  const memAfter = memory();
  await ctx.browser.close();
  // cold-from-cache: Chrome restarted, model in Cache Storage
  ctx = await launch();
  const cached = await speakFromPage(ctx, [benchTexts[0]]);
  await ctx.browser.close();
  const pick = (m) => ({ ttfaMs: Math.round(m.ttfaMs), offscreenCreateMs: Math.round(m.offscreen?.ms ?? 0), initMs: m.init && Math.round(m.init.initMs), model: m.init?.model, sessionMs: m.init && Math.round(m.init.sessionMs), firstSynthMs: Math.round(m.firstSynthMs), msgToOffscreenMs: Math.round(m.tArrive - m.tSent) });
  const r = { exp: "ttfa", tag, env: env(), text: benchTexts[0], cold: pick(cold.marks), warm: warm.map(pick), coldFromCache: pick(cached.marks), memAfter };
  console.log(JSON.stringify({ tag, cold: r.cold, warm: r.warm.map((w) => w.ttfaMs), coldFromCache: r.coldFromCache, load: r.env.loadavg }));
  save(`ttfa-${tag}`, r);
};

exps.drift = async () => {
  // a 2-minute-plus passage: consecutive sentences of one book, by the Node engine's audio length
  const book = opt("book", "gp");
  const texts = [];
  let secs = 0;
  corpus.forEach((s, i) => {
    if (s.book === book && secs < 125) texts.push(s.text), (secs += ref.sents[i].samples / 24000);
  });
  const ctx = await launch();
  // AUDIO_PLAYBACK alone is closed ~20-30 s in under --mute-audio (see survive), so add WORKERS
  await ctx.sw.evaluate((r) => self.setReasons(r), opt("reasons", "AUDIO_PLAYBACK,WORKERS").split(","));
  await speakFromPage(ctx, [benchTexts[0]]); // load the model first; this is about the clock
  const { log, marks } = await speakFromPage(ctx, texts, "table", 360000);
  const mem = memory();
  await ctx.browser.close();
  const ticks = log.events.filter((e) => e.type === "tick");
  const sents = log.events.filter((e) => e.type === "sentence");
  // 1. the audio clock against the system clock, as the offscreen document sees it
  const t0 = ticks[0], tn = ticks[ticks.length - 1];
  const audioVsWallMs = (tn.perfWall - t0.perfWall) - (tn.contextTime - t0.contextTime) * 1000;
  // 2. offscreen -> content message latency
  const lat = log.events.filter((e) => e.sentAt).map((e) => e.tRecv - e.sentAt).sort((a, b) => a - b);
  // 3. the page's cursor: when each word was shown vs when the audio played it, the truth taken
  //    from the tick closest in time (its audio-clock -> wall mapping)
  const truth = (ctxT) => {
    let best = ticks[0];
    for (const t of ticks) if (Math.abs(t.contextTime - ctxT) < Math.abs(best.contextTime - ctxT)) best = t;
    return best.perfWall + (ctxT - best.contextTime) * 1000;
  };
  const err = log.highlights.map((h) => {
    const s = sents[h.s];
    // several spans can share a first word, so match the span by its planned time
    const sp = s.spans.reduce((b, x) => (Math.abs(s.wallStart + x.start * 1000 - h.planned) < Math.abs(s.wallStart + b.start * 1000 - h.planned) ? x : b));
    return { s: h.s, err: h.shown - truth(s.ctxStart + sp.start), late: h.shown - h.planned };
  });
  const q = (a, f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  const abs = err.map((e) => Math.abs(e.err)).sort((a, b) => a - b);
  const firstHalf = err.filter((e) => sents[e.s].ctxStart < 30).map((e) => e.err), lastHalf = err.filter((e) => sents[e.s].ctxStart > secs - 30).map((e) => e.err);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const summary = {
    passageS: +marks.audioS.toFixed(1), sentences: texts.length, gaps: marks.gaps, words: err.length,
    audioClockVsSystemClockMs: +audioVsWallMs.toFixed(2),
    msgLatencyMs: { p50: q(lat, 0.5).toFixed(2), p95: q(lat, 0.95).toFixed(2), max: lat[lat.length - 1].toFixed(2) },
    cursorErrMs: { p50: q(abs, 0.5).toFixed(1), p95: q(abs, 0.95).toFixed(1), max: abs[abs.length - 1].toFixed(1) },
    cursorMeanErrFirst30sMs: mean(firstHalf).toFixed(1), cursorMeanErrLast30sMs: mean(lastHalf).toFixed(1),
  };
  console.log(tag, JSON.stringify(summary));
  save(`drift-${tag}`, { exp: "drift", tag, env: env(), summary, marks, mem, log });
};

exps.survive = async () => {
  // does the offscreen document outlive a pause? reasons and pause style from argv
  const reasons = opt("reasons", "AUDIO_PLAYBACK").split(",");
  const pauseS = Number(opt("pause", 35));
  const suspend = flag("suspend");
  const ctx = await launch();
  await ctx.sw.evaluate((r) => self.setReasons(r), reasons);
  await speakFromPage(ctx, [benchTexts[0]]);
  const off = await offscreenPage(ctx.browser, ctx.extId);
  const born = await off.evaluate(() => window.P48.bornAt);
  if (suspend) await off.evaluate(() => window.P48.suspendAudio());
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < pauseS * 1000) {
    await sleep(5000);
    // ask the SW (this wakes it, which is what a real resume would do too)
    samples.push({ s: Math.round((Date.now() - t0) / 1000), alive: await ctx.sw.evaluate(() => self.offscreenAlive()).catch((e) => "sw:" + e.message) });
  }
  const aliveAtEnd = samples[samples.length - 1].alive;
  const closedAt = samples.find((x) => x.alive === false)?.s ?? null;
  // and resuming after the pause: how long until audio again?
  const resume = (await speakFromPage(ctx, [benchTexts[1]])).marks;
  const off2 = await offscreenPage(ctx.browser, ctx.extId);
  const sameDoc = (await off2.evaluate(() => window.P48.bornAt)) === born;
  const r = { exp: "survive", tag, reasons, pauseS, suspend, env: env(), aliveAtEnd, closedAt, sameDoc, resumeTtfaMs: Math.round(resume.ttfaMs), resumeReloaded: !!resume.init, samples };
  console.log(JSON.stringify({ reasons, pauseS, suspend, aliveAtEnd, closedAt, sameDoc, resumeTtfaMs: r.resumeTtfaMs }));
  save(`survive-${reasons.join("+")}-${pauseS}s${suspend ? "-suspend" : ""}`, r);
  await ctx.browser.close();
};

exps.phon = async () => {
  const ctx = await launch();
  const { off } = await openOffscreen(ctx, ["WORKERS"]);
  const texts = [...new Set(corpus.flatMap((s) => [s.text, ...(s.text.match(/\S+/gu) ?? [])]))];
  const { out, ms } = await off.evaluate((t) => window.P48.phonemizeAll(t), texts);
  const norm = (x) => x.split(/\s+/).filter(Boolean).join(" ");
  const summary = {};
  const ex = {};
  for (const [name, tab] of Object.entries(out)) {
    let s = 0, sNoStress = 0, w = 0, wn = 0, wNoSpace = 0;
    ex[name] = [];
    for (const c of corpus) {
      const want = norm(ref.phon[c.text]);
      if (tab[c.text] === want) s++;
      else if (ex[name].length < 12) ex[name].push({ text: c.text, espeak152: want, browser: tab[c.text] });
      if (tab[c.text].replace(/[ˈˌ]/g, "") === want.replace(/[ˈˌ]/g, "")) sNoStress++;
      for (const x of c.text.match(/\S+/gu) ?? []) {
        wn++;
        if (tab[x] === ref.phon[x]) w++;
        if (tab[x].replace(/ /g, "") === ref.phon[x].replace(/ /g, "")) wNoSpace++;
      }
    }
    summary[name] = { sentences: `${s}/${corpus.length} (${((100 * s) / corpus.length).toFixed(1)}%)`, sentencesIgnoringStress: `${sNoStress}/${corpus.length}`, words: `${w}/${wn} (${((100 * w) / wn).toFixed(1)}%)`, wordsIgnoringSpaces: `${wNoSpace}/${wn}` };
  }
  console.log(JSON.stringify({ summary, ms: Math.round(ms) }, null, 1));
  save("phon", { exp: "phon", env: env(), summary, ms, examples: ex });
  await ctx.browser.close();
};

try {
  await exps[exp]();
} finally {
  srv.close();
}
process.exit(0);
