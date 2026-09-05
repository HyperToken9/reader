# 03 — How is reading order recovered from a multi-column PDF?

Type: research
Status: resolved

## Question

This is the crux risk of the entire effort. PDF text is stored in content-stream order, which is the order a generator happened to emit drawing operations — for a two-column page that is frequently *not* reading order, and running headers, footers, page numbers, figure captions, footnotes and margin notes arrive interleaved with body text carrying no reliable labelling. If reading order can't be recovered acceptably, the audio jumps around the page and the product does not work.

Survey how this problem is actually solved:

- **Classical geometric algorithms**: recursive XY-cut, Docstrum, Voronoi-based segmentation, whitespace-density column detection. How well does each handle two-column text, figures interrupting a column, and spanning headers? What are their known failure modes?
- **What existing tools do**: how do PyMuPDF (`get_text("blocks")` / sort flag), pdfplumber, pdfminer.six's `LAParams`, Poppler's `pdftotext -layout`, `unstructured.io`, Marker, and Grobid recover order? Which of these have transplantable *algorithms* even though they're Python/C++?
- **Client-side JS viability** — the load-bearing question, since the prototype is a browser web app. Is there any JS library that does layout analysis on PDF.js output? If not, how much of an XY-cut or column-detection pass is realistic to implement directly against `getTextContent()` items? Roughly how much code?
- **Region classification**: how are running headers/footers distinguished from body text (repetition across pages, position bands)? How are figure captions, footnotes (font size, position, leading marker) and display equations identified? Note that equations in PDFs often appear as text items in a maths font, or as vector drawings with no text at all — which is it typically, and how is it detected?
- **Marked content / tagged PDFs**: some PDFs carry a structure tree giving explicit reading order and semantic roles. How often do real textbooks have this, can PDF.js expose it (`getStructTree`), and is it trustworthy enough to use as a fast path when present?
- Is there a pragmatic 80% approach — e.g. detect column count via vertical whitespace, sort within columns top-to-bottom, drop repeated header/footer bands — that gets acceptable results without full document-layout ML?

Report the recommended approach for a browser-side prototype, with its expected failure modes stated plainly.

## Answer

Full findings: [`../research/03-reading-order-algorithms.md`](../research/03-reading-order-algorithms.md)

**Write it ourselves — the pragmatic 80% approach is the answer, and it's ~600–900 lines of TypeScript.**

**No JS library does this.** Searched the npm registry across seven queries. `pdfreader`'s "column detection" is table-cell clustering, not layout analysis. `@embedpdf/plugin-layout-analysis` is v0.0.1 with no README. `@makibm/layt` does XY-cut on *images*. `ppu-doclayout` (ONNX PP-DocLayoutV2 in-browser) is the only real ML escape hatch — one version, one author, needs page rasters; note it, don't build on it. PDF.js won't help either: issues [#17191](https://github.com/mozilla/pdf.js/issues/17191) and [#14493](https://github.com/mozilla/pdf.js/issues/14493) sit open with no maintainer commitment.

