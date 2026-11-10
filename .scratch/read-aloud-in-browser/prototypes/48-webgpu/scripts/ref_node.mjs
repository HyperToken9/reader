// PROTOTYPE 48 (throwaway): the reference. Blitz's Node engine (app/electron/speech on
// origin/dev, copied unmodified into ../ref/ by setup.sh) over prototype 17's corpus.
// Writes out/ref_node.json: espeak-ng 1.52 phonemes for every sentence and word (the
// browser is fed these to isolate the model), raw `duration` per ONNX run, word spans.
//   node scripts/ref_node.mjs [threads=4] [reps=3]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { Kokoro, wordList } from "../ref/engine.js";
import { espeakBackend, makePhonemize } from "../ref/phonemize.js";

const here = new URL("..", import.meta.url).pathname;
const threads = Number(process.argv[2] || 4), reps = Number(process.argv[3] || 3);
const SP = homedir() + "/.local/share/blitz-tts/venv/lib/python3.10/site-packages/espeakng_loader";
const MODEL = homedir() + "/.config/blitz/speech/kokoro-v1.0.fp16.onnx";
const VOICES = homedir() + "/.config/blitz/speech/voices-v1.0.bin";
const corpus = JSON.parse(readFileSync(here + "corpus/sentences.json", "utf8"));

const phonemize = makePhonemize(await espeakBackend(SP + "/libespeak-ng.so", SP + "/espeak-ng-data"));
let t = performance.now();
const k = await Kokoro.create({ model: MODEL, voices: VOICES, phonemize, threads });
const loadMs = performance.now() - t;
// Capture the raw `duration` of every ONNX run.
let runs = [];
const infer = k.infer.bind(k);
k.infer = async (...a) => {
  const r = await infer(...a);
  runs.push({ n: a[0].length, duration: r[1] });
  return r;
};

const phon = {};
const sents = [];
for (const s of corpus) {
  phon[s.text] = phonemize(s.text);
  for (const w of wordList(s.text)) phon[w] = phonemize(w);
  runs = [];
  const r = await k.synthesize(s.text, "bf_emma", 1);
  sents.push({ id: s.id, runs, spans: r.spans, samples: r.audio.length });
}
// Warm RTF on the 6 bench sentences, the same set research 44 used.
const bench = corpus.filter((s) => s.book === "bench");
const rtf = [];
for (let rep = 0; rep < reps; rep++) {
  let ms = 0, secs = 0;
  for (const s of bench) {
    t = performance.now();
    const r = await k.synthesize(s.text, "bf_emma", 1);
    ms += performance.now() - t;
    secs += r.audio.length / 24000;
  }
  rtf.push(+(ms / 1000 / secs).toFixed(3));
}
mkdirSync(here + "out", { recursive: true });
writeFileSync(here + "out/ref_node.json", JSON.stringify({ threads, loadMs, rtf, loadavg: loadavg(), phon, sents }));
console.log(JSON.stringify({ engine: "node ort 1.23.2 cpu", threads, loadMs: Math.round(loadMs), warmRtf: rtf, loadavg: loadavg().map((x) => x.toFixed(2)) }));
