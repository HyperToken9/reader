// PROTOTYPE 47: drive a throwaway Chrome profile with the unpacked extension.
//
//   node bench/browser.mjs <mode> [--profile DIR]
//   modes: smoke | ttfa | passage | survival | idle | ids
//
// Chrome 137+ (branded) ignores --load-extension, so the extension goes in
// through CDP's Extensions.loadUnpacked (puppeteer's enableExtensions, which
// launches with --remote-debugging-pipe --enable-unsafe-extension-debugging).
// Headless (new) with --mute-audio, so nothing reaches the speakers; the
// AudioContext still renders and its clock still runs.
import { cpSync, existsSync, mkdirSync, appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(root, "extension");
const WANT_ID = "agdejbojbbncecmipiedhfefmpkmcmba";
const args = process.argv.slice(2);
const mode = args[0];
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const PROFILE = opt("--profile", "/home/homefree/.claude/jobs/ec2bb647/tmp/p47/chrome-profile");
const OUT = join(root, "out");
const NULL_AUDIO = process.env.P47_AUDIO === "null";
mkdirSync(OUT, { recursive: true });
const corpus = JSON.parse(readFileSync(join(root, "corpus/sentences.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = () => loadavg().map((x) => +x.toFixed(2));
const record = (o) => {
  const line = { at: new Date().toISOString(), mode, audio: NULL_AUDIO ? "alsa-null" : "muted", load1_5_15: load(), ...o };
  appendFileSync(join(OUT, "results.jsonl"), JSON.stringify(line) + "\n");
  console.log(JSON.stringify(line));
};

/* ---------- the test page: the corpus, one sentence per paragraph ---------- */
const page = `<!doctype html><meta charset=utf-8><title>p47 corpus</title>
<script>window.__words=[];window.__sentences=[];addEventListener("message",e=>{if(e.data?.p47==="word")__words.push(e.data);if(e.data?.p47==="sentence")__sentences.push(e.data)})</script>
${corpus.map((s) => `<p id="${s.id}">${s.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`).join("\n")}`;
const server = createServer((_q, r) => r.end(page)).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

let launches = 0;
/** A fresh throwaway profile each time, with the host installed into it by install.sh. */
function freshProfile() {
  const dir = `${PROFILE}-${process.pid}-${++launches}`;
  rmSync(dir, { recursive: true, force: true });
  execFileSync(join(root, "install.sh"), ["--user-data-dir", dir], { stdio: "ignore" });
  return dir;
}

async function launch(extPath = EXT, profile = freshProfile()) {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    userDataDir: profile,
    pipe: true,
    enableExtensions: [extPath],
    // P47_AUDIO=null: not muted (so Chrome sees the page as audible) but sent
    // to ALSA's null device with PulseAudio unreachable, so still silent.
    args: [...(NULL_AUDIO ? ["--alsa-output-device=null"] : ["--mute-audio"]), "--no-first-run", "--no-default-browser-check"],
    env: { ...process.env, BLITZ_TTS_THREADS: process.env.BLITZ_TTS_THREADS || "4", ...(NULL_AUDIO ? { PULSE_SERVER: "unix:/tmp/p47-no-pulse" } : {}) },
  });
  const swt = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 15000 });
  const id = new URL(swt.url()).host;
  const sw = await swt.worker();
  const tab = await browser.newPage();
  await tab.goto(URL_);
  await sleep(300); // content script at document_idle
  let tabId = null;
  for (let i = 0; i < 100 && !tabId; i++) (tabId = await sw.evaluate(() => p47.lastTab)), await sleep(50);
  return { browser, sw, tab, tabId, id };
}

/** Right-click a paragraph (a real contextmenu event), then run the menu item's handler. */
async function readFrom(env, pid) {
  const el = await env.tab.$(`#${pid}`);
  await el.scrollIntoView();
  const box = await el.boundingBox();
  await env.tab.mouse.click(box.x + 5, box.y + box.height / 2, { button: "right" });
  for (let i = 0; ; i++)
    try {
      return await env.sw.evaluate((tabId) => p47.readFromHere(tabId), env.tabId);
    } catch (e) {
      if (i >= 5 || !/Receiving end/.test(e.message)) throw e;
      console.error("retrying readFromHere:", e.message);
      await sleep(500);
    }
}

async function waitFor(env, fn, timeout = 60000, arg) {
  const t = Date.now();
  for (;;) {
    const v = await env.sw.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() - t > timeout) throw new Error(`timed out waiting for ${fn}`);
    await sleep(50);
  }
}

