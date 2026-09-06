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
import { analyzeLayout } from "./layout.js";
import { parseEpub } from "./epub.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const SVG_NS = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);
const el = {
  pick: $("pick"), file: $("file"), docinfo: $("docinfo"),
  voice: $("voice"), rate: $("rate"), rateOut: $("rateOut"),
  nativeSpeed: $("nativeSpeed"),
  zoom: $("zoom"), zoomOut: $("zoomOut"),
  play: $("play"), stop: $("stop"),
  autoscroll: $("autoscroll"), showall: $("showall"), showRegions: $("showRegions"),
  layoutHint: $("layoutHint"),
  enableLayout: $("enableLayout"),
  state: $("state"), spoken: $("spoken"),
  sentences: $("sentences"), segcount: $("segcount"),
  pages: $("pages"), viewer: $("viewer"), drop: $("drop"),
  engineStatus: $("engineStatus"),
  prevVariant: $("prevVariant"), nextVariant: $("nextVariant"), variantLabel: $("variantLabel"),
  prevCursor: $("prevCursor"), nextCursor: $("nextCursorBtn"), cursorLabel: $("cursorLabel"),
  busyDot: $("busyDot"), hoverBadge: $("hoverBadge"),
};

// ---------------------------------------------------------------- state

let doc = null;
// "pdf" or "epub". PageEntry (below) duck-types the same shape either way --
// pn/div/rendered/sentences/base -- so the whole scroll, zoom, eviction and
// playback pipeline below is shared unmodified; only shell-building,
// renderPage, evictPage and zoom reflow branch on this.
let docKind = null;
/** @type {Map<number, PageEntry>} */
const pages = new Map();
let scale = 1.2;
let zoomGeneration = 0; // bumped per reZoom, so a superseded pass bails out

let playing = false;
let generation = 0;   // bumped on every cancel; stale audio events are ignored
let cursor = null;    // {pn, si} — sentence to play after the current one
let speaking = null;  // {pn, si} — sentence currently sounding
let loadingSentence = null; // {pn, si} — set the instant speakOne is asked for it, cleared once audio starts
let hovered = null;   // {pn, si} — sentence under the mouse, for the hover-to-play badge
const timings = [];   // wall-clock synth+play time per sentence, to judge lag

const audioEl = new Audio();
audioEl.preload = "auto";
audioEl.muted = false;  // defensive: rule out an accidental mute path outright
audioEl.volume = 1;
try { audioEl.preservesPitch = true; } catch { /* older browsers: ignore */ }
// Diagnostic for a reported case: the word cursor advanced in real time with
// no audible sound, once, on a first click, not reproduced since. If it
// recurs this is the fastest way to tell "audio never actually started"
// (autoplay policy, muted/volume) from "audio started but was silent" (a
// sibling of the server's zero-length-audio bug -- see server.py's peak-
// amplitude check) from "browser routed it to the wrong output device."
audioEl.addEventListener("loadedmetadata", () => {
  console.log(`[tts] loaded  duration=${audioEl.duration.toFixed(2)}s  volume=${audioEl.volume}  muted=${audioEl.muted}`);
});
audioEl.addEventListener("playing", () => {
  console.log(`[tts] playing  currentTime=${audioEl.currentTime.toFixed(2)}  paused=${audioEl.paused}`);
});
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
  const busy = activeRequests > 0 || fetchQueue.length > 0;
  el.busyDot.hidden = !busy;
  status(
    [
      `${playing ? "speaking" : "idle"}  gen ${generation}`,
      speaking ? `at  p${speaking.pn} s${speaking.si}  word ${activeWordIdxs.join(",") || "—"}` : "at  —",
      `pages rendered ${rendered}/${doc ? doc.numPages : 0}   zoom ${scale.toFixed(2)}`,
      `sentences spoken ${timings.length}  mean ${avg}s   synthesizing ${activeRequests}  queued ${fetchQueue.length}`,
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
    this.labels = div.querySelector(".regionLabels");
    this.iframe = div.querySelector("iframe"); // epub only; null for a PDF shell
    this.textLayer = null;
    this.proxy = null;
    this.sentences = [];
    this.rendered = false;
    this.rendering = null;
    this.base = null;         // unscaled viewport size, so zoom can resize without PDF.js
    this.regions = null;      // set once layout analysis resolves (06)
    this.layoutLoading = false;
    this.renderTask = null;   // in-flight PDF.js RenderTask, so it can be cancelled
  }
}

/** Sniff format from the filename first, falling back to the bytes themselves. */
function sniffKind(name, data) {
  if (/\.epub$/i.test(name || "")) return "epub";
  if (/\.pdf$/i.test(name || "")) return "pdf";
  const head = new Uint8Array(data, 0, Math.min(data.byteLength, 4));
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "pdf"; // %PDF
  if (head[0] === 0x50 && head[1] === 0x4b) return "epub"; // PK.. (zip)
  return null;
}

async function openFile(file) {
  const data = await file.arrayBuffer();
  const kind = sniffKind(file.name, data);
  if (kind === "epub") return openEpub(data);
  if (kind === "pdf") return openPdf(data);
  status(`Can't tell what kind of file "${file.name}" is -- expected a .pdf or .epub`);
}

/** Teardown shared by both openers: stop playback, release the old document's pages. */
async function closeDoc() {
  stop();
  if (doc && docKind === "pdf") await doc.destroy();
  for (const p of pages.values()) evictPage(p); // release canvases/iframes before dropping the map
  renderOrder.length = 0;
  pages.clear();
  el.pages.replaceChildren();
  el.sentences.replaceChildren();
  doc = null;
  docKind = null;
  syncLayoutControls();
}

/**
 * The "reading order via layout model" checkbox only means anything for a
 * PDF -- an epub chapter's TreeWalker already visits nodes in document
 * order, which for reflowable HTML *is* the reading order, so there is no
 * equivalent reordering problem for the layout model to fix (see
 * el.enableLayout.onchange below). Left checkable-but-inert on an epub, the
 * control looks broken: nothing happens, with no indication why. Disable it
 * (and the region-overlay checkbox that depends on it) instead, so an epub
 * makes the control's irrelevance visible rather than silently doing nothing.
 */
function syncLayoutControls() {
  const isPdf = docKind === "pdf";
  el.enableLayout.disabled = !isPdf;
  el.showRegions.disabled = !isPdf;
  el.layoutHint.textContent =
    docKind === "epub"
      ? "Not applicable to an EPUB: its chapters are read in document order already, which for reflowable HTML is the correct reading order -- there's no layout model step to run."
      : docKind === "pdf"
        ? "Runs PP-DocLayoutV2 outside the window (~1.4s a page), so scrolling stays smooth. Groups each page into titles, paragraphs and figures so a click picks the paragraph you meant. Off means pages keep their default reading order."
        : "Open a PDF to enable this.";
}

/** Build one page/chapter shell, shared innerHTML for whichever fields both formats use. */
function makeShell(pn, extraClass, bodyHtml) {
  const div = document.createElement("div");
  div.className = `page ${extraClass}`;
  div.dataset.page = String(pn);
  div.innerHTML = bodyHtml +
    `<svg class="overlay" viewBox="0 0 1 1" preserveAspectRatio="none"></svg>` +
    `<div class="regionLabels"></div>`;
  el.pages.append(div);
  return div;
}

async function openPdf(data) {
  await closeDoc();
  docKind = "pdf";
  syncLayoutControls();

  doc = await pdfjsLib.getDocument({ data }).promise;
  el.drop.classList.add("hide");
  el.docinfo.textContent = `${doc.numPages} pages`;

  // Shell every page up front at the right aspect ratio, so the scrollbar is
  // honest; rasterise lazily as they come into view.
  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });

  for (let pn = 1; pn <= doc.numPages; pn++) {
    // width/height 0 until rasterised: a default <canvas> is 300x150, and at
    // 4 bytes a pixel that is ~180 KB per page of pure shell -- 145 MB of it
    // on an 809-page book, before anything has been rendered at all.
    const div = makeShell(pn, "pdfpage",
      `<canvas width="0" height="0"></canvas><div class="textLayer"></div>`);
    sizePage(div, base);
    const entry = new PageEntry(pn, div);
    // Page 1's size, as a stand-in until this page is actually opened. Every
    // shell needs *a* height for the scrollbar to be honest, and asking PDF.js
    // for 611 real ones up front is the thing lazy rendering exists to avoid.
    entry.base = { width: base.width, height: base.height };
    pages.set(pn, entry);
    observer.observe(div);
  }
  markGeomDirty();

  await renderPage(1);
  report();
}

// A book with no per-chapter width info yet gets a guessed placeholder height
// so the scrollbar is roughly honest before anything has actually reflowed --
// same idea as the PDF shell borrowing page 1's size, just a flat guess since
// an EPUB chapter has no upfront aspect ratio to ask for.
const EPUB_PLACEHOLDER_HEIGHT = 900;

