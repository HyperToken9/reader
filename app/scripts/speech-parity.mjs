#!/usr/bin/env node
/*
 * Does the Node speech engine still say what the Python one did?
 *
 *   node scripts/speech-parity.mjs [speech-dir]          parity over the corpus
 *   node scripts/speech-parity.mjs [speech-dir] --bench  warm real-time factor
 *
 * speech-dir holds the two downloaded files (electron/speech/model.js);
 * it defaults to $BLITZ_SPEECH_DIR, then the dev app's ~/.config/blitz/speech.
 *
 * Parity runs every sentence of speech-parity/sentences.json (206 sentences
 * from five sample books, heavy on numbers, abbreviations, hyphens, quotes,
 * symbols and code) through the engine exactly as the app does and compares
 * the word spans with speech-parity/python-reference.json, which the old
 * Python engine produced (see python_reference.py for how). It compares
 * spans, never audio bytes: the model graph has random ops, so audio is not
 * bit-identical even Python against Python.
 *
 *   words per group   every phoneme group lights the same word(s)       must be all
 *   spans incl times  ...and starts and ends at the same instant        noise floor
 *
 * The noise floor is Python against itself (python-reference-2.json, a second
 * run): spans-with-times can legitimately differ on a few sentences, and the
 * Node engine has to do no worse than that.
 *
 * --bench synthesises the first six sentences four times and reports the warm
 * real-time factor (synthesis time / audio time; lower is faster), skipping
 * the first pass.
 */
import { readFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ort from "ort-speech";
import { Kokoro } from "../electron/speech/engine.js";
import { espeakBackend, makePhonemize } from "../electron/speech/phonemize.js";
import { FILES } from "../electron/speech/model.js";

const app = fileURLToPath(new URL("..", import.meta.url));
const here = join(app, "scripts/speech-parity");
const args = process.argv.slice(2);
const bench = args.includes("--bench");
const dir = args.find((a) => !a.startsWith("--")) || process.env.BLITZ_SPEECH_DIR || join(homedir(), ".config/blitz/speech");
const threads = Number(process.env.BLITZ_TTS_THREADS) || Math.max(1, Math.min(8, Math.floor(cpus().length / 2)));
const read = (name) => JSON.parse(readFileSync(join(here, name), "utf8"));

ort.env.logLevel = "error";
const espeak = join(app, "vendor/espeak-ng");
const phonemize = makePhonemize(await espeakBackend(join(espeak, "libespeak-ng.so"), join(espeak, "espeak-ng-data")));
const engine = await Kokoro.create({
  model: join(dir, FILES[0].name),
  voices: join(dir, FILES[1].name),
  phonemize,
  threads,
});
const sentences = read("sentences.json");

if (bench) {
  let synth = 0, audio = 0;
  for (let rep = 0; rep < 4; rep++)
    for (const s of sentences.slice(0, 6)) {
      const t = performance.now();
      const r = await engine.synthesize(s.text);
      if (rep === 0) continue; // the first pass warms the session
      synth += (performance.now() - t) / 1000;
      audio += r.audio.length / r.sr;
    }
  console.log(JSON.stringify({ threads, warmRTF: +(synth / audio).toFixed(3), audio_s: +audio.toFixed(1) }));
  process.exit(0);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** How `other` agrees with `ref`, sentence by sentence. */
function compare(ref, other) {
  const byId = new Map(other.map((r) => [r.id, r]));
  let words = 0, spans = 0, phonemes = 0;
  const differ = [];
  for (const r of ref) {
    const o = byId.get(r.id);
    if (!o) continue;
    if (o.phonemes === undefined || o.phonemes === r.phonemes) phonemes++;
    if (same(r.spans.map((s) => s.words), o.spans.map((s) => s.words))) words++;
    else differ.push(r.id);
    if (same(r.spans, o.spans)) spans++;
  }
  return { n: ref.length, phonemes, words, spans, differ };
}

const t0 = performance.now();
const node = [];
for (const s of sentences) {
  const r = await engine.synthesize(s.text);
  node.push({ id: s.id, phonemes: phonemize(s.text), words: r.words, spans: r.spans });
}
const elapsed = (performance.now() - t0) / 1000;

const python = read("python-reference.json");
const fmt = (c) =>
  `phonemes ${c.phonemes}/${c.n}  words per group ${c.words}/${c.n}  spans incl times ${c.spans}/${c.n}`;
const floor = compare(python, read("python-reference-2.json"));
const result = compare(python, node);
console.log(`Python vs Python (noise floor)  ${fmt(floor)}`);
console.log(`Node   vs Python                ${fmt(result)}`);
if (result.differ.length) console.log(`word groups differ on: ${result.differ.join(", ")}`);
console.log(`(${sentences.length} sentences in ${elapsed.toFixed(0)} s, ${threads} threads)`);

// The bar from #37: every word group identical, and spans with times no
// worse than Python's agreement with itself.
const ok = result.words === result.n && result.phonemes === result.n && result.spans >= floor.spans;
process.exit(ok ? 0 : 1);
