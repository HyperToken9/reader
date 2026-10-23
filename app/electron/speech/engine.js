/*
 * Kokoro speech, in Node. A port of what the Python engine (tts_server.py,
 * on kokoro-onnx) did for every sentence:
 *
 *   kokoro-onnx create_timed(continuous=True)   sliding.py, pauses.py, tokenizer
 *   tts_server.phoneme_groups / align_groups_to_words, with a difflib port
 *
 * It was ported from prototype 17 and checked against the Python engine over a
 * 206-sentence corpus (scripts/speech-parity.mjs). Matching Python bit for bit
 * where the choices depend on it took three numpy details, and they are not
 * optional: round-half-to-even when scaling token edges, float32 pairwise
 * summation in the RMS gates, and float32 crossfade arithmetic. Math.fround
 * emulates numpy's float32 wherever numpy computes in float32.
 *
 * onnxruntime here is 1.23.2, under the `ort-speech` npm alias, not the 1.29
 * the layout model uses: 1.29 is ~20% slower on this graph and shifts phoneme
 * timings, and two onnxruntime versions cannot share a process -- which is one
 * reason this runs in its own utilityProcess (see worker.js).
 */
import { readFileSync } from "node:fs";
import ort from "ort-speech";
import { VOCAB } from "./phonemize.js";

const SR = 24000;
const f32 = Math.fround;

/* ---------- voices-v1.0.bin: an uncompressed .npz of (510, 1, 256) float32 ---------- */

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
    if (method !== 0) throw new Error(`compressed npz entry ${name}`);
    const data = buf.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + size);
    const hlen = data.readUInt16LE(8);
    const header = data.toString("latin1", 10, 10 + hlen);
    if (!header.includes("'<f4'")) throw new Error(`voice ${name} is not float32: ${header}`);
    const raw = data.subarray(10 + hlen);
    voices[name.replace(/\.npy$/, "")] = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
    p += 30 + nameLen + extraLen + size;
  }
  return voices; // each: 510 rows of 256
}

/* ---------- numpy-faithful arithmetic ---------- */

const roundHalfEven = (x) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

// numpy's float32 pairwise summation (PW_BLOCKSIZE 128, 8-way unrolled).
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

function rmsF32(audio, lo, hi) {
  const n = hi - lo;
  const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) sq[i] = f32(audio[lo + i] * audio[lo + i]);
  return f32(Math.sqrt(f32(pairwise(sq, 0, n) / n)));
}