async function openEpub(data) {
  await closeDoc();
  docKind = "epub";
  syncLayoutControls();

  const parsed = await parseEpub(data);
  // numPages, not numChapters: every generic page-shaped codepath below
  // (nextCursor, firstPageWithSentences, report(), the render queue) already
  // reads doc.numPages and only PDF-specific call sites (getPage, destroy)
  // need to know the difference, gated on docKind instead.
  doc = { numPages: parsed.numChapters, chapters: parsed.chapters, title: parsed.title };
  el.drop.classList.add("hide");
  el.docinfo.textContent = `${parsed.title} -- ${doc.numPages} chapter${doc.numPages === 1 ? "" : "s"}`;

  for (let pn = 1; pn <= doc.numPages; pn++) {
    const div = makeShell(pn, "epubchapter",
      `<iframe sandbox="allow-same-origin" tabindex="-1" scrolling="no"></iframe>`);
    div.style.height = `${EPUB_PLACEHOLDER_HEIGHT * scale}px`;
    const entry = new PageEntry(pn, div);
    entry.base = { width: 0, height: EPUB_PLACEHOLDER_HEIGHT * scale };
    pages.set(pn, entry);
    observer.observe(div);
  }
  markGeomDirty();

  await renderPage(1);
  report();
}

/*
 * Where each page sits in the scroll container.
 *
 * Everything on the scroll path used to ask the DOM: the scroll handler called
 * getBoundingClientRect() on *every* page to find the one under the midpoint,
 * which is 611 forced layouts per scroll event on a big textbook. This reads
 * the offsets once into a sorted array and rebuilds only when page sizes
 * actually change (open, zoom, a shell learning its real size).
 */
let geomIndex = null;

function markGeomDirty() { geomIndex = null; }

function geom() {
  if (!geomIndex) {
    geomIndex = [...pages.values()]
      .map((p) => ({ pn: p.pn, top: p.div.offsetTop, bottom: p.div.offsetTop + p.div.offsetHeight }))
      .sort((a, b) => a.top - b.top);
  }
  return geomIndex;
}

/** The page containing this scroll offset, or the nearest one. */
function pageAtOffset(y) {
  const g = geom();
  if (!g.length) return null;
  let lo = 0, hi = g.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g[mid].top <= y) lo = mid; else hi = mid - 1;
  }
  return g[lo];
}

/*
 * Zoom scales page heights but not the gaps between them, so the index can be
 * transformed exactly rather than re-read: each page keeps its ordinal, its
 * height scales, and the constant gap stays put. Saves a forced layout on
 * every wheel event of a zoom gesture.
 */
function rescaleGeom(ratio) {
  if (!geomIndex || geomIndex.length === 0 || ratio === 1) return;
  const gap = geomIndex.length > 1 ? geomIndex[1].top - geomIndex[0].bottom : 0;
  let top = geomIndex[0].top;
  for (const e of geomIndex) {
    const h = (e.bottom - e.top) * ratio;
    e.top = top;
    e.bottom = top + h;
    top += h + gap;
  }
}

function geomFor(pn) {
  return geom().find((e) => e.pn === pn) ?? null;
}

/** Record a page's unscaled size; CSS multiplies it by the document zoom. */
function sizePage(div, base) {
  div.style.setProperty("--pw", String(base.width));
  div.style.setProperty("--ph", String(base.height));
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) queueRender(Number(e.target.dataset.page));
    }
  },
  { root: null, rootMargin: "400px 0px" },
);

/*
 * Scrolling outranks rendering.
 *
 * The observer used to call renderPage() the instant a page crossed the
 * margin, so flinging through a 600-page book queued a rasterise, a
 * getTextContent, a TextLayer build and a sentence pass for every page the
 * scroll swept over -- hundreds of them, all on the thread that has to move
 * the scrollbar. That is the lag: the work was for pages already long gone by
 * the time it ran.
 *
 * So intersecting only *queues* a page. The pump waits for the scroll to slow
 * down, then renders one page at a time, nearest the viewport first, dropping
 * anything that has since scrolled away. A fast fling therefore costs nothing
 * but the scroll itself, and settles into rendering what you actually stopped
 * on. Slow reading-speed scrolling is not throttled at all -- the gate is
 * velocity, not movement.
 */
const renderQueue = new Set();
const FAST_SCROLL = 1.5;   // px/ms — above this, rendering waits
const SCROLL_IDLE_MS = 100;
const DROP_MARGIN = 1200;  // px from the viewport; queued pages past this are dropped
let lastScrollAt = 0;
let lastScrollTop = 0;
let scrollVelocity = 0;    // px/ms, decayed to 0 once scrolling stops
let pumping = false;

function scrollingFast() {
  if (performance.now() - lastScrollAt > SCROLL_IDLE_MS) return false;
  return scrollVelocity > FAST_SCROLL;
}

/** Distance in px from the viewport, or Infinity if the page is gone from the index. */
function offViewport(pn) {
  const g = geomFor(pn);
  if (!g) return Infinity;
  const top = el.viewer.scrollTop;
  const bottom = top + el.viewer.clientHeight;
  if (g.bottom < top) return top - g.bottom;
  if (g.top > bottom) return g.top - bottom;
  return 0;
}

function queueRender(pn) {
  const p = pages.get(pn);
  if (!p || p.rendered || p.rendering) return;
  renderQueue.add(pn);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (renderQueue.size) {
      if (scrollingFast()) {
        await new Promise((r) => setTimeout(r, SCROLL_IDLE_MS));
        continue;
      }
      let next = null;
      let nearest = Infinity;
      for (const pn of renderQueue) {
        const p = pages.get(pn);
        if (!p || p.rendered) { renderQueue.delete(pn); continue; }
        const d = offViewport(pn);
        if (d > DROP_MARGIN) { renderQueue.delete(pn); continue; } // scrolled past
        if (d < nearest) { nearest = d; next = pn; }
      }
      if (next === null) continue;
      renderQueue.delete(next);
      await renderPage(next);
      // Yield a frame between pages so a scroll that starts mid-queue is felt
      // immediately rather than after the whole backlog.
      await new Promise((r) => requestAnimationFrame(r));
    }
  } finally {
    pumping = false;
  }
}

/**
 * Rasterise a page into its own canvas, cancelling whatever was already
 * drawing into it. PDF.js throws "Cannot use the same canvas during multiple
 * render() operations" if two render tasks share a canvas, and two of them
 * genuinely race here: the IntersectionObserver re-renders on scroll while
 * reZoom is walking every rendered page re-rasterising it. Reproduced in the
 * stress harness; this is the fix.
 */
async function paintCanvas(p, viewport) {
  if (p.renderTask) {
    try { p.renderTask.cancel(); } catch { /* already finished */ }
    p.renderTask = null;
  }
  const dpr = window.devicePixelRatio || 1;
  p.canvas.width = Math.floor(viewport.width * dpr);
  p.canvas.height = Math.floor(viewport.height * dpr);
  const ctx = p.canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const task = p.proxy.render({ canvasContext: ctx, viewport });
  p.renderTask = task;
  try {
    await task.promise;
  } catch (e) {
    // A cancelled render is the expected outcome of the race above, not an error.
    if (e?.name !== "RenderingCancelledException") throw e;
  } finally {
    if (p.renderTask === task) p.renderTask = null;
  }
}

/*
 * Rasterised pages are evicted once they're far from the viewport.
 *
 * Without this, every page scrolled past keeps its full-resolution canvas
 * backing store forever: measured on the 809-page biochemistry book at
 * devicePixelRatio 2, scrolling accumulated 3.3 GB of canvas memory (JS heap
 * stayed under 70 MB the whole time, which is why it looked fine) before the
 * harness stopped. That is the reported "crashes instantaneously" -- the tab
 * is killed for native memory, not for anything JS-visible.
 */
const MAX_RASTERISED = 14;
const renderOrder = []; // page numbers, most recently rendered last

function noteRendered(pn) {
  const i = renderOrder.indexOf(pn);
  if (i >= 0) renderOrder.splice(i, 1);
  renderOrder.push(pn);
  evictFarPages();
}

/**
 * Evict everything rasterised that is no longer near the viewport, ignoring
 * the LRU cap. During a fast scroll burst many pages finish rendering at
 * once and all of them briefly count as "near", so the cap alone let peak
 * canvas memory reach ~530 MB; sweeping on scroll holds it near the visible
 * working set instead.
 */
function sweepEvictions() {
  for (let i = renderOrder.length - 1; i >= 0; i--) {
    const pn = renderOrder[i];
    const p = pages.get(pn);
    if (!p) { renderOrder.splice(i, 1); continue; }
    if (speaking?.pn === pn || cursor?.pn === pn || loadingSentence?.pn === pn) continue;
    if (nearViewport(p, 600)) continue;
    renderOrder.splice(i, 1);
    evictPage(p);
  }
}

function evictFarPages() {
  while (renderOrder.length > MAX_RASTERISED) {
    // Oldest first, but never evict what is speaking, queued to speak next,
    // or still on screen -- those get skipped and stay in the list.
    const idx = renderOrder.findIndex((pn) => {
      const p = pages.get(pn);
      if (!p) return true;
      if (speaking?.pn === pn || cursor?.pn === pn || loadingSentence?.pn === pn) return false;
      return !nearViewport(p, 600);
    });
    if (idx < 0) return; // everything left is in use; let the cap slip rather than thrash
    const [pn] = renderOrder.splice(idx, 1);
    evictPage(pages.get(pn));
  }
}

