// Throwaway: onnxruntime-web WASM backend (in Node) on Kokoro, numThreads from argv.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const NATIVE = process.env.NATIVE;
const ortm = await import(NATIVE ? "/home/homefree/.claude/jobs/ec2bb647/tmp/proto17/node_modules/onnxruntime-node/dist/index.js" : "/tmp/claude-r44/bench/node_modules/onnxruntime-web/dist/ort.node.min.mjs");
const ort = ortm.default ?? ortm;
const P = "/home/homefree/.claude/jobs/ec2bb647/tmp/proto17";
const { ffiBackend, makePhonemize, VOCAB } = await import(P + "/phon.mjs");
const { loadVoices } = await import(P + "/kokoro_node.mjs");
const [model, threads] = [process.argv[2], Number(process.argv[3] || 4)];
if (!NATIVE) ort.env.wasm.numThreads = threads;
ort.env.logLevel = "error";
const H = homedir() + "/.local/share/blitz-tts";
const SP = H + "/venv/lib/python3.10/site-packages/espeakng_loader";
const be = await ffiBackend(SP + "/libespeak-ng.so", SP + "/espeak-ng-data");
const phon = makePhonemize(be.raw);
const voice = loadVoices(H + "/kokoro/voices-v1.0.bin").bf_emma;
let t = performance.now();
const sess = await ort.InferenceSession.create(model, NATIVE ? { executionProviders: ["cpu"], intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: "all", logSeverityLevel: 3 } : { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
const loadMs = performance.now() - t;
console.log("model", model.split("/").slice(-2).join("/"), "threads", threads, "load ms", loadMs.toFixed(0), "outputs", sess.outputNames, "inputs", sess.inputNames);
const sents = JSON.parse(readFileSync(P + "/corpus/sentences.json")).filter((s) => s.book === "bench").slice(0, 6);
let tot = 0, aud = 0, first = null;
for (let rep = 0; rep < 2; rep++) for (const s of sents) {
  const ph = (await phon(s.text)).split(/\s+/).filter(Boolean).join(" ");
  const toks = [...ph].filter((c) => c in VOCAB).map((c) => VOCAB[c]);
  const ids = BigInt64Array.from([0, ...toks, 0].map(BigInt));
  const row = toks.length - 1;
  const feeds = { [sess.inputNames[0]]: new ort.Tensor("int64", ids, [1, ids.length]), style: new ort.Tensor("float32", voice.slice(row * 256, row * 256 + 256), [1, 256]), speed: new ort.Tensor("float32", new Float32Array([1]), [1]) };
  t = performance.now();
  const o = await sess.run(feeds);
  const ms = performance.now() - t;
  const wav = o[sess.outputNames.find((n) => n !== "duration" && n !== "durations")];
  const dn = sess.outputNames.find((n) => n.startsWith("duration"));
  const secs = wav.data.length / 24000;
  if (first === null) { first = ms; console.log(`  durations output '${dn}' ${o[dn]?.type} len ${o[dn]?.data.length} for ${ids.length} ids; first values ${Array.from(o[dn].data.slice(0, 6), Number)}`); }
  console.log(`  rep${rep} ${ms.toFixed(0)} ms / ${secs.toFixed(2)} s audio  RTF ${(ms / 1000 / secs).toFixed(3)}  (${s.text.length} chars)`);
  if (rep === 1) { tot += ms; aud += secs; }
}
console.log(`  first-run ms ${first.toFixed(0)}  warm TOTAL RTF ${(tot / 1000 / aud).toFixed(3)}`);
process.exit(0);
