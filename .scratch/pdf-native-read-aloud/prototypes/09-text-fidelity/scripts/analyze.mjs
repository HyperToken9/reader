// Part 2 measurements over out/dump.json -> out/measure.json (+ console summary)
import fs from "node:fs";
const pages = JSON.parse(fs.readFileSync("out/dump.json", "utf8"));

// ---------- dictionary
const dict = new Set();
for (const f of ["/usr/share/dict/american-english", "/usr/share/dict/british-english"]) {
  for (const w of fs.readFileSync(f, "utf8").split("\n")) {
    if (!w || w.includes("'")) continue;
    dict.add(w.toLowerCase());
  }
}
const SHORT_OK = new Set(("a an the of to in is it on at by as be or we he so if no do up us my me and for are but not you all can has had was one our out its may use two new now how any see way who did get let set our his her him she they them this that with from have will each than then also into more most only over such when what which where while our been were some time like just very well much many same both even here there these those your one ten six few off own old big end top low per via add run call code type data line case form game file make take give find work know show tell move hand fact part point rate body mass free real step frame name next last first test true false value list item node tree text word page book key sign")
  .split(/\s+/));
const inDict = (w) => {
  w = w.toLowerCase();
  if (dict.has(w)) return true;
  for (const suf of ["s", "es", "ed", "d", "ing", "ly", "er", "ers", "est"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      const st = w.slice(0, -suf.length);
      if (dict.has(st) || dict.has(st + "e")) return true;
    }
  }
  return false;
};
const partOk = (p) => (p.length <= 3 ? SHORT_OK.has(p) : p.length >= 4 && inDict(p) && (p.length >= 5 || SHORT_OK.has(p) || dict.has(p)));
function weldSplit(tok) {
  const w = tok.toLowerCase();
  if (w.length < 6 || inDict(w)) return null;
  // prefer the split with the longest shorter part
  let best = null;
  for (let i = 2; i <= w.length - 2; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (partOk(a) && partOk(b)) {
      const sc = Math.min(a.length, b.length);
      if (!best || sc > best.sc) best = { a, b, i, sc };
    }
  }
  return best;
}

// ---------- per page
const books = {};
const B = (b) => (books[b] ??= { pages: 0, words: 0, sentences: 0, ttsChars: 0, welds: [], weldsCamel: 0, hyphenWelds: [], junk: {}, junkExamples: {}, furniture: 0, furnitureSentences: 0, furnitureEx: [], dropped: 0, skipped: 0, droppedEx: [], fontWelds: {}, fontWords: {}, normDiff: {}, normDiffPages: 0, normSentDelta: 0, unmappedSent: 0, nonAscii: {} });

const JUNK = [
  ["bracket/box pieces", /[⎛-⎳─-╿▀-▟]/gu],
  ["private-use", /[-\u{f0000}-\u{ffffd}]/gu],
  ["replacement/unmappable", /[�]/gu],
  ["C0 controls (unmapped glyph, stripped before TTS)", /[\u0000-\u0008\u000b-\u001f]/gu],
  ["math alphanumerics", /[\u{1d400}-\u{1d7ff}]/gu],
  ["dot leaders", /(?:\. ?){4,}|…{2,}|(?:․|‧){3,}/gu],
  ["zero-width / soft hyphen", /[​-‏­⁠﻿]/gu],
  ["lone operator token", /(?<=^|\s)[=+−×÷*/<>≤≥≠≈∼~^|·∗∘⋅]+(?=\s|$)/gu],
  ["combining/spacing accents (˙ ˆ ¨ ¯)", /[ˆ-˝̀-ͯ¨¯´¸]/gu],
  ["arrows", /[←-⇿⟰-⟿]/gu],
  ["math operators block", /[∀-⋿⨀-⫿]/gu],
  ["greek", /[Ͱ-Ͽ]/gu],
  ["dingbats/bullets", /[•■-◿✀-➿❖‣⁃◦]/gu],
];