/** Release a page's pixels and DOM. It re-renders from scratch when scrolled back to. */
function evictPage(p) {
  if (!p || !p.rendered) return;
  if (p.iframe) {
    // Epub chapter: drop the iframe's document (frees its whole render tree —
    // DOM, fonts, decoded images) but keep the div's measured height, the
    // same way a PDF shell keeps p.base, so the scrollbar doesn't jump.
    p.iframe.removeAttribute("srcdoc");
    p.svg.replaceChildren();
    p.labels.replaceChildren();
    p.sentences = [];
    p._epubNodeIndex = null;
    p.rendered = false;
    p.rendering = null;
    return;
  }
  if (p.renderTask) {
    try { p.renderTask.cancel(); } catch { /* already finished */ }
    p.renderTask = null;
  }
  // Setting either dimension to 0 is what actually frees the backing store;
  // clearing the context does not.
  p.canvas.width = 0;
  p.canvas.height = 0;
  p.textLayerDiv.replaceChildren();
  p.svg.replaceChildren();
  p.labels.replaceChildren();
  p.textLayer = null;
  p.textContent = null;
  p.sentences = [];
  p._geom = null;
  p.rendered = false;
  p.rendering = null;
  // p.regions is deliberately kept: it is page-fraction data, costs nothing,
  // and saves re-running the layout model if this page comes back.
}

async function renderPage(pn) {
  const p = pages.get(pn);
  if (!p || p.rendered) return p;
  if (p.rendering) return p.rendering.then(() => p);
  return docKind === "epub" ? renderChapter(pn) : renderPdfPage(pn);
}

async function renderPdfPage(pn) {
  const p = pages.get(pn);
  p.rendering = (async () => {
    p.proxy = await doc.getPage(pn);
    const base = p.proxy.getViewport({ scale: 1 });
    const resized = !p.base || p.base.height !== base.height || p.base.width !== base.width;
    p.base = { width: base.width, height: base.height };
    const viewport = p.proxy.getViewport({ scale });
    sizePage(p.div, p.base);
    if (resized) markGeomDirty(); // this page was standing in with page 1's size
    // The text layer positions itself off --total-scale-factor, which it
    // inherits from #pages; everything else about it is percentage-based, so
    // that one variable is all it needs (02 §3).

    await paintCanvas(p, viewport);

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

    buildSentences(p, p.regions ?? undefined);
    p.rendered = true;
    noteRendered(pn);
    if (el.showall.checked) paintAllBands(p);
    report();
  })();

  await p.rendering;
  // Opt-in, default off (16 §latest feedback): this used to fire from every
  // page the IntersectionObserver merely scrolled into view, which meant
  // *scrolling* a document — not reading it — queued several seconds of
  // WASM inference per page, on the browser's main thread, for pages the
  // reader may never listen to. That's the scroll jank that was reported.
  // Reading order is still worth having; it just has to be asked for.
  if (el.enableLayout.checked) refineLayout(p); // background, not awaited
  return p;
}

/**
 * An EPUB chapter's iframe *is* its text layer -- there is no separate
 * extraction step. The sandbox has allow-same-origin but not allow-scripts,
 * so the book's own markup can't run anything, but contentDocument is
 * synchronously readable from here, which is what buildEpubSentences (below)
 * walks with a TreeWalker to find real text nodes and build real Ranges
 * against, the same way [[02]]'s PDF text layer does.
 */
async function renderChapter(pn) {
  const p = pages.get(pn);
  p.rendering = (async () => {
    const chapter = doc.chapters[pn - 1];
    const html = epubShellHtml(chapter, scale);

    await new Promise((resolve) => {
      p.iframe.addEventListener("load", resolve, { once: true });
      p.iframe.srcdoc = html;
    });
    try { await p.iframe.contentDocument.fonts?.ready; } catch { /* not fatal if unsupported */ }
    // An <img> with no size yet reports zero height, so a cover or figure
    // page measured before its image decodes comes out far too short --
    // that's what an internal iframe scrollbar on an otherwise-plain page
    // was: the div was sized to a too-small pre-image measurement, and the
    // image then finished loading into a box too short to hold it.
    await Promise.all(
      [...p.iframe.contentDocument.images].map((img) => img.complete
        ? null
        : new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); })),
    ).catch(() => {});

    const h = Math.max(1, p.iframe.contentDocument.documentElement.scrollHeight);
    const resized = !p.base || p.base.height !== h;
    p.base = { width: p.div.clientWidth, height: h };
    p.div.style.height = `${h}px`;
    if (resized) markGeomDirty();

    buildEpubSentences(p);
    p.rendered = true;
    noteRendered(pn);
    if (el.showall.checked) paintAllBands(p);
    report();
  })();

  await p.rendering;
  return p;
}

/**
 * The HTML document an epub chapter's sandboxed iframe gets as its srcdoc.
 *
 * The !important rules here are a deliberate fight with the book's own CSS,
 * not an oversight. A cover or title page is routinely authored assuming a
 * fixed device screen -- this book's cover.xhtml sets
 * `body{position:absolute;height:100%}` and `img{height:90vh}` -- which is a
 * reasonable thing to author against a real e-reader viewport and a broken
 * thing to hand a div that's supposed to size itself to its content: the
 * image renders at 90% of whatever height the iframe happens to have *that
 * instant* with no matching width constraint, so it can overflow the page
 * sideways, and the chapter's real content height becomes unmeasurable
 * (position:absolute takes an element out of the flow scrollHeight sums).
 * Forcing position/height/display back to normal flow, and forcing images
 * to fit the page's own width instead of the book's assumed screen, is what
 * every general-purpose reflowable reading view does with this pattern --
 * it costs the *one* case where a book deliberately set a smaller display
 * width or height on a figure, but wins every fixed-layout-flavoured page.
 */
function epubShellHtml(chapter, zoom) {
  return `<!doctype html><html style="--zoom:${zoom}"><head><meta charset="utf-8">` +
    `<style>
      html, body { margin: 0; background: #fff; color: #14161a; overflow: hidden; }
      body {
        font: calc(var(--zoom, 1) * 1em)/1.6 Georgia, "Times New Roman", serif;
        padding: 48px 60px;
        max-width: 720px;
        margin: 0 auto;
        overflow-wrap: break-word;
        position: static !important;
        height: auto !important;
        width: auto !important;
      }
      img, svg {
        max-width: 100% !important;
        width: auto !important;
        height: auto !important;
      }
      * { -webkit-user-select: none; user-select: none; }
    </style>` +
    chapter.headHtml +
    `</head><body>${chapter.bodyHtml}</body></html>`;
}

/** Is this page in or near the visible scroll window? */
function nearViewport(p, margin = 800) {
  const b = p.div.getBoundingClientRect();
  const v = el.viewer.getBoundingClientRect();
  return b.bottom > v.top - margin && b.top < v.bottom + margin;
}

/**
 * TICKET 06. The DOM-order sentences above are the fallback, available
 * immediately so the page is speakable without waiting on a model. This
 * runs the layout model in the background and, if it returns anything
 * usable, rebuilds the page's sentences in true reading order.
 *
 * Deliberately not awaited by renderPage: onnxruntime-web (WASM) is
 * measured at several seconds a page, far slower than [[12]]'s ~731ms on
 * native onnxruntime-node, and blocking the page render on it would
 * reintroduce exactly the scroll stall fixed earlier this session, just
 * from a slower cause. A page is visible and speakable the instant PDF.js
 * finishes; whether its order is *correct* catches up a few seconds later.
 *
 * Known rough edge, accepted for a prototype: if playback is already
 * mid-page when this resolves, p.sentences is replaced under it — indices
 * a live cursor holds can end up pointing at a different sentence. Judging
 * order-correctness doesn't require fixing that; a real build would.
 */
