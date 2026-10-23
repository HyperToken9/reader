/*
 * Node port of the speech path tts_server.py runs today:
 *   kokoro-onnx create_timed(continuous=True)  (sliding.py + pauses.py + tokenizer)
 *   + tts_server.phoneme_groups / align_groups_to_words (incl. a difflib port)
 * onnxruntime-node, CPU EP only. Float32 arithmetic numpy does in float32 is
 * emulated with Math.fround (crossfade, RMS gates) so choices match bit for bit.
 */
import { readFileSync } from "node:fs";
const ort = (await import(process.env.ORT_MODULE || "onnxruntime-node")).default;
import { VOCAB } from "./phon.mjs";

const SR = 24000;
const f32 = Math.fround;

/* ---------- voices-v1.0.bin: an uncompressed .npz of (510,1,256) float32 ---------- */
export function loadVoices(path) {
  const buf = readFileSync(path);
  const voices = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    let size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26), extraLen = buf.readUInt16LE(p + 28);
    const name = buf.toString("utf8", p + 30, p + 30 + nameLen);
    const extra = buf.subarray(p + 30 + nameLen, p + 30 + nameLen + extraLen);
    if (size === 0xffffffff) size = Number(extra.readBigUInt64LE(4 + 8)); // zip64: usize, csize
    if (method !== 0) throw new Error("compressed npz entry " + name);
    const data = buf.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + size);
    const hlen = data.readUInt16LE(8);
    const header = data.toString("latin1", 10, 10 + hlen);
    if (!header.includes("'<f4'")) throw new Error("not f4: " + header);
    const raw = data.subarray(10 + hlen);
    voices[name.replace(/\.npy$/, "")] = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
    p += 30 + nameLen + extraLen + size;
  }
  return voices; // each: 510 rows of 256
}

/* ---------- numpy-faithful helpers ---------- */
const roundHalfEven = (x) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};
// numpy's float32 pairwise summation (PW_BLOCKSIZE 128, 8-way unroll)
function pairwise(a, lo, n) {
  if (n < 8) {
    let s = -0;
    for (let i = 0; i < n; i++) s = f32(s + a[lo + i]);
    return s;
  }
  if (n <= 128) {
    const r = new Array(8);
    for (let k = 0; k < 8; k++) r[k] = a[lo + k];
    let i;
    for (i = 8; i < n - (n % 8); i += 8) for (let k = 0; k < 8; k++) r[k] = f32(r[k] + a[lo + i + k]);
    let res = f32(f32(f32(r[0] + r[1]) + f32(r[2] + r[3])) + f32(f32(r[4] + r[5]) + f32(r[6] + r[7])));
    for (; i < n; i++) res = f32(res + a[lo + i]);
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return f32(pairwise(a, lo, n2) + pairwise(a, lo + n2, n - n2));
}
const rmsF32 = (audio, lo, hi) => {
  const n = hi - lo;
  const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) sq[i] = f32(audio[lo + i] * audio[lo + i]);
  return f32(Math.sqrt(f32(pairwise(sq, 0, n) / n)));
};

/* ---------- sliding.py ---------- */
const KEEP = 300, CONTEXT = 60, LOOKAHEAD = 60, CROSSFADE = 0.025;
const STOP_SEARCH = 70, GAP_SEARCH = 12, QUIET_WINDOW = 0.02;

function tokenEdges(duration, samples) {
  const frames = [0];
  for (const d of duration) frames.push(frames[frames.length - 1] + d);
  const scale = samples / frames[frames.length - 1];
  return frames.map((f) => roundHalfEven(f * scale));
}

function quietest(audio, edges, offset, candidates) {
  const half = Math.trunc(QUIET_WINDOW * SR);
  let best = candidates[0], q = null;
  for (const token of candidates) {
    const at = edges[token - offset + 1];
    const lo = Math.max(0, at - half), hi = Math.min(audio.length, at + half);
    const energy = hi > lo ? rmsF32(audio, lo, hi) : 1.0;
    if (q === null || energy < q) (best = token), (q = energy);
  }
  return best;
}

function candidates(tokens, stops, spaces, target, floor, limit) {
  const within = (reach, wanted, shift) => {
    reach = Math.min(reach, Math.max(1, target - floor));
    const out = [];
    for (let i = target - reach; i < target + reach; i++) {
      // python: tokens[index] with negative index wraps; index>=len raises -- guard both
      const tok = i < 0 ? tokens[tokens.length + i] : tokens[i];
      if (floor < i + shift && i + shift < limit && wanted.has(tok)) out.push(i + shift);
    }
    return out;
  };
  const a = within(STOP_SEARCH, stops, 1);
  if (a.length) return a;
  const b = within(GAP_SEARCH, spaces, 0);
  return b.length ? b : [target];
}

