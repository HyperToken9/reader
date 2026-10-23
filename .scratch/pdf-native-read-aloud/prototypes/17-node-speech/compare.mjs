/* node compare.mjs <ref> <other>   e.g. py node | py py2 | py node-wasm
   reads out/<name>_synth.json + out/<name>/<id>.f32 -> spans/timings/audio agreement */
import { readFileSync } from "node:fs";
const O = new URL("./out/", import.meta.url).pathname;
const [refName = "py", which = "node"] = process.argv.slice(2);
const dir = which + "/";
const py = JSON.parse(readFileSync(O + refName + "_synth.json"));
const nd = new Map(JSON.parse(readFileSync(O + which + "_synth.json")).map((r) => [r.id, r]));
const f32 = (p) => { const b = readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };

let n = 0, spansSame = 0, spanWordsSame = 0, timingsCountSame = 0, lenSame = 0, audioBitSame = 0;
let maxT = 0, maxSpanT = 0, worstSnr = Infinity, maxAbs = 0, groupsTotal = 0, groupsWordsDiff = 0;
const snrs = [], bad = [];
for (const p of py) {
  const q = nd.get(p.id);
  if (!q) continue;
  n++;
  const sw = JSON.stringify(p.spans.map((s) => s.words)) === JSON.stringify(q.spans.map((s) => s.words));
  if (sw) spanWordsSame++;
  else bad.push(p.id);
  groupsTotal += p.spans.length;
  for (let i = 0; i < Math.max(p.spans.length, q.spans.length); i++)
    if (JSON.stringify(p.spans[i]?.words) !== JSON.stringify(q.spans[i]?.words)) groupsWordsDiff++;
  if (JSON.stringify(p.spans) === JSON.stringify(q.spans)) spansSame++;
  if (p.spans.length === q.spans.length)
    p.spans.forEach((s, i) => (maxSpanT = Math.max(maxSpanT, Math.abs(s.start - q.spans[i].start), Math.abs(s.end - q.spans[i].end))));
  if (p.timings.length === q.timings.length) {
    timingsCountSame++;
    p.timings.forEach((t, i) => (maxT = Math.max(maxT, Math.abs(t[1] - q.timings[i][1]), Math.abs(t[2] - q.timings[i][2]))));
  }
  const a = f32(O + refName + "/" + p.id + ".f32"), b = f32(O + dir + p.id + ".f32");
  if (a.length === b.length) lenSame++;
  const m = Math.min(a.length, b.length);
  let sig = 0, err = 0, same = a.length === b.length;
  for (let i = 0; i < m; i++) {
    const d = a[i] - b[i];
    sig += a[i] * a[i]; err += d * d;
    if (d !== 0) same = false;
    maxAbs = Math.max(maxAbs, Math.abs(d));
  }
  if (same) audioBitSame++;
  const snr = err ? 10 * Math.log10(sig / err) : Infinity;
  if (a.length === b.length && JSON.stringify(p.timings) === JSON.stringify(q.timings)) { snrs.push(snr); worstSnr = Math.min(worstSnr, snr); }
}
snrs.sort((x, y) => x - y);
console.log(JSON.stringify({
  ref: refName, which, sentences: n,
  spanWordIndicesIdentical: `${spanWordsSame}/${n}`, groupsWithDifferentWords: `${groupsWordsDiff}/${groupsTotal}`,
  spansIdenticalInclTimes: `${spansSame}/${n}`, maxSpanTimeDiff_s: maxSpanT,
  timingsCountSame: `${timingsCountSame}/${n}`, maxPhonemeTimeDiff_s: maxT,
  audioLengthSame: `${lenSame}/${n}`, audioBitIdentical: `${audioBitSame}/${n}`,
  maxAbsSampleDiff: maxAbs, snrOnlyOverSentencesWithIdenticalTimings: snrs.length, snr_dB_min: worstSnr, snr_dB_median: snrs[Math.floor(snrs.length / 2)],
  sentencesWithDifferentSpanWords: bad.slice(0, 20),
}, null, 1));
