/* node bench_summary.mjs py node node-ort123 node2 -> RTF / per-sentence latency table */
import { readFileSync } from "node:fs";
for (const name of process.argv.slice(2)) {
  const b = JSON.parse(readFileSync(new URL(`./out/${name}_bench.json`, import.meta.url)));
  const warm = b.runs.filter((r) => r.rep > 0);
  const rtf = warm.reduce((a, r) => a + r.s, 0) / warm.reduce((a, r) => a + r.audio_s, 0);
  const onnxShare = warm.reduce((a, r) => a + r.onnx_s, 0) / warm.reduce((a, r) => a + r.s, 0);
  const per = {};
  for (const r of warm) (per[r.id] ??= []).push(r.s);
  const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const first = b.runs.find((r) => r.rep === 0);
  console.log(
    `${name.padEnd(12)} load ${b.import_and_load_s.toFixed(2)}s | first synth after load ${first.s.toFixed(2)}s (${first.chars} chars) ` +
      `| warm RTF ${rtf.toFixed(3)} | onnx share ${(100 * onnxShare).toFixed(1)}% | warm median s per sentence: ` +
      Object.entries(per).map(([id, xs]) => `${id}(${b.runs.find((r) => r.id === id).chars}c)=${med(xs).toFixed(2)}`).join(" "),
  );
}
