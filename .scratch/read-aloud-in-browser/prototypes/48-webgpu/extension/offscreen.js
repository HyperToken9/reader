// PROTOTYPE 48 (throwaway): the offscreen document. Runs Blitz's engine (engine.browser.js,
// a minimal patch of app/electron/speech/engine.js) on onnxruntime-web, WebGPU or WASM,
// with the model kept in Cache Storage. Plays audio and sends word timings to the tab.
// The harness (scripts/run.mjs) also calls window.P48.* directly through CDP.
import { Kokoro, ort, wordList } from "./engine.browser.js";
import { makePhonemize } from "./phonemize.browser.js";

const wall = () => performance.timeOrigin + performance.now();
const P48 = (window.P48 = { bornAt: wall(), engine: null, info: null, table: {}, log: [] });

/* ---------- model: download once into Cache Storage ---------- */
async function cached(url) {
  const c = await caches.open("p48-kokoro");
  let t = performance.now();
  let res = await c.match(url);
  const hit = !!res;
  let fetchMs = 0, putMs = 0;
  if (!res) {
    const net = await fetch(url);
    if (!net.ok) throw new Error(`${url}: HTTP ${net.status}`);
    const body = await net.arrayBuffer(); // the download itself
    fetchMs = performance.now() - t;
    t = performance.now();
    await c.put(url, new Response(body, { headers: { "content-type": "application/octet-stream" } }));
    putMs = performance.now() - t;
    return { bytes: body, hit, fetchMs, putMs, readMs: 0 };
  }
  const bytes = await res.arrayBuffer();
  return { bytes, hit, fetchMs, putMs, readMs: performance.now() - t };
}

P48.clearCache = () => caches.delete("p48-kokoro");

P48.init = async ({ ep = "webgpu", powerPreference = "high-performance", threads = 4, modelUrl, voicesUrl }) => {
  const t0 = performance.now();
  const info = { ep, powerPreference, crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, ortVersion: ort.env.versions?.web };
  ort.env.wasm.wasmPaths = chrome.runtime.getURL("ort/");
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = "error";
  let executionProviders = ["wasm"];
  if (ep === "webgpu") {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference });
    if (!adapter) throw new Error("no WebGPU adapter");
    info.adapter = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, shaderF16: adapter.features.has("shader-f16") };
    // onnxruntime-web 1.31's native WebGPU EP makes its own device from the default
    // adapter (here the NVIDIA one) unless it is handed a device, so make it ourselves.
    const L = adapter.limits;
    const device = await adapter.requestDevice({
      requiredFeatures: ["shader-f16", "timestamp-query", "subgroups"].filter((f) => adapter.features.has(f)),
      requiredLimits: { maxBufferSize: L.maxBufferSize, maxStorageBufferBindingSize: L.maxStorageBufferBindingSize, maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize, maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup, maxComputeWorkgroupSizeX: L.maxComputeWorkgroupSizeX },
    });
    executionProviders = [{ name: "webgpu", device }, "wasm"];
  }
  const m = await cached(modelUrl), v = await cached(voicesUrl);
  info.model = { hit: m.hit, fetchMs: m.fetchMs, putMs: m.putMs, readMs: m.readMs, mb: m.bytes.byteLength / 1e6 };
  info.voices = { hit: v.hit, fetchMs: v.fetchMs, putMs: v.putMs, readMs: v.readMs };
  const t1 = performance.now();
  P48.engine = await Kokoro.create({ model: new Uint8Array(m.bytes), voices: v.bytes, phonemize: (t) => lookup(t), executionProviders });
  info.sessionMs = performance.now() - t1;
  info.numThreadsEffective = ort.env.wasm.numThreads;
  info.initMs = performance.now() - t0;
  P48.info = info;
  return info;
};

/* ---------- phonemes: a lookup table, filled either from Node's espeak-ng (harness) or in-browser ---------- */
function lookup(t) {
  const p = P48.table[t];
  if (p === undefined) throw new Error("no phonemes for " + JSON.stringify(t));
  return p;
}
P48.setTable = (tab) => Object.assign(P48.table, tab);

let browserPhon = null;
async function browserPhonemizers() {
  if (browserPhon) return browserPhon;
  const { phonemize } = await import("./vendor/phonemizer.js");
  const { kokoroJsPhonemize } = await import("./vendor/kokorojs_phon.js");
  const { VOCAB } = await import("./phonemize.browser.js");
  const vocabOnly = (s) => [...s].filter((c) => c in VOCAB).join("").trim();
  // Blitz's own punctuation/post-processing port fed by the WASM espeak instead of FFI.
  // makePhonemize wants a sync raw(), so pre-compute every chunk the port will ask for.
  const memo = new Map();
  const portSync = makePhonemize((c) => memo.get(c));
  const port = async (text) => {
    for (let i = 0; i < 4; i++) {
      try { return portSync(text); } catch {}
      const missing = new Set();
      makePhonemize((c) => (memo.has(c) ? memo.get(c) : (missing.add(c), "")))(text);
      for (const c of missing) memo.set(c, (await phonemize(c, "en-us")).join(" "));
    }
    return portSync(text);
  };
  browserPhon = {
    "kokoro-js phonemize()": async (t) => vocabOnly(await kokoroJsPhonemize(t, "a")),
    "npm phonemizer + Blitz punctuation port": port,
  };
  return browserPhon;
}
// For parity: every sentence and word through each in-browser phonemizer.
P48.phonemizeAll = async (texts) => {
  const ph = await browserPhonemizers();
  const out = {};
  const t = performance.now();
  for (const [name, f] of Object.entries(ph)) {
    out[name] = {};
    for (const x of texts) out[name][x] = (await f(x)).split(/\s+/).filter(Boolean).join(" ");
  }
  return { out, ms: performance.now() - t };
};
P48.fillTableInBrowser = async (text, name = "kokoro-js phonemize()") => {
  const f = (await browserPhonemizers())[name];
  for (const x of [text, ...wordList(text)]) if (!(x in P48.table)) P48.table[x] = await f(x);
};

