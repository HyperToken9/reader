/*
 * PROTOTYPE 47 offscreen document (reason AUDIO_PLAYBACK). Turns the host's
 * int16 PCM chunks into AudioBuffers scheduled back to back on one
 * AudioContext, and keeps the word clock: each span fires when the audio
 * clock says its first sample is being heard. The events go to the service
 * worker, which relays them to the tab's content script.
 */
const instance = crypto.randomUUID();
const loadedAt = Date.now();
const SR = 24000;
const epoch = () => performance.timeOrigin + performance.now();

let ctx = null;
let s = null; // the current session
let clockSamples = [];
let ticks = 0;

function audio() {
  if (!ctx) ctx = new AudioContext({ sampleRate: SR, latencyHint: "playback" });
  return ctx;
}

/* When will the sample at context time t be heard, as a wall-clock epoch? */
function heardEpoch(t) {
  const ts = ctx.getOutputTimestamp();
  if (ts.performanceTime) return performance.timeOrigin + ts.performanceTime + (t - ts.contextTime) * 1000;
  // No output timestamp (yet): fall back to currentTime plus the reported latency.
  return epoch() + (t - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
}

/* The context time being heard right now. */
function heardNow() {
  const ts = ctx.getOutputTimestamp();
  if (ts.performanceTime) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
}

const toSW = (m) => chrome.runtime.sendMessage({ to: "sw", ...m }).catch(() => {});

function onHost(k, m) {
  if (!s) return;
  if (m.type === "start") {
    s.sentences[k] = { words: m.words, spans: m.spans, samples: m.samples, parts: [], startCtx: null };
    return;
  }
  if (m.type === "end") {
    // Fingerprint exactly what arrived, to compare with the engine run in-process.
    const sen = s.sentences[k];
    const all = new Uint8Array(sen.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of sen.parts) all.set(p, o), (o += p.length);
    sen.parts = [];
    crypto.subtle.digest("SHA-256", all).then((d) => (sen.sha = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")));
    return;
  }
  if (m.type !== "chunk") return;
  const sen = s.sentences[k];
  const bytes = Uint8Array.from(atob(m.pcm), (c) => c.charCodeAt(0));
  sen.parts.push(bytes);
  const pcm = new Int16Array(bytes.buffer);
  const buf = ctx.createBuffer(1, pcm.length, SR);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32767;
  s.received.push({ k, seq: m.seq, n: pcm.length, at: epoch(), ctxNow: ctx.currentTime, state: ctx.state, ts: ctx.getOutputTimestamp() });
  // In order only: sentence k waits for k-1 to be scheduled (the host sends in order anyway).
  if (sen.startCtx === null) {
    const margin = ctx.currentTime + 0.03;
    if (s.nextCtx < margin) {
      if (k > 0) s.underruns.push({ k, gapS: margin - s.nextCtx });
      s.nextCtx = margin;
    }
    sen.startCtx = s.nextCtx;
    s.events.push({ ctxT: sen.startCtx, kind: "sentence", k });
    sen.spans.forEach((sp, i) =>
      s.events.push({ ctxT: sen.startCtx + sp.start, kind: "word", k, i, text: sp.words.map((w) => sen.words[w]).join(" "), wordIdx: sp.words }),
    );
    s.events.sort((a, b) => a.ctxT - b.ctxT);
    if (k === 0) {
      s.soundEpoch = heardEpoch(sen.startCtx);
      toSW({ type: "first-sound", sid: s.sid, soundEpoch: s.soundEpoch });
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(s.nextCtx);
  s.nextCtx += pcm.length / SR;
  s.endCtx = s.nextCtx;
}

function tick() {
  ticks++;
  if (!ctx || !s || ctx.state !== "running") return;
  const now = heardNow();
  while (s.events.length && s.events[0].ctxT <= now) {
    const e = s.events.shift();
    const tAudio = heardEpoch(e.ctxT);
    const tFire = epoch();
    if (e.kind === "sentence") toSW({ type: "sentence-playing", sid: s.sid, k: e.k, tAudio, tFire });
    else {
      const ev = { type: "word", sid: s.sid, k: e.k, i: e.i, text: e.text, wordIdx: e.wordIdx, ctxT: e.ctxT, tAudio, tFire };
      s.fired.push(ev);
      toSW(ev);
    }
  }
  if (!s.done && s.endCtx && s.received.length && !s.events.length && now >= s.endCtx && Object.keys(s.sentences).length >= s.count) {
    s.done = true;
    toSW({ type: "session-done", sid: s.sid });
  }
}
setInterval(tick, 4);

// One sample a second of how the audio clock runs against the wall clock.
setInterval(() => {
  if (!ctx || ctx.state !== "running") return;
  const ts = ctx.getOutputTimestamp();
  clockSamples.push({ wall: epoch(), ctxTime: ctx.currentTime, outCtx: ts.contextTime, outPerf: performance.timeOrigin + ts.performanceTime });
  if (clockSamples.length > 1200) clockSamples.shift();
}, 1000);

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.to !== "offscreen") return;
  switch (m.type) {
    case "ping":
      reply(true);
      return;
    case "session":
      audio();
      ctx.resume();
      s = { sid: m.sid, count: m.count, clickEpoch: m.clickEpoch, sentences: {}, events: [], fired: [], received: [], underruns: [], nextCtx: 0, endCtx: 0 };
      clockSamples = [];
      break;
    case "host":
      if (s?.sid === m.sid) onHost(m.k, m.msg);
      break;
    case "stop":
      if (ctx) {
        ctx.close();
        ctx = null;
      }
      s = null;
      break;
    case "pause":
      ctx?.suspend();
      break;
    case "resume":
      ctx?.resume();
      break;
    case "status":
      reply({
        instance, loadedAt, ageS: (Date.now() - loadedAt) / 1000, ticks,
        crossOriginIsolated: self.crossOriginIsolated,
        ctx: ctx && { state: ctx.state, currentTime: ctx.currentTime, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency, outputTimestamp: ctx.getOutputTimestamp() },
        session: s && { sid: s.sid, soundEpoch: s.soundEpoch, fired: s.fired.length, pending: s.events.length, underruns: s.underruns, done: !!s.done },
      });
      return;
    case "dump":
      reply({ fired: s?.fired ?? [], received: s?.received ?? [], underruns: s?.underruns ?? [], clockSamples, sentences: s ? Object.fromEntries(Object.entries(s.sentences).map(([k, v]) => [k, { startCtx: v.startCtx, samples: v.samples, sha: v.sha, spans: v.spans, words: v.words }])) : {} });
      return;
  }
  reply(true);
});