async function refineLayout(p) {
  p.layoutLoading = true;
  p.div.classList.add("layout-loading");
  repaint();
  try {
    // Scrolling fast queues one of these per page passed. Analysis is off the
    // main thread now (see layout-server.mjs) so a backlog no longer freezes
    // anything, but analysing 90 pages someone scrolled past is still pure
    // waste. Settle briefly, then only proceed if the page is still near the
    // viewport -- a page scrolled away from drops out here.
    await new Promise((r) => setTimeout(r, 600));
    if (pages.get(p.pn) !== p) return;
    if (!nearViewport(p)) return;
    const regions = await analyzeLayout(p.canvas);
    if (pages.get(p.pn) !== p) return; // doc changed under us; discard
    p.regions = regions;
    buildSentences(p, regions);
    if (listedPage === p.pn) { listedPage = null; renderSentenceList(p.pn); }
  } catch (e) {
    console.warn("[layout] analysis failed, keeping DOM order for page", p.pn, e);
  } finally {
    p.layoutLoading = false;
    p.div.classList.remove("layout-loading");
    repaint();
  }
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

/*
 * Zoom in two halves.
 *
 * `applyScale` is synchronous and instant: it resizes every page shell from
 * the cached unscaled size and fixes the scroll position so the point under
 * the cursor stays under the cursor. The canvases are CSS-sized to their
 * shell, so the already-drawn bitmaps stretch immediately -- blurry, but
 * there, and the text layer follows because it positions everything off
 * --total-scale-factor. Ctrl+wheel therefore tracks the wheel with no
 * rasterising in the loop at all.
 *
 * `rasteriseAtScale` then redraws the pages that are actually rendered, once
 * the gesture settles. This used to be one pass that awaited doc.getPage() per
 * page while resizing, which made the document's height change 611 times
 * during a zoom and put the anchor somewhere else entirely.
 */
function applyScale(next, anchorClientY = null) {
  const prev = scale;
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  el.zoomOut.textContent = scale.toFixed(2);
  el.zoom.value = String(scale);
  if (!doc || scale === prev) return;

  // Anchor: the point that must not move. Default is the middle of the
  // viewport, which is what the zoom slider should feel like; ctrl+wheel
  // passes the pointer instead.
  const viewerTop = el.viewer.getBoundingClientRect().top;
  const anchor = anchorClientY == null
    ? el.viewer.clientHeight / 2
    : Math.max(0, Math.min(el.viewer.clientHeight, anchorClientY - viewerTop));
  const at = el.viewer.scrollTop + anchor;
  const before = pageAtOffset(at);
  const frac = before && before.bottom > before.top
    ? (at - before.top) / (before.bottom - before.top)
    : null;

  el.pages.style.setProperty("--zoom", String(scale));
  el.pages.style.setProperty("--total-scale-factor", String(scale));
  rescaleGeom(scale / prev);

  // Re-anchor off the same page rather than scaling scrollTop by the zoom
  // ratio: the gaps between pages do not scale, so the ratio drifts. The
  // anchor page's new position is read back from the DOM rather than taken
  // from the rescaled index -- that read forces one layout, but a stale
  // half-pixel here compounds across a wheel gesture into visible slippage.
  const anchorDiv = before ? pages.get(before.pn)?.div : null;
  if (anchorDiv && frac !== null) {
    const top = anchorDiv.offsetTop;
    const height = anchorDiv.offsetHeight;
    const e = geomFor(before.pn);
    if (e) { e.top = top; e.bottom = top + height; }
    el.viewer.scrollTop = top + frac * height - anchor;
  } else {
    el.viewer.scrollTop = (at * (scale / prev)) - anchor;
  }

  // No repaint: the overlay is a viewBox="0 0 1 1" SVG over a page-fraction
  // coordinate system, so it rescales with the page for free.
  report();
}

async function rasteriseAtScale() {
  if (!doc) return;
  // Two of these overlapping means two render tasks per canvas, which PDF.js
  // refuses; the generation check drops the older walk.
  const gen = ++zoomGeneration;
  for (const p of pages.values()) {
    if (gen !== zoomGeneration) return;
    if (!p.rendered) continue;
    const viewport = p.proxy.getViewport({ scale });
    await paintCanvas(p, viewport);
    if (gen !== zoomGeneration) return;
    // The page can be evicted while that await is outstanding, which nulls
    // the text layer out from under us.
    if (!p.rendered || !p.textLayer) continue;
    p.textLayer.update({ viewport });
    // NOTE: p.sentences is deliberately NOT recomputed. The rects are page
    // fractions, so zoom is meant to cost nothing. If the band drifts after a
    // zoom, that claim (02 §6) is wrong and the ticket should say so.
  }
  // The index was transformed rather than re-measured during the gesture;
  // resync it from the DOM now that the zoom has stopped moving.
  markGeomDirty();
  repaint();
  report();
}

let rasterTimer;
function reZoom(next, anchorClientY = null) {
  if (docKind === "epub") return applyEpubScale(next, anchorClientY);
  applyScale(next, anchorClientY);
  clearTimeout(rasterTimer);
  rasterTimer = setTimeout(rasteriseAtScale, 150);
}

/**
 * Epub has no PDF-style raster/CSS-var split for zoom: reflowing a chapter
 * means changing --zoom (a font-size multiplier) inside its own iframe and
 * remeasuring, and there is no bitmap to stretch for cheap instant feedback
 * the way a canvas gives PDF. What keeps it feeling instant anyway is that
 * each chapter is its own isolated iframe -- reflowing one means reflowing a
 * single short document, not the 611-page one the scroll fix earlier this
 * session was about -- and the render queue already keeps only a handful of
 * chapters rendered at once. So this runs synchronously on every tick,
 * across whichever chapters are actually rendered; nothing is debounced.
 */
function applyEpubScale(next, anchorClientY = null) {
  const prev = scale;
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  el.zoomOut.textContent = scale.toFixed(2);
  el.zoom.value = String(scale);
  if (!doc || scale === prev) return;

  const viewerTop = el.viewer.getBoundingClientRect().top;
  const anchor = anchorClientY == null
    ? el.viewer.clientHeight / 2
    : Math.max(0, Math.min(el.viewer.clientHeight, anchorClientY - viewerTop));
  const at = el.viewer.scrollTop + anchor;
  const before = pageAtOffset(at);
  const frac = before && before.bottom > before.top
    ? (at - before.top) / (before.bottom - before.top)
    : null;

  for (const p of pages.values()) {
    if (!p.rendered || !p.iframe?.contentDocument) continue;
    p.iframe.contentDocument.documentElement.style.setProperty("--zoom", String(scale));
    const h = Math.max(1, p.iframe.contentDocument.documentElement.scrollHeight);
    p.div.style.height = `${h}px`;
    p.base = { width: p.base?.width ?? 0, height: h };
    // Old Range()-derived rects and word rects describe the layout from
    // before this reflow; drop them so the next paint recomputes fresh ones.
    for (const s of p.sentences) { s.rects = null; s.words = null; }
  }
  markGeomDirty();

  const g = geomFor(before?.pn);
  el.viewer.scrollTop = g && frac !== null
    ? g.top + frac * (g.bottom - g.top) - anchor
    : Math.max(0, at - anchor);

  repaint();
  report();
}

// ------------------------------------------------- sentences and geometry

function buildSentences(p, regions) {
  const strs = p.textLayer.textContentItemsStr;
  const divs = p.textLayer.textDivs;
  // textContentItemsStr mirrors textContent.items 1:1 while includeMarkedContent
  // is off; if that ever stops holding, fall back to no EOL separators.
  const src = p.textContent.items.length === strs.length ? p.textContent.items : [];

  // 02 said "join the strs". That is not quite enough: PDF.js emits no
  // whitespace at a line break (it appends a <br> to the DOM instead), so a
  // plain join welds the last word of one line onto the first of the next
  // ("It is thispersonality that..."), which segments wrong and speaks wrong.
  // Resolve each item's own string first, independent of order -- whether to
  // drop a trailing hyphen and whether a separator follows are both
  // properties of the item itself, not of whatever comes next, so this is
  // safe to do before 06's reordering below.
  let resolved = [];
  for (let i = 0; i < strs.length; i++) {
    const eol = Boolean(src[i]?.hasEOL);
    // A line broken mid-word leaves a hyphen behind ("accelerat-" / "ing").
    // Drop it and join with nothing, so TTS says "accelerating". The hyphen is
    // simply not part of the index space; the Range still covers it visually.
    const hyphenated = eol && /[-‐­]$/.test(strs[i]);
    const str = hyphenated ? strs[i].slice(0, -1) : strs[i];
    const sep = eol && !hyphenated && !/\s$/.test(str);
    resolved.push({ divIdx: i, str, sep, indexable: str.length > 0 });
  }

  const box = p.textLayerDiv.getBoundingClientRect();
  p._geom = { divs, box }; // getWordRects() needs these later; locate is per-sentence, below

  // 06: DOM order is a fallback, not the truth. PDF.js emits text in
  // content-stream order, which can interleave columns on a multi-column
  // page. When the layout model has already told us the true region order
  // (regions is set once analysis finishes, on a later render pass -- see
  // refineLayout), GROUP items by which region they fall in, by max-area
  // overlap, instead of trusting the stream -- each region becomes its own
  // independently-segmented run. No regions yet (or analysis failed) is one
  // group, the whole page, DOM order: exactly [[05]]'s original behaviour.
  //
  // Grouping, not just reordering, matters: a title has no full stop to end
  // on, so if its text and the following paragraph's text ever land in the
  // same Intl.Segmenter pass, nothing tells the segmenter they're different
  // sentences and it reads the two as one (reported directly: clicking a
  // paragraph also selected its title). Giving each region its own
  // segmenter pass makes that boundary structural, not punctuation-dependent.
  const groups = (regions && regions.length)
    ? groupByRegion(resolved, divs, box, regions)
    : [resolved];

  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  const out = [];

  for (const groupItems of groups) {
    const parts = [];
    const items = [];
    let acc = 0;
    for (const { divIdx, str, sep, indexable } of groupItems) {
      // Index only non-empty items: PDF.js creates a div for an empty str but
      // never appends it to the DOM, and a Range endpoint inside one throws (02 §3).
      if (indexable) items.push({ divIdx, start: acc, len: str.length });
      parts.push(str);
      acc += str.length;
      if (sep) { parts.push(" "); acc += 1; }
    }
    const pageText = parts.join("");
    if (!items.length) continue;

    const locate = (idx) => {
      let lo = 0, hi = items.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (items[mid].start <= idx) lo = mid; else hi = mid - 1;
      }
      return items[lo];
    };

    // One Intl.Segmenter sentence is one unit -- no smaller (an earlier
    // version of this file split further at clause punctuation to shorten
    // synth latency; reverted: that's a subtitle-style chop mid-sentence,
    // and the right fix for latency is prefetching ahead, not a smaller
    // unit). Still guard against Intl.Segmenter itself under-splitting: it
    // can occasionally treat two real sentences as one segment (an
    // abbreviation, an odd quote/citation pattern), and that's a genuine
    // bug worth catching here rather than living with a chunk that's
    // *larger* than a sentence.
    const spans = [];
    for (const { segment, index } of seg.segment(pageText)) {
      let s = index, e = index + segment.length;
      while (s < e && /\s/.test(pageText[s])) s++;
      while (e > s && /\s/.test(pageText[e - 1])) e--;
      if (e <= s) continue;
      for (const span of guardSentenceBoundaries(pageText, s, e)) spans.push(span);
    }

    // Nothing unpronounceable may become a unit of its own. A span with no
    // letters in it -- a list marker ("2."), a stray dash, the tail of a
    // split figure reference -- is absorbed into the sentence that follows
    // (or the one before, if it is last) rather than emitted.
    //
    // This is the fix for a real failure seen in the server log: a request
    // whose whole text was "-", which Kokoro rejects outright ("Nothing to
    // synthesize, '-' produced no phonemes"). The client skipped that
    // sentence, so the highlight advanced with no sound -- the reported
    // "audio doesn't work" case. Merging also stops numbered lists being
    // read aloud as "two." "three." "four."
    const kept = [];
    for (let i = 0; i < spans.length; i++) {
      const [a, b] = spans[i];
      if (!/[A-Za-z]/.test(pageText.slice(a, b))) {
        if (i + 1 < spans.length) { spans[i + 1][0] = a; continue; }
        if (kept.length) { kept[kept.length - 1][1] = b; continue; }
        continue; // nothing to attach to; drop it
      }
      kept.push([a, b]);
    }

    {
      for (const [as, ae] of kept) {
        const text = pageText.slice(as, ae);

        const rects = mergeLines(rangeRects(divs, box, locate, as, ae));
        if (!rects.length) continue;
        // Glyphs with no Unicode mapping (Δ in the Millington PDF) come
        // through as C0 control characters, not as nothing. Keep them in the
        // index space so the geometry stays right, but never hand them to TTS.
        const unmapped = (text.match(/[\u0000-\u001f]/g) ?? []).length;

        // Per-word geometry for the word cursor (16) is *offsets only* here —
        // not rects. Computing a Range + getClientRects() per word for every
        // sentence on every page, the moment it scrolls into view, forces a
        // synchronous layout reflow per word; on a normal page that's
        // hundreds of extra reflows just from scrolling past it, never mind
        // reading it. (Measured: this is what made fast scrolling through a
        // multi-page document stall.) getWordRects() below computes and
        // caches the actual rects lazily, the first time a sentence is about
        // to be spoken -- using *this group's* locate, stashed per-sentence,
        // since with regions on, different sentences on the same page can
        // come from different groups with different offset spaces.
        const wordSpans = [];
        for (const m of text.matchAll(/\S+/g)) {
          wordSpans.push({ text: m[0], ws: as + m.index, we: as + m.index + m[0].length });
        }

        out.push({
          pn: p.pn, si: out.length, text, rects, wordSpans, words: null, unmapped,
          speech: text.replace(/[\u0000-\u001f]+/g, " "),
          _locate: locate,
        });
      }
    }
  }
  p.sentences = out;
}