/* ---------- measurements the harness calls directly ---------- */
P48.bench = async (texts, reps = 3) => {
  const out = [];
  for (let r = 0; r < reps; r++) {
    let ms = 0, secs = 0;
    const each = [];
    for (const t of texts) {
      const a = performance.now();
      const res = await P48.engine.synthesize(t, "bf_emma", 1);
      const d = performance.now() - a;
      ms += d;
      secs += res.audio.length / 24000;
      each.push(Math.round(d));
    }
    out.push({ rtf: +(ms / 1000 / secs).toFixed(3), ms: Math.round(ms), audioS: +secs.toFixed(2), each });
  }
  return out;
};

P48.durations = async (corpus) => {
  const k = P48.engine;
  const infer = k.infer.bind(k);
  let runs;
  k.infer = async (...a) => {
    const r = await infer(...a);
    runs.push({ n: a[0].length, duration: r[1] });
    return r;
  };
  const sents = [];
  for (const s of corpus) {
    runs = [];
    const r = await k.synthesize(s.text, "bf_emma", 1);
    sents.push({ id: s.id, runs, spans: r.spans, samples: r.audio.length });
  }
  k.infer = infer;
  return sents;
};

P48.memory = async () => {
  const m = { jsHeapUsed: performance.memory?.usedJSHeapSize };
  if (self.crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
    try { m.uaSpecific = (await performance.measureUserAgentSpecificMemory()).bytes; } catch (e) { m.uaErr = String(e); }
  }
  return m;
};

/* ---------- speaking: the real path, driven by the content script ---------- */
let ctx = null;
const toTab = (tabId, m) => chrome.runtime.sendMessage({ to: "tab", tabId, ...m });
const ctxWall = (ctxT) => {
  const o = ctx.getOutputTimestamp();
  return performance.timeOrigin + o.performanceTime + (ctxT - o.contextTime) * 1000;
};

async function speak({ tabId, texts, init, phon = "table", table, offscreen, tSent }) {
  const tArrive = wall();
  if (table) P48.setTable(table);
  const marks = { tSent, tArrive, offscreen };
  if (!P48.engine) marks.init = await P48.init(init);
  marks.tReady = wall();
  ctx ??= new AudioContext({ sampleRate: 24000 });
  if (ctx.state !== "running") await ctx.resume();
  let next = 0, late = 0;
  const ticker = setInterval(() => {
    const o = ctx.getOutputTimestamp();
    toTab(tabId, { type: "tick", ctxTime: ctx.currentTime, contextTime: o.contextTime, perfWall: performance.timeOrigin + o.performanceTime, sentAt: wall() });
  }, 1000);
  for (let i = 0; i < texts.length; i++) {
    if (phon !== "table") await P48.fillTableInBrowser(texts[i]);
    const a = performance.now();
    const r = await P48.engine.synthesize(texts[i], "bf_emma", 1);
    const synthMs = performance.now() - a;
    const buf = ctx.createBuffer(1, r.audio.length, 24000);
    buf.copyToChannel(r.audio, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const start = Math.max(ctx.currentTime + 0.02, next);
    if (i > 0 && start > next + 0.001) late++; // synthesis did not keep up: a gap
    src.start(start);
    next = start + buf.duration;
    const wallStart = ctxWall(start);
    if (i === 0) Object.assign(marks, { firstSynthMs: synthMs, firstWallStart: wallStart, ttfaMs: wallStart - tSent });
    toTab(tabId, { type: "sentence", index: i, ctxStart: start, wallStart, sentAt: wall(), synthMs, spans: r.spans, dur: buf.duration });
    // don't run more than ~2 sentences ahead
    while (next - ctx.currentTime > 20) await new Promise((res) => setTimeout(res, 200));
  }
  await new Promise((res) => setTimeout(res, (next - ctx.currentTime) * 1000 + 300));
  clearInterval(ticker);
  marks.gaps = late;
  marks.audioS = next;
  P48.log.push(marks);
  toTab(tabId, { type: "done", marks });
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.to === "offscreen" && m.type === "speak") speak(m).catch((e) => toTab(m.tabId, { type: "error", error: String(e?.stack ?? e) }));
});
P48.suspendAudio = () => ctx?.suspend();
P48.ctxState = () => ctx?.state;
chrome.runtime.sendMessage({ to: "sw", type: "offscreen-ready" });