function join(pieces, fade) {
  let total = pieces.reduce((n, p) => n + p.length, 0);
  const starts = [0];
  let audio = pieces[0];
  for (const piece of pieces.slice(1)) {
    const overlap = Math.min(fade, audio.length, piece.length);
    starts.push(audio.length - overlap);
    const next = new Float32Array(audio.length + piece.length - overlap);
    next.set(audio.subarray(0, audio.length - overlap));
    const base = audio.length - overlap;
    for (let i = 0; i < overlap; i++) {
      const r = f32(overlap === 1 ? 0 : i * (1 / (overlap - 1)));
      const ramp = i === overlap - 1 && overlap > 1 ? 1 : r;
      next[base + i] = f32(f32(audio[base + i] * f32(1 - ramp)) + f32(piece[i] * ramp));
    }
    next.set(piece.subarray(overlap), base + overlap);
    audio = next;
  }
  return [audio, starts];
}

async function synthesizeWindows(run, tokens, stops, spaces) {
  const pieces = [], spans = [];
  let start = 0;
  while (start < tokens.length) {
    let end = Math.min(start + KEEP, tokens.length);
    const first = Math.max(0, start - CONTEXT), last = Math.min(tokens.length, end + LOOKAHEAD);
    const [audio, duration] = await run(tokens.slice(first, last));
    const edges = tokenEdges(duration, audio.length);
    if (end < tokens.length)
      end = quietest(audio, edges, first, candidates(tokens, stops, spaces, end, start, last));
    if (end <= start) throw new Error(`window ${start}:${end} makes no progress`);
    const begin = edges[start - first + 1], finish = edges[end - first + 1];
    pieces.push(audio.slice(begin, finish));
    spans.push(edges.slice(start - first + 1, end - first + 2).map((e) => e - begin));
    start = end;
  }
  const [audio, starts] = join(pieces, Math.trunc(CROSSFADE * SR));
  const offsets = [];
  spans.forEach((span, k) => span.slice(0, -1).forEach((e) => offsets.push(e + starts[k])));
  offsets.push(audio.length);
  return [audio, offsets];
}

/* ---------- pauses.py ---------- */
const SENTENCE_MARKS = ".!?…", CLAUSE_MARKS = ",;:";
const QUIET_DB = -40, FRAME = 0.01, REACH = 0.15;

function insertPauses(audio, timings, sentence = 0.25, clause = 0.1) {
  if (!timings.length) return [audio, timings];
  const frame = Math.max(1, Math.trunc(FRAME * SR));
  const nf = Math.floor(audio.length / frame);
  const loud = new Float32Array(nf);
  for (let k = 0; k < nf; k++) loud[k] = rmsF32(audio, k * frame, (k + 1) * frame);
  let mx = -Infinity;
  for (const v of loud) mx = Math.max(mx, v);
  const thr = mx * 10 ** (QUIET_DB / 20);
  const quiet = Array.from(loud, (v) => v <= thr);
  const reach = Math.trunc(REACH / FRAME);
  const parts = [], moved = [];
  let cut = 0, shift = 0.0;
  for (const t of timings) {
    moved.push([t[0], t[1] + shift, t[2] + shift]);
    const target = SENTENCE_MARKS.includes(t[0]) ? sentence : CLAUSE_MARKS.includes(t[0]) ? clause : 0;
    if (!target) continue;
    const at = Math.floor(Math.trunc(t[2] * SR) / frame);
    // _run_around
    const order = [];
    for (let i = at - reach; i <= at + reach; i++) order.push(i);
    order.sort((x, y) => Math.abs(x - at) - Math.abs(y - at)); // stable, like python sorted
    const inside = order.find((i) => i >= 0 && i < quiet.length && quiet[i]);
    let start = at, length = 0;
    if (inside !== undefined) {
      let s = inside, e = inside;
      while (s > 0 && quiet[s - 1]) s--;
      while (e + 1 < quiet.length && quiet[e + 1]) e++;
      (start = s), (length = e - s + 1);
    }
    const missing = target - length * FRAME;
    if (!length || missing <= 0) continue;
    const middle = (start + Math.floor(length / 2)) * frame;
    parts.push(audio.subarray(cut, middle), new Float32Array(Math.trunc(missing * SR)));
    cut = middle;
    shift += missing;
  }
  if (!parts.length) return [audio, timings];
  parts.push(audio.subarray(cut));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return [out, moved];
}

/* ---------- the engine ---------- */
export class KokoroNode {
  static async create({ model, voices, phonemize, threads = 8 }) {
    const k = new KokoroNode();
    k.sess = await ort.InferenceSession.create(model, {
      executionProviders: ["cpu"],
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    });
    if (!k.sess.outputNames.includes("duration")) throw new Error("model has no `duration` output");
    k.voices = loadVoices(voices);
    k.phonemize = phonemize;
    k.stops = new Set([...".!?"].map((c) => VOCAB[c]));
    k.spaces = new Set([VOCAB[" "]]);
    k.onnxMs = [];
    return k;
  }

