/*
 * TICKET 16 — rebuild the reading loop on Kokoro, with a word cursor.
 * THROWAWAY PROTOTYPE, not production code.
 *
 * [[05]]'s geometry, spotlight and page-rendering all survive unchanged. What
 * changes: speechSynthesis.speak() becomes a fetch to the Kokoro sidecar
 * (server.py) for a WAV plus word-level timing spans, played through a plain
 * <audio> element. Sentence advance is still an *event* — 'ended' plays the
 * same role u.onend did — so [[10]]'s one-sentence-per-unit invariant holds
 * and there is still no cadence model, no drift correction, no watchdog:
 * <audio>'s 'ended' event doesn't wedge the way speechSynthesis did on Linux,
 * so [[05]]'s wedged-queue guard is simply gone, not replaced.
 *
 * Word position is a lookup, not a model (11): requestAnimationFrame reads
 * audio.currentTime and binary-searches a span table the server computed
 * before the first sample played, aligning Kokoro's phoneme groups to
 * orthographic words by content (see server.py's align_groups_to_words),
 * not by count — counting drifts the moment a sentence has either a number
 * (one word, several groups) or a cliticised function word (several words,
 * one group), and textbooks have both in the same sentence.
 *
 * The word cursor lives only inside variant C (spotlight), because the
 * design question this ticket answers is what a moving cursor looks like
 * inside an already-punched hole. Switchable styles: dim / underline / tint
 * / off — cycle with the second floating bar, or the "c" key.
 */

import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const SVG_NS = "http://www.w3.org/2000/svg";
const SERVER = "http://127.0.0.1:5177"; // server.py, run separately (see README)

const $ = (id) => document.getElementById(id);
const el = {
  pick: $("pick"), file: $("file"), docinfo: $("docinfo"),
  voice: $("voice"), rate: $("rate"), rateOut: $("rateOut"),
  nativeSpeed: $("nativeSpeed"),
  zoom: $("zoom"), zoomOut: $("zoomOut"),
  play: $("play"), stop: $("stop"),
  autoscroll: $("autoscroll"), showall: $("showall"),
  state: $("state"), spoken: $("spoken"),
  sentences: $("sentences"), segcount: $("segcount"),
  pages: $("pages"), viewer: $("viewer"), drop: $("drop"),
  prevVariant: $("prevVariant"), nextVariant: $("nextVariant"), variantLabel: $("variantLabel"),
  prevCursor: $("prevCursor"), nextCursor: $("nextCursorBtn"), cursorLabel: $("cursorLabel"),
};

// ---------------------------------------------------------------- state

let doc = null;
/** @type {Map<number, PageEntry>} */
const pages = new Map();
let scale = 1.2;

let playing = false;
let generation = 0;   // bumped on every cancel; stale audio events are ignored
let cursor = null;    // {pn, si} — sentence to play after the current one
let speaking = null;  // {pn, si} — sentence currently sounding
const timings = [];   // wall-clock synth+play time per sentence, to judge lag

const audioEl = new Audio();
audioEl.preload = "auto";
try { audioEl.preservesPitch = true; } catch { /* older browsers: ignore */ }
let currentBlobUrl = null;
let currentSpans = [];     // this sentence's [{start,end,words:[idx,...]}], time-ordered
let activeWordIdxs = [];   // word indices lit right now
let rafId = null;
const prefetchCache = new Map(); // "pn:si" -> Promise<{sr,audio_b64,words,spans}>

const VARIANTS = [
  { key: "A", name: "Tint" },
  { key: "B", name: "Underline" },
  { key: "C", name: "Spotlight" },
];
let variant = VARIANTS[0];

const CURSOR_STYLES = [
  { key: "dim", name: "Nested dim" },
  { key: "underline", name: "Underline" },
  { key: "tint", name: "Tint" },
  { key: "off", name: "Off" },
];
let cursorStyle = CURSOR_STYLES[0];

// ---------------------------------------------------------------- utils

const clamp01 = (n) => Math.max(0, Math.min(1, n));

function status(text) {
  el.state.textContent = text;
}

