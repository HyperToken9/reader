# Research: recovering reading order from a multi-column PDF, client-side

Ticket: `.scratch/pdf-native-read-aloud/issues/03-reading-order-algorithms.md`
Date: 2026-09-05

---

## Bottom line

Write it yourself. There is **no JavaScript library that does document layout analysis on PDF.js output** — the npm registry has nothing, and PDF.js explicitly does not do it. But the algorithms that matter are small, and the two that matter most are genuinely small in JS:

1. **Tagged-PDF fast path.** When a structure tree is present, PDF.js gives you explicit reading order and semantic roles, and the join back to text items is *already wired* — same ID format on both sides. Free, exact, and it drops running heads for you. But expect it on **only ~13% of documents**, and it must be validated, not trusted.
2. **Geometric fallback: whitespace-gap column detection + in-column sort + cross-page repetition stripping.** This is the pragmatic 80% approach the ticket hypothesises, and the evidence supports it. Estimated **600–900 lines of TypeScript** for a good version.

Recursive XY-cut is the classical algorithm for this and is genuinely tiny (~130 lines core). But for the specific case of *textbook body prose*, a simpler column-band approach is more robust than full XY-cut, for reasons below.

**Verdict on the crux risk: surmountable, with a named residual.** Two-column body prose is a solved geometry problem. What is not solved cheaply is *classification* — knowing that a block is a caption, a footnote, or a sidebar rather than prose. That is where the honest failure modes live, and the mitigation is product-shaped, not algorithm-shaped.

---

## 1. The tagged-PDF fast path

### It exists, and the plumbing is complete