const bandFreq = {};
for (const p of pages) {
  const [, y0, , y1] = p.view; const H = y1 - y0;
  const m = (bandFreq[p.book] ??= new Map());
  const seen = new Set();
  for (const it of p.items) {
    const t = it.s.trim();
    if (t.length < 3 || !(it.y > y1 - 0.08 * H || it.y < y0 + 0.08 * H)) continue;
    seen.add(t.replace(/\d+/g, "#"));
  }
  for (const k of seen) m.set(k, (m.get(k) ?? 0) + 1);
}
for (const p of pages) {
  const b = B(p.book);
  b.pages++;
  const [, y0, , y1] = p.view;
  const H = y1 - y0;
  // furniture items: in the top or bottom 8% band AND (a bare page number, or
  // a digit-normalised string that recurs in that band on >=3 sampled pages)
  const furnIdx = new Set();
  p.items.forEach((it, i) => {
    const t = it.s.trim();
    if (!t || !(it.y > y1 - 0.08 * H || it.y < y0 + 0.08 * H)) return;
    if (/^(\d{1,4}|[ivxlc]{1,6})$/i.test(t) || (bandFreq[p.book].get(t.replace(/\d+/g, "#")) ?? 0) >= 3) furnIdx.add(i);
  });
  // item offsets in pageText, recomputed exactly like buildSentences
  const offs = []; let acc = 0;
  for (const it of p.items) {
    const hy = it.eol && /[-‐­]$/.test(it.s);
    const str = hy ? it.s.slice(0, -1) : it.s;
    offs.push({ start: acc, end: acc + str.length, hy, eol: it.eol });
    acc += str.length;
    if (it.eol && !hy && !/\s$/.test(str)) acc += 1;
  }
  const itemAt = (idx) => { let lo = 0, hi = offs.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (offs[m].start <= idx) lo = m; else hi = m - 1; } return lo; };

  for (const s of p.sentences) {
    if (s.skipped) { b.skipped++; continue; }
    b.sentences++;
    b.ttsChars += s.speech.length;
    if (s.unmapped) b.unmappedSent++;
    const words = s.speech.match(/[A-Za-z]+/g) ?? [];
    b.words += words.length;
    for (const m of s.speech.matchAll(/[A-Za-z]+/g)) {
      const fi = itemAt(s.start + m.index);
      const fname = p.fonts[p.items[fi].f] || p.items[fi].f;
      b.fontWords[fname] = (b.fontWords[fname] || 0) + 1;
    }
    // welds
    for (const m of s.speech.matchAll(/(?<![A-Za-z0-9_.])[A-Za-z]+(?![A-Za-z0-9_(])/g)) {
      const tok = m[0];
      const camel = /^[a-z]+[A-Z]/.test(tok) || /[a-z][A-Z]/.test(tok.slice(1));
      if (camel) { if (weldSplit(tok)) b.weldsCamel++; continue; }
      if (/^[A-Z]{2,}/.test(tok)) continue; // acronyms
      const sp = weldSplit(tok);
      if (!sp) continue;
      const at = s.start + m.index + sp.i;
      const ia = itemAt(s.start + m.index + sp.i - 1), ib = itemAt(at);
      let kind;
      if (ia !== ib) kind = offs[ia].hy ? "dropped-hyphen at line end" : offs[ia].eol ? "eol" : "item boundary, no space item";
      else kind = "inside one item (pdf.js spacing heuristic)";
      const fname = p.fonts[p.items[ib].f] || p.items[ib].f;
      const ctx = s.speech.slice(Math.max(0, m.index - 30), m.index + tok.length + 30);
      const rec = { book: p.book, pn: p.pn, tok, split: sp.a + " " + sp.b, kind, font: fname, ctx };
      if (kind === "dropped-hyphen at line end") b.hyphenWelds.push(rec); else b.welds.push(rec);
      b.fontWelds[fname] = (b.fontWelds[fname] || 0) + (kind === "dropped-hyphen at line end" ? 0 : 1);
    }
    // junk
    for (const [name, re] of JUNK) {
      const target = name.startsWith("C0") ? s.text : s.speech;
      const n = (target.match(re) || []).length;
      if (n) {
        b.junk[name] = (b.junk[name] || 0) + n;
        (b.junkExamples[name] ??= []).length < 4 && b.junkExamples[name].push(`p${p.pn}: ${JSON.stringify(s.speech.slice(0, 160))}`);
      }
    }
    for (const ch of s.speech) if (ch.codePointAt(0) > 127) b.nonAscii[ch] = (b.nonAscii[ch] || 0) + 1;
    // furniture reaching speech
    let furnChars = 0; const fis = [];
    for (let i = s.firstItem; i <= s.lastItem; i++) if (furnIdx.has(i)) { furnChars += p.items[i].s.length; fis.push(p.items[i].s.trim()); }
    if (furnChars) {
      b.furniture += furnChars; b.furnitureSentences++;
      if (b.furnitureEx.length < 6) b.furnitureEx.push(`p${p.pn}: [${fis.join(" | ").slice(0, 80)}] in ${JSON.stringify(s.speech.slice(0, 140))}`);
    }
  }
  b.dropped += p.dropped.length;
  for (const d of p.dropped) if (b.droppedEx.length < 6) b.droppedEx.push(`p${p.pn}: ${JSON.stringify(d.slice(0, 80))}`);
  // normalisation diff
  if (p.rawPageText !== p.pageText) {
    b.normDiffPages++;
    const a = [...p.pageText], r = [...p.rawPageText];
    const ca = {}, cr = {};
    for (const c of a) if (c.codePointAt(0) > 127) ca[c] = (ca[c] || 0) + 1;
    for (const c of r) if (c.codePointAt(0) > 127) cr[c] = (cr[c] || 0) + 1;
    for (const c of new Set([...Object.keys(ca), ...Object.keys(cr)])) {
      const d = (cr[c] || 0) - (ca[c] || 0);
      if (d) b.normDiff[c] = (b.normDiff[c] || 0) + d;
    }
  }
  b.normSentDelta += p.rawSentences.length - p.sentences.length;
}