function report() {
  const avg = timings.length
    ? (timings.reduce((a, b) => a + b, 0) / timings.length / 1000).toFixed(2)
    : "–";
  const rendered = [...pages.values()].filter((p) => p.rendered).length;
  status(
    [
      `${playing ? "speaking" : "idle"}  gen ${generation}`,
      speaking ? `at  p${speaking.pn} s${speaking.si}  word ${activeWordIdxs.join(",") || "—"}` : "at  —",
      `pages rendered ${rendered}/${doc ? doc.numPages : 0}   zoom ${scale.toFixed(2)}`,
      `sentences spoken ${timings.length}  mean ${avg}s   prefetched ${prefetchCache.size}`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------- rendering

class PageEntry {
  constructor(pn, div) {
    this.pn = pn;
    this.div = div;
    this.canvas = div.querySelector("canvas");
    this.textLayerDiv = div.querySelector(".textLayer");
    this.svg = div.querySelector(".overlay");
    this.textLayer = null;
    this.proxy = null;
    this.sentences = [];
    this.rendered = false;
    this.rendering = null;
  }
}

async function openDoc(data) {
  if (doc) await doc.destroy();
  stop();
  pages.clear();
  el.pages.replaceChildren();
  el.sentences.replaceChildren();

  doc = await pdfjsLib.getDocument({ data }).promise;
  el.drop.classList.add("hide");
  el.docinfo.textContent = `${doc.numPages} pages`;

  // Shell every page up front at the right aspect ratio, so the scrollbar is
  // honest; rasterise lazily as they come into view.
  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });

  for (let pn = 1; pn <= doc.numPages; pn++) {
    const div = document.createElement("div");
    div.className = "pdfpage";
    div.dataset.page = String(pn);
    div.innerHTML = `<canvas></canvas><div class="textLayer"></div>` +
      `<svg class="overlay" viewBox="0 0 1 1" preserveAspectRatio="none"></svg>`;
    sizePage(div, base.width * scale, base.height * scale);
    el.pages.append(div);
    pages.set(pn, new PageEntry(pn, div));
    observer.observe(div);
  }

  await renderPage(1);
  report();
}

function sizePage(div, w, h) {
  div.style.width = `${Math.floor(w)}px`;
  div.style.height = `${Math.floor(h)}px`;
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) renderPage(Number(e.target.dataset.page));
    }
  },
  { root: null, rootMargin: "400px 0px" },
);

async function renderPage(pn) {
  const p = pages.get(pn);
  if (!p || p.rendered) return p;
  if (p.rendering) return p.rendering.then(() => p);

  p.rendering = (async () => {
    p.proxy = await doc.getPage(pn);
    const viewport = p.proxy.getViewport({ scale });
    sizePage(p.div, viewport.width, viewport.height);
    // The text layer reads --total-scale-factor; everything else about its
    // positioning is percentage-based, so this is all it needs (02 §3).
    p.div.style.setProperty("--total-scale-factor", String(scale));

    const dpr = window.devicePixelRatio || 1;
    p.canvas.width = Math.floor(viewport.width * dpr);
    p.canvas.height = Math.floor(viewport.height * dpr);
    const ctx = p.canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    await p.proxy.render({ canvasContext: ctx, viewport }).promise;

    // Fonts are only registered as @font-face once the render task has loaded
    // them, so the text layer must come after render() (02 §5).
    const textContent = await p.proxy.getTextContent();
    p.textContent = textContent;
    p.textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: p.textLayerDiv,
      viewport,
    });
    await p.textLayer.render();

    buildSentences(p);
    p.rendered = true;
    if (el.showall.checked) paintAllBands(p);
    report();
  })();

  await p.rendering;
  return p;
}

