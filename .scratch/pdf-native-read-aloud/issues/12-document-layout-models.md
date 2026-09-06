# 12 — Can a document-layout model do what ticket 06 planned to hand-write?

Type: research
Status: resolved
Blocked by: —

## Question

[[03]] found no JS library for reading order and concluded we write it ourselves: roughly 600–900 lines of geometry — running-head removal by cross-page repetition, line clustering, bands before columns, gutter detection by x-projection. It also found the hard half is not ordering but **classification**: sidebars and boxed worked-example panels are geometrically identical to a narrow column, and that is the dominant textbook failure.

Classification is exactly what a trained layout model does. So this ticket asks whether [[06]] should be written at all.

Named by the human: **PaddleOCR / PP-StructureV3**. Others to price alongside it: **docling** (IBM), **MinerU**, **marker**, **Surya**, **DocLayout-YOLO**, **LayoutLMv3**. Prefer current repos and model cards; this field turns over fast.

Establish, for the serious candidates:

- **What the output actually is.** Region boxes with class labels (text / title / figure / table / formula / caption / header / footer)? A reading order? Markdown or HTML? [[03]]'s vocabulary and this ticket's answer have to line up, because [[07]] fixes the region vocabulary the codebase uses.
- **Whether the coordinates can be joined back to the PDF.** This is the load-bearing risk. These models consume a *rasterised page image*, so their boxes are in image pixel space. Getting to PDF user space is a scale factor we control by choosing the render DPI — fine. The real join is **region box → text-layer items**, so we know which sentences live inside which region. State whether that intersection is clean in practice, or whether boxes are loose enough that items straddle two regions.
- **How it runs.** Python only? ONNX export? Anything that runs in a browser or in Node? Per-page latency on CPU. Model size. This lands straight on [[08]] alongside [[11]].
- **How well it does on *this* corpus** — three untagged textbook PDFs, one equation-dense and figure-heavy. Vendor benchmarks are on academic papers; textbooks are not papers.
- **Licence**, for both code and weights.
- **What it does NOT give us.** It returns regions, not text with per-character geometry — so it cannot draw the sentence band. The band still comes from PDF.js's text layer via [[02]]. Confirm this reading: the model **complements** the text layer and replaces only [[06]], it does not replace [[02]] or [[05]]'s mechanism.

Then answer the question this exists for: **does [[06]] survive?** Three possible shapes — the model replaces it outright; the model is the primary path with a geometric fallback for pages it fails; or the model is too slow, too heavy or too inaccurate on textbooks and [[03]]'s plan stands. Say which, with evidence.

Note the corpus gap [[01]] recorded: there is still no two-column PDF in `sample_books/`. That blocked [[06]] and it blocks a fair test here too.

## Answer

**Yes, and I ran one on the corpus rather than reading about it.** Full findings, with method and
per-page numbers: [research/12-document-layout-models.md](../research/12-document-layout-models.md).
The winning shape is not PP-StructureV3 (Python-only, >1 GB of models, a full OCR pipeline we do
not need since we already have the text). It is the **layout module alone**, in JS:
`ppu-doclayout@1.0.0` (MIT) running `PP-DocLayoutV2.onnx` (Apache-2.0, 203 MiB) under
`onnxruntime-node`. It returns labelled region boxes **already sorted in reading order** — a real
network output, an RT-DETR detector followed by a pointer network, not a post-hoc XY-cut. Note
that [[03]] §4 saw this package and rightly dismissed it as "a one-version, one-author package
with no README"; that dismissal was accurate when written and is now out of date. This is the
biggest single delta from [[03]].

**The load-bearing risk is measured and it is not real.** I joined model boxes (image px ÷ dpi/72
→ PDF points) against the PDF's own text-layer word boxes across **40 pages / 19,760 words** — ten
pages each from all three `sample_books/` PDFs plus a two-column paper. **0.12%** of words fell in
no region; **0.84%** overlapped more than one. Crucially, of those 166 straddles, 129 were
`text`↔`text` (two abutting prose blocks — harmless, both prose, adjacent in order), 34 were
figure-on-figure (harmless, both skipped), and **only 3 words in the entire sweep — 0.015% — straddled
a prose region and a skip region.** A coarse "best overlap < 90%" metric reports an alarming 21%
on one page, but that bucket is entirely single-region words whose box clips the ascenders; once
you separate "clipped by one box" from "shared between two boxes", the scary number vanishes.
Assignment by max area overlap is safe to build on. The results are also DPI-invariant (150 vs
200 dpi gave identical region counts, identical straddles, identical latency), since the model
resizes to 800×800 internally — so render DPI is genuinely just a scalar we control.

**It solves the half [[03]] said was hard, plus two things [[03]] did not have on the table.** On
Millington p60 — the equation-dense named page — it returned, on a *single* page with no thresholds
tuned: the running head as `header`, the folio as `number`, the figure as `image`, its caption as
`figure_title`, all three display equations as `display_formula` isolated from surrounding prose,
`inline_formula` spans nested inside the prose blocks, and `paragraph_title` for the subhead. That
is [[03]] §6 in its entirety — including the cross-page repetition pass ([[03]] Pass 0) obtained
for free from one page — plus **inline maths**, which [[03]] explicitly declined to solve, plus
`algorithm` for code listings, which [[01]] flagged as a skip-policy case [[07]] had not
anticipated. The 25-label vocabulary also contains **`aside_text`** — precisely the sidebar/boxed-panel
case [[03]] named as "the most common textbook-specific failure" and whose mitigation it costed
as "real extra work".