/* ---------- sliding.py: long inputs in overlapping windows ---------- */

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
      // python's tokens[i] wraps a negative index; past the end it would raise
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
  const starts = [0];
  let audio = pieces[0];
  for (const piece of pieces.slice(1)) {
    const overlap = Math.min(fade, audio.length, piece.length);
    starts.push(audio.length - overlap);
    const next = new Float32Array(audio.length + piece.length - overlap);
    next.set(audio.subarray(0, audio.length - overlap));
    const base = audio.length - overlap;
    for (let i = 0; i < overlap; i++) {
      // np.linspace(0, 1, overlap, dtype=float32): exact 1 at the last step
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
    if (end < tokens.length) end = quietest(audio, edges, first, candidates(tokens, stops, spaces, end, start, last));
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

/* ---------- pauses.py: stretch the silence at punctuation ---------- */

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
    // _run_around: the nearest quiet frame, closest first (a stable sort, as python's)
    const order = [];
    for (let i = at - reach; i <= at + reach; i++) order.push(i);
    order.sort((x, y) => Math.abs(x - at) - Math.abs(y - at));
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

/* ---------- tts_server.py: phoneme groups and word alignment ---------- */

/*
 * Split the phoneme timeline into groups on the literal ' ' phoneme. Each
 * group keeps its own phoneme text, so alignWords can match it against
 * per-word phonemes by content rather than by counting.
 */
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

/*
 * Which word(s) each phoneme group spoke, by content, not by counting.
 * Counting drifts on real text: espeak cliticises function words ("on the" is
 * one group) and expands numbers ("55" is "fifty five", two groups). So every
 * word is phonemized alone, and the concatenation of those is diffed against
 * the concatenation of the groups' real phonemes; the matching blocks say
 * which word contributed characters to which group. Errors, when stress marks
 * shift at a word boundary, only ever land on a neighbouring word.
 */
export function alignWords(words, groups, phonemize) {
  const expWord = [], exp = [];
  words.forEach((w, wi) => {
    for (const c of phonemize(w).replace(/ /g, "")) exp.push(c), expWord.push(wi);
  });
  const actGroup = [], act = [];
  groups.forEach((g, gi) => {
    for (const c of g[2]) act.push(c), actGroup.push(gi);
  });
  const groupWords = groups.map(() => new Set());
  for (const [a0, b0, size] of matchingBlocks(act, exp))
    for (let k = 0; k < size; k++)
      if (a0 + k < actGroup.length && b0 + k < expWord.length) groupWords[actGroup[a0 + k]].add(expWord[b0 + k]);
  return groups.map((g, gi) => {
    let ws = [...groupWords[gi]].sort((x, y) => x - y);
    if (!ws.length) ws = gi < words.length ? [gi] : [];
    return { start: g[0], end: g[1], words: ws };
  });
}

export const wordList = (text) => text.match(/\S+/gu) ?? [];

/** 16-bit mono PCM WAV, clipped and truncated the way numpy's astype("<i2") does. */
export function toWav(audio, sr = SR) {
  const wav = Buffer.alloc(44 + audio.length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + audio.length * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24);
  wav.writeUInt32LE(sr * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(audio.length * 2, 40);
  for (let i = 0; i < audio.length; i++)
    wav.writeInt16LE(Math.trunc(f32(Math.max(-1, Math.min(1, audio[i])) * 32767)), 44 + i * 2);
  return wav;
}

/* ---------- the engine ---------- */

export class Kokoro {
  /** {model, voices, phonemize, threads} -> a loaded engine. */
  static async create({ model, voices, phonemize, threads }) {
    const k = new Kokoro();
    k.sess = await ort.InferenceSession.create(model, {
      executionProviders: ["cpu"],
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
      logSeverityLevel: 3, // the graph's unfoldable Reciprocal nodes warn on every load
    });
    // Without a `duration` output there are no phoneme timings, so no word
    // spans, and the cursor never moves. Refuse such a model loudly.
    if (!k.sess.outputNames.includes("duration")) throw new Error(`${model} has no \`duration\` output`);
    k.voices = loadVoices(voices);
    k.phonemize = phonemize;
    k.stops = new Set([...".!?"].map((c) => VOCAB[c]));
    k.spaces = new Set([VOCAB[" "]]);
    return k;
  }

  voiceNames() {
    return Object.keys(this.voices).sort();
  }

  async infer(tokens, style, speed) {
    const ids = new BigInt64Array(tokens.length + 2); // 0-padded at both ends
    tokens.forEach((t, i) => (ids[i + 1] = BigInt(t)));
    const out = await this.sess.run({
      input_ids: new ort.Tensor("int64", ids, [1, ids.length]),
      style: new ort.Tensor("float32", style, [1, 256]),
      speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
    });
    return [out.waveform.data, Array.from(out.duration.data, Number)];
  }

  /** kokoro-onnx create_timed(continuous=True): audio plus per-phoneme [phoneme, start, end]. */
  async createTimed(text, voice, speed) {
    const ph = this.phonemize(text).split(/\s+/).filter(Boolean).join(" ");
    if (!ph) throw new Error(`Nothing to synthesize, ${JSON.stringify(text)} produced no phonemes`);
    const v = this.voices[voice];
    if (!v) throw new Error(`no voice ${voice}`);
    const known = [...ph].filter((c) => c in VOCAB);
    const tokens = known.map((c) => VOCAB[c]);
    const row = Math.min(tokens.length, 510) - 1;
    const style = v.subarray(row * 256, row * 256 + 256);
    const [raw, edges] = await synthesizeWindows((w) => this.infer(w, style, speed), tokens, this.stops, this.spaces);
    const timings = [];
    for (let i = 0; i < known.length; i++)
      if (i + 1 < edges.length) timings.push([known[i], edges[i] / SR, edges[i + 1] / SR]);
    const [audio, moved] = insertPauses(raw, timings);
    return { audio, timings: moved };
  }

  /**
   * One sentence, in the shape the reading loop consumes:
   * {sr, audio (Float32Array), words, spans: [{start, end, words: [index]}]}.
   */
  async synthesize(text, voice = "bf_emma", speed = 1.0) {
    const { audio, timings } = await this.createTimed(text, voice, speed);
    if (!audio.length) throw new Error(`synthesis produced zero-length audio for ${JSON.stringify(text)}`);
    let peak = 0;
    for (const s of audio) peak = Math.max(peak, Math.abs(s));
    // A user once heard nothing on a sentence whose cursor moved normally;
    // a near-silent clip is the one thing that would explain it.
    if (peak < 0.01) console.warn(`[speech] near-silent audio (peak=${peak.toFixed(5)}) for ${JSON.stringify(text)}`);
    const words = wordList(text);
    const spans = alignWords(words, phonemeGroups(timings), this.phonemize);
    return { sr: SR, audio, words, spans };
  }
}