async function reZoom(next) {
  scale = next;
  el.zoomOut.textContent = scale.toFixed(2);
  if (!doc) return;
  for (const p of pages.values()) {
    if (!p.rendered) {
      // Not rasterised yet — just resize the shell.
      const base = (await doc.getPage(p.pn)).getViewport({ scale: 1 });
      sizePage(p.div, base.width * scale, base.height * scale);
      continue;
    }
    const viewport = p.proxy.getViewport({ scale });
    sizePage(p.div, viewport.width, viewport.height);
    p.div.style.setProperty("--total-scale-factor", String(scale));
    const dpr = window.devicePixelRatio || 1;
    p.canvas.width = Math.floor(viewport.width * dpr);
    p.canvas.height = Math.floor(viewport.height * dpr);
    const ctx = p.canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    await p.proxy.render({ canvasContext: ctx, viewport }).promise;
    p.textLayer.update({ viewport });
    // NOTE: p.sentences is deliberately NOT recomputed. The rects are page
    // fractions, so zoom is meant to cost nothing. If the band drifts after a
    // zoom, that claim (02 §6) is wrong and the ticket should say so.
  }
  repaint();
  report();
}

// ------------------------------------------------- sentences and geometry

function buildSentences(p) {
  const strs = p.textLayer.textContentItemsStr;
  const divs = p.textLayer.textDivs;
  // textContentItemsStr mirrors textContent.items 1:1 while includeMarkedContent
  // is off; if that ever stops holding, fall back to no EOL separators.
  const src = p.textContent.items.length === strs.length ? p.textContent.items : [];

  // 02 said "join the strs". That is not quite enough: PDF.js emits no
  // whitespace at a line break (it appends a <br> to the DOM instead), so a
  // plain join welds the last word of one line onto the first of the next
  // ("It is thispersonality that..."), which segments wrong and speaks wrong.
  // Inject a separator after every hasEOL item. It belongs to no item, so the
  // offset map below simply skips over it; sentence endpoints are always
  // trimmed of whitespace, so no Range endpoint can ever land inside one.
  const parts = [];
  const items = [];
  let acc = 0;
  for (let i = 0; i < strs.length; i++) {
    // Index only non-empty items: PDF.js creates a div for an empty str but
    // never appends it to the DOM, and a Range endpoint inside one throws (02 §3).
    const eol = Boolean(src[i]?.hasEOL);
    // A line broken mid-word leaves a hyphen behind ("accelerat-" / "ing").
    // Drop it and join with nothing, so TTS says "accelerating". The hyphen is
    // simply not part of the index space; the Range still covers it visually.
    const hyphenated = eol && /[-‐­]$/.test(strs[i]);
    const str = hyphenated ? strs[i].slice(0, -1) : strs[i];

    if (str.length) items.push({ divIdx: i, start: acc, len: str.length });
    parts.push(str);
    acc += str.length;
    if (eol && !hyphenated && !/\s$/.test(str)) { parts.push(" "); acc += 1; }
  }
  const pageText = parts.join("");

  const locate = (idx) => {
    let lo = 0, hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (items[mid].start <= idx) lo = mid; else hi = mid - 1;
    }
    return items[lo];
  };

  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  const box = p.textLayerDiv.getBoundingClientRect();
  const out = [];

  for (const { segment, index } of seg.segment(pageText)) {
    let s = index, e = index + segment.length;
    while (s < e && /\s/.test(pageText[s])) s++;
    while (e > s && /\s/.test(pageText[e - 1])) e--;
    if (e <= s) continue;
    const text = pageText.slice(s, e);
    if (!/[A-Za-z0-9]/.test(text)) continue;

    const rects = mergeLines(rangeRects(divs, box, locate, s, e));
    if (!rects.length) continue;
    // Glyphs with no Unicode mapping (Δ in the Millington PDF) come through as
    // C0 control characters, not as nothing. Keep them in the index space so the
    // geometry stays right, but never hand them to TTS.
    const unmapped = (text.match(/[\u0000-\u001f]/g) ?? []).length;

    // Per-word geometry for the word cursor (16). Split on the same \S+ shape
    // the server uses on s.speech, but run it against the *raw* text so
    // control characters (equation glyphs) don't shift offsets. One place
    // this can still desync, noted in the README: an unmapped-glyph run with
    // no surrounding whitespace collapses to one space in .speech and splits
    // what was a single word there into two, so .speech's word list can run
    // one short of this one on that rare sentence.
    const words = [];
    for (const m of text.matchAll(/\S+/g)) {
      const ws = s + m.index, we = ws + m[0].length;
      const wrects = mergeLines(rangeRects(divs, box, locate, ws, we));
      if (wrects.length) words.push({ text: m[0], rects: wrects });
    }

    out.push({
      pn: p.pn, si: out.length, text, rects, words, unmapped,
      speech: text.replace(/[\u0000-\u001f]+/g, " "),
    });
  }
  p.sentences = out;
}