/**
 * Intl.Segmenter already finds sentence boundaries; this only catches the
 * case where it missed one -- a run of *two* sentence-ending marks (one
 * mid-string) inside what it called a single segment. Splits there too, so
 * the unit handed to speech and the highlight is never larger than one
 * sentence. Does not try to be a better sentence splitter than
 * Intl.Segmenter; it only refuses to trust a segment that visibly contains
 * more than one.
 */
function guardSentenceBoundaries(pageText, s, e) {
  const text = pageText.slice(s, e);
  // The lookahead deliberately excludes digits. Allowing them split every
  // numbered list marker into its own "sentence" -- measured on the
  // biochemistry book, "2." "3." "4." … were being spoken as standalone
  // utterances, and figure references ("see Fig. 3.21).") were cut in half
  // at the abbreviation's full stop. A real missed boundary is followed by a
  // capital or an opening quote, not by a digit.
  const boundary = /[.!?][”"'’)\]]*\s+(?=[A-Z"“'’(])/g;
  const MIN_CHUNK = 20; // don't cut after "Fig." or "No." -- too short to be a sentence
  const cuts = [];
  let last = 0;
  for (const m of text.matchAll(boundary)) {
    const cut = m.index + m[0].length;
    if (cut - last < MIN_CHUNK) continue;
    cuts.push(cut);
    last = cut;
  }
  if (!cuts.length) return [[s, e]];
  const spans = [];
  let start = 0;
  for (const cut of cuts) { spans.push([s + start, s + cut]); start = cut; }
  spans.push([s + start, e]);
  return spans
    .map(([a, b]) => {
      while (a < b && /\s/.test(pageText[a])) a++;
      while (b > a && /\s/.test(pageText[b - 1])) b--;
      return [a, b];
    })
    .filter(([a, b]) => b > a);
}

/**
 * Group resolved text items by which layout region they fall in (max-area
 * overlap, matching [[06]]'s research at a 10% threshold): sorted first by
 * region (in the model's reading order), then by original relative order
 * within a region (stable sort — correct almost always, since a single
 * column/region's own stream order is already top-to-bottom). Returns
 * contiguous per-region runs, each to be segmented independently by
 * buildSentences — a title's region and the following paragraph's region
 * must never share one Intl.Segmenter pass, or a title with no ending
 * punctuation reads as the first clause of the next sentence (reported
 * directly: clicking a paragraph also selected its title).
 *
 * An item with no region above threshold inherits its nearest preceding
 * item's region rather than being dropped or scattered — [[06]] left "what
 * the fallback does" as an open decision; this is that decision, made the
 * cheap way rather than the correct-for-every-case way.
 */
function groupByRegion(resolved, divs, box, regions) {
  const boxOf = (divIdx) => {
    const r = divs[divIdx].getBoundingClientRect();
    return {
      x: (r.x - box.x) / box.width, y: (r.y - box.y) / box.height,
      w: r.width / box.width, h: r.height / box.height,
    };
  };
  const overlapFrac = (a, b) => {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const areaA = a.w * a.h;
    return areaA > 0 ? (ix * iy) / areaA : 0;
  };

  let lastRegion = 0;
  const tagged = resolved.map((item, i) => {
    const ib = boxOf(item.divIdx);
    let best = -1, bestFrac = 0.1;
    for (let ri = 0; ri < regions.length; ri++) {
      const f = overlapFrac(ib, regions[ri]);
      if (f > bestFrac) { bestFrac = f; best = ri; }
    }
    if (best >= 0) lastRegion = best; else best = lastRegion;
    return { item, region: best, i };
  });

  tagged.sort((a, b) => a.region - b.region || a.i - b.i);

  // Consecutive same-label regions (the model splits one paragraph into two
  // adjacent "text" boxes more often than it splits a title from its body)
  // merge into one group -- the hard boundary this function exists to add
  // is a *label change* (title -> text), not merely a *region change*.
  // Getting this wrong the other way round reintroduced a splitting bug
  // this fix wasn't meant to add: "It is easy" / "to study individual
  // enzyme systems..." as two sentences, on this corpus, at the boundary
  // between two same-label boxes.
  const groups = [];
  let current = null, currentRegion = null, currentLabel = null;
  for (const t of tagged) {
    const label = t.region >= 0 ? regions[t.region].label : null;
    const sameRun = current && (t.region === currentRegion || (label !== null && label === currentLabel));
    if (!sameRun) {
      current = [];
      groups.push(current);
      currentRegion = t.region;
      currentLabel = label;
    }
    current.push(t.item);
  }
  return groups;
}

/*
 * ---- EPUB sentences and rects ----
 *
 * An EPUB chapter's iframe is its own text layer: TreeWalker finds real Text
 * nodes directly, so items reference nodes themselves rather than PDF's
 * textDivs-by-index, and there is no textPosition() descent to do. The
 * sentence *text* is still built and segmented eagerly (buildEpubSentences,
 * cheap -- Intl.Segmenter is one linear pass over the chapter's string) but
 * unlike a PDF page's dozen sentences, a chapter can hold hundreds, and each
 * one's line RECTS cost a forced layout via Range().getClientRects(). Doing
 * that for every sentence the moment a chapter renders would reintroduce the
 * scroll stall this session just fixed for PDF, just from a new cause -- so
 * rects are computed lazily, the first time a sentence is actually painted
 * or hit-tested, exactly like getWordRects below already does for words.
 */

const BLOCK_TAGS = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|SECTION|ARTICLE|TABLE|TR|TD|TH|UL|OL|BR|HR|FIGURE|FIGCAPTION|PRE|HEADER|FOOTER|ASIDE|NAV|DT|DD)$/;