const sessionSummary = (env) =>
  env.sw.evaluate(() => {
    const s = p47.session;
    if (!s) return null;
    const r0 = s.perSentence[0] ?? {};
    return {
      sid: s.sid, ttfaMs: s.ttfaMs, hostWasUp: s.hostWasUp, offscreenWasUp: s.offscreenWasUp,
      text: s.sentences[0],
      clickToOffscreenMs: s.offscreenReadyEpoch - s.clickEpoch,
      clickToHostStartMs: r0.startEpoch - s.clickEpoch, clickToFirstChunkMs: r0.firstChunkEpoch - s.clickEpoch, synthMs: r0.synthMs, waitMs: r0.waitMs,
      audioS: r0.samples / 24000,
      hostReadyAfterConnectMs: p47.hostInfo?.readyAfterConnectMs, hostLoadMs: p47.hostInfo?.loadMs,
    };
  });

const procStat = (pid) => {
  const st = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return { cpuTicks: Number(st[11]) + Number(st[12]), rssKB: Number(/VmRSS:\s+(\d+)/.exec(status)[1]) };
};

/* ---------- modes ---------- */

if (mode === "smoke") {
  const env = await launch();
  console.log("extension id", env.id);
  await readFrom(env, "bench0");
  await waitFor(env, () => p47.session?.ttfaMs);
  console.log(await sessionSummary(env));
  const d = await env.sw.evaluate(() => chrome.runtime.sendMessage({ to: "offscreen", type: "dump" }));
  const ce = await env.sw.evaluate(() => p47.session.clickEpoch);
  console.log("first chunk", d.received[0].at - ce, JSON.stringify(d.received.slice(0, 3)), JSON.stringify(d.sentences[0]?.startCtx));
  await sleep(4000);
  console.log(await env.sw.evaluate(() => p47.offscreen()));
  console.log("words in page", await env.tab.evaluate(() => __words.map((w) => `${w.text}@${(w.tRecv - w.tAudio).toFixed(1)}`).join(" ")));
  console.log("sw log", (await env.sw.evaluate(() => p47.log)).map((l) => l[1]).join("\n"));
  await env.browser.close();
}

if (mode === "ttfa") {
  // Cold: a fresh browser, no host process, no offscreen document. Then warm,
  // in the same browser: host loaded and offscreen document up.
  const reps = Number(opt("--reps", 3));
  for (let c = 0; c < reps; c++) {
    const env = await launch();
    await readFrom(env, "bench0");
    await waitFor(env, () => p47.session?.ttfaMs);
    record({ kind: "cold", ...(await sessionSummary(env)) });
    await sleep(3000);
    if (c === reps - 1)
      for (let rep = 0; rep < reps; rep++)
        for (const s of corpus.slice(0, 6)) {
          await env.sw.evaluate(() => p47.stop());
          await sleep(1000);
          await readFrom(env, s.id);
          await waitFor(env, () => p47.session?.ttfaMs);
          record({ kind: "warm", rep, id: s.id, ...(await sessionSummary(env)) });
          await sleep(1500);
        }
    await env.browser.close();
    await sleep(1000);
  }
}