/** DOM Range -> normalised page-fraction rects for [s, e) of pageText. */
function rangeRects(divs, box, locate, s, e) {
  if (e <= s) return [];
  const a = locate(s), b = locate(e - 1);
  try {
    const range = document.createRange();
    range.setStart(...textPosition(divs[a.divIdx], s - a.start));
    range.setEnd(...textPosition(divs[b.divIdx], e - 1 - b.start + 1));
    return [...range.getClientRects()]
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        x: (r.x - box.x) / box.width,
        y: (r.y - box.y) / box.height,
        w: r.width / box.width,
        h: r.height / box.height,
      }));
  } catch {
    return [];
  }
}

/** Descend to the text node a Range endpoint needs (autolinker.js textPosition). */
function textPosition(div, offset) {
  let node = div;
  while (node && node.nodeType !== Node.TEXT_NODE) node = node.firstChild;
  if (!node) return [div, 0];
  return [node, Math.min(offset, node.length)];
}

/**
 * getClientRects() gives one rect per inline box, so a single visual line that
 * crosses a font change comes back as several. A band wants one rect per line.
 */
function mergeLines(rects) {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    const sameLine = last &&
      Math.abs(r.y + r.h / 2 - (last.y + last.h / 2)) < Math.max(r.h, last.h) * 0.55;
    if (sameLine) {
      const right = Math.max(last.x + last.w, r.x + r.w);
      const bottom = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = right - last.x;
      last.h = bottom - last.y;
    } else {
      lines.push({ ...r });
    }
  }
  return lines;
}

// ---------------------------------------------------------------- overlay

function clearOverlay(p) {
  p.svg.replaceChildren();
}

function rect(x, y, w, h, fill, opts = {}) {
  const r = document.createElementNS(SVG_NS, "rect");
  r.setAttribute("x", x);
  r.setAttribute("y", y);
  r.setAttribute("width", Math.max(w, 0));
  r.setAttribute("height", Math.max(h, 0));
  r.setAttribute("fill", fill);
  for (const [k, v] of Object.entries(opts)) r.setAttribute(k, v);
  return r;
}

/** Pad a line rect a little so drift reads as "generous", not "misaligned" (02 §4). */
const pad = (r) => ({
  x: clamp01(r.x - r.h * 0.03),
  y: clamp01(r.y - r.h * 0.14),
  w: r.w + r.h * 0.06,
  h: r.h * 1.28,
});

function paintBand(p, rects) {
  clearOverlay(p);
  if (!rects || !rects.length) return;
  const boxes = rects.map(pad);

  if (variant.key === "A") {
    for (const b of boxes) p.svg.append(rect(b.x, b.y, b.w, b.h, "rgba(255, 212, 0, 0.34)"));
  } else if (variant.key === "B") {
    for (const b of boxes) {
      p.svg.append(rect(b.x, b.y, b.w, b.h, "rgba(255, 212, 0, 0.10)"));
      p.svg.append(rect(b.x, b.y + b.h - b.h * 0.13, b.w, b.h * 0.13, "rgba(226, 110, 20, 0.9)"));
    }
  } else {
    // Spotlight: dim the whole page and punch the sentence out of the mask.
    const id = `mask-${p.pn}`;
    const mask = document.createElementNS(SVG_NS, "mask");
    mask.setAttribute("id", id);
    mask.setAttribute("maskUnits", "userSpaceOnUse");
    mask.append(rect(0, 0, 1, 1, "#fff"));
    for (const b of boxes) mask.append(rect(b.x, b.y, b.w, b.h, "#000"));
    p.svg.append(mask);
    p.svg.append(rect(0, 0, 1, 1, "rgba(10, 12, 18, 0.42)", { mask: `url(#${id})` }));
  }
}

/**
 * The word cursor. Only meaningful inside variant C's punched-out hole — the
 * hole is already at full brightness, so "highlight the current word" can't
 * mean "make it brighter"; each style below finds a different way to make it
 * stand out from the rest of an already-lit sentence without re-darkening
 * the page outside it (16's central design question).
 */