function blockAncestor(node) {
  let el = node.parentElement;
  while (el && !BLOCK_TAGS.test(el.tagName)) el = el.parentElement;
  return el;
}

function buildEpubSentences(p) {
  const idoc = p.iframe.contentDocument;
  const walker = idoc.createTreeWalker(idoc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !/\S/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
      const tag = n.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // Concatenate text nodes in document order, trusting the source's own
  // whitespace where it exists (an inline split mid-word, e.g. bold "act" +
  // plain "ive", has none between the nodes and must not gain a space) and
  // adding exactly one only where reading across a block-element boundary
  // (paragraph, heading, list item...) would otherwise weld two unrelated
  // runs together with nothing between them at all.
  const items = []; // { node, start, len }
  const parts = [];
  let acc = 0;
  let prevNode = null;
  let node;
  while ((node = walker.nextNode())) {
    const str = node.nodeValue;
    if (prevNode && blockAncestor(prevNode) !== blockAncestor(node) &&
        !/\s$/.test(parts[parts.length - 1]) && !/^\s/.test(str)) {
      parts.push(" ");
      acc += 1;
    }
    items.push({ node, start: acc, len: str.length });
    parts.push(str);
    acc += str.length;
    prevNode = node;
  }
  if (!items.length) { p.sentences = []; p._epubNodeIndex = null; return; }
  const pageText = parts.join("");
  // node -> item, for epubHitTest (below) to turn a point under the pointer
  // straight into a global text offset without testing every sentence's
  // rects on every mousemove -- the thing that made [[05]]'s "POC-grade,
  // fine at this page count" hitTest not fine at all once a page (chapter)
  // can hold hundreds of sentences.
  p._epubNodeIndex = new Map(items.map((it) => [it.node, it]));

  const locate = (idx) => {
    let lo = 0, hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (items[mid].start <= idx) lo = mid; else hi = mid - 1;
    }
    return items[lo];
  };

  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  const spans = [];
  for (const { segment, index } of seg.segment(pageText)) {
    let s = index, e = index + segment.length;
    while (s < e && /\s/.test(pageText[s])) s++;
    while (e > s && /\s/.test(pageText[e - 1])) e--;
    if (e <= s) continue;
    for (const span of guardSentenceBoundaries(pageText, s, e)) spans.push(span);
  }

  // Same "nothing unpronounceable stands alone" merge as buildSentences (02
  // §"kept"): a lone list marker or figure-reference tail gets folded into
  // its neighbour rather than sent to Kokoro to reject.
  const kept = [];
  for (let i = 0; i < spans.length; i++) {
    const [a, b] = spans[i];
    if (!/[A-Za-z]/.test(pageText.slice(a, b))) {
      if (i + 1 < spans.length) { spans[i + 1][0] = a; continue; }
      if (kept.length) { kept[kept.length - 1][1] = b; continue; }
      continue;
    }
    kept.push([a, b]);
  }

  const out = [];
  for (const [as, ae] of kept) {
    const text = pageText.slice(as, ae);
    const wordSpans = [];
    for (const m of text.matchAll(/\S+/g)) {
      wordSpans.push({ text: m[0], ws: as + m.index, we: as + m.index + m[0].length });
    }
    out.push({
      pn: p.pn, si: out.length, text, rects: null, wordSpans, words: null, unmapped: 0,
      speech: text, _locate: locate, _start: as, _end: ae,
    });
  }
  p.sentences = out;
}

/** DOM Range -> normalised page-fraction rects, epub version. Items reference
 * real Text nodes directly (no textPosition descent needed). Unlike a PDF
 * page's textLayer -- which lives in the *main* document, so its rects need
 * the outer document's coordinate space -- these nodes live inside the
 * iframe's own document, and getClientRects() already reports positions in
 * *that* document's own viewport (its own (0,0) is the iframe's top-left,
 * independent of where the iframe itself sits in the main page). So this
 * only needs to divide by the iframe's own size to get a page fraction, not
 * subtract its position too -- doing that (an earlier version of this did)
 * double-offsets every rect by the iframe's own position, which is exactly
 * what made every highlight render shifted and truncated. */
function epubRangeRects(p, locate, s, e) {
  if (e <= s) return [];
  const a = locate(s), b = locate(e - 1);
  try {
    const range = p.iframe.contentDocument.createRange();
    range.setStart(a.node, Math.max(0, Math.min(s - a.start, a.node.length)));
    range.setEnd(b.node, Math.max(0, Math.min(e - 1 - b.start + 1, b.node.length)));
    const box = p.iframe.getBoundingClientRect();
    return [...range.getClientRects()]
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        x: r.x / box.width, y: r.y / box.height,
        w: r.width / box.width, h: r.height / box.height,
      }));
  } catch {
    return [];
  }
}

/**
 * A sentence's line rects. PDF sentences already have theirs filled in
 * eagerly by buildSentences -- cheap there, a page has ~a dozen -- so this
 * is a plain cache read for them; epub sentences start with rects:null and
 * compute (and cache) lazily here, the first time one is actually painted,
 * hit-tested or scrolled to.
 */
function sentenceRects(p, s) {
  if (s.rects) return s.rects;
  if (!p.iframe) return [];
  s.rects = mergeLines(epubRangeRects(p, s._locate, s._start, s._end));
  return s.rects;
}

/** Compute (and cache) a sentence's per-word rects, only when it's about to speak. */
function getWordRects(p, sentence) {
  if (sentence.words) return sentence.words;
  if (p.iframe) {
    sentence.words = sentence.wordSpans
      .map(({ text, ws, we }) => ({ text, rects: mergeLines(epubRangeRects(p, sentence._locate, ws, we)) }))
      .filter((w) => w.rects.length);
    return sentence.words;
  }
  const { divs } = p._geom;
  const locate = sentence._locate;
  // A fresh box, not the one buildSentences captured: this can run long
  // after render, once the page has scrolled, and range.getClientRects()
  // below always reports *current* viewport position — mixing a stale box
  // with live rects would misplace every word box by the scroll delta.
  const box = p.textLayerDiv.getBoundingClientRect();
  sentence.words = sentence.wordSpans
    .map(({ text, ws, we }) => ({ text, rects: mergeLines(rangeRects(divs, box, locate, ws, we)) }))
    .filter((w) => w.rects.length);
  return sentence.words;
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
  if (p.labels) p.labels.replaceChildren();
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
  const words = getWordRects(p, sentence);
  const wordBoxes = wordIdxs
    .map((i) => words[i])
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
  for (const b of sentenceRects(p, sentence).map(pad)) mask.append(rect(b.x, b.y, b.w, b.h, "#fff"));
  for (const b of wordBoxes) mask.append(rect(b.x, b.y, b.w, b.h, "#000"));
  p.svg.append(mask);
  p.svg.append(rect(0, 0, 1, 1, "rgba(10, 12, 18, 0.24)", { mask: `url(#${id})` }));
}

function paintAllBands(p) {
  clearOverlay(p);
  // Debug-only (the "show every sentence band" checkbox): forces every
  // sentence's rects, which on an epub chapter with hundreds of them is
  // real work. Fine when explicitly opted into; never called otherwise.
  for (const s of p.sentences) {
    for (const r of sentenceRects(p, s).map(pad)) {
      p.svg.append(rect(r.x, r.y, r.w, r.h, "rgba(80, 160, 255, 0.12)", {
        stroke: "rgba(80, 160, 255, 0.55)",
        "stroke-width": 1,
        "vector-effect": "non-scaling-stroke",
      }));
    }
  }
}

/**
 * TICKET 06's explicit ask: "render that order visibly ... so the order can
 * be eyeballed against the real page rather than trusted." Numbered so the
 * reading order (not just the boxes) is checkable at a glance.
 */
function paintRegions(p) {
  if (!p.regions) return;
  // Boxes go in the SVG; labels do NOT. The overlay is viewBox="0 0 1 1"
  // with preserveAspectRatio="none", so it scales x and y by different
  // factors -- rectangles survive that, glyphs come out stretched and
  // unreadable (reported). Labels are positioned HTML instead, so they
  // render at real font size whatever the page aspect ratio is.
  const frag = document.createDocumentFragment();
  p.regions.forEach((r, i) => {
    const hue = Math.round((i / p.regions.length) * 300);
    const color = `hsl(${hue}, 85%, 60%)`;
    p.svg.append(rect(r.x, r.y, r.w, r.h, "none", {
      stroke: color, "stroke-width": 2, "vector-effect": "non-scaling-stroke",
    }));
    // Just the reading-order number, inside the box's top-left corner, with
    // the label on hover. Earlier revisions put the full label in the SVG
    // (stretched unreadable by preserveAspectRatio="none") and then in the
    // page margin (clipped at the page edge, and for a right-hand column it
    // landed on top of the left column's text). A number is two characters
    // wide, so it occludes almost nothing and the order still reads at a
    // glance -- which is the thing this overlay exists to show.
    const tag = document.createElement("span");
    tag.className = "regionTag";
    tag.style.left = `${r.x * 100}%`;
    tag.style.top = `${r.y * 100}%`;
    tag.style.borderColor = color;
    tag.style.color = color;
    tag.textContent = String(i + 1);
    tag.title = `${i + 1}. ${r.label} (${r.score.toFixed(2)})`;
    frag.append(tag);
  });
  p.labels.replaceChildren(frag);
}

