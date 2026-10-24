// Dump the app-faithful pipeline output for a spread sample of pages from every
// PDF in sample_books, in both normalisation modes. -> out/dump.json
import { openPdf, buildSentences } from "./pipeline.mjs";
import fs from "node:fs";

const dir = "/home/homefree/Development/blitz/sample_books/";
const PER_BOOK = Number(process.env.PER_BOOK || 75);
const books = fs.readdirSync(dir).filter((f) => f.endsWith(".pdf"));
const short = (f) => f.startsWith("Game") ? "millington" : f.startsWith("Textbook") ? "biochem" : f.startsWith("crafting") ? "crafting" : f.startsWith("lejepa") ? "lejepa" : f.startsWith("theCode") ? "codebook" : f;
fs.mkdirSync("out", { recursive: true });
const out = [];
for (const f of books) {
  const doc = await openPdf(dir + f);
  const n = doc.numPages;
  const pns = new Set();
  if (n <= PER_BOOK) for (let i = 1; i <= n; i++) pns.add(i);
  else for (let k = 0; k < PER_BOOK; k++) pns.add(1 + Math.round((k * (n - 1)) / (PER_BOOK - 1)));
  for (const extra of (process.env.EXTRA_PAGES || "").split(",").filter(Boolean)) {
    const [b, p] = extra.split(":"); if (b === short(f)) pns.add(Number(p));
  }
  for (const pn of [...pns].sort((a, b) => a - b)) {
    const page = await doc.getPage(pn);
    const tc = await page.getTextContent();
    const tcRaw = await page.getTextContent({ disableNormalization: true });
    const r = buildSentences(tc.items);
    const rr = buildSentences(tcRaw.items);
    // real font names: need the operator list to have loaded the fonts
    let fonts = {};
    try {
      await page.getOperatorList();
      for (const fn of new Set(tc.items.map((i) => i.fontName))) {
        try { const fo = page.commonObjs.get(fn); fonts[fn] = fo?.name || fo?.loadedName || fn; } catch { fonts[fn] = fn; }
      }
    } catch {}
    out.push({
      book: short(f), file: f, pn, view: page.view,
      items: tc.items.map((i) => ({ s: i.str, eol: i.hasEOL, f: i.fontName, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height })),
      fonts,
      pageText: r.pageText, sentences: r.sentences.map(({ text, speech, unmapped, skipped, start, end, firstItem, lastItem }) => ({ text, speech, unmapped, skipped, start, end, firstItem, lastItem })), dropped: r.dropped,
      rawPageText: rr.pageText, rawSentences: rr.sentences.map((s) => s.speech), rawItemsStr: tcRaw.items.map((i) => i.str),
    });
    page.cleanup();
  }
  console.error(short(f), n, "pages, sampled", pns.size);
  await doc.loadingTask?.destroy?.();
}
fs.writeFileSync("out/dump.json", JSON.stringify(out));
console.error("pages", out.length);