function paintWordCursor(p, sentence, wordIdxs) {
  if (cursorStyle.key === "off" || !sentence || !wordIdxs.length) return;
  const wordBoxes = wordIdxs
    .map((i) => sentence.words[i])
    .filter(Boolean)
    .flatMap((w) => w.rects.map(pad));
  if (!wordBoxes.length) return;

  if (cursorStyle.key === "underline") {
    for (const b of wordBoxes) {
      p.svg.append(rect(b.x, b.y + b.h - b.h * 0.11, b.w, b.h * 0.1, "rgba(255, 176, 32, 0.92)"));
    }
    return;
  }
  if (cursorStyle.key === "tint") {
    for (const b of wordBoxes) {
      p.svg.append(rect(b.x, b.y, b.w, b.h, "rgba(255, 200, 0, 0.26)"));
    }
    return;
  }
  // "dim": a second, fainter spotlight nested inside the first — gently
  // recede the rest of the already-lit sentence, rather than marking the
  // current word. Confined to the sentence's own rects, so it never touches
  // the page outside the outer punch.
  const id = `wordmask-${p.pn}`;
  const mask = document.createElementNS(SVG_NS, "mask");
  mask.setAttribute("id", id);
  mask.setAttribute("maskUnits", "userSpaceOnUse");
  mask.append(rect(0, 0, 1, 1, "#000"));
  for (const b of sentence.rects.map(pad)) mask.append(rect(b.x, b.y, b.w, b.h, "#fff"));
  for (const b of wordBoxes) mask.append(rect(b.x, b.y, b.w, b.h, "#000"));
  p.svg.append(mask);
  p.svg.append(rect(0, 0, 1, 1, "rgba(10, 12, 18, 0.24)", { mask: `url(#${id})` }));
}

function paintAllBands(p) {
  clearOverlay(p);
  for (const s of p.sentences) {
    for (const r of s.rects.map(pad)) {
      p.svg.append(rect(r.x, r.y, r.w, r.h, "rgba(80, 160, 255, 0.12)", {
        stroke: "rgba(80, 160, 255, 0.55)",
        "stroke-width": 1,
        "vector-effect": "non-scaling-stroke",
      }));
    }
  }
}

function repaint() {
  for (const p of pages.values()) {
    if (!p.rendered) continue;
    if (el.showall.checked) {
      paintAllBands(p);
      if (speaking && speaking.pn === p.pn) {
        // still show where the voice is, on top of the debug bands
        const s = p.sentences[speaking.si];
        if (s) for (const b of s.rects.map(pad)) {
          p.svg.append(rect(b.x, b.y, b.w, b.h, "rgba(255, 212, 0, 0.40)"));
        }
      }
    } else if (speaking && speaking.pn === p.pn) {
      paintBand(p, p.sentences[speaking.si]?.rects);
      if (variant.key === "C") paintWordCursor(p, p.sentences[speaking.si], activeWordIdxs);
    } else if (variant.key === "C" && speaking) {
      clearOverlay(p);
      p.svg.append(rect(0, 0, 1, 1, "rgba(10, 12, 18, 0.42)"));
    } else {
      clearOverlay(p);
    }
  }
}

// ---------------------------------------------------------------- scrolling

function scrollTo(p, rects) {
  if (!el.autoscroll.checked || !rects.length) return;
  const pageBox = p.div.getBoundingClientRect();
  const viewBox = el.viewer.getBoundingClientRect();
  const top = pageBox.top + rects[0].y * pageBox.height;
  const bottom = pageBox.top + (rects.at(-1).y + rects.at(-1).h) * pageBox.height;
  const comfortTop = viewBox.top + viewBox.height * 0.15;
  const comfortBottom = viewBox.top + viewBox.height * 0.75;
  if (top >= comfortTop && bottom <= comfortBottom) return;
  el.viewer.scrollBy({
    top: top - (viewBox.top + viewBox.height * 0.32),
    behavior: "smooth",
  });
}

// ---------------------------------------------------------------- playback

