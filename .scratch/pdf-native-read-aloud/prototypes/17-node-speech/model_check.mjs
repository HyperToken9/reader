// Question D: do public exports carry per-phoneme durations, and do they match our export's?
import ort from "onnxruntime-node";
import { readFileSync } from "node:fs";
import { loadVoices } from "./kokoro_node.mjs";
ort.env.logLevel = "error";
const H = process.env.HOME + "/.local/share/blitz-tts/kokoro/";
const toks = JSON.parse(readFileSync("out/toks.json"));
const v = loadVoices(H + "voices-v1.0.bin").bf_emma, row = toks.length - 1;
const ids = BigInt64Array.from([0, ...toks, 0].map(BigInt));
const feeds = { input_ids: new ort.Tensor("int64", ids, [1, ids.length]), style: new ort.Tensor("float32", v.slice(row * 256, row * 256 + 256), [1, 256]), speed: new ort.Tensor("float32", new Float32Array([1]), [1]) };
const models = { ours: H + "kokoro-v1.0.fp16.onnx", "kokoro-onnx release model-files-v1.1 fp16": "dl/gh11/kokoro-v1.0.fp16.onnx", "kokoro-onnx release v1.1 int8": "dl/gh11/kokoro-v1.0.int8.onnx", "HF timestamped fp16": "dl/hf/ts/model_fp16.onnx", "HF timestamped q8f16": "dl/hf/ts/model_q8f16.onnx" };
let ref;
for (const [name, f] of Object.entries(models)) {
  const s = await ort.InferenceSession.create(f, { executionProviders: ["cpu"], intraOpNumThreads: 8 });
  const o = await s.run(feeds);
  const dname = s.outputNames.find((n) => n.startsWith("duration"));
  const d = Array.from(o[dname].data, Number);
  ref ??= d;
  const sum = d.reduce((a, b) => a + b, 0);
  const same = d.length === ref.length && d.every((x, i) => Math.round(x) === ref[i]);
  const diff = d.reduce((m, x, i) => Math.max(m, Math.abs(x - ref[i])), 0);
  console.log(`${name}: output '${dname}' ${o[dname].type} len ${d.length} (tokens+2=${toks.length + 2}) sum ${sum.toFixed(2)} samples ${o.waveform.data.length} (=${(o.waveform.data.length / 600).toFixed(2)} frames) | rounded==ours ${same} maxdiff ${diff.toFixed(3)} first ${d.slice(0, 6).map((x) => +x.toFixed(2))}`);
}