**Recommended pipeline** (per page, after one document-level pass):
0. **Document-level**: sample ~20 pages, key top/bottom-band text by (digit-normalised string, quantised x/y); anything recurring on ≥50% is a running head/footer kill-band. This is how GROBID does it, and it is the highest-confidence classifier we get.
1. Cluster `getTextContent()` items into lines (pdfminer's rule: v-overlap + `hdistance < max(w0,w1)*2.0`).
2. **Bands before columns**: y-project line boxes, split at full-width strips (spanning headings, wide figures). This is the mitigation for XY-cut's worst failure mode and is why the order matters.
3. **Columns per band**: x-projection histogram, gutters = zero-runs wider than ~1.5× median space and taller than ~60% of band height.
4. Assign lines by x-midpoint, columns L→R, lines T→B, concatenate.
5. Strip kill-bands; classify captions (`Figure N`/`Table N` opening token is the cheapest, most reliable signal), footnotes (bottom + smaller font + superscript marker), equations.

**Tagged-PDF fast path: real, free, and already wired — but a bonus, never the plan.** `getStructTree()` emits content leaves as `` `p${pageObjId}_mc${mcid}` `` (`struct_tree.js`), and `getTextContent({includeMarkedContent:true})` emits `` `${getPageObjId()}_mc${mcid}` `` where `getPageObjId()` returns `` `p${ref}` `` (`evaluator.js`, `document.js` L128). **Identical construction — join on the string, ~60 lines.** Bonuses: `/Artifact` content carries no MCID so running heads vanish for free; `role: "Formula"` (+ `mathML`) hands us the equation hook for ticket 07; `Caption`/`Note`/`H1`–`H6` give the rest.

But prevalence is low and falling: **12.6% tagged** across 19,997 scholarly PDFs 2014–2023, 6.8% for Tab Order, 74.9% meeting *no* criteria ([ASSETS '24](https://arxiv.org/abs/2410.03022)), declining since 2017. Textbooks skew up (publisher procurement pressure) but STEM skews hard down — pdfTeX emitted no tags at all, and the LaTeX tagging project only lands in the **2026-11-01** release, so every existing LaTeX textbook is untagged. And presence ≠ correctness: the same paper documents auto-tagged PDFs where "the tagged order conflicts with intuitive visual cues". **So: don't branch on `getStructTree() !== null`.** Build geometry first, compute both orders, adopt the struct tree only when it broadly agrees with geometry (inversion count under threshold). Also check `getMarkInfo().Suspects`.

**Algorithms surveyed.** XY-cut is tiny (~130 lines core in Unstructured's `xycut.py`) but spanning figures kill the global cut and one stray glyph in the gutter collapses it. Breuel's whitespace-cover (DAS 2002, "under 100 lines", globally optimal, no heuristics) is the better idea to steal — tall empty rectangles survive a spanning figure. Docstrum and Voronoi solve a scanned-image problem we don't have; `getTextContent()` already gives us lines. pdfminer's `boxes_flow` scalar blend is a fudge (see its own issues #398/#411) — take its char→line clustering, not its sort. Closest existing template is PyMuPDF's `multi_column.py`: **337 lines total including docstring and CLI**, and its candid restrictions transfer to us verbatim ("image captions are not recognized and are handled like normal text").

**Failure modes, plainly.** Worst three: (1) text wrapping around an inset figure — outside the rectangular model, unfixable by tuning; (2) **sidebars and boxed "worked example" panels — geometrically indistinguishable from a narrow column**, will be read as body prose in the wrong place; this is the dominant textbook-specific failure; (3) chapter-opener furniture (drop caps, epigraphs, one-off titles) — repetition detection can't see a one-off. Also: gutter contamination by a vertical rule or straddling subscript; mid-page column-count changes with a figure slightly overhanging the gutter; tables (detect and skip — cell-by-cell audio is useless regardless of order); hyphenation and cross-page sentence continuation.

**Verdict: the crux risk is surmountable.** It decomposes into ordering (easy — a gutter is a large, stable whitespace feature, solved geometrically for forty years) and classification (hard — where every failure above lives). Critically, **classification error is cheap here because the reader is looking at the real page**: the sentence band *is* the error-recovery UI, which is a wholly different failure than blind TTS scrambling audio with no visual anchor. So the bar is not per-page perfection — it is correct order over runs of prose long enough to sit and listen to, with a visible cursor.

**For ticket 06, measure rather than just build**: implement passes 1–4 only, skip classification, score *page-level* order correctness by eye against the ticket-01 corpus. ~80–85% closes the risk. If it doesn't, the failing pages name which mode dominates. **Check the corpus composition early** — if it's dominated by heavily-designed sidebar-rich modern textbooks rather than conventional two-column academic ones, classification moves onto the critical path and an ONNX layout model stops being a footnote.