async function nextCursor(c) {
  if (!c) return null;
  const p = pages.get(c.pn);
  if (p && c.si + 1 < p.sentences.length) return { pn: c.pn, si: c.si + 1 };
  for (let pn = c.pn + 1; pn <= doc.numPages; pn++) {
    const np = await renderPage(pn);
    if (np && np.sentences.length) return { pn, si: 0 };
  }
  return null;
}

function sentenceAt(c) {
  return c ? pages.get(c.pn)?.sentences[c.si] ?? null : null;
}

const cacheKey = (c) => `${c.pn}:${c.si}`;

async function fetchSynth(text, voiceName, speed) {
  const res = await fetch(`${SERVER}/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice: voiceName, speed }),
  });
  if (!res.ok) throw new Error(`synth ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Kick off (or reuse) the synthesis request for a sentence, ahead of need. */
function ensurePrefetch(c) {
  const k = cacheKey(c);
  if (prefetchCache.has(k)) return prefetchCache.get(k);
  const s = sentenceAt(c);
  if (!s) return Promise.resolve(null);
  const p = fetchSynth(s.speech, el.voice.value, Number(el.nativeSpeed.value))
    .catch((e) => { prefetchCache.delete(k); throw e; });
  prefetchCache.set(k, p);
  return p;
}

function wordsAt(t) {
  // currentSpans is time-ordered (server emits phoneme groups in speech
  // order); find the last span that has started by t.
  let lo = 0, hi = currentSpans.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (currentSpans[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? [] : currentSpans[found].words;
}

function sameWords(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function startWordLoop(gen) {
  const step = () => {
    if (gen !== generation) return;
    const next = wordsAt(audioEl.currentTime);
    if (!sameWords(next, activeWordIdxs)) {
      activeWordIdxs = next;
      repaint();
    }
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopWordLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  activeWordIdxs = [];
}

async function speakOne(c) {
  const s = sentenceAt(c);
  if (!s) return endOfDocument();
  const gen = generation;
  const startedAt = performance.now();

  let data, nc;
  try {
    [data, nc] = await Promise.all([ensurePrefetch(c), nextCursor(c)]);
  } catch (e) {
    if (gen !== generation) return;
    console.warn("[tts] synth error", e, "—", s.text.slice(0, 60));
    playing = false;
    el.play.textContent = "▶ Play";
    status(`synth error — is the Kokoro sidecar running? (npm run server)\n${e.message}`);
    return;
  }
  if (gen !== generation) return;
  prefetchCache.delete(cacheKey(c));

  cursor = nc;
  if (cursor) ensurePrefetch(cursor); // keep ~1 sentence of audio ahead (16 §"app-owned buffer queue")

  speaking = c;
  currentSpans = data.spans;
  activeWordIdxs = [];
  el.spoken.textContent = s.text;
  const p = pages.get(c.pn);
  repaint();
  scrollTo(p, s.rects);
  markSentenceList(c);
  report();

  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  const bytes = Uint8Array.from(atob(data.audio_b64), (ch) => ch.charCodeAt(0));
  currentBlobUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  audioEl.src = currentBlobUrl;
  audioEl.playbackRate = Number(el.rate.value);

  audioEl.onended = () => {
    if (gen !== generation) return;
    timings.push(performance.now() - startedAt);
    stopWordLoop();
    if (cursor) speakOne(cursor); else endOfDocument();
  };
  audioEl.onerror = () => {
    if (gen !== generation) return;
    console.warn("[tts] audio element error", audioEl.error);
    if (cursor) speakOne(cursor); else endOfDocument();
  };

  startWordLoop(gen);
  audioEl.play().catch((e) => console.warn("[tts] play() rejected", e));
}

function endOfDocument() {
  playing = false;
  speaking = null;
  stopWordLoop();
  el.play.textContent = "▶ Play";
  repaint();
  report();
}

async function play(from) {
  if (playing) return pause();
  if (!doc) return;
  let start = from ?? cursor;
  if (!start) {
    const p = await firstPageWithSentences();
    if (!p) return;
    start = { pn: p.pn, si: 0 };
  }
  playing = true;
  el.play.textContent = "⏸ Pause";
  speakOne(start);
  report();
}

function pause() {
  playing = false;
  generation++;
  audioEl.pause();
  stopWordLoop();
  // resume from the sentence that was interrupted, not the one queued behind it
  if (speaking) cursor = speaking;
  el.play.textContent = "▶ Play";
  report();
}

function stop() {
  playing = false;
  generation++;
  audioEl.pause();
  audioEl.removeAttribute("src");
  stopWordLoop();
  cursor = null;
  speaking = null;
  el.play.textContent = "▶ Play";
  el.spoken.textContent = "—";
  repaint();
  report();
}

async function firstPageWithSentences() {
  for (let pn = 1; pn <= doc.numPages; pn++) {
    const p = await renderPage(pn);
    if (p && p.sentences.length) return p;
  }
  return null;
}

// ---------------------------------------------------------------- sentence list

let listedPage = null;

function renderSentenceList(pn) {
  const p = pages.get(pn);
  if (!p || !p.rendered || listedPage === pn) return;
  listedPage = pn;
  el.segcount.textContent = `p${pn} · ${p.sentences.length} sentences`;
  el.sentences.replaceChildren(
    ...p.sentences.map((s, i) => {
      const li = document.createElement("li");
      li.textContent = s.text;
      li.title = `${s.rects.length} line rect(s)` +
        (s.unmapped ? ` · ${s.unmapped} unmapped glyph(s)` : "");
      if (s.unmapped) li.style.color = "#ff9b6b";
      li.onclick = () => { stop(); play({ pn, si: i }); };
      return li;
    }),
  );
  markSentenceList(speaking);
}

function markSentenceList(c) {
  if (!c || c.pn !== listedPage) return;
  [...el.sentences.children].forEach((li, i) => li.classList.toggle("on", i === c.si));
  el.sentences.children[c.si]?.scrollIntoView({ block: "nearest" });
}

el.viewer.addEventListener("scroll", () => {
  const mid = el.viewer.getBoundingClientRect().top + el.viewer.clientHeight / 2;
  for (const p of pages.values()) {
    const b = p.div.getBoundingClientRect();
    if (b.top <= mid && b.bottom >= mid) { renderSentenceList(p.pn); break; }
  }
}, { passive: true });

// click a sentence on the page itself to speak from there
el.pages.addEventListener("click", (ev) => {
  const div = ev.target.closest(".pdfpage");
  if (!div) return;
  const p = pages.get(Number(div.dataset.page));
  if (!p?.rendered) return;
  const b = div.getBoundingClientRect();
  const x = (ev.clientX - b.left) / b.width;
  const y = (ev.clientY - b.top) / b.height;
  const hit = p.sentences.findIndex((s) =>
    s.rects.some((r) => x >= r.x - 0.01 && x <= r.x + r.w + 0.01 && y >= r.y && y <= r.y + r.h));
  if (hit >= 0) { stop(); play({ pn: p.pn, si: hit }); }
});

// ---------------------------------------------------------------- voices

const PREFERRED_VOICE = "bf_emma"; // liked in [[14]]'s listening comparison

async function loadVoices() {
  let names = [];
  try {
    const res = await fetch(`${SERVER}/voices`);
    names = (await res.json()).voices ?? [];
  } catch (e) {
    console.warn("[tts] could not reach Kokoro sidecar for voice list:", e);
    names = [PREFERRED_VOICE];
  }
  el.voice.replaceChildren(
    ...names.map((v) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      return o;
    }),
  );
  el.voice.value = names.includes(PREFERRED_VOICE) ? PREFERRED_VOICE : (names[0] ?? "");
}
loadVoices();

// ---------------------------------------------------------------- variants

function setVariant(i) {
  variant = VARIANTS[(i + VARIANTS.length) % VARIANTS.length];
  el.variantLabel.textContent = `${variant.key} (${variant.name})`;
  const url = new URL(location.href);
  url.searchParams.set("variant", variant.key);
  history.replaceState(null, "", url);
  repaint();
}

const startVariant = VARIANTS.findIndex(
  (v) => v.key === (new URL(location.href).searchParams.get("variant") ?? "C"),
);
setVariant(startVariant < 0 ? 0 : startVariant);

el.prevVariant.onclick = () => setVariant(VARIANTS.indexOf(variant) - 1);
el.nextVariant.onclick = () => setVariant(VARIANTS.indexOf(variant) + 1);

function setCursorStyle(i) {
  cursorStyle = CURSOR_STYLES[(i + CURSOR_STYLES.length) % CURSOR_STYLES.length];
  el.cursorLabel.textContent = `${cursorStyle.key} (${cursorStyle.name})`;
  const url = new URL(location.href);
  url.searchParams.set("cursor", cursorStyle.key);
  history.replaceState(null, "", url);
  repaint();
}

const startCursor = CURSOR_STYLES.findIndex(
  (c) => c.key === (new URL(location.href).searchParams.get("cursor") ?? "dim"),
);
setCursorStyle(startCursor < 0 ? 0 : startCursor);

el.prevCursor.onclick = () => setCursorStyle(CURSOR_STYLES.indexOf(cursorStyle) - 1);
el.nextCursor.onclick = () => setCursorStyle(CURSOR_STYLES.indexOf(cursorStyle) + 1);

addEventListener("keydown", (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if (e.key === "ArrowLeft") setVariant(VARIANTS.indexOf(variant) - 1);
  else if (e.key === "ArrowRight") setVariant(VARIANTS.indexOf(variant) + 1);
  else if (e.key === "c") setCursorStyle(CURSOR_STYLES.indexOf(cursorStyle) + 1);
  else if (e.key === " ") { e.preventDefault(); play(); }
  else if (e.key === "h") $("hide").click();
});

$("hide").onclick = () => document.getElementById("app").classList.toggle("bare");

// ---------------------------------------------------------------- wiring

el.pick.onclick = () => el.file.click();
el.file.onchange = async () => {
  const f = el.file.files?.[0];
  if (f) openDoc(await f.arrayBuffer());
};

el.viewer.addEventListener("dragover", (e) => {
  e.preventDefault();
  el.viewer.classList.add("dragging");
});
el.viewer.addEventListener("dragleave", () => el.viewer.classList.remove("dragging"));
el.viewer.addEventListener("drop", async (e) => {
  e.preventDefault();
  el.viewer.classList.remove("dragging");
  const f = e.dataTransfer?.files?.[0];
  if (f) openDoc(await f.arrayBuffer());
});

el.play.onclick = () => play();
el.stop.onclick = () => stop();

el.rate.oninput = () => {
  el.rateOut.textContent = Number(el.rate.value).toFixed(2);
  // Live control: playbackRate + preservesPitch is instant and needs no
  // re-synthesis, unlike [[05]]'s speechSynthesis.rate — and because it
  // scales the whole clip by one constant, currentSpans stays correct with
  // no recomputation (16 §"rate control uses two mechanisms").
  audioEl.playbackRate = Number(el.rate.value);
};

el.nativeSpeed.onchange = () => {
  // Baseline control: Kokoro's own `speed` needs re-synthesis, so it only
  // takes effect on sentences not yet fetched — invalidate the lookahead.
  prefetchCache.clear();
  if (cursor) ensurePrefetch(cursor);
};

el.voice.onchange = () => {
  prefetchCache.clear();
  if (cursor) ensurePrefetch(cursor);
};

let zoomTimer;
el.zoom.oninput = () => {
  el.zoomOut.textContent = Number(el.zoom.value).toFixed(2);
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => reZoom(Number(el.zoom.value)), 180);
};

el.showall.onchange = repaint;

addEventListener("beforeunload", () => audioEl.pause());

report();
console.log("[16] throwaway Kokoro reading loop. pdfjs-dist", pdfjsLib.version);

// Debug hook, used by verify.mjs to check the geometry pipeline headlessly.
window.__spike = {
  pages, renderPage, setVariant, version: pdfjsLib.version,
  get scale() { return scale; },
  preview(pn, si) { speaking = { pn, si }; repaint(); return pages.get(pn)?.sentences[si] ?? null; },
  setCursorStyle, play, stop,
  get cursorStyle() { return cursorStyle; },
  get activeWordIdxs() { return activeWordIdxs; },
};
