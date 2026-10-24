/*
 * Kokoro speech, as seen by the renderer.
 *
 * The renderer calls synthesize()/voices() over IPC and does not know how
 * speech is produced. Behind this module the engine is a Node port of Kokoro
 * (electron/speech/) running in its own Electron utilityProcess -- see
 * speech/worker.js for why it is a separate process.
 *
 * Nothing about speech happens at launch. The weights (~190 MB) are fetched
 * the first time the reader presses play: the renderer calls prepare(), which
 * downloads into <userData>/speech/ with progress events, verifies, and then
 * starts the engine. Someone who never presses play never downloads anything.
 */
import { app, utilityProcess } from "electron";
import { cpus } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as model from "./speech/model.js";

const here = dirname(fileURLToPath(import.meta.url));
// koffi and espeak need real files, not paths inside the asar archive; the
// build unpacks vendor/espeak-ng (see build.asarUnpack in package.json).
const unpacked = (p) => p.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
const ESPEAK = unpacked(join(here, "../vendor/espeak-ng"));
const WORKER = join(here, "speech/worker.js");
const modelDir = () => process.env.BLITZ_SPEECH_DIR || join(app.getPath("userData"), "speech");

/*
 * Half the cores, never more than eight. Speech is synthesized while speech is
 * playing, so pinning every core starves the audio thread (heard as crackle),
 * and on a 16-core machine 16 threads ran at 0.36x real time where 8 ran at
 * 0.27x: oversubscribing cost throughput as well.
 */
const THREADS = Number(process.env.BLITZ_TTS_THREADS) || Math.max(1, Math.min(8, Math.floor(cpus().length / 2)));

/*
 * The voices are fixed by the pinned voices-v1.0.bin (speech/model.js), so
 * the list is known before it is downloaded -- the voice picker fills in at
 * launch without anything being fetched.
 */
const VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova",
  "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
  "am_michael", "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "ef_dora", "em_alex", "em_santa", "ff_siwis",
  "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola", "jf_alpha", "jf_gongitsune",
  "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa", "zf_xiaobei", "zf_xiaoni",
  "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
];

let child = null;
let ready = null; // Promise for a running, initialised engine
let lastError = null;
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject}

function call(op, args = {}) {
  return new Promise((resolve, reject) => {
    if (!child) return reject(new Error("speech engine is not running"));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.postMessage({ id, op, ...args });
  });
}

function spawnEngine() {
  const proc = utilityProcess.fork(WORKER, [], { serviceName: "Blitz speech", stdio: "pipe" });
  proc.stdout.on("data", (d) => process.stdout.write(`[speech] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[speech] ${d}`));
  proc.on("message", ({ id, ok, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(new Error(error));
  });
  proc.on("exit", (code) => {
    if (child !== proc) return; // an engine we already replaced
    const err = new Error(`speech engine exited (${code})`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    child = null;
    ready = null;
    if (code) lastError = err.message;
  });
  child = proc;
}

/**
 * Get speech ready to play: download the weights if they are not here yet
 * (onProgress gets {phase, received, total}), then start the engine. Safe to
 * call on every press of play -- after the first it resolves at once. A
 * failure leaves nothing half-started, so calling it again is the retry.
 */
export function prepare(onProgress) {
  if (ready) return ready;
  ready = (async () => {
    const dir = modelDir();
    await model.ensure(dir, onProgress);
    onProgress?.({ phase: "load" });
    spawnEngine();
    try {
      await call("init", {
        model: join(dir, model.FILES[0].name),
        voices: join(dir, model.FILES[1].name),
        espeakLib: join(ESPEAK, "libespeak-ng.so"),
        espeakData: join(ESPEAK, "espeak-ng-data"),
        threads: THREADS,
      });
    } catch (e) {
      // A model onnxruntime cannot load is as good as corrupt: re-hash it
      // next time rather than trusting the marker again.
      await model.distrust(dir);
      throw e;
    }
    lastError = null;
  })();
  const attempt = ready;
  attempt.catch((e) => {
    lastError = e.message;
    if (ready === attempt) stop();
  });
  return attempt;
}

export function stop() {
  const proc = child;
  child = null;
  ready = null;
  for (const p of pending.values()) p.reject(new Error("speech engine stopped"));
  pending.clear();
  proc?.kill();
}

/** -> {ok, installed, error?}: whether speech works, and whether play will download first. */
export async function status() {
  const installed = await model.installed(modelDir());
  return { ok: !lastError, installed, error: lastError ?? undefined, downloadBytes: model.TOTAL_BYTES };
}

export const voices = async () => ({ voices: VOICES });

/** {text, voice, speed} -> {sr, audio_b64 (wav pcm16), words, spans} */
export async function synthesize({ text, voice, speed }) {
  // Only prepare() downloads. If the engine stopped (it crashed, say) with
  // the weights already here, starting it again is quick and silent.
  if (!ready && !(await model.installed(modelDir()))) {
    throw new Error("speech is not downloaded yet; press play to fetch it");
  }
  await prepare();
  return call("synthesize", { text, voice, speed });
}
