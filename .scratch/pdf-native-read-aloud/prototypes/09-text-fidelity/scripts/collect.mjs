// Run the app-faithful pipeline over both test-bench PDFs and attribute the
// resulting TTS strings to cases. -> bench/results.json
import { openPdf, pageSentences } from "./pipeline.mjs";
import fs from "node:fs";

const B = process.argv[2] || "bench";
const cases = JSON.parse(fs.readFileSync(`${B}/cases.json`, "utf8"));
const out = { synthetic: [], real: [] };

// ---- synthetic: walk every sentence in reading order, assign by visible IDs
{
  const doc = await openPdf(`${B}/blitz-text-testbench.pdf`);
  const byId = Object.fromEntries(cases.map((c) => [c.id, { ...c, sentences: [] }]));
  let current = null;
  let nextIdx = 0;
  const ID = /\b([JSPM]-\d\d)\./g;
  for (let pn = 1; pn <= doc.numPages; pn++) {
    const r = await pageSentences(doc, pn);
    for (const s of r.sentences) {
      // accept IDs only in document order, so prose that merely mentions an
      // ID ("Every case has an ID like J-03") does not open that case
      const ids = [];
      for (const m of s.text.matchAll(ID)) if (cases[nextIdx] && m[1] === cases[nextIdx].id) { ids.push(m); nextIdx++; }
      const rec = { page: pn, text: s.text, speech: s.speech, unmapped: s.unmapped, skipped: s.skipped };
      if (!ids.length) { if (current) byId[current].sentences.push(rec); continue; }
      if (current && /[A-Za-z0-9]/.test(s.text.slice(0, ids[0].index))) byId[current].sentences.push({ ...rec, sharedWith: ids[0][1] });
      for (const m of ids) byId[m[1]].sentences.push(rec);
      current = ids[ids.length - 1][1];
    }
    for (const d of r.dropped) if (current) byId[current].sentences.push({ page: pn, text: d, speech: null, dropped: true });
  }
  for (const c of cases) {
    const x = byId[c.id];
    // A sentence that is nothing but "J-01." or the case's own label is the
    // bench's scaffolding: shown in the report, kept out of the audio.
    const label = c.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const SECTION = /^(?:Junk that should not be spoken Each case.*|Symbols that must be spoken Each case.*|Prose mechanics Each case.*|Mathematics in context Each case.*)$/;
    for (const s of x.sentences) {
      // only the bench's own words count as scaffold; anything with a running
      // header or page number glued on is real evidence and stays audible
      const core = s.text.trim();
      s.scaffold = new RegExp(`^(${c.id}\\.)?\\s*(${label}\\.)?$`).test(core) || SECTION.test(core);
    }
    out.synthetic.push(x);
  }
}

// ---- real excerpts: one page per source page, as assembled in real-excerpts.pdf
{
  const rc = JSON.parse(fs.readFileSync("real_cases.json", "utf8"));
  const manifest = JSON.parse(fs.readFileSync(`${B}/real-excerpts-manifest.json`, "utf8"));
  const doc = await openPdf(`${B}/real-excerpts.pdf`);
  const dir = "/home/homefree/Development/blitz/sample_books/";
  const origDocs = {};
  for (const c of rc) {
    const m = manifest.find((m) => m.cases.includes(c.id));
    const r = await pageSentences(doc, m.excerpt_page);
    origDocs[m.book] ??= await openPdf(dir + m.file);
    const ro = await pageSentences(origDocs[m.book], c.pn);
    const same = JSON.stringify(ro.sentences.map((s) => s.speech)) === JSON.stringify(r.sentences.map((s) => s.speech));
    const re = new RegExp(c.match);
    const hits = r.sentences.filter((s) => re.test(s.text));
    out.real.push({ ...c, section: "R", file: m.file, excerpt_page: m.excerpt_page, identicalToSource: same,
      on_page: `${m.book} p.${c.pn} (excerpt page ${m.excerpt_page})`,
      sentences: hits.map((s) => ({ page: m.excerpt_page, text: s.text, speech: s.speech, unmapped: s.unmapped, skipped: s.skipped })) });
  }
}
fs.writeFileSync(`${B}/results.json`, JSON.stringify(out, null, 1));
console.log("synthetic", out.synthetic.length, "real", out.real.length, "real identical to source:", out.real.every((r) => r.identicalToSource));
