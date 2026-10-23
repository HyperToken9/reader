/*
 * node node_synth.mjs [--bench] [--wasm]
 *   default: all corpus sentences -> out/node[ -wasm]/<id>.f32 + out/node_synth[-wasm].json
 *   --bench: cold start + 6 bench sentences x 4 reps -> out/node_bench.json
 *   --wasm:  use the npm `phonemizer` WASM espeak (+ python-phonemizer port) instead of FFI
 */
const T0 = performance.now();
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
const ort = (await import(process.env.ORT_MODULE || "onnxruntime-node")).default;
import { KokoroNode, synthesize, toWav } from "./kokoro_node.mjs";
import { ffiBackend, wasmBackend, makePhonemize } from "./phon.mjs";

ort.env.logLevel = "error";
const H = homedir() + "/.local/share/blitz-tts";
const SP = H + "/venv/lib/python3.10/site-packages/espeakng_loader";
const wasm = process.argv.includes("--wasm");
const bench = process.argv.includes("--bench");
const backend = wasm ? await wasmBackend() : await ffiBackend(SP + "/libespeak-ng.so", SP + "/espeak-ng-data");
const k = await KokoroNode.create({
  model: H + "/kokoro/kokoro-v1.0.fp16.onnx",
  voices: H + "/kokoro/voices-v1.0.bin",
  phonemize: makePhonemize(backend.raw),
  threads: Number(process.env.BLITZ_TTS_THREADS || 8),
});
const T_LOADED = performance.now();
const sents = JSON.parse(readFileSync(new URL("./corpus/sentences.json", import.meta.url)));
const OUT = new URL("./out/", import.meta.url).pathname;

async function one(text) {
  k.onnxMs = [];
  const t = performance.now();
  const r = await synthesize(k, text);
  const wav = toWav(r.audio).toString("base64");
  return { ...r, ms: performance.now() - t, onnx: k.onnxMs.reduce((a, b) => a + b, 0), windows: k.onnxMs.length, wavLen: wav.length };
}

if (bench) {
  const res = { import_and_load_s: T_LOADED / 1000 /* performance.now() counts from process start */, runs: [] };
  for (let rep = 0; rep < 4; rep++)
    for (const s of sents.slice(0, 6)) {
      const r = await one(s.text);
      res.runs.push({ rep, id: s.id, chars: s.text.length, s: r.ms / 1000, onnx_s: r.onnx / 1000, audio_s: r.audio.length / 24000 });
    }
  writeFileSync(OUT + (process.env.OUTNAME || "node") + "_bench.json", JSON.stringify(res, null, 1));
  console.log(res.import_and_load_s);
  process.exit(0);
}

const NAME = process.env.OUTNAME || (wasm ? "node-wasm" : "node");
const dir = OUT + NAME + "/";
mkdirSync(dir, { recursive: true });
const out = [];
for (const [i, s] of sents.entries()) {
  const r = await one(s.text);
  writeFileSync(dir + s.id + ".f32", Buffer.from(r.audio.buffer, r.audio.byteOffset, r.audio.byteLength));
  out.push({ id: s.id, n: r.audio.length, s: r.ms / 1000, onnx_s: r.onnx / 1000, windows: r.windows, timings: r.timings, words: r.words, spans: r.spans, phonemes: r.phonemes, wav_len: r.wavLen });
  if (i % 20 === 0) console.log(i, s.id, (r.ms / 1000).toFixed(2) + "s");
}
writeFileSync(OUT + NAME + "_synth.json", JSON.stringify(out));
console.log("done", out.length);
