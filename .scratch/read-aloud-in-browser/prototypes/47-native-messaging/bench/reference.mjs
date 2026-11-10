// PROTOTYPE 47: the engine in-process (no host), as the reference for "exact".
//   node bench/reference.mjs out/reference.json [first N sentences]
// Writes {id: {sha, samples, words, spans}} where sha is sha256 of the int16 PCM.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kokoro } from "../engine/engine.js";
import { espeakBackend, makePhonemize } from "../engine/phonemize.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [outPath, limit] = [process.argv[2] || join(root, "out/reference.json"), Number(process.argv[3]) || Infinity];
const SPEECH = process.env.BLITZ_SPEECH_DIR || join(homedir(), ".config/blitz/speech");
const THREADS = Number(process.env.BLITZ_TTS_THREADS) || Math.max(1, Math.min(8, Math.floor(cpus().length / 2)));
const E = process.env.BLITZ_ESPEAK_DIR || join(root, "vendor/espeak-ng");
const engine = await Kokoro.create({
  model: join(SPEECH, "kokoro-v1.0.fp16.onnx"),
  voices: join(SPEECH, "voices-v1.0.bin"),
  phonemize: makePhonemize(await espeakBackend(join(E, "libespeak-ng.so"), join(E, "espeak-ng-data"))),
  threads: THREADS,
});
const f32 = Math.fround;
export const pcmSha = (audio) => {
  const b = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i++) b.writeInt16LE(Math.trunc(f32(Math.max(-1, Math.min(1, audio[i])) * 32767)), i * 2);
  return createHash("sha256").update(b).digest("hex");
};
const sentences = JSON.parse(readFileSync(join(root, "corpus/sentences.json"), "utf8")).slice(0, limit);
const out = {};
for (const s of sentences) {
  const r = await engine.synthesize(s.text);
  out[s.id] = { sha: pcmSha(r.audio), samples: r.audio.length, words: r.words, spans: r.spans };
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out));
console.log(`${sentences.length} sentences, ${THREADS} threads -> ${outPath}`);
