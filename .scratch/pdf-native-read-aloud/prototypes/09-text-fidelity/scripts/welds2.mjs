// Weld / split detection with a second extractor (poppler pdftotext) as a
// referee. pdf.js token T is a WELD if pdftotext has two adjacent tokens a,b
// with a+b == T and T itself never appears in pdftotext's page. A pdf.js token
// pair "a b" is a SPLIT if pdftotext has the single token a+b and never the
// pair. Dictionary is used as a second, independent signal.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const pages = JSON.parse(fs.readFileSync("out/dump.json", "utf8"));
const dir = "/home/homefree/Development/blitz/sample_books/";
const dict = new Set();
for (const f of ["/usr/share/dict/american-english", "/usr/share/dict/british-english"])
  for (const w of fs.readFileSync(f, "utf8").split("\n")) if (w && !w.includes("'")) dict.add(w.toLowerCase());
const inDict = (w) => { w = w.toLowerCase(); if (dict.has(w)) return true; for (const s of ["s", "es", "ed", "d", "ing", "ly"]) if (w.endsWith(s) && dict.has(w.slice(0, -s.length))) return true; return false; };
const toks = (t) => (t.normalize("NFKC").match(/[A-Za-z]+/g) ?? []);
const res = {};
const ex = { weld: [], split: [] };
for (const p of pages) {
  const ref = execFileSync("pdftotext", ["-f", String(p.pn), "-l", String(p.pn), "-enc", "UTF-8", dir + p.file, "-"], { encoding: "utf8", maxBuffer: 1 << 26 });
  const rt = toks(ref);
  const refSet = new Set(rt.map((w) => w.toLowerCase()));
  const refPairs = new Map(); // joined -> "a b"
  const refPairSet = new Set();
  for (let i = 0; i + 1 < rt.length; i++) { refPairs.set((rt[i] + rt[i + 1]).toLowerCase(), rt[i] + " " + rt[i + 1]); refPairSet.add((rt[i] + " " + rt[i + 1]).toLowerCase()); }
  const r = (res[p.book] ??= { words: 0, welds: 0, splits: 0, weldsDict: 0, splitsDict: 0, pagesWithSplit: new Set(), pagesWithWeld: new Set() });
  for (const s of p.sentences) {
    if (s.skipped) continue;
    const t = toks(s.speech);
    r.words += t.length;
    for (let i = 0; i < t.length; i++) {
      const T = t[i], L = T.toLowerCase();
      if (L.length >= 4 && !refSet.has(L) && refPairs.has(L)) {
        r.welds++; r.pagesWithWeld.add(p.pn);
        const dictSays = !inDict(L);
        if (dictSays) r.weldsDict++;
        ex.weld.push({ book: p.book, pn: p.pn, tok: T, ref: refPairs.get(L), dictNonWord: dictSays, ctx: s.speech.slice(Math.max(0, s.speech.indexOf(T) - 30), s.speech.indexOf(T) + T.length + 30) });
      }
      if (i + 1 < t.length) {
        const J = (T + t[i + 1]).toLowerCase();
        if (J.length >= 4 && refSet.has(J) && !refPairSet.has((T + " " + t[i + 1]).toLowerCase())) {
          // must be adjacent in speech with only whitespace between
          const k = s.speech.indexOf(T + " " + t[i + 1]);
          if (k < 0) continue;
          r.splits++; r.pagesWithSplit.add(p.pn);
          const dictSays = inDict(J) && (!inDict(T) || !inDict(t[i + 1]));
          if (dictSays) r.splitsDict++;
          ex.split.push({ book: p.book, pn: p.pn, pair: T + " " + t[i + 1], ref: J, dictConfirms: dictSays, ctx: s.speech.slice(Math.max(0, k - 30), k + 40) });
        }
      }
    }
  }
}
const out = {};
for (const [b, r] of Object.entries(res)) out[b] = { words: r.words, welds: r.welds, weldsPer1k: +(1000 * r.welds / r.words).toFixed(2), weldsAlsoNonDict: r.weldsDict, splits: r.splits, splitsPer1k: +(1000 * r.splits / r.words).toFixed(2), splitsDictConfirmed: r.splitsDict, pagesWithWeld: r.pagesWithWeld.size, pagesWithSplit: r.pagesWithSplit.size };
console.log(JSON.stringify(out, null, 1));
fs.writeFileSync("out/welds2.json", JSON.stringify({ summary: out, ex }, null, 1));