if (mode === "passage") {
  // ~2 minutes of continuous reading from the top of the corpus page.
  const env = await launch();
  const secs = Number(opt("--secs", 125));
  await readFrom(env, corpus[0].id);
  await waitFor(env, () => p47.session?.ttfaMs);
  const t = Date.now();
  let offscreenGoneAtS = null, dump = null;
  while (Date.now() - t < secs * 1000) {
    await sleep(2000);
    const alive = (await env.sw.evaluate(() => p47.offscreen())).alive;
    if (!alive && offscreenGoneAtS === null) offscreenGoneAtS = (Date.now() - t) / 1000;
    if (!alive) break;
    if (Date.now() - t > (secs - 3) * 1000) dump = await env.sw.evaluate(() => chrome.runtime.sendMessage({ to: "offscreen", type: "dump" }));
  }
  const words = await env.tab.evaluate(() => __words);
  if (!dump) dump = { clockSamples: [], underruns: [], sentences: {}, note: "offscreen document was gone" };
  record({ kind: "passage-offscreen", offscreenGoneAtS, offscreenAgeAtGoneS: offscreenGoneAtS && offscreenGoneAtS + (await sessionSummary(env))?.ttfaMs / 1000, swLog: (await env.sw.evaluate(() => p47.log)).slice(-4) });
  const swSide = await env.sw.evaluate(() => p47.session.perSentence.map((r) => ({ synthMs: r.synthMs, samples: r.samples, waitMs: r.waitMs })));
  await env.sw.evaluate(() => p47.stop());
  writeFileSync(join(OUT, "passage.json"), JSON.stringify({ words, dump, swSide, corpusIds: corpus.map((s) => s.id) }));
  // drift: content receive time minus the audio clock's heard time, per word
  const lag = words.map((w) => ({ t: (w.tAudio - words[0].tAudio) / 1000, lag: w.tRecv - w.tAudio, fireLate: w.tFire - w.tAudio }));
  const fit = (pts) => {
    const n = pts.length, mx = pts.reduce((a, p) => a + p.t, 0) / n, my = pts.reduce((a, p) => a + p.lag, 0) / n;
    const b = pts.reduce((a, p) => a + (p.t - mx) * (p.lag - my), 0) / pts.reduce((a, p) => a + (p.t - mx) ** 2, 0);
    return b; // ms of lag per second of audio
  };
  const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))];
  const first = lag.filter((p) => p.t < 10).map((p) => p.lag), last = lag.filter((p) => p.t > lag.at(-1).t - 10).map((p) => p.lag);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const cs = dump.clockSamples;
  const ctxRate = cs.length > 2 ? (cs.at(-1).ctxTime - cs[0].ctxTime) / ((cs.at(-1).wall - cs[0].wall) / 1000) : null;
  const synth = swSide.filter((r) => r.synthMs);
  const sens = Object.values(dump.sentences).filter((x) => x.sha);
  const transportExact = sens.filter((x) => x.sha === x.hostSha).length;
  record({
    kind: "passage", secondsListened: (Date.now() - t) / 1000, words: words.length, sentencesPlayed: Object.values(dump.sentences).filter((s) => s.startCtx !== null).length,
    audioSpanS: lag.at(-1).t,
    lagMs: { median: pct(lag.map((p) => p.lag), 0.5), p95: pct(lag.map((p) => p.lag), 0.95), max: Math.max(...lag.map((p) => p.lag)) },
    fireLateMs: { median: pct(lag.map((p) => p.fireLate), 0.5), p95: pct(lag.map((p) => p.fireLate), 0.95) },
    driftMsPerMin: +(fit(lag) * 60).toFixed(3), lagFirst10sMean: +mean(first).toFixed(2), lagLast10sMean: +mean(last).toFixed(2),
    pcmArrivedBitExact: `${transportExact}/${sens.length}`,
    audioClockVsWall: ctxRate && +((ctxRate - 1) * 1e6).toFixed(1) + " ppm", underruns: dump.underruns,
    hostRTFduringPlayback: +(synth.reduce((a, r) => a + r.synthMs, 0) / 1000 / (synth.reduce((a, r) => a + r.samples, 0) / 24000)).toFixed(3),
  });
  await env.browser.close();
}