  async infer(tokens, style, speed) {
    const ids = new BigInt64Array(tokens.length + 2);
    tokens.forEach((t, i) => (ids[i + 1] = BigInt(t)));
    const t0 = performance.now();
    const out = await this.sess.run({
      input_ids: new ort.Tensor("int64", ids, [1, ids.length]),
      style: new ort.Tensor("float32", style, [1, 256]),
      speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
    });
    this.onnxMs.push(performance.now() - t0);
    return [out.waveform.data, Array.from(out.duration.data, Number)];
  }

  async createTimed(text, voice = "bf_emma", speed = 1.0) {
    let ph = await this.phonemize(text);
    ph = ph.split(/\s+/).filter(Boolean).join(" ");
    if (!ph) throw new Error(`Nothing to synthesize, ${JSON.stringify(text)} produced no phonemes`);
    const known = [...ph].filter((c) => c in VOCAB);
    const tokens = known.map((c) => VOCAB[c]);
    const v = this.voices[voice];
    const row = Math.min(tokens.length, 510) - 1;
    const style = v.subarray(row * 256, row * 256 + 256);
    const [audio0, edges] = await synthesizeWindows((w) => this.infer(w, style, speed), tokens, this.stops, this.spaces);
    const timings = [];
    for (let i = 0; i < known.length; i++)
      if (i + 1 < edges.length) timings.push([known[i], edges[i] / SR, edges[i + 1] / SR]);
    const [audio, moved] = insertPauses(audio0, timings);
    return { audio, sr: SR, timings: moved, phonemes: ph };
  }
}

/* ---------- tts_server.py: phoneme_groups / align_groups_to_words ---------- */
export function phonemeGroups(timings) {
  const groups = [];
  let cur = null;
  for (const [p, s, e] of timings) {
    if (p === " ") {
      if (cur) groups.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = [s, e, p];
    else (cur[1] = e), (cur[2] += p);
  }
  if (cur) groups.push(cur);
  return groups;
}

// difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks()
export function matchingBlocks(a, b) {
  const b2j = new Map();
  b.forEach((c, j) => (b2j.has(c) ? b2j.get(c).push(j) : b2j.set(c, [j])));
  const longest = (alo, ahi, blo, bhi) => {
    let bi = alo, bj = blo, bs = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const nj = new Map();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        nj.set(j, k);
        if (k > bs) (bi = i - k + 1), (bj = j - k + 1), (bs = k);
      }
      j2len = nj;
    }
    while (bi > alo && bj > blo && a[bi - 1] === b[bj - 1]) bi--, bj--, bs++;
    while (bi + bs < ahi && bj + bs < bhi && a[bi + bs] === b[bj + bs]) bs++;
    return [bi, bj, bs];
  };
  const queue = [[0, a.length, 0, b.length]], blocks = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const out = [];
  let [i1, j1, k1] = [0, 0, 0];
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
    else {
      if (k1) out.push([i1, j1, k1]);
      [i1, j1, k1] = [i2, j2, k2];
    }
  }
  if (k1) out.push([i1, j1, k1]);
  out.push([a.length, b.length, 0]);
  return out;
}

export async function alignGroupsToWords(words, groups, phonemize) {
  const expWord = [], exp = [];
  for (let wi = 0; wi < words.length; wi++) {
    const ph = [...(await phonemize(words[wi])).replace(/ /g, "")];
    exp.push(...ph);
    ph.forEach(() => expWord.push(wi));
  }
  const actGroup = [], act = [];
  groups.forEach((g, gi) => [...g[2]].forEach((c) => (act.push(c), actGroup.push(gi))));
  const gw = groups.map(() => new Set());
  for (const [a0, b0, size] of matchingBlocks(act, exp))
    for (let k = 0; k < size; k++)
      if (a0 + k < actGroup.length && b0 + k < expWord.length) gw[actGroup[a0 + k]].add(expWord[b0 + k]);
  return groups.map((g, gi) => {
    let ws = [...gw[gi]].sort((x, y) => x - y);
    if (!ws.length) ws = gi < words.length ? [gi] : [];
    return { start: g[0], end: g[1], words: ws };
  });
}

export const wordList = (text) => text.match(/\S+/gu) ?? [];

export function toWav(audio, sr = SR) {
  const pcm = Buffer.alloc(44 + audio.length * 2);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + audio.length * 2, 4); pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36); pcm.writeUInt32LE(audio.length * 2, 40);
  for (let i = 0; i < audio.length; i++)
    pcm.writeInt16LE(Math.trunc(f32(Math.max(-1, Math.min(1, audio[i])) * 32767)), 44 + i * 2);
  return pcm;
}

/** What POST /synthesize returns, minus the base64. */
export async function synthesize(k, text, voice = "bf_emma", speed = 1.0) {
  const { audio, sr, timings, phonemes } = await k.createTimed(text, voice, speed);
  if (!audio.length) throw new Error(`synthesis produced zero-length audio for ${JSON.stringify(text)}`);
  const groups = phonemeGroups(timings);
  const words = wordList(text);
  const spans = await alignGroupsToWords(words, groups, k.phonemize);
  return { sr, audio, words, spans, timings, phonemes };
}