const summary = {};
for (const [k, b] of Object.entries(books)) {
  const fontRates = Object.entries(b.fontWords).filter(([, n]) => n >= 200).map(([f, n]) => ({ font: f, words: n, welds: b.fontWelds[f] || 0, per1k: +((1000 * (b.fontWelds[f] || 0)) / n).toFixed(2) })).sort((x, y) => y.per1k - x.per1k);
  const kinds = {}; for (const w of b.welds) kinds[w.kind] = (kinds[w.kind] || 0) + 1;
  summary[k] = {
    pages: b.pages, sentences: b.sentences, words: b.words, ttsChars: b.ttsChars,
    weldCandidates: b.welds.length, weldPer1kWords: +((1000 * b.welds.length) / b.words).toFixed(2), weldKinds: kinds, camelCandidates: b.weldsCamel,
    hyphenDropWelds: b.hyphenWelds.length,
    fontRates: fontRates.slice(0, 8),
    junk: b.junk, junkExamples: b.junkExamples,
    furnitureSentences: b.furnitureSentences, furnitureChars: b.furniture, furnitureEx: b.furnitureEx,
    droppedSilently: b.dropped, droppedEx: b.droppedEx, skippedNoLetters: b.skipped, unmappedSentences: b.unmappedSent,
    normDiffPages: b.normDiffPages, normDiff: b.normDiff, normSentenceDelta: b.normSentDelta,
    nonAscii: Object.fromEntries(Object.entries(b.nonAscii).sort((x, y) => y[1] - x[1])),
  };
}
const allWelds = Object.values(books).flatMap((b) => b.welds);
const allHy = Object.values(books).flatMap((b) => b.hyphenWelds);
fs.writeFileSync("out/measure.json", JSON.stringify({ summary, welds: allWelds, hyphenWelds: allHy }, null, 1));
for (const [k, s] of Object.entries(summary)) {
  console.log(`\n== ${k}: ${s.pages}pp ${s.sentences} sents ${s.words} words | welds ${s.weldCandidates} (${s.weldPer1kWords}/1k) ${JSON.stringify(s.weldKinds)} camel ${s.camelCandidates} | hyphen-drop welds ${s.hyphenDropWelds}`);
  console.log(" fonts", JSON.stringify(s.fontRates.slice(0, 5)));
  console.log(" junk", JSON.stringify(s.junk));
  console.log(" furniture sents", s.furnitureSentences, "dropped", s.droppedSilently, "skipped", s.skippedNoLetters, "unmapped sents", s.unmappedSentences);
  console.log(" normDiffPages", s.normDiffPages, JSON.stringify(s.normDiff), "sentDelta", s.normSentenceDelta);
}
