// A/B a single long window (bench5 tokens) across ORT builds / session options: median of 5 warm runs.
import { readFileSync } from "node:fs";
import { loadVoices } from "./kokoro_node.mjs";
const mod = process.argv[2] || "onnxruntime-node";
const ort = (await import(mod)).default; ort.env.logLevel = "error";
const H = process.env.HOME + "/.local/share/blitz-tts/kokoro/";
const toks = JSON.parse(readFileSync("out/toks.json"));
const v = loadVoices(H + "voices-v1.0.bin").bf_emma, row = toks.length - 1;
const ids = BigInt64Array.from([0, ...toks, 0].map(BigInt));
const feeds = { input_ids: new ort.Tensor("int64", ids, [1, ids.length]), style: new ort.Tensor("float32", v.slice(row * 256, row * 256 + 256), [1, 256]), speed: new ort.Tensor("float32", new Float32Array([1]), [1]) };
for (const lvl of ["all", "extended", "basic"]) {
  const s = await ort.InferenceSession.create(H + "kokoro-v1.0.fp16.onnx", { executionProviders: ["cpu"], intraOpNumThreads: 8, interOpNumThreads: 1, graphOptimizationLevel: lvl });
  await s.run(feeds);
  const t = [];
  for (let i = 0; i < 5; i++) { const t0 = performance.now(); await s.run(feeds); t.push(performance.now() - t0); }
  t.sort((a, b) => a - b);
  console.log(ort.env.versions?.common ?? mod, lvl, "median ms", t[2].toFixed(0));
}
