/*
 * PROTOTYPE 47 service worker. Owns the native messaging port (which keeps
 * this worker alive, Chrome 105+), relays the host's audio to the offscreen
 * document, and relays the offscreen document's word events to the tab.
 *
 * Everything the bench reads hangs off self.p47 so it can be driven over CDP.
 */
const HOST = "dev.blitz.speech";
const AHEAD = 2; // sentences requested ahead of the one playing
const epoch = () => performance.timeOrigin + performance.now();
const swInstance = crypto.randomUUID();
const swStarted = Date.now();

let port = null;
let hostInfo = null; // the host's "ready" message
let hostStatsWaiters = [];
let session = null;
let sidSeq = 0;
const log = [];
const note = (...a) => {
  log.push([Date.now(), a.join(" ")]);
  console.log("[p47]", ...a);
};

/* ---------- the native host ---------- */

function ensurePort() {
  if (port) return port;
  const t = epoch();
  port = chrome.runtime.connectNative(HOST);
  note("connectNative", HOST);
  port.onMessage.addListener((m) => onHost(m, t));
  port.onDisconnect.addListener(() => {
    note("host disconnected:", chrome.runtime.lastError?.message ?? "(no error)");
    port = null;
    hostInfo = null;
  });
  return port;
}

function onHost(m, connectedAt) {
  if (m.type === "ready") {
    hostInfo = { ...m, readyAfterConnectMs: epoch() - connectedAt };
    note("host ready", JSON.stringify(hostInfo));
    return;
  }
  if (m.type === "stats") {
    hostStatsWaiters.splice(0).forEach((r) => r(m));
    return;
  }
  if (m.type === "error") note("host error", m.id, m.error);
  const s = session;
  if (!s || !m.id?.startsWith(s.sid + ":")) return; // a stopped session's leftovers
  const k = Number(m.id.split(":")[1]);
  const rec = s.perSentence[k];
  if (m.type === "start") Object.assign(rec, { startEpoch: epoch(), synthMs: m.synthMs, waitMs: m.waitMs, samples: m.samples, spans: m.spans, words: m.words });
  if (m.type === "chunk" && m.seq === 0) rec.firstChunkEpoch = epoch();
  if (m.type === "end") {
    rec.endEpoch = epoch();
    pump();
  }
  toOffscreen({ type: "host", sid: s.sid, k, msg: m });
}

/* ---------- the offscreen document ---------- */

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return false;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Plays the synthesized speech and keeps the word clock.",
  });
  // Wait until its listener is up.
  for (let i = 0; i < 100; i++) {
    try {
      if (await chrome.runtime.sendMessage({ to: "offscreen", type: "ping" })) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("offscreen document never answered");
}

const toOffscreen = (m) => chrome.runtime.sendMessage({ to: "offscreen", ...m }).catch((e) => note("offscreen send failed", e.message));

/* ---------- reading ---------- */

function pump() {
  const s = session;
  if (!s) return;
  while (s.requested < s.sentences.length && s.requested <= s.playing + AHEAD) {
    const k = s.requested++;
    s.perSentence[k] = { text: s.sentences[k], reqEpoch: epoch() };
    ensurePort().postMessage({ op: "speak", id: `${s.sid}:${k}`, text: s.sentences[k] });
  }
}

async function readFrom(tabId, sentences, clickEpoch) {
  await stop();
  const s = (session = {
    sid: `s${++sidSeq}`, tabId, sentences, clickEpoch, requested: 0, playing: -1, perSentence: [],
    hostWasUp: !!hostInfo, offscreenWasUp: await chrome.offscreen.hasDocument(),
  });
  note("read", s.sid, `${sentences.length} sentences from: ${JSON.stringify(sentences[0]).slice(0, 80)}`);
  ensurePort(); // start the host first: its model load is the long pole when cold
  await ensureOffscreen();
  s.offscreenReadyEpoch = epoch();
  await toOffscreen({ type: "session", sid: s.sid, clickEpoch, count: sentences.length });
  pump();
  return s.sid;
}

async function readFromHere(tabId, frameId = 0) {
  const clickEpoch = epoch();
  const sentences = await chrome.tabs.sendMessage(tabId, { type: "sentences-from-click" }, { frameId });
  if (!sentences?.length) return note("nothing to read at the click");
  return readFrom(tabId, sentences, clickEpoch);
}

async function stop() {
  const s = session;
  session = null;
  if (!s) return;
  if (port) port.postMessage({ op: "cancel", ids: s.sentences.map((_, k) => `${s.sid}:${k}`) });
  await toOffscreen({ type: "stop" });
}

/* ---------- messages from the offscreen document ---------- */

let lastTab = null; // the last tab whose content script said hello (bench only)

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.to !== "sw") return;
  if (m.type === "hello") lastTab = sender.tab?.id;
  const s = session;
  if (m.type === "first-sound" && s?.sid === m.sid) {
    s.firstSoundEpoch = m.soundEpoch;
    s.ttfaMs = m.soundEpoch - s.clickEpoch;
    note(`first sound ${s.sid}: ${s.ttfaMs.toFixed(0)} ms after the click (host was ${s.hostWasUp ? "up" : "down"}, offscreen was ${s.offscreenWasUp ? "up" : "down"})`);
  }
  if (m.type === "sentence-playing" && s?.sid === m.sid) {
    s.playing = m.k;
    pump();
  }
  if (m.type === "session-done" && s?.sid === m.sid) {
    s.doneEpoch = epoch();
    note("session done", s.sid);
  }
  if ((m.type === "word" || m.type === "sentence-playing") && s?.sid === m.sid)
    chrome.tabs.sendMessage(s.tabId, m).catch(() => {});
  reply(true);
});

/* ---------- the context menu ---------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "read-from-here", title: "Read from here", contexts: ["all"] });
  chrome.contextMenus.create({ id: "stop-reading", title: "Stop reading", contexts: ["all"] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "read-from-here") readFromHere(tab.id, info.frameId ?? 0);
  if (info.menuItemId === "stop-reading") stop();
});

/* ---------- bench hooks ---------- */

self.p47 = {
  readFromHere, readFrom, stop, ensureOffscreen,
  get session() { return session; },
  get hostInfo() { return hostInfo; },
  log, swInstance, swStarted,
  get lastTab() { return lastTab; },
  id: chrome.runtime.id,
  pause: () => toOffscreen({ type: "pause" }),
  resume: () => toOffscreen({ type: "resume" }),
  offscreen: async () => {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (!ctxs.length) return { alive: false };
    return { alive: true, ...(await chrome.runtime.sendMessage({ to: "offscreen", type: "status" })) };
  },
  hostStats: () => {
    if (!port) return Promise.resolve(null);
    const p = new Promise((r) => hostStatsWaiters.push(r));
    port.postMessage({ op: "stats" });
    return p;
  },
  disconnectHost: () => {
    port?.disconnect();
    port = null;
    hostInfo = null;
  },
  closeOffscreen: async () => {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  },
};