**Reading order is correct on genuine two-column pages, including the case [[06]] exists to
de-risk.** On the two-column paper: p2 gave the whole left column then the whole right column with
no interleaving; p3 put the two **full-width spanning bands first**, then left column, then right
column — [[03]]'s "bands before columns" prescription, produced unasked; p5 emitted the `footnote`
**last**, after all body prose, despite it sitting physically mid-page. Zero straddles and zero
unassigned words on all three. I also cross-checked against PaddleOCR's native
`PP-DocLayout_plus-L` on CPU: near-identical geometry, but it sorts by *confidence* not reading
order, has one merged `formula` class instead of display/inline, labels code listings `text`
rather than `algorithm`, and is slower (855–1,023 ms vs 588–885 ms). The JS/ONNX path is not a
degraded port — on this corpus it is the better of the two.

**Cost is a delivery problem, not an accuracy one.** Median **731 ms/page on CPU** (min 588, 16
cores, GPU deliberately unused), 921 ms warm session init, 203 MiB of weights. In Node/Electron or
a local sidecar that is a one-time cached download and fine. In a pure browser under
`onnxruntime-web` — which **I did not measure** — expect low single-digit seconds per page plus a
203 MiB first load; survivable only if layout analysis runs lazily, a page or two ahead of the
speech cursor, which is exactly read-aloud's access pattern. That constraint should be written
down before [[08]] prices anything. I also did not sweep thread counts, so a 4-core laptop is
unmeasured. For contrast, PP-StructureV3's *full* pipeline is documented at ~3.74 s/page on CPU
with >1 GB of models — we want the layout module only.

**Licensing is the field's real minefield and PP-DocLayout is the clean exit.** Code and weights
are licensed separately almost everywhere. DocLayout-YOLO is AGPL-3.0 (and stale — last README
milestone 2024.10.25); MinerU is effectively AGPL-3.0 because it never bought a YOLO commercial
licence; Marker/Surya weights carry an AI Pubs Open RAIL-M ceiling barring commercial use above
$5M revenue or funding, or if you offer a competing product; LayoutLMv3 weights are CC BY-NC-SA
(non-commercial) and it is the wrong shape anyway. docling is genuinely clean (MIT code,
Apache-2.0 `docling-layout-heron` weights) but Python + PyTorch only — **and I must flag that my
docling install did not complete, so every docling claim here is documented, not measured.**
PP-DocLayout is Apache-2.0 on both halves, with MIT glue. One availability caveat: the ONNX file
ships from a single maintainer's GitHub LFS repo, so mirror it rather than depend on it.

**The ticket's proposed reading of what the model does *not* give us is confirmed.** It returns
region rectangles, never per-character geometry. It cannot draw the sentence band and does not
try. [[02]] and [[05]] are untouched — the band still comes from `Range.getClientRects()` over the
PDF.js text layer exactly as [[02]] §4 specifies. The model is a *filter and a sort key* over text
items, nothing more. Separately, [[07]] should **adopt the model's 25-label vocabulary rather than
invent one**; it is trained, stable and real, and any taxonomy we define alongside it becomes a
translation layer that will drift. [[07]] then reduces to a policy question — which labels do we
speak, which do we announce-and-skip, which do we drop silently.

**Verdict on [[06]]: shape 2 — model primary with a geometric fallback — but the fallback is far
smaller than [[03]]'s 600–900 lines, and its content changes.** Not shape 1, because a page the
model has not reached yet still needs something to speak, because regions-in-order is not yet
sentences-in-order (the join and in-region assembly are real code), and because `aside_text` fired
only *once* in 40 pages — the class exists and was trained, but the corpus contains no sidebar-heavy
book, so I have **not** demonstrated it works on the case that motivated the question. Not shape 3,
because writing 600–900 lines to reproduce a subset of what a 203 MiB Apache-2.0 file already does
better is indefensible against a 0.015% harmful-straddle measurement. [[06]] gets rewritten as:
rasterise → run the model → join items to regions by max overlap → trivial baseline sort *within*
each region (Passes 2–4 of [[03]] — bands, gutters, columns — are simply not needed) → keep a
**150–250 line** fallback of line clustering plus naive top-to-bottom/left-to-right. Gutter
detection, band segmentation, cross-page repetition stripping and the caption/footnote/equation
heuristics all fall away. Two gaps stay open and should be stated in [[06]]: the corpus still has
**no two-column PDF** — I fetched PDF.js's own `compressed.tracemonkey-pldi-09.pdf` into a scratch
dir for this test and deliberately did **not** commit it or any page image, so [[01]]'s gap is
unchanged — and the highest-value next test is a **sidebar-heavy modern textbook**, which is
exactly the corpus condition [[03]] said would change its own answer.