function repaint() {
  for (const p of pages.values()) {
    if (!p.rendered) continue;
    if (el.showall.checked) {
      paintAllBands(p);
      if (speaking && speaking.pn === p.pn) {
        // still show where the voice is, on top of the debug bands
        const s = p.sentences[speaking.si];
        if (s) for (const b of sentenceRects(p, s).map(pad)) {
          p.svg.append(rect(b.x, b.y, b.w, b.h, "rgba(255, 212, 0, 0.40)"));
        }
      }
    } else if (speaking && speaking.pn === p.pn) {
      const s = p.sentences[speaking.si];
      paintBand(p, s ? sentenceRects(p, s) : null);
      if (variant.key === "C") paintWordCursor(p, s, activeWordIdxs);
    } else if (variant.key === "C" && speaking) {
      clearOverlay(p);
      p.svg.append(rect(0, 0, 1, 1, "rgba(10, 12, 18, 0.42)"));
    } else {
      clearOverlay(p);
    }

    // Additive, regardless of which branch above ran: regions, loading and
    // hover are independent of whether anything is currently speaking.
    if (el.showRegions.checked) paintRegions(p); else if (p.labels.firstChild) p.labels.replaceChildren();
    if (loadingSentence?.pn === p.pn && !isSame(speaking, loadingSentence)) {
      paintLoading(p, p.sentences[loadingSentence.si]);
    }
    if (hovered?.pn === p.pn && !isSame(speaking, hovered)) {
      paintHover(p, p.sentences[hovered.si]);
    }
  }
}

const isSame = (a, b) => Boolean(a && b && a.pn === b.pn && a.si === b.si);

/** Pulsing dashed outline: synthesis is in flight for this sentence. */
function paintLoading(p, sentence) {
  if (!sentence) return;
  for (const b of sentenceRects(p, sentence).map(pad)) {
    const r = rect(b.x, b.y, b.w, b.h, "none", {
      stroke: "rgba(124, 196, 255, 0.9)",
      "stroke-width": 2,
      "stroke-dasharray": "6 4",
      "vector-effect": "non-scaling-stroke",
    });
    r.setAttribute("class", "loading-outline");
    p.svg.append(r);
  }
}

