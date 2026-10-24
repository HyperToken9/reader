/*
 * Faithful Node re-implementation of Blitz's PDF page -> sentence -> TTS string
 * pipeline (dev branch, app/renderer/main.js). Line refs are to that file
 * unless stated. Runs the SAME pdfjs-dist 6.3.289 build/pdf.mjs the app bundles.
 */
import "./polyfill.mjs";
import * as pdfjs from "pdfjs-dist";
import fs from "node:fs";

export { pdfjs };

export async function openPdf(path) {
  // main.js:918  getDocument({ data }) -- no other options. In a browser that
  // means useSystemFonts=true (pdf.mjs:15463: `!isNodeJS && !disableFontFace`),
  // so we pass it explicitly to match; Node would otherwise default to false.
  return pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path)), useSystemFonts: true, verbosity: 0 }).promise;
}

/** guardSentenceBoundaries, main.js:2361-2393, verbatim. */
function guardSentenceBoundaries(pageText, s, e) {
  const text = pageText.slice(s, e);
  const boundary = /[.!?][”"'’)\]]*\s+(?=[A-Z"“'’(])/g;
  const MIN_CHUNK = 20;
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
 * items: textContent.items (default getTextContent options, main.js:1412).
 * Returns pageText, the item offset map, and sentences with .speech exactly as
 * ensurePrefetch would send it (or sentDropped / skipped flags).
 */
export function buildSentences(items) {
  // TextLayer.textContentItemsStr: pdf.mjs:15209 pushes item.str for every
  // item with str !== undefined (marked-content items are off by default).
  const strs = items.map((it) => it.str);
  const src = items; // main.js:2204 -- lengths match with includeMarkedContent off
  // main.js:2214-2225: per-item resolve (EOL separator, trailing-hyphen drop)
  const resolved = [];
  for (let i = 0; i < strs.length; i++) {
    const eol = Boolean(src[i]?.hasEOL);
    const hyphenated = eol && /[-‐­]$/.test(strs[i]);
    const str = hyphenated ? strs[i].slice(0, -1) : strs[i];
    const sep = eol && !hyphenated && !/\s$/.test(str);
    resolved.push({ divIdx: i, str, sep, indexable: str.length > 0, hyphenated });
  }
  // main.js:2244-2246: regions are only set when the opt-in layout model ran
  // (el.enableLayout, default unchecked, index.html:195 / main.js:1435), so
  // the default is ONE group = whole page in content-stream order.
  const groups = [resolved];
  const seg = new Intl.Segmenter("en", { granularity: "sentence" }); // main.js:2248
  const out = [];
  const dropped = [];
  let pageTextAll = "";
  for (const groupItems of groups) {
    const parts = [];
    const itemsIdx = [];
    let acc = 0;
    for (const { divIdx, str, sep, indexable } of groupItems) { // main.js:2254-2262
      if (indexable) itemsIdx.push({ divIdx, start: acc, len: str.length });
      parts.push(str);
      acc += str.length;
      if (sep) { parts.push(" "); acc += 1; }
    }
    const pageText = parts.join(""); // main.js:2263
    pageTextAll = pageText;
    if (!itemsIdx.length) continue;
    const locate = (idx) => {
      let lo = 0, hi = itemsIdx.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (itemsIdx[mid].start <= idx) lo = mid; else hi = mid - 1; }
      return itemsIdx[lo];
    };
    const spans = []; // main.js:2283-2289
    for (const { segment, index } of seg.segment(pageText)) {
      let s = index, e = index + segment.length;
      while (s < e && /\s/.test(pageText[s])) s++;
      while (e > s && /\s/.test(pageText[e - 1])) e--;
      if (e <= s) continue;
      for (const span of guardSentenceBoundaries(pageText, s, e)) spans.push(span);
    }
    // main.js:2304-2313: letterless spans merge forward (or back); dropped only if alone
    const kept = [];
    const mergedLetterless = [];
    for (let i = 0; i < spans.length; i++) {
      const [a, b] = spans[i];
      if (!/[A-Za-z]/.test(pageText.slice(a, b))) {
        mergedLetterless.push(pageText.slice(a, b));
        if (i + 1 < spans.length) { spans[i + 1][0] = a; continue; }
        if (kept.length) { kept[kept.length - 1][1] = b; continue; }
        dropped.push(pageText.slice(a, b));
        continue;
      }
      kept.push([a, b]);
    }
    for (const [as, ae] of kept) {
      const text = pageText.slice(as, ae);
      // main.js:2318 drops a sentence whose Range has no client rects. We have
      // no DOM; approximate: drop if every covered item has zero width.
      const a = locate(as), b = locate(ae - 1);
      const covered = items.slice(a.divIdx, b.divIdx + 1);
      if (covered.every((it) => !(it.width > 0))) { dropped.push(text); continue; }
      const unmapped = (text.match(/[\u0000-\u001f]/g) ?? []).length; // main.js:2324
      const speech = text.replace(/[\u0000-\u001f]+/g, " "); // main.js:2344
      // main.js:2990 ensurePrefetch: never synthesise speech with no letters
      const skipped = !/[A-Za-z]/.test(speech);
      out.push({ text, speech, unmapped, skipped, start: as, end: ae, firstItem: a.divIdx, lastItem: b.divIdx });
    }
  }
  return { strs, resolved, pageText: pageTextAll, sentences: out, dropped };
}

export async function pageSentences(doc, pn, opts = {}) {
  const page = await doc.getPage(pn);
  const tc = await page.getTextContent(opts); // main.js:1412 calls with NO options
  const r = buildSentences(tc.items);
  r.items = tc.items;
  r.styles = tc.styles;
  return r;
}