if (mode === "survival") {
  // Pause mid-sentence (AudioContext.suspend, as a reader's pause would), wait, check, resume.
  const env = await launch();
  for (const pauseS of (opt("--pauses", "30,300")).split(",").map(Number)) {
    await readFrom(env, "bench2");
    await waitFor(env, () => p47.session?.ttfaMs);
    await sleep(1500);
    const before = await env.sw.evaluate(async () => ({ off: await p47.offscreen(), sw: p47.swInstance, host: (await p47.hostStats())?.pid }));
    await env.sw.evaluate(() => p47.pause());
    const wordsBefore = await env.tab.evaluate(() => __words.length);
    await sleep(pauseS * 1000);
    let after;
    try {
      after = await env.sw.evaluate(async () => ({ off: await p47.offscreen(), sw: p47.swInstance, host: (await p47.hostStats())?.pid, log: p47.log.slice(-5) }));
    } catch (e) {
      after = { error: e.message };
    }
    const wordsAtResume = await env.tab.evaluate(() => __words.length);
    await env.sw.evaluate(() => p47.resume()).catch(() => {});
    await sleep(3000);
    const wordsAfter = await env.tab.evaluate(() => __words.length);
    record({
      kind: "survival", pauseS, offscreenAliveAfter: after.off?.alive, sameOffscreen: after.off?.instance === before.off.instance,
      ctxStateAfterPause: after.off?.ctx?.state, sameServiceWorker: after.sw === before.sw, sameHost: after.host === before.host,
      wordsFiredWhilePaused: wordsAtResume - wordsBefore, wordsFiredIn3sAfterResume: wordsAfter - wordsAtResume,
      before: { instance: before.off.instance, ageS: before.off.ageS }, after,
    });
    await env.sw.evaluate(() => p47.stop());
    await sleep(2000);
  }
  // And with no session at all: offscreen document left idle, AudioContext closed.
  const t = Date.now();
  const idleOff = [];
  for (const at of [35, 65]) {
    await sleep(at * 1000 - (Date.now() - t));
    idleOff.push({ afterS: at, ...(await env.sw.evaluate(() => p47.offscreen())) });
  }
  record({ kind: "survival-idle-no-audio", idleOff: idleOff.map((o) => ({ afterS: o.afterS, alive: o.alive, instance: o.instance, ctx: o.ctx })) });
  await env.browser.close();
}

if (mode === "idle") {
  // Host RAM and idle CPU, as Chrome launched it, loaded and quiet.
  const env = await launch();
  await readFrom(env, "bench2");
  await waitFor(env, () => p47.session?.ttfaMs, 60000);
  await sleep(8000);
  await env.sw.evaluate(() => p47.stop());
  const st = await env.sw.evaluate(() => p47.hostStats());
  await sleep(5000);
  const a = procStat(st.pid);
  const t = Date.now();
  await sleep(Number(opt("--secs", 60)) * 1000);
  const b = procStat(st.pid);
  record({ kind: "host-idle", pid: st.pid, threads: st.threads, rssMB: +(b.rssKB / 1024).toFixed(0), idleCpuPct: +(((b.cpuTicks - a.cpuTicks) / 100 / ((Date.now() - t) / 1000)) * 100).toFixed(2), cpuTicks: b.cpuTicks - a.cpuTicks, overS: (Date.now() - t) / 1000 });
  await env.browser.close();
}

if (mode === "ids") {
  const ids = {};
  const same = freshProfile();
  let env = await launch(EXT, same);
  ids.firstLoad = env.id;
  // chrome.runtime.reload(): the "reload" button on chrome://extensions.
  await env.sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  const t2 = await env.browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 15000 });
  ids.afterRuntimeReload = new URL(t2.url()).host;
  // The host still connects after the reload?
  const sw2 = await t2.worker();
  await sw2.evaluate(() => new Promise((r) => { const p = chrome.runtime.connectNative("dev.blitz.speech"); p.onMessage.addListener((m) => m.type === "ready" && (p.disconnect(), r(true))); p.onDisconnect.addListener(() => r(chrome.runtime.lastError?.message)); })).then((v) => (ids.hostConnectsAfterReload = v));
  await env.browser.close();
  env = await launch(EXT, same);
  ids.afterBrowserRestart = env.id;
  await env.browser.close();
  // Same extension at another path, fresh profile.
  const tmp = "/home/homefree/.claude/jobs/ec2bb647/tmp/p47/moved";
  rmSync(tmp, { recursive: true, force: true });
  cpSync(EXT, join(tmp, "elsewhere/extension"), { recursive: true });
  env = await launch(join(tmp, "elsewhere/extension"), join(tmp, "profile-a"));
  ids.movedPathFreshProfile = env.id;
  await env.browser.close();
  // Contrast: no "key", two paths.
  for (const name of ["nokey-a", "nokey-b"]) {
    const d = join(tmp, name, "extension");
    cpSync(EXT, d, { recursive: true });
    const m = JSON.parse(readFileSync(join(d, "manifest.json"), "utf8"));
    delete m.key;
    writeFileSync(join(d, "manifest.json"), JSON.stringify(m));
    env = await launch(d, join(tmp, `profile-${name}`));
    ids[`noKey_${name}`] = env.id;
    await env.browser.close();
  }
  record({ kind: "ids", want: WANT_ID, ...ids });
}

server.close();