/** Quiet outline: this is what a click here would play. */
function paintHover(p, sentence) {
  if (!sentence) return;
  for (const b of sentenceRects(p, sentence).map(pad)) {
    p.svg.append(rect(b.x, b.y, b.w, b.h, "rgba(124, 196, 255, 0.10)", {
      stroke: "rgba(124, 196, 255, 0.55)",
      "stroke-width": 1,
      "vector-effect": "non-scaling-stroke",
    }));
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

function fetchSynth(text, voiceName, speed) {
  return window.blitz.synthesize({ text, voice: voiceName, speed });
}

// A page's worth of sentences all become fetchable the moment it renders
// (see renderPage), which would otherwise fire 10-20 requests at once and
// make every one of them slow. Cap how many the sidecar is doing at a time,
// and let an explicit play() request cut the queue -- the reader is waiting
// on it, the background reader-ahead isn't.
// The sidecar pins each ONNX session to every CPU thread (server.py's
// intra_op_num_threads), so two requests in parallel oversubscribe the
// machine and both get SLOWER, not faster -- measured: raising this past 1
// turned a cold click into a 6-8s wait instead of the ~2-4s one request
// alone takes. One at a time, reordered by priority, is faster in practice.
const MAX_CONCURRENT = 1;
let activeRequests = 0;
const fetchQueue = []; // [{key, run}], FIFO except promote() reorders it

function pumpFetchQueue() {
  while (activeRequests < MAX_CONCURRENT && fetchQueue.length) {
    const { run } = fetchQueue.shift();
    activeRequests++;
    run();
  }
  report(); // keeps the busy-dot and queue depth live, not just on playback events
}

function promote(k) {
  const i = fetchQueue.findIndex((t) => t.key === k);
  if (i > 0) fetchQueue.unshift(fetchQueue.splice(i, 1)[0]);
}

/** Kick off (or reuse) the synthesis request for a sentence, ahead of need. */
function ensurePrefetch(c, opts) {
  const priority = Boolean(opts && opts.priority);
  const k = cacheKey(c);
  if (prefetchCache.has(k)) {
    if (priority) promote(k);
    return prefetchCache.get(k);
  }
  const s = sentenceAt(c);
  if (!s) return Promise.resolve(null);
  // Belt and braces on top of the merge in buildSentences: never ask the
  // synthesiser for text with nothing to pronounce -- it 500s on that.
  if (!/[A-Za-z]/.test(s.speech)) return Promise.resolve(null);

  let resolveFn, rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  prefetchCache.set(k, promise);

  const run = () => {
    fetchSynth(s.speech, el.voice.value, Number(el.nativeSpeed.value))
      .then(resolveFn, (e) => { prefetchCache.delete(k); rejectFn(e); })
      .finally(() => { activeRequests--; pumpFetchQueue(); });
  };
  fetchQueue[priority ? "unshift" : "push"]({ key: k, run });
  pumpFetchQueue();
  return promise;
}

// Read a few sentences ahead of wherever the *voice* actually is, not
// wherever the viewport happens to be. This used to fire from renderPage,
// which meant scrolling through the document -- not reading it -- queued
// audio for every page that scrolled into view. On a long document, fast
// scrolling could queue hundreds of sentences behind whatever was already
// playing, and worse, buildSentences' per-word geometry (now lazy, see
// getWordRects) used to run eagerly for all of them too. Tying prefetch to
// playback instead means scrolling costs nothing beyond the page render
// [[05]] already paid for.
const READ_AHEAD = 3;
async function prefetchAhead(c, { priorityFirst = false } = {}) {
  let at = c;
  for (let i = 0; i < READ_AHEAD && at; i++) {
    // fire-and-forget; speakOne's own await on the immediate-next sentence
    // is what surfaces a real failure, not this background warm-up
    ensurePrefetch(at, { priority: priorityFirst && i === 0 }).catch(() => {});
    at = await nextCursor(at);
  }
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

  // Visible the instant a click is made, not once synthesis returns — a
  // cache miss can take a couple of seconds (see README), and silence
  // during that wait reads as broken rather than as "working on it."
  loadingSentence = c;
  repaint();

  let data, nc;
  try {
    [data, nc] = await Promise.all([ensurePrefetch(c, { priority: true }), nextCursor(c)]);
  } catch (e) {
    if (gen !== generation) return;
    console.warn("[tts] synth error, skipping sentence", e, "—", s.text.slice(0, 60));
    // One bad sentence shouldn't end the read. Skip it and keep going — the
    // reader hears a gap, not a dead stop. If the sidecar itself is down,
    // every following sentence will fail the same way; that surfaces as
    // reaching endOfDocument almost immediately, which is enough of a signal.
    loadingSentence = null;
    nc = await nextCursor(c).catch(() => null);
    if (nc) return speakOne(nc);
    status(`synth error on the last sentence — is the Kokoro sidecar running? (npm run server)\n${e.message}`);
    return endOfDocument();
  }
  if (gen !== generation) return;
  prefetchCache.delete(cacheKey(c));

  if (!data) {
    // Nothing pronounceable here (see ensurePrefetch's guard). Move on
    // rather than stalling on a sentence that can never make a sound.
    loadingSentence = null;
    cursor = nc;
    if (cursor) return speakOne(cursor);
    return endOfDocument();
  }

  cursor = nc;
  if (cursor) prefetchAhead(cursor, { priorityFirst: true }); // the sentence right after this one, plus a couple more behind it

  loadingSentence = null;
  speaking = c;
  currentSpans = data.spans;
  activeWordIdxs = [];
  el.spoken.textContent = s.text;
  const p = pages.get(c.pn);
  getWordRects(p, s); // pay the per-word layout cost for this one sentence, now that it's needed
  repaint();
  scrollTo(p, sentenceRects(p, s));
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
  audioEl.play().catch((e) => {
    // Autoplay-policy rejections land here with currentTime stuck at 0, so
    // the word cursor should NOT visibly advance in this case -- if it does
    // (the reported symptom), the audio started fine and was just silent,
    // which points at the server-side peak-amplitude check instead.
    console.warn("[tts] play() rejected -- word cursor should stay frozen at word 0:", e);
  });
}

function endOfDocument() {
  playing = false;
  speaking = null;
  loadingSentence = null;
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
  loadingSentence = null;
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
  loadingSentence = null;
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
      // s.rects may still be null here (epub: computed lazily) -- reading the
      // list must not itself force a Range().getClientRects() pass over
      // every sentence in the chapter, so this only reports a count when the
      // rects already happen to be cached.
      li.title = (s.rects ? `${s.rects.length} line rect(s)` : "") +
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

/*
 * The scroll handler does the least it possibly can: measure how fast we are
 * moving, and set a timer. Everything else -- eviction, the sentence list,
 * resuming the render pump -- happens once the scroll settles. It used to call
 * getBoundingClientRect() on every page in the document on every scroll event,
 * which on a 611-page book is 611 forced layouts per event.
 */
let settleTimer = null;
el.viewer.addEventListener("scroll", () => {
  const now = performance.now();
  const top = el.viewer.scrollTop;
  const dt = now - lastScrollAt;
  // A gap longer than an idle beat is a new gesture, not a slow one.
  scrollVelocity = dt > 0 && dt < SCROLL_IDLE_MS * 4 ? Math.abs(top - lastScrollTop) / dt : 0;
  lastScrollAt = now;
  lastScrollTop = top;

  if (!pumping && renderQueue.size && !scrollingFast()) pump();

  clearTimeout(settleTimer);
  settleTimer = setTimeout(onScrollSettled, 150);
}, { passive: true });

function onScrollSettled() {
  scrollVelocity = 0;
  sweepEvictions();
  const hit = pageAtOffset(el.viewer.scrollTop + el.viewer.clientHeight / 2);
  if (hit) renderSentenceList(hit.pn);
  pump();
}

/** Which sentence, if any, sits under this page-relative point. */
function hitTest(p, clientX, clientY) {
  if (p.iframe) return epubHitTest(p, clientX, clientY);
  const b = p.div.getBoundingClientRect();
  const x = (clientX - b.left) / b.width;
  const y = (clientY - b.top) / b.height;
  const hit = p.sentences.findIndex((s) =>
    s.rects.some((r) => x >= r.x - 0.01 && x <= r.x + r.w + 0.01 && y >= r.y && y <= r.y + r.h));
  return hit >= 0 ? hit : null;
}

/**
 * The epub equivalent of hitTest above, but taking a completely different
 * route to it: this runs on every mousemove for the hover-to-preview badge,
 * and testing every sentence's rects (the PDF approach -- fine there, "a
 * page has ~a dozen") would force sentenceRects for hundreds of sentences on
 * every pixel the pointer crosses. caretRangeFromPoint asks the browser
 * directly which text offset is under the cursor -- no rects computed at
 * all -- and a binary search over sentence boundaries (already sorted,
 * built in order) finds which sentence that offset falls in.
 */
function epubHitTest(p, clientX, clientY) {
  const idoc = p.iframe.contentDocument;
  if (!idoc || !p._epubNodeIndex) return null;
  const ib = p.iframe.getBoundingClientRect();
  const ix = clientX - ib.left, iy = clientY - ib.top;
  let range = null;
  if (idoc.caretRangeFromPoint) {
    range = idoc.caretRangeFromPoint(ix, iy);
  } else if (idoc.caretPositionFromPoint) {
    const pos = idoc.caretPositionFromPoint(ix, iy);
    if (pos) { range = idoc.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  }
  if (!range) return null;

  let node = range.startContainer, offset = range.startOffset;
  if (node.nodeType !== Node.TEXT_NODE) {
    let n = node.childNodes[offset] ?? node.childNodes[offset - 1] ?? node.firstChild;
    while (n && n.nodeType !== Node.TEXT_NODE) n = n.firstChild ?? n.nextSibling;
    if (!n) return null;
    node = n; offset = 0;
  }
  const item = p._epubNodeIndex.get(node);
  if (!item) return null;
  const idx = item.start + Math.min(offset, item.len);

  const arr = p.sentences;
  if (!arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid]._start <= idx) lo = mid; else hi = mid - 1;
  }
  return idx >= arr[lo]._start && idx < arr[lo]._end ? lo : null;
}

// click a sentence on the page itself to speak from there
el.pages.addEventListener("click", (ev) => {
  const div = ev.target.closest(".page");
  if (!div) return;
  const p = pages.get(Number(div.dataset.page));
  if (!p?.rendered) return;
  const hit = hitTest(p, ev.clientX, ev.clientY);
  if (hit !== null) { stop(); play({ pn: p.pn, si: hit }); }
});

// Hover-to-preview (16): make it visible before the click that this is
// clickable and what it will play, not just clickable-and-hope. No
// debouncing -- hitTest runs on every mousemove -- fine for a PDF page's
// dozen-odd rects; an epub chapter's hundreds route through epubHitTest
// instead, which asks the browser for the offset under the point rather
// than testing every sentence's rects.
el.pages.addEventListener("mousemove", (ev) => {
  const div = ev.target.closest(".page");
  const p = div ? pages.get(Number(div.dataset.page)) : null;
  const hit = p?.rendered ? hitTest(p, ev.clientX, ev.clientY) : null;

  if (hit === null) {
    if (hovered) { hovered = null; repaint(); }
    el.hoverBadge.hidden = true;
    return;
  }
  const changed = !hovered || hovered.pn !== p.pn || hovered.si !== hit;
  hovered = { pn: p.pn, si: hit };
  if (changed) repaint();

  el.hoverBadge.hidden = false;
  el.hoverBadge.style.left = `${ev.clientX}px`;
  el.hoverBadge.style.top = `${ev.clientY}px`;
  const already = speaking && speaking.pn === p.pn && speaking.si === hit;
  el.hoverBadge.textContent = already ? "♪ Playing" : "▶ Play from here";
});
el.pages.addEventListener("mouseleave", () => {
  if (hovered) { hovered = null; repaint(); }
  el.hoverBadge.hidden = true;
});

// ---------------------------------------------------------------- voices

const PREFERRED_VOICE = "bf_emma"; // liked in [[14]]'s listening comparison

/*
 * Speech loads in the background and can legitimately be missing (the model
 * weights live outside the repo). Say so in the panel rather than letting the
 * first click fail silently -- a silent failure here is exactly the bug that
 * cost a day in the prototype.
 */
async function reportEngineStatus() {
  const { ok, error } = await window.blitz.ttsStatus();
  el.engineStatus.textContent = ok
    ? "Speech engine ready."
    : `Speech unavailable — ${error}`;
  el.engineStatus.classList.toggle("bad", !ok);
}

async function loadVoices() {
  reportEngineStatus().catch(() => {});
  let names = [];
  try {
    names = (await window.blitz.voices()).voices ?? [];
  } catch (e) {
    console.warn("[tts] speech engine unavailable, voice list is a stub:", e);
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
el.file.onchange = () => {
  const f = el.file.files?.[0];
  if (f) openFile(f);
};

el.viewer.addEventListener("dragover", (e) => {
  e.preventDefault();
  el.viewer.classList.add("dragging");
});
el.viewer.addEventListener("dragleave", () => el.viewer.classList.remove("dragging"));
el.viewer.addEventListener("drop", (e) => {
  e.preventDefault();
  el.viewer.classList.remove("dragging");
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
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
  fetchQueue.length = 0;
  if (cursor) ensurePrefetch(cursor, { priority: true }).catch(() => {});
};

el.voice.onchange = () => {
  prefetchCache.clear();
  fetchQueue.length = 0;
  if (cursor) ensurePrefetch(cursor, { priority: true }).catch(() => {});
};

el.zoom.oninput = () => reZoom(Number(el.zoom.value));

/*
 * Ctrl+wheel zoom, anchored on the pointer -- the gesture every PDF reader
 * has. passive:false because it has to preventDefault: left alone, Chromium
 * turns ctrl+wheel into browser zoom, which scales the chrome along with the
 * page and is not what anyone means by zooming a document.
 *
 * The step is exponential so each notch is the same proportional change at
 * every zoom level; deltaMode 1 is a line-scrolling mouse rather than a
 * trackpad, so its deltas are much coarser.
 */
el.viewer.addEventListener("wheel", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const per = e.deltaMode === 1 ? 0.05 : 0.0012;
  reZoom(scale * Math.exp(-e.deltaY * per), e.clientY);
}, { passive: false });

// Keyboard zoom, for the same reason: ctrl +/-/0 is the other half of the
// gesture people already have in their hands.
addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === "+" || e.key === "=") { e.preventDefault(); reZoom(scale * 1.1); }
  else if (e.key === "-") { e.preventDefault(); reZoom(scale / 1.1); }
  else if (e.key === "0") { e.preventDefault(); reZoom(1.2); }
});

el.showall.onchange = repaint;
el.showRegions.onchange = repaint;
el.enableLayout.onchange = () => {
  if (!el.enableLayout.checked || docKind !== "pdf") return;
  // Only meaningful for PDF: reading order there can interleave columns in
  // content-stream order. An epub chapter's TreeWalker already visits nodes
  // in document order, which for reflowable HTML *is* the reading order --
  // there's no equivalent reordering problem for the layout model to fix.
  // Only pages already on screen need a nudge; renderPage() checks the box
  // itself for anything rendered from here on.
  for (const p of pages.values()) if (p.rendered && !p.regions) refineLayout(p);
};
syncLayoutControls(); // no doc open yet -- starts disabled

addEventListener("beforeunload", () => audioEl.pause());

report();
console.log("[blitz] pdfjs-dist", pdfjsLib.version);

// Debug hook, used by verify.mjs to check the geometry pipeline headlessly.
window.__spike = {
  pages, renderPage, setVariant, version: pdfjsLib.version,
  get scale() { return scale; },
  preview(pn, si) { speaking = { pn, si }; repaint(); return pages.get(pn)?.sentences[si] ?? null; },
  setCursorStyle, play, stop,
  get cursorStyle() { return cursorStyle; },
  get activeWordIdxs() { return activeWordIdxs; },
};
