/*
 * PROTOTYPE (ticket 47, throwaway): Blitz's Node speech engine as a Chrome
 * native messaging host.
 *
 * Chrome starts this (through blitz-speech-host.sh) when the extension calls
 * chrome.runtime.connectNative("dev.blitz.speech"), and kills it when the port
 * closes. stdin/stdout carry native-messaging frames: a 32-bit length in
 * native byte order, then that many bytes of UTF-8 JSON. Host -> Chrome is
 * capped at 1 MB per message, so audio goes as int16 PCM in base64 chunks.
 *
 * In:   {op: "speak", id, text, voice?, speed?}
 *       {op: "stats"}
 * Out:  {type: "ready", pid, loadMs, threads}
 *       {type: "start", id, sr, words, spans, samples, nchunks, synthMs, waitMs}
 *       {type: "chunk", id, seq, pcm}        base64 int16 LE mono
 *       {type: "end", id}
 *       {type: "stats", pid, rssKB, cpuMs: {user, system}, uptimeS, ready}
 *       {type: "error", id?, error}
 *
 * The engine is engine/engine.js + engine/phonemize.js, copied verbatim from
 * app/electron/speech on origin/dev (489272f). Same init as worker.js.
 */
import { createHash } from "node:crypto";
import { cpus, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kokoro } from "../engine/engine.js";
import { espeakBackend, makePhonemize } from "../engine/phonemize.js";

// stdout is the message channel: nothing else may write to it.
console.log = (...a) => console.error(...a);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEECH_DIR = process.env.BLITZ_SPEECH_DIR || join(homedir(), ".config/blitz/speech");
const ESPEAK = process.env.BLITZ_ESPEAK_DIR || join(root, "vendor/espeak-ng");
// Blitz's own default (electron/tts.js): half the cores, at most 8.
const THREADS = Number(process.env.BLITZ_TTS_THREADS) || Math.max(1, Math.min(8, Math.floor(cpus().length / 2)));
const CHUNK = 96000; // samples per chunk: 4 s, 192 KB int16, 256 KB base64
const f32 = Math.fround;

/*
 * Resolves once the frame has left this process. A 256 KB chunk is bigger
 * than the pipe's buffer, so without waiting the rest of it sits in Node's
 * queue while the next sentence's synthesis hogs the thread -- which held
 * sentence 1's audio back ~1.7 s behind its own "start" message.
 */
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return new Promise((r) => process.stdout.write(Buffer.concat([head, body]), r));
}

const t0 = performance.now();
const ready = (async () => {
  const phonemize = makePhonemize(await espeakBackend(join(ESPEAK, "libespeak-ng.so"), join(ESPEAK, "espeak-ng-data")));
  const engine = await Kokoro.create({
    model: join(SPEECH_DIR, "kokoro-v1.0.fp16.onnx"),
    voices: join(SPEECH_DIR, "voices-v1.0.bin"),
    phonemize,
    threads: THREADS,
  });
  send({ type: "ready", pid: process.pid, loadMs: Math.round(performance.now() - t0), threads: THREADS });
  return engine;
})();
ready.catch((e) => send({ type: "error", error: `engine failed to load: ${e.message}` }));

/** Float32 [-1, 1] -> int16 exactly as engine.toWav() does it. */
function toInt16(audio) {
  const out = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i++) out.writeInt16LE(Math.trunc(f32(Math.max(-1, Math.min(1, audio[i])) * 32767)), i * 2);
  return out;
}

let queue = Promise.resolve();
const cancelled = new Set();

const ops = {
  speak(m) {
    const asked = performance.now();
    queue = queue.then(async () => {
      if (cancelled.has(m.id)) return;
      try {
        const engine = await ready;
        const t = performance.now();
        const r = await engine.synthesize(m.text, m.voice || "bf_emma", Number(m.speed ?? 1));
        const synthMs = performance.now() - t;
        const pcm = toInt16(r.audio);
        const nchunks = Math.ceil(r.audio.length / CHUNK);
        await send({ type: "start", id: m.id, sr: r.sr, words: r.words, spans: r.spans, samples: r.audio.length, nchunks, synthMs: +synthMs.toFixed(1), waitMs: +(t - asked).toFixed(1) });
        for (let k = 0; k < nchunks; k++)
          await send({ type: "chunk", id: m.id, seq: k, pcm: pcm.subarray(k * CHUNK * 2, (k + 1) * CHUNK * 2).toString("base64") });
        // The fingerprint of what the engine made, so the far end can check what arrived.
        await send({ type: "end", id: m.id, sha: createHash("sha256").update(pcm).digest("hex") });
      } catch (e) {
        send({ type: "error", id: m.id, error: e?.message ?? String(e) });
      }
    });
  },
  cancel(m) {
    for (const id of m.ids ?? []) cancelled.add(id);
  },
  stats() {
    const u = process.resourceUsage();
    send({
      type: "stats", pid: process.pid, rssKB: Math.round(process.memoryUsage.rss() / 1024),
      cpuMs: { user: Math.round(u.userCPUTime / 1000), system: Math.round(u.systemCPUTime / 1000) },
      uptimeS: +process.uptime().toFixed(1), threads: THREADS,
    });
  },
};

// Frame reader.
let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    const msg = JSON.parse(buf.toString("utf8", 4, 4 + n));
    buf = buf.subarray(4 + n);
    (ops[msg.op] ?? ((m) => send({ type: "error", id: m.id, error: `unknown op ${m.op}` })))(msg);
  }
});
// Chrome closes our stdin when the port goes away: leave with it.
process.stdin.on("end", () => process.exit(0));