`PDFPageProxy.getStructTree()` "is resolved with a `StructTreeNode` object that represents the page's structure tree, or `null` when no structure tree is present for the current page" ([api.js typedefs](https://raw.githubusercontent.com/mozilla/pdf.js/master/src/display/api.js)). Added in [PR #13171](https://github.com/mozilla/pdf.js/pull/13171).

Serialized node shape, from [`src/core/struct_tree.js`](https://raw.githubusercontent.com/mozilla/pdf.js/master/src/core/struct_tree.js): `role`, `children`, `alt`, `lang`, `structId`, `tableAttributes`, `mathML`, `bbox`. Leaf content children are:

```js
{ type: "content", id: `p${kid.pageObjId}_mc${kid.mcid}` }   // struct_tree.js
```

And `getTextContent({ includeMarkedContent: true })` emits, from [`src/core/evaluator.js`](https://raw.githubusercontent.com/mozilla/pdf.js/master/src/core/evaluator.js):

```js
{ type: "beginMarkedContentProps",
  id: `${self.idFactory.getPageObjId()}_mc${mcid}` }
```

where `getPageObjId()` returns `` `p${ref.toString()}` `` ([`src/core/document.js`](https://raw.githubusercontent.com/mozilla/pdf.js/master/src/core/document.js) L128–130).

**The two ID strings are constructed identically.** So: walk the struct tree depth-first, collect `content` IDs in order, and index the marked-content-annotated text items by the same key. That is the whole fast path — maybe 60 lines. No geometry needed.

Three bonuses that fall out of it, all directly relevant to sibling ticket 07:

- **Running heads and page numbers vanish for free.** In a correctly tagged PDF, headers/footers/rules are marked `/Artifact`, which carries no MCID in the structure tree — so they simply never appear among the content IDs you collected. You get the skip policy without writing a header detector.
- **`role: "Formula"`** is an explicit display-equation marker, and `struct_tree.js` extracts an associated `mathML` field when present. That is the announce-and-step-over hook, handed to you.
- Roles `Caption`, `Note`, `TOC`, `H1`–`H6`, `Figure` give the rest of the classification for free.

Known limits in the code: `MAX_DEPTH = 40`, past which subtrees are dropped with a `"StructTree MAX_DEPTH reached"` warning; and bboxes "cannot recover position" from Width/Height attributes alone. Neither bites for prose.

### How often is it actually there? ~13%, and falling

The best primary measurement is Wang et al., *["Uncovering the New Accessibility Crisis in Scholarly PDFs"](https://arxiv.org/abs/2410.03022)* (ASSETS '24), over **19,997 scholarly PDFs published 2014–2023**:

| Criterion | Pass rate |
|---|---|
| Tagged PDF | **12.6%** |
| Tab Order | 6.8% |
| Alt-Text | 8.5% |
| All six criteria | <3.2% |
| **No** criteria at all | 74.9% |

And the trend is *down*: "since 2017, there has been a significant decline in the proportion of PDFs compliant with all criteria except for Default Language", accelerating after 2019.

Two adjustments for textbooks specifically, in opposite directions:

- **Upward**: commercial textbook publishers (Pearson, Cengage, McGraw-Hill) ship accessible editions under US education-procurement accessibility pressure, so a *purchased current-edition* textbook is meaningfully more likely to be tagged than a random paper.
- **Downward, and this is the one that hurts**: STEM textbooks are overwhelmingly LaTeX, and pdfTeX historically emitted **no tags whatsoever**. The [LaTeX Tagged PDF project](https://latex3.github.io/tagging-project/) is only now "finishing phase IV", with the newest tagging features targeted at the **2026-11-01** release — i.e. two months from now, and applying only to documents compiled after that. Every LaTeX textbook already in existence is untagged.

**Conclusion: the fast path is a bonus, never the plan.** Build the geometric pipeline first; bolt the fast path on as an optimisation.

### Is it trustworthy when present?

Only conditionally. The same ASSETS paper is blunt that presence ≠ correctness: their automated checker "fails to interpret the reading sequence or identify issues caused by visually overlaid content, structured differently in the tag tree", producing documents where "the tagged order conflicts with intuitive visual cues". They also attribute observed gains to "automatic enhancements made by creation platforms" rather than author care — i.e. much of that 12.6% is *auto-tagged*, and auto-tagging on a two-column page is exactly where tag order goes wrong.

**Recommended guard.** Do not branch on `getStructTree() !== null`. Branch on a cheap agreement check:

1. Build the struct-tree order.
2. Build the geometric order independently.
3. Compare. If they broadly agree (e.g. Kendall-tau / inversion count over block starts below a threshold), take the struct tree — it is strictly better, since it carries roles.
4. If they disagree badly, the tags are junk. Take geometry.

This costs one extra pass you were computing anyway, and converts an untrustworthy signal into a safe one. Also check `pdfDocument.getMarkInfo()` → `{ Marked, UserProperties, Suspects }`; a `Suspects: true` flag is the PDF's own admission that its tags may be wrong.

---

## 2. Classical geometric algorithms, and which one to actually use

### Recursive XY-cut (Nagy & Seth, 1984)

Alternate horizontal and vertical projection profiles; cut wherever there is a background run wider than a threshold; recurse. Reading order falls out of the recursion order.

The canonical implementation is worth reading because it shows how small this is. Unstructured's [`xycut.py`](https://raw.githubusercontent.com/Unstructured-IO/unstructured/main/unstructured/partition/utils/xycut.py) is 337 lines, but ~200 of that is matplotlib visualisation. The **actual algorithm is three functions in ~130 lines**: `projection_by_bboxes` (accumulate a per-pixel histogram over boxes on one axis, 24 lines), `split_projection_profile` (find zero-runs longer than `min_gap`, 45 lines), `recursive_xy_cut` (sort, project-y, split, project-x per band, recurse, 60 lines). The numpy is trivial loops — porting to TypeScript with a `Int32Array` histogram is close to line-for-line.

**Failure modes, and they are serious for textbooks:**
- **Spanning elements break it globally.** A full-width figure, table, or heading sitting between two columns means *no* vertical cut exists across that band. XY-cut then either fails to split the page into columns at all (giving you zig-zag across-column reading), or, if you recurse y-first, correctly isolates the band but you must then handle each band separately.
- **Any noise touching the gutter destroys the cut.** A single stray glyph, a vertical rule, or a wide superscript straddling the column gap collapses the whitespace run below `min_gap`.
- **Threshold sensitivity.** `min_gap` must scale with font size, and textbooks vary font size heavily within a page.
- It is a strictly rectangular, Manhattan-layout model. Wrapped text around an inset figure is outside its expressive range.

Meunier's [*Optimized XY-Cut for Determining a Page Reading Order*](https://dl.acm.org/doi/10.1109/ICDAR.2005.182) (ICDAR 2005) exists precisely because naive cut-choice gives wrong reading order; it globally optimises the cut sequence rather than taking the widest gap greedily.

### Docstrum (O'Gorman, 1993)

Bottom-up: k-nearest-neighbour vectors between connected components, angle/distance histograms to recover text-line orientation and inter-line spacing, transitive closure to build lines, then blocks. Per [BobLd's DocumentLayoutAnalysis](https://github.com/BobLd/DocumentLayoutAnalysis) (C#/PdfPig ports of all four classics): strong on variable text sizes and non-Manhattan layouts, but "parameter-dependent (character size ratio, distance thresholds)".

**Not worth it here.** Docstrum's whole value is recovering line structure from raw connected components — a scanned-image problem. You have `getTextContent()`, which already hands you positioned text runs. You would be paying Docstrum's parameter-tuning cost to rediscover information you were given.

### Voronoi (Kise et al., 1998)

Area-Voronoi diagram over component boundaries, delete edges by area-ratio and distance thresholds. Best classical accuracy on non-Manhattan layouts. Also the most complex to implement (you need a Voronoi construction), and it produces *regions*, not reading order — you still need a separate ordering pass. Not appropriate for a browser prototype.

### Whitespace cover / Breuel (2002)

[*Two Geometric Algorithms for Layout Analysis*](https://link.springer.com/content/pdf/10.1007/3-540-45869-7_23.pdf), DAS V. Branch-and-bound search for the *n* maximal empty rectangles in the page background, with an evaluation function that "reliably identifies maximal empty rectangles corresponding to column boundaries"; then constrained text-line detection using those rectangles as obstacles.

This is the one I would steal ideas from. Breuel's own claims: "globally optimal solutions", "require no heuristics", "considerably easier to implement than prior methods", and the whitespace analysis "computes rectangular covers without complex geometric structures in **under 100 lines of code**". That is a strong signal for a browser implementation.

Its advantage over XY-cut is exactly the textbook failure case: because it finds *tall* empty rectangles rather than requiring a full-page cut, a spanning figure does not destroy the column gutter — the gutter is still a tall empty rectangle above and below it. BobLd's caveat: Breuel presented it as a demonstration, not a complete system.

---

## 3. What existing tools do

| Tool | Mechanism | Transplantable? |
|---|---|---|
| **pdfminer.six** | Cluster chars → lines → boxes, then sort boxes by `(1 - boxes_flow) * obj.x0 - (1 + boxes_flow) * (obj.y0 + obj.y1)`; `boxes_flow` in [-1, +1] trades horizontal against vertical priority. Defaults: `char_margin=2.0`, `line_margin=0.5`, `word_margin=0.1`, `boxes_flow=0.5`. ([layout.py](https://github.com/pdfminer/pdfminer.six/blob/master/pdfminer/layout.py)) | **Yes, partly — and this is the single most useful steal.** The char→line→block clustering rules are simple and directly applicable: same-line if `is_voverlap` and `hdistance < max(w0,w1)*char_margin`; lines join a block if left/right/centre-aligned within `ratio * height`. Note the *sort* is a scalar blend, not a column model — it is a fudge, and pdfminer's own issue tracker ([#398](https://github.com/pdfminer/pdfminer.six/issues/398), [#411](https://github.com/pdfminer/pdfminer.six/issues/411)) is full of people getting reversed or interleaved order from it. Take the clustering; don't take the sort. |
| **PyMuPDF `get_text(sort=True)`** | Sorts blocks by vertical then horizontal coordinate. Docs concede it only "in many cases should suffice"; the [FAQ](https://pymupdf.readthedocs.io/en/latest/faq/index.html) admits the generator "may decide to first write all the text of the left column, then that of the right column" and `sort` does not fix multi-column. | The naive baseline. Documents that pure y-then-x sorting is *not* enough — which is the whole reason this ticket exists. |
| **PyMuPDF `multi_column.py`** | **The closest existing thing to what we want.** Takes block bboxes as the structuring primitive, then iteratively joins/extends rectangles that fit the same column, ignoring header/footer bands via `header_margin=50` / `footer_margin=50` and optionally text over images. Returns column bboxes sorted by (y0, x0); caller re-extracts within each. ([source](https://github.com/pymupdf/PyMuPDF-Utilities/blob/master/text-extraction/multi_column.py)) | **Yes — closest algorithmic template, and a hard LOC datapoint: the whole file is 337 lines including a 50-line docstring and a CLI.** Its documented restrictions are candid and transfer directly to us: horizontal LTR only; cannot handle "overlapping (non-disjoint) text blocks"; and **"image captions are not recognized and are handled like normal text"**. |
| **Poppler `pdftotext`** | Default mode reorders to reading order (top-to-bottom, left-to-right) via `TextOutputDev`; `-raw` gives content-stream order; `-layout` preserves *physical* column layout with spacing. | Confirms that a C++ production tool solves this with geometric coalescing, not ML. Algorithm is deep inside `TextOutputDev.cc` and not a clean lift. |
| **GROBID / pdfalto** | pdfalto supplies line/block/position/style and does "line number detection, text order recovery at block level, and column detection"; GROBID then extracts headers/footers and **removes them from body text**. ([principles](https://grobid.readthedocs.io/en/latest/Principles/)) | The architectural lesson: header/footer removal is a *document-level* pass, done before body assembly. Not per-page. |
| **unstructured.io** | `SORT_MODE_BASIC` / `SORT_MODE_XY_CUT` / `SORT_MODE_DONT`; always basic-sorts first for determinism, then applies XY-cut. Classification comes from a **layout detection model** (YOLOX/Detectron2), not geometry. ([pdf.py](https://github.com/Unstructured-IO/unstructured/blob/main/unstructured/partition/pdf.py), [sorting.py](https://github.com/Unstructured-IO/unstructured/blob/main/unstructured/partition/utils/sorting.py), 268 lines) | XY-cut code lifts cleanly. The classifier does not. |
| **Marker / Surya** | rf-detr layout detector in fast mode, or a ~650M-param VLM; **reading order is predicted end-to-end by the model**. ([surya](https://github.com/datalab-to/surya)) | State of the art, and out of reach client-side. Confirms the ML frontier explicitly beats "the heuristic XYCut algorithm" on reading-order distance — so we should expect to lose on hard pages, and should know which ones. |

---

## 4. Client-side JS viability — the load-bearing question

### Nothing exists

I searched the npm registry across `reading order`, `layout analysis`, `pdf columns`, `xy-cut`, `pdf text extraction layout`, `pdf reading order`, and `document layout`. Findings:

- **`pdfreader`** — advertises "automatic column detection", but it is a *table*-extraction helper over pdf2json, clustering cell x-coordinates. Not document layout analysis; will not order a two-column page of prose.
- **`unpdf`, `pdf-parse`, `pdf-lib`, `react-pdf`, `pdfkit`** — no layout analysis. `pdf-lib`/`pdfkit` are writers.
- **`@embedpdf/plugin-layout-analysis`** — version **0.0.1**, no description, no README, depends on `@embedpdf/ai`. Not a thing yet.
- **`@makibm/layt`** — recursive XY-cut on whitespace, but on **images** (png/jpg/webp), not PDF text geometry. Proof the algorithm ports to JS easily; not a usable dependency.
- **`ppu-doclayout`** — "PP-DocLayoutV2 for Web/Node, powered by ONNX Runtime". A single `1.0.0` published 2026-04-05, no README, one dependency. This is the *only* real in-browser ML escape hatch (PP-DocLayoutV2 does predict reading order), but it needs page rasters plus ONNX Runtime Web, and is a one-version, one-author package. Note it as a fallback; do not build on it.

PDF.js itself will not help. [Issue #17191](https://github.com/mozilla/pdf.js/issues/17191) ("(Re)ordering of the PDF textcontent elements in the DOM", Oct 2023) and [#14493](https://github.com/mozilla/pdf.js/issues/14493) ("array of items in getTextContent() not always in correct order") both sit open with no maintainer commitment. PDF.js's job is faithful rendering; reading order is out of scope for it.

### So: how much code?

Concrete anchors, all from source I read:

| Reference implementation | Lines |
|---|---|
| Breuel whitespace cover (author's own claim) | <100 |
| Unstructured `xycut.py`, algorithm only (excl. visualisation) | ~130 |
| Unstructured `sorting.py` (glue, modes, element ordering) | 268 |
| PyMuPDF `multi_column.py` **entire file** incl. docstring + CLI | 337 |

**Estimate for the recommended pipeline in TypeScript: 600–900 lines.** Roughly:

- line assembly from `getTextContent()` items (baseline clustering, x-gap word joins) — 120
- column-gap detection (x-projection histogram over line boxes, gutter scoring) — 100
- band segmentation for full-width spanning elements — 80
- in-column ordering + block/paragraph grouping — 120
- cross-page repeated header/footer detection — 100
- caption / footnote / equation heuristics — 150
- struct-tree fast path + agreement guard — 120

That is one focused week, not a research project. This is decidedly *not* a "thousands of lines" problem.

---

## 5. The recommended pipeline

Per page, after a one-time document-level pass.

**Pass 0 (document-level, once): repeated-band detection.**
Sample N pages (say 20, spread). For each, take text items in the top ~12% and bottom ~12% bands. Normalise each candidate string by replacing digit runs with a placeholder (`§ 4.2 Continuity  57` → `§ N.N Continuity  N`), and key it by (normalised text, quantised x, quantised y). Any key recurring on ≥ ~50% of sampled pages is a running head/footer — record its geometry as a kill-band. This handles verso/recto alternation naturally, because left and right pages produce different keys and each still clears 50% of its own parity if you bucket by parity. GROBID does this document-level, and so should we.

**Pass 1: lines.** Cluster `getTextContent()` items into text lines by baseline. Use pdfminer's rule as the template: same line if vertically overlapping and `hdistance < max(w0, w1) * char_margin`. Sibling ticket 02 owns the transform/geometry details.

**Pass 2: bands.** Project line boxes onto y. Any horizontal strip whose lines span most of the page width and which is bounded above and below by whitespace is a *full-width band* (spanning heading, wide figure, wide table). Split the page into bands at those. Order bands top-to-bottom. This is the step that makes the whole thing survive textbook figures, and it is why you run y-projection *before* column detection.

**Pass 3: columns, per band.** Build an x-projection histogram over the band's line boxes. Find zero-runs (gutters) wider than ~1.5× the median space width and taller than ~60% of the band height. That count + 1 is the column count. Guard: reject a "gutter" that would produce columns narrower than ~15% of page width, and reject candidate splits that cut through more than a couple of line boxes.

**Pass 4: order.** Assign each line to a column by its x-midpoint; sort columns left-to-right; within each column sort top-to-bottom; concatenate. Group into paragraphs by vertical gap versus median leading, plus first-line indent.

**Pass 5: strip and classify.** Drop anything inside a Pass 0 kill-band. Apply the classifiers in §6. Emit prose blocks for TTS with non-prose replaced by placeholders (ticket 07).

**Pass 6: struct-tree override.** If `getStructTree()` is non-null, build its order and run the agreement check from §1. Adopt it when it agrees; keep geometry when it doesn't.

**Why this rather than plain recursive XY-cut:** it is XY-cut restricted to two levels with domain knowledge baked in (y first, then x, then stop). Textbook pages are Manhattan and shallow; unbounded recursion buys nothing and adds ways to go wrong. And band-first is precisely the mitigation for XY-cut's worst failure mode.

---

## 6. Region classification

**Running headers/footers/page numbers** — solved above, by cross-page repetition at stable position. This works well and is the highest-confidence classifier in the pipeline. Pure position bands alone are not enough (a body paragraph can start high on a page); repetition is what makes it safe.

**Footnotes** — bottom of the column, font size below body median (typically 0.75–0.85×), and usually separated from body by a short horizontal rule (a vector path, not text — so it is *invisible* to `getTextContent()`; you would need the operator list to see it). Leading superscript marker is a strong extra signal: a small-font digit sitting above the line baseline.

**Figure captions** — smaller and/or different font from body, adjacent to a large text-free region, and very often opening with a literal `Figure N`/`Fig. N`/`Table N`/`Plate N` token. **The opening-token match is by far the most reliable signal and is trivially cheap.** Worth stating plainly that PyMuPDF's mature `multi_column.py` gives up here — "image captions are not recognized and are handled like normal text" — so a caption regex puts us slightly *ahead* of a well-established tool, not behind it.

**Display equations** — the ticket asks whether these are text or vector. **Typically text, with vector accents.** Both dominant producers emit maths glyphs as real text: pdfTeX draws maths from CM/Latin Modern maths fonts (CMMI, CMSY, CMEX, or their Unicode successors), and Word's equation editor uses Cambria Math. What is *not* text is the connective vector work — fraction bars, radical extensions, over/underbraces, matrix delimiters — which are drawn as filled rectangles and paths. So a display equation typically appears as a cluster of text items in a font different from body text, geometrically scattered off the baseline (superscripts, subscripts, limits), with invisible rules between them.

Detection signals, in order of usefulness:
1. **Font change.** `getTextContent()` gives each item a `fontName` key into `textContent.styles`, whose `TextStyle` carries `{ ascent, descent, vertical, fontFamily }` ([api.js](https://raw.githubusercontent.com/mozilla/pdf.js/master/src/display/api.js) L1184–1188). Caveat: `fontName` is PDF.js's *internal* converted name (`g_d0_f1`), and `fontFamily` is only "the possible font family" — so you may not read "CMMI10" off it. But distinct keys still cluster items by distinct embedded font, which is enough to say "this run is in a different font from body prose".
2. **Baseline scatter.** A prose line has near-constant baseline y; an equation line does not.
3. **Geometry.** Centred (left margin well inside the column) and vertically isolated by more than normal leading.
4. **A right-aligned parenthesised tag** `(3.14)` at the column's right edge — near-conclusive for a numbered display equation.
5. If tagged: `role: "Formula"`, plus `mathML` when the producer supplied it.

**Inline maths inside a prose sentence is a different and harder problem** and this ticket does not solve it. It will be read aloud as whatever glyph string it is, which will sound wrong. Flag for ticket 07.

---

## 7. Failure modes, stated plainly

These are the things that *will* go wrong. None is hypothetical.

1. **Text wrapping around an inset figure.** A figure sitting inside one column with prose flowing round it produces line boxes whose x-extents vary per line. Column detection either splits the page spuriously or merges the wrap into the wrong column. This is outside the rectangular model entirely and no amount of threshold tuning fixes it.
2. **Sidebars, boxed asides, "worked example" panels.** Geometrically indistinguishable from a narrow column. They will be read as body prose, in the wrong place. This is the most common textbook-specific failure, and I would expect it on a meaningful fraction of pages in any modern illustrated textbook. Mitigation is a background-colour / bounding-box-rule check via the operator list, which is real extra work.
3. **Uncaptioned or regex-missed captions** get read as prose mid-flow.
4. **Column-count changes mid-page** (single-column heading → two columns → single-column figure → two columns) — handled by the band pass, *provided* the band boundaries are clean. A figure that only slightly overhangs the gutter produces a band that is neither full-width nor column-local, and confuses both passes.
5. **Gutter contamination.** One stray glyph, a vertical rule between columns, or a wide subscript straddling the gutter can collapse the whitespace run and merge two columns into one. Guard by allowing a gutter to tolerate a small number of intersecting boxes rather than requiring exactly zero.
6. **First page / chapter openers.** Drop caps, running titles that appear only once, epigraphs, chapter-number blocks. Repetition detection cannot see a one-off, so chapter-opener furniture will be read aloud.
7. **Tables.** Reading a table cell-by-cell aloud is useless regardless of whether the order is right. Detect and announce-and-skip; do not attempt.
8. **Tag-order-wrong-but-tags-present PDFs** — mitigated by the agreement guard, but the guard has a threshold and thresholds are wrong sometimes.
9. **Hyphenation and cross-page sentence continuation.** Not reading order strictly, but it lands in the same pipeline: a sentence broken across a column or page break must be rejoined or the TTS will stop mid-clause.
10. **Multi-column footnote blocks** spanning the full width beneath two body columns — the band pass sees a full-width band and orders it correctly, but only if it also classifies it as footnote rather than prose.

**The honest summary of severity:** items 1, 2 and 6 are the ones that will actually degrade the demo. Items 3–5, 7, 9 are handleable with the heuristics above. Item 8 is guarded.

---

## 8. Read on the crux risk

**Surmountable.** The reason for confidence is that the risk decomposes into two problems of very different difficulty, and the hard half is not on the critical path for the prototype.

- **Ordering two-column body prose is easy** and has been solved geometrically for forty years. A gutter between columns of a textbook is a large, stable, high-contrast whitespace feature. Detecting it needs a histogram and a threshold. `multi_column.py` does the whole job in 337 lines of Python; we would write 600–900 lines of TypeScript to do it with better classification.
- **Classifying non-prose regions is hard**, and it is where all the honest failure modes sit. But — and this is the part that makes the risk tolerable — **the product is unusually forgiving of classification error, because the reader is looking at the real page.** The whole premise of this effort is native-fidelity rendering with an audio overlay. If a sidebar gets read at the wrong moment, the user can see exactly what happened and where the cursor is. That is a very different failure than a blind text-to-speech pipeline producing scrambled audio with no visual anchor. The sentence band *is* the error-recovery UI.

That reframes the acceptance bar. The prototype does not need correct reading order on every page; it needs correct reading order on **runs of ordinary body prose long enough to sit and listen to**, plus a visible cursor so that when it does go wrong the user knows immediately and can tap to resume. That bar is reachable with the pipeline above.

**Recommended de-risking sequence** — ticket 06 (reading-order spike) should measure, not just build:

1. Implement Pass 0–4 only (bands, columns, order, header stripping). Skip all classification.
2. Run against the ticket-01 corpus and score *page-level* order correctness by eye — not character-level accuracy, just "did the prose come out in the right sequence".
3. If that clears ~80–85% of pages, the risk is closed and the remaining work is classification polish.
4. If it does not, the failure pages will tell you which of §7's modes dominate, and that is a much better-informed conversation than the one we can have today.

**What would change my answer:** if the ticket-01 corpus turns out to be dominated by heavily-designed, sidebar-rich, magazine-style modern textbooks rather than conventional two-column academic ones, the classification problem moves onto the critical path and `ppu-doclayout` / an ONNX layout model stops being a footnote and becomes the plan. Worth checking the corpus composition early for exactly this reason.

---

## Sources

Primary source code read directly:
- [pdfminer.six `layout.py`](https://github.com/pdfminer/pdfminer.six/blob/master/pdfminer/layout.py) — LAParams defaults, grouping rules, `boxes_flow` sort
- [PyMuPDF-Utilities `multi_column.py`](https://github.com/pymupdf/PyMuPDF-Utilities/blob/master/text-extraction/multi_column.py) — 337 lines; documented restrictions
- [Unstructured `xycut.py`](https://github.com/Unstructured-IO/unstructured/blob/main/unstructured/partition/utils/xycut.py), [`sorting.py`](https://github.com/Unstructured-IO/unstructured/blob/main/unstructured/partition/utils/sorting.py), [`partition/pdf.py`](https://github.com/Unstructured-IO/unstructured/blob/main/unstructured/partition/pdf.py)
- PDF.js: [`src/display/api.js`](https://github.com/mozilla/pdf.js/blob/master/src/display/api.js) (TextItem/TextStyle/getTextContentParameters/getStructTree typedefs), [`src/core/struct_tree.js`](https://github.com/mozilla/pdf.js/blob/master/src/core/struct_tree.js), [`src/core/evaluator.js`](https://github.com/mozilla/pdf.js/blob/master/src/core/evaluator.js) (MCID id construction), [`src/core/document.js`](https://github.com/mozilla/pdf.js/blob/master/src/core/document.js) (`getPageObjId`)

Papers:
- Breuel, [*Two Geometric Algorithms for Layout Analysis*](https://link.springer.com/content/pdf/10.1007/3-540-45869-7_23.pdf), DAS V, 2002
- Meunier, [*Optimized XY-Cut for Determining a Page Reading Order*](https://dl.acm.org/doi/10.1109/ICDAR.2005.182), ICDAR 2005
- Wang et al., [*Uncovering the New Accessibility Crisis in Scholarly PDFs*](https://arxiv.org/abs/2410.03022), ASSETS 2024 ([HTML](https://arxiv.org/html/2410.03022v1))
- O'Gorman, *The Document Spectrum for Page Layout Analysis* (Docstrum), IEEE TPAMI 1993; Kise et al., area-Voronoi, CVIU 1998 — surveyed via [BobLd/DocumentLayoutAnalysis](https://github.com/BobLd/DocumentLayoutAnalysis)

Docs and issues:
- [PDF.js PR #13171](https://github.com/mozilla/pdf.js/pull/13171), [issue #17191](https://github.com/mozilla/pdf.js/issues/17191), [issue #14493](https://github.com/mozilla/pdf.js/issues/14493)
- [PyMuPDF FAQ](https://pymupdf.readthedocs.io/en/latest/faq/index.html), [TextPage docs](https://pymupdf.readthedocs.io/en/latest/textpage.html)
- pdfminer.six issues [#395](https://github.com/pdfminer/pdfminer.six/issues/395), [#398](https://github.com/pdfminer/pdfminer.six/issues/398), [#411](https://github.com/pdfminer/pdfminer.six/issues/411)
- [GROBID Principles](https://grobid.readthedocs.io/en/latest/Principles/); [Surya](https://github.com/datalab-to/surya); [Marker](https://github.com/datalab-to/marker)
- [LaTeX Tagged PDF Project](https://latex3.github.io/tagging-project/); [tagpdf on CTAN](https://ctan.org/pkg/tagpdf)
- npm registry search API (`registry.npmjs.org/-/v1/search`) across seven queries; `ppu-doclayout` and `@embedpdf/plugin-layout-analysis` metadata read from the registry
