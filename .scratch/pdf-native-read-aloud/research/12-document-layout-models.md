# Research: can a trained document-layout model replace the hand-written pipeline of ticket 03?

Ticket: `.scratch/pdf-native-read-aloud/issues/12-document-layout-models.md`
Date: 2026-09-05

Everything below marked **[measured]** was run on this machine during this session against the
real corpus. Everything marked **[documented]** comes from a repo, model card or paper I read,
and is labelled as such because I did not reproduce it. I have tried hard not to let the two
blur, because the whole point of this ticket is that vendor benchmarks are on academic papers
and our corpus is textbooks.

---

## 0. TL;DR

- **A layout model does the job, and I ran one on the corpus.** `ppu-doclayout@1.0.0` (MIT) running
  `PP-DocLayoutV2.onnx` (Apache-2.0) under `onnxruntime-node` classified all 40 sweep pages of the
  three corpus books plus a two-column paper, returning **labelled region boxes already sorted in
  reading order**. Median **731 ms/page on CPU**, 203 MiB model. No Python, no PaddlePaddle.
- **The load-bearing risk is not real. The join is clean.** Over **40 pages / 19,760 words**,
  **0.12%** of words fell in no region, and **0.84%** overlapped more than one region — of which
  **only 3 words in the entire sweep (0.015%) straddled a prose region and a skip region**. Every
  other multi-region word straddled either two adjacent prose blocks (129) or two overlapping
  figure regions (34). A word-to-region assignment by max-overlap is effectively exact.
- **The label vocabulary is a near-perfect fit for ticket 07.** 25 classes including `text`,
  `paragraph_title`, `header`, `footer`, `footnote`, `figure_title`, `display_formula`,
  `inline_formula`, `formula_number`, `image`, `chart`, `table`, `algorithm`, and — the one that
  matters most — **`aside_text`**, which is exactly the sidebar/boxed-panel case [[03]] named as
  its dominant textbook failure mode.
- **It solves both halves that [[03]] separated.** [[03]] said ordering is easy and classification
  is hard. The model does classification *natively* and ordering *as a network output* (a pointer
  network over the detected boxes — not a post-hoc XY-cut). On a genuine two-column page it read
  left column fully, then right column, then the footnote last. Correct.
- **It does not replace [[02]].** It returns region rectangles, not per-character geometry. The
  sentence band still comes from `Range.getClientRects()` over the PDF.js text layer. The model
  is a *filter and a sort key* over text items, nothing more. [[05]]'s mechanism is untouched.
- **The real costs are delivery and licence hygiene, not accuracy.** 203 MiB of weights is a
  serious download for a browser, and the field's licensing is a minefield (DocLayout-YOLO and
  MinerU are AGPL-3.0; Surya/Marker weights carry a $5M revenue ceiling; LayoutLMv3 is
  non-commercial). PP-DocLayout is the outlier: Apache-2.0 code *and* Apache-2.0 weights.
- **Verdict: [[06]] survives, but shrinks — shape 2, "model primary with a geometric fallback",
  and the fallback is far smaller than [[03]]'s 600–900 lines.** See §9.

---

## 1. What actually exists, September 2026

This field turned over since [[03]] was written, and it turned over *again* since my training data.
Two concrete examples of staleness worth flagging to anyone reading this later:

- **PP-DocLayoutV3** now exists, accepted to ECCV 2026 ([arXiv:2606.23344](https://arxiv.org/abs/2606.23344)),
  predicting multi-point boxes for non-planar pages plus segmentation masks. Its
  [model card](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3) is Apache-2.0.
- **`ppu-doclayout` is no longer the "one-version, one-author package with no README"** that [[03]]
  §4 correctly dismissed. It now has a README, a typed API, MIT licence, browser *and* Node
  targets, and it ships PP-DocLayoutV2/V3 ONNX. [[03]]'s dismissal was accurate when written and
  is no longer accurate. This is the single biggest delta from [[03]].

| Candidate | Code licence | Weights licence | Runtime | Reading order? |
|---|---|---|---|---|
| **PP-DocLayoutV2 / V3** (PaddleOCR) | Apache-2.0 | **Apache-2.0** | Paddle, ONNX | **Yes, in-network (pointer net)** |
| **`ppu-doclayout`** (JS wrapper) | **MIT** | inherits Apache-2.0 | onnxruntime-node / **-web** | Yes (passes model's order through) |
| **PP-StructureV3** (full pipeline) | Apache-2.0 | Apache-2.0 | Python + PaddlePaddle only | Yes, but post-hoc sort |
| **docling** (IBM) | MIT | Apache-2.0 (`docling-layout-heron`) | Python + PyTorch | Yes |
| **DocLayout-YOLO** | **AGPL-3.0** | AGPL-3.0 (Ultralytics) | PyTorch | No |
| **MinerU** | **AGPL-3.0** (see §7) | mixed | Python | Yes |
| **Marker / Surya** | GPL-3.0 | **OpenRAIL-M, $5M ceiling** | PyTorch | Yes |
| **LayoutLMv3** | MIT | **CC BY-NC-SA 4.0 (non-commercial)** | PyTorch | No (token classifier) |

Two structural points that decide the shortlist before any accuracy number:

1. **Only PP-DocLayout has a JS/ONNX story.** docling, MinerU, marker and DocLayout-YOLO are all
   Python + PyTorch. For an effort whose entire artifact is a browser app driven by PDF.js, that
   is not a detail — it is the difference between a dependency and a second runtime ([[08]]).
2. **Only PP-DocLayout is unambiguously permissive on both halves.** Code and weights are licensed
   separately across this whole field and the mismatch is where people get caught (§7).

---

## 2. What I ran [measured]

**Machine**: Linux, 16 logical cores, 13 GB RAM, RTX 3060 present but **deliberately unused** —
every timing below is CPU-only, because the deployment target is a laptop browser, not a GPU box.

**Stack**: Node v22.16.0, `onnxruntime-node@1.29.0`, `ppu-doclayout@1.0.0`, default
`executionProviders: ["cpu"]`, `threshold: 0.4`, `modelInputSize: 800`.
Model file: `PP-DocLayoutV2.onnx`, **213,303,073 bytes (203 MiB)**, auto-downloaded on first
`initialize()` from `media.githubusercontent.com/.../ppu-paddle-ocr-models`.
Session init: **921 ms** warm, 2,990 ms cold.

**Pages**: rendered with PyMuPDF at 150 dpi (and 150+200 dpi for the three named pages).

- `theCodeBook.pdf` — p40, p41, p55, p90, p120, p180, p240, p300, p360, p400
- `Game Physics Engine Development (Millington)` — p60, p75, p110, p150, p200, p250, p300, p350, p400, p450
- `crafting-interpreters-…` — p40, p80, p120, p200, p260, p320, p400, p460, p520, p580
- **two-column paper** (see §8) — p2–p11

**Cross-check**: I also ran PaddleOCR's own `LayoutDetection` module natively
(`paddleocr==3.3.2`, `paddlex==3.3.9`, `paddle==3.2.2`, `PP-DocLayout_plus-L`, `device="cpu"`) on
three of the same page images, to see whether the JS/ONNX path is faithful. It is (§4).

**A note on honesty**: I attempted to install **docling** into a scratch venv and it did not
complete — the venv ended at 82 MB with no `docling` module and no PyTorch. I did not retry,
because pulling ~2.5 GB of torch to confirm a number I can read off a model card is a poor use
of the session. **Everything I say about docling is [documented], not measured.** Likewise I did
not run `onnxruntime-web` in a real browser; the WASM latency claim in §6 is inference from the
Node measurement, and is flagged as such.

### Physics book, p60 — the named hard page

336×414pt is not what this page measures. **[measured]** `cropbox` is `(36, 36.2)–(576, 701.2)`,
`mediabox` is `611.7×737.2`, and PyMuPDF's effective `page.rect` is **540×665 pt**. Worth
correcting in [[01]], since the render-DPI arithmetic depends on it.

Model output, image px at 150 dpi divided by 150/72 to reach PDF points, with the text-layer
words that fell inside each region:

```
 [0] header           0.91 pt[ 408.0   38.9  463.2   50.4]    2w | '2.2 Calculus'
 [1] image            0.67 pt[ 143.5   73.0  483.8  176.2]    0w | ''
 [2] figure_title     0.94 pt[  79.7  186.2  366.2  199.7]    8w | 'FIGURE 2.8 Same average velocity, different instantaneous velocity.'
 [3] text             0.97 pt[ 143.5  215.0  484.8  239.5]   28w | 'accurate picture of the velocity of the object at one instant…'
 [4] text             0.94 pt[ 158.4  239.5  428.2  251.5]   10w | 'In mathematical notation this is written using the "limit" notation'
 [5] display_formula  0.96 pt[ 285.6  263.5  343.2  287.5]    6w | 'v = lim t→0 p t'
 [6] text             0.98 pt[ 143.5  298.1  485.3  347.5]   53w | 'which simply means that the velocity would be accurately given…'
 [7] display_formula  0.96 pt[ 273.6  358.6  355.2  383.5]    9w | 'v = lim t→0 p t = dp dt'
 [8] text             0.97 pt[ 144.0  394.1  484.8  419.0]   23w | 'Because it is so common in mechanics to be talking about…'
 [9] display_formula  0.95 pt[ 289.0  430.1  341.3  454.6]    6w | 'v = dp dt = ˙p'
[10] text             0.97 pt[ 144.0  465.1  485.3  490.1]   22w | 'The dot over the p simply means that it is the velocity at which p is changing…'
[11] paragraph_title  0.94 pt[ 144.5  501.6  211.2  514.1]    1w | 'Acceleration'
[12] text             0.97 pt[ 144.0  520.8  484.8  544.8]   23w | 'If p is the position of an object and v is its velocity…'
[13] text             0.98 pt[ 143.5  545.8  485.8  607.7]   70w | 'Acceleration is the rate at which velocity is changing…'
```

Plus, filtered out as sub-region marks: `number 0.88` (the folio "37"), and five `inline_formula`
boxes nested *inside* the `text` regions.

Read that against [[03]] §6 and §7. It got, unprompted and with no thresholds to tune:

- the running head, separated from body text, on a **single page** — no cross-page repetition pass
  needed, which is [[03]] Pass 0 entirely;
- the folio, as its own class;
- the figure and its caption, with the caption identified as `figure_title` rather than prose
  (the thing [[03]] noted PyMuPDF's mature `multi_column.py` explicitly gives up on);
- all three display equations as `display_formula`, isolated from surrounding prose — including
  the paragraph-internal ones that [[03]] flagged as needing font-change + baseline-scatter +
  right-aligned-tag heuristics;
- `inline_formula` spans *inside* prose, which is the problem [[03]] §6 explicitly declined to
  solve ("Inline maths inside a prose sentence is a different and harder problem and this ticket
  does not solve it").

That last one is a capability [[03]] did not have on the table at all.

### Code Book, p40–41 — the clean prose control

p40 came back as 8 regions: a `table` at the top with **0 text items** (it is a raster image),
five `text` blocks, and two low-confidence `paragraph_title` regions which are actually the
italic attribution lines under the ciphertext excerpts. Not a correct label, but not prose
either, so the skip policy still lands right.

p41 is more interesting as a failure study. The model emitted two `display_formula` regions at
pt y 433–450 and 452–468 with **0 words each**. I checked the PDF: `page.get_text("dict")`
reports a **type-1 (image) block** at `[110.2, 435.6, 502.6, 465.8]`. That is the plain/cipher
alphabet table, shipped as a raster. So the label is wrong (`display_formula`, not `image`), but
the region contains no text items, so it costs us nothing — the read-aloud stream is identical
either way. **This is the shape of most misclassification here: wrong label on a region that has
no prose in it.**

---

## 3. The load-bearing risk: region box → text-layer items [measured]

This is what the ticket exists to settle, so I measured it directly rather than eyeballing it.

**Method.** For each page: take the model's boxes in image px, divide by `dpi/72` to reach PDF
user space, then take every word box from the PDF's own text layer (PyMuPDF `get_text("words")`,
which is the same PDF user space as PDF.js `TextItem.transform` after the flip described in
[[02]] §1). For each word, compute the fraction of the *word's* area covered by each region.
Exclude `inline_formula`, `formula_number` and `number` from the region set — they are sub-region
marks nested inside block regions, not containers, and counting them would fake a straddle.

Then classify each word:

- **no region** — it fell outside every block box. A word we would lose.
- **>1 region** — two or more regions each cover >10% of it. A word that genuinely straddles.
- **clipped** — its best region covers <90% of it, but only one region touches it. Not a straddle;
  the box just cropped the ascender or descender.

That third bucket is the refinement that matters. A coarse "best-overlap < 90%" metric reports
**77 of 362 words (21%) as suspicious on Code Book p40** — which reads as alarming and is
entirely an artefact. Those 77 words all have exactly *one* overlapping region; the model's box
simply hugs the x-height and clips the ascenders. Separating "clipped by one box" from "shared
between two boxes" turns a scary number into a boring one, and only the second bucket can
actually misroute a sentence.

**Result over the whole sweep — 40 pages, 19,760 words:**

| | count | % |
|---|---|---|
| words in **no** region | 23 | **0.12%** |
| words in **>1** region (true straddle) | 166 | **0.84%** |
| words clipped >10% by their single region | 376 | 1.90% |

And the straddles broken down by *what* they straddle — the number that decides the ticket:

| straddle kind | count | consequence |
|---|---|---|
| `text` ↔ `text` | 129 | **harmless.** Two abutting prose blocks; the word is prose either way and both blocks are adjacent in reading order. |
| `image` ↔ `chart` | 33 | **harmless.** Two overlapping figure regions; skipped either way. |
| `figure_title` ↔ `image` | 1 | harmless. Caption vs figure, both non-prose. |
| **`algorithm` ↔ `text`** | **3** | **the only harmful case** — a code-listing line that might be read aloud, or a prose line that might be skipped. |

**Three words out of 19,760 — 0.015% — could be misrouted between prose and skip.**

The 23 unassigned words are equally benign, and they are *informative*: they are almost entirely
page folios (`'37'`, `'87'`, `'127'`, `'177'`, `'227'`, `'277'`, `'327'`, `'377'`, `'427'` — one
per Millington page), which the model classified as `number` and my filter deliberately excluded.
In other words, **the page number falls out of the pipeline for free**, which is half of [[03]]'s
Pass 0. The remainder are Crafting Interpreters' `<<` code-snippet markers and section numbers
like `'25.1.1'`.

**DPI invariance [measured].** I re-ran the three named pages at 200 dpi. Region counts were
identical (8 / 5 / 14 blocks), straddle counts identical (16 / 11 / 0), latency unchanged
(624–780 ms). The model resizes its input to 800×800 internally, so render DPI above ~150 buys
nothing but costs rasterisation time. The image-px → PDF-pt conversion is a single scalar and it
is exact.

**Conclusion on the risk as the ticket framed it: the boxes are not loose. The intersection is
clean.** A max-overlap assignment of text items to regions is safe to build on, and the residual
straddle is small enough to ignore rather than engineer around.

---

## 4. Reading order [measured]

`ppu-doclayout` returns `boxes` "sorted in reading order by the model" — and this is a real
network output, not a sort applied afterwards. The
[PP-DocLayoutV2 model card](https://huggingface.co/PaddlePaddle/PP-DocLayoutV2) describes it as an
RT-DETR detector "followed by a pointer network for reading order prediction… responsible for
ordering these layout elements". **[documented]** That is architecturally different from
PP-StructureV3, which detects with `PP-DocLayout-L` and then *sorts* — and it shows in practice.

On the two-column paper:

- **p2** — regions `[0]`–`[10]` are the entire left column top-to-bottom, then `[11]`–`[19]` the
  entire right column. No interleaving. The figure and its caption sit in the right column in the
  right place.
- **p3** — two full-width `algorithm` bands and their `figure_title` captions come first
  (`[0]`–`[3]`), *then* the left column (`[4]`–`[6]`), *then* the right column (`[7]`–`[8]`).
  This is exactly [[03]]'s "bands before columns" prescription, produced without being asked.
- **p5** — left column, right column, and the **`footnote` emitted last** (`[17]`), after all body
  prose, despite sitting physically at the bottom of the left column. That is the correct
  behaviour for read-aloud and it is not what a naive geometric sort produces.

Zero straddles and zero unassigned words on all three ([measured], §3 table).

**Where the order is not clean**: nested `inline_formula` boxes are interleaved arbitrarily
relative to their containing `text` block — e.g. on Millington p60 an `inline_formula` at y 673
is emitted *before* the `text` region at y 621 that contains it. This is a non-issue provided you
treat the inline classes as annotations on a containing block rather than as sequence entries,
which is what §3's filter does.

**Cross-check against PaddleOCR native [measured].** Running `PP-DocLayout_plus-L` on CPU through
`paddleocr==3.3.2` on the same three page images gave near-identical geometry but three
differences that favour the ONNX V2 path:

1. Output is **sorted by confidence score, not reading order** — the ordering must be supplied by
   PP-StructureV3's separate post-processing.
2. It has a single `formula` class; V2 splits `display_formula` / `inline_formula`. The split is
   directly useful to us — display equations get announce-and-skip, inline ones need different
   treatment ([[09]]).
3. It labelled the tracemonkey code listings `text`; V2 labelled them `algorithm`. V2 is right,
   and it is right about the thing [[01]] flagged as "a skip-policy case [[07]] did not anticipate".
4. Latency was **855–1,023 ms** vs the ONNX path's 588–885 ms on the same images.

So the JS path is not a degraded port. On this corpus it is the better of the two.

---

## 5. Class vocabulary, against [[07]]'s needs

The 25 labels PP-DocLayoutV2 emits, verbatim from `ppu-doclayout`'s `LABELS` **[measured]**:

```
abstract, algorithm, aside_text, chart, content, display_formula, doc_title,
figure_title, footer, footer_image, footnote, formula_number, header,
header_image, image, inline_formula, number, paragraph_title, reference,
reference_content, seal, table, text, vertical_text, vision_footnote
```

Mapped onto what [[03]] §6 said we would have to write by hand:

| [[03]] classifier, hand-written | Model class | [[03]]'s estimate |
|---|---|---|
| running header/footer by cross-page repetition | `header`, `footer` | 100 lines + a document-level pass |
| page numbers | `number` | (part of the above) |
| figure captions by `Figure N` regex | `figure_title` | part of 150 |
| footnotes by size + rule + superscript | `footnote`, `vision_footnote` | part of 150 |
| display equations by font change + baseline scatter + `(3.14)` tag | `display_formula`, `formula_number` | part of 150 |
| **inline maths** | `inline_formula` | **explicitly declined** |
| tables | `table` | part of 150 |
| **sidebars / boxed panels** | **`aside_text`** | **"the most common textbook-specific failure"; mitigation "real extra work"** |
| code listings | `algorithm` | not anticipated at all ([[01]] found this gap) |

That is [[03]]'s entire §6 plus two items it did not have.

**Honest caveat on `aside_text`**: it fired **once** across 40 pages. That is not a validation —
it is a consequence of the corpus. None of the three books is a sidebar-heavy modern illustrated
textbook. So the class exists and the model was trained on it, but **I have not demonstrated it
works on the case [[03]] cared about**, and I should not claim I have. See §8.

Label histogram over the 40-page sweep **[measured]**:
`text 319, inline_formula 84, algorithm 73, paragraph_title 38, figure_title 19, image 17,
number 12, display_formula 11, header 10, chart 5, table 3, formula_number 2, footnote 2,
aside_text 1, footer 1`.

---

## 6. Cost: latency, size, runtime [measured, except where noted]

**Latency, CPU, 16 threads, 150 dpi, over 40 pages**: min **588 ms**, median **731 ms**,
max 2,664 ms (a first-page-of-session outlier; steady state is 590–900 ms).
Session init 921 ms warm / 2,990 ms cold. Rasterisation with PyMuPDF at 150 dpi is a few tens of
ms and is not the bottleneck; the 800×800 fixed input means DPI does not move the number (§3).

**Model size**: 203 MiB (213,303,073 bytes) for `PP-DocLayoutV2.onnx`, fp32.

That size is the genuine problem, and it is a *delivery* problem rather than an accuracy one:

- In **Node / Electron / a local server sidecar**, 203 MiB is a one-time download that lands in a
  cache directory and is then free. Given [[10]] settled Linux-only local development and the map
  describes "a local web app", this is very likely the shape that matters, and it is fine.
- In a **pure browser** with `onnxruntime-web`, 203 MiB over WASM is a different story. I did
  **not** measure this **[not measured]**. Reasoning from the Node number: ORT WASM with SIMD and
  threads typically runs a transformer detector several times slower than the native CPU EP, so
  expect **low single-digit seconds per page**, plus a 203 MiB first-load. Both are survivable
  *if* layout analysis is a background pass that runs a page or two ahead of the speech cursor,
  which is precisely the access pattern read-aloud has. Neither is survivable as a
  blocking on-open cost for a 600-page book — so the design constraint is "analyse lazily, one
  page ahead", and that should be written down before [[08]] prices anything.
- The [README](https://github.com/PT-Perkasa-Pilar-Utama/ppu-doclayout) quotes **~654 ms/page on
  an Apple M1** **[documented]**, consistent with my 731 ms median on a 16-core x86 CPU.

**Threading caveat [not measured]**: my 731 ms median used ORT's default thread count on 16 cores.
A 4-core laptop will be materially slower, and I did not sweep `intraOpNumThreads`. Anyone
sizing this for [[08]] should measure at 2 and 4 threads before trusting the median.

For contrast **[documented]**: PP-StructureV3's *full* pipeline (layout + OCR + formula
recognition + tables) is quoted at ~3.74 s/image on an Intel 8350C CPU and 0.64 s/page on an
A100, with 8.3–21 GB VRAM depending on configuration, and its component models total well over
1 GB (`PP-FormulaNet_plus-L` alone is 698 MB, `PP-Chart2Table` 1.4 GB). **We do not want the
pipeline. We want the layout module only** — we already have the text, so OCR is dead weight, and
[[09]] handles equation speech separately.

---

## 7. Licences — code and weights, checked separately

This field licenses code and weights differently as a matter of course, and the mismatch is where
the trap is.

- **PP-DocLayoutV2 / V3 weights**: **Apache-2.0**, stated on the
  [V2](https://huggingface.co/PaddlePaddle/PP-DocLayoutV2) and
  [V3](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3) model cards.
- **PaddleOCR / PaddleX code**: Apache-2.0.
- **`ppu-doclayout`**: **MIT**, confirmed in the installed `package.json` **[measured]**.
  Peer-deps `onnxruntime-node` / `onnxruntime-web` are MIT. The ONNX file it downloads is a
  conversion of the Apache-2.0 PaddlePaddle weights, redistributed from the author's own GitHub
  LFS repo — **if this matters commercially, mirror the weights rather than depending on a
  single maintainer's LFS quota.** That is an availability risk more than a licence one.
- **docling**: MIT code; `docling-layout-heron` weights Apache-2.0. **[documented]** Clean, but
  Python + PyTorch only.
- **DocLayout-YOLO**: **AGPL-3.0** — it is built on Ultralytics YOLOv10, and Ultralytics'
  dual-licence means AGPL or a paid commercial licence. Also **stale**: the repo's most recent
  README milestone is 2024.10.25. Rule it out on both counts.
- **MinerU**: moved to a custom "MinerU Open Source License" based on Apache-2.0, **but** because
  the project has not bought a YOLO commercial licence, the repository code remains effectively
  **AGPL-3.0**, with an attribution clause that is not revenue-conditional. **[documented]**
- **Marker / Surya**: GPL-3.0 code plus an **AI Pubs Open RAIL-M (Modified) v0.1** weight licence.
  I read the licence file directly: commercial use is prohibited if you or your employer
  "generated more than five million US Dollars ($5,000,000) in gross revenue in the prior year",
  or raised >$5M in equity/debt, or offer a competing product — exempted only for "personal use
  or research purposes". Fine for a prototype, a landmine for anything shipped.
- **LayoutLMv3**: MIT code, **CC BY-NC-SA 4.0 weights** — non-commercial. Also the wrong shape:
  it is a token classifier needing OCR boxes as input, not a page-level region detector.

**Only PP-DocLayout is permissive end-to-end.** That is not a close call.

---

## 8. What I did not establish

Stated plainly, because these are the things a later session will want to know were gaps.

**The two-column corpus gap is still open.** [[01]] records that `sample_books/` has no two-column
document, and **that is still true — I did not add one to the repo.** For the fairness of this
test I fetched `web/compressed.tracemonkey-pldi-09.pdf` from the
[PDF.js repository](https://github.com/mozilla/pdf.js/tree/master/web) — the Gal et al. PLDI 2009
TraceMonkey paper, which PDF.js ships as its own reference test document and which [[02]] already
used as a two-column proxy. It lives at `/tmp/claude-1000/dla/twocol.pdf`, **outside the repo, and
neither it nor any rendered page image was committed.** Anyone repeating this must re-fetch it.
(I first pulled arXiv 1706.03762 and discovered it is NeurIPS single-column — not useful here.)

**`aside_text` is untested on real sidebars** (§5). One firing in 40 pages proves nothing. [[03]]
said its answer would change "if the ticket-01 corpus turns out to be dominated by
heavily-designed, sidebar-rich, magazine-style modern textbooks" — that corpus still does not
exist, so the single most valuable next test is a sidebar-heavy book, not more of these three.

**docling was not run.** The install did not complete and I chose not to spend ~2.5 GB of torch
on it. All docling claims here are from its repo and model card.

**`onnxruntime-web` in a browser was not run.** §6's WASM latency figure is inference from the
Node measurement, not a measurement.

**Thread scaling was not swept.** All timings are on 16 cores.

**I did not score classification accuracy against ground truth.** There is no annotated ground
truth for these pages, and hand-annotating 40 pages was not affordable in-session. What I measured
is the *join* (§3), which is objective, plus a qualitative read of three pages against the real
rendering. The join numbers are trustworthy; "the model classifies textbooks well" is my
judgement from reading its output, not a metric.

**Word boxes came from PyMuPDF, not PDF.js.** Both report PDF user space and [[02]] §1 documents
the flip that gets PDF.js `TextItem.transform` there, so the geometry is the same space — but a
PDF.js-side reimplementation should re-verify the join on one page before trusting §3's numbers
wholesale. I expect no surprise; I did not prove it.

---

## 9. Does [[06]] survive?

The ticket offers three shapes. **The answer is shape 2 — model primary, geometric fallback — but
the fallback that remains is much smaller than [[03]]'s 600–900 lines, and its content changes.**

**Why not shape 1 (model replaces [[06]] outright).** Three reasons, none of them accuracy.
First, the model is a 203 MiB asset with a nontrivial per-page cost, and a page it fails — or a
page reached before the analysis pass catches up — still needs *something* to speak. Second, its
output is region rectangles; turning "regions in order" into "sentences in order" still requires
the item-to-region join, the in-region line ordering, and paragraph/sentence assembly. That is
real code, it is just not *layout analysis* code. Third, `aside_text` is unvalidated on the case
that motivated the question (§8), so committing entirely to the model on the strength of 40 pages
of non-sidebar textbook would be over-reading the evidence I actually have.

**Why not shape 3 ([[03]]'s plan stands).** Because the evidence against it is direct and
measured. [[03]]'s own framing was "ordering is easy, classification is hard, and classification
is where all the honest failure modes live". The model does classification well enough on this
corpus that the failure modes [[03]] enumerated in §7 — running heads, captions, footnotes,
equations, page numbers, code listings — simply did not occur on the pages I ran, and the one
class of error I did see (`display_formula` on a raster alphabet chart) cost nothing because the
region held no text. Meanwhile it also does the ordering, correctly, on a genuine two-column
page with full-width spanning bands, which is the exact case [[06]] was created to de-risk. And
critically, **the join risk that would have killed the idea is measured at 0.015% harmful
straddle**. Writing 600–900 lines of geometry to reproduce a subset of what a 203 MiB Apache-2.0
file already does — and does better, since it gets `inline_formula` and `aside_text` which [[03]]
declined and feared respectively — is not defensible on this evidence.

**So [[06]] should be rewritten, not deleted.** Its new content:

1. **Wire the model as the primary path.** Rasterise the page (PDF.js can render to an
   `OffscreenCanvas` you already have), run `ppu-doclayout`, take `boxes` in the order returned.
2. **Build the join** — assign text-layer items to regions by max area overlap, treating
   `inline_formula` / `formula_number` / `number` as annotations rather than containers. §3 says
   this is safe. Verify it once from the PDF.js side rather than PyMuPDF's.
3. **Order within a region** by the trivial baseline sort; the model has already ordered the
   regions themselves, so [[03]]'s Passes 2–4 (bands, gutters, columns) are **not needed**.
4. **Keep a small geometric fallback** for the case where the model has not run yet, fails, or
   returns nothing: line clustering plus plain top-to-bottom / left-to-right. That is [[03]]'s
   Pass 1 and a naive Pass 4 — call it **150–250 lines**, not 600–900. Gutter detection, band
   segmentation, cross-page repetition and the caption/footnote/equation heuristics all fall away.
5. **Measure on a sidebar-heavy textbook** before declaring the classification half closed (§8).

Two consequences elsewhere on the map:

- **[[07]] should adopt the model's vocabulary rather than invent one.** Those 25 labels are a
  real, trained, stable taxonomy, and every mapping we define on top of a different vocabulary is
  a translation layer that will drift. Ticket 07 becomes "which of these 25 do we speak, which do
  we announce-and-skip, and which do we drop silently" — a policy question, not a taxonomy one.
- **[[02]] and [[05]] are untouched**, and the ticket's proposed reading is confirmed: the model
  returns *regions*, never per-character geometry. It cannot draw the sentence band and does not
  try. The band still comes from `Range.getClientRects()` over the PDF.js text layer exactly as
  [[02]] §4 specifies. The model complements the text layer; it selects and sequences the items
  the band is drawn over.

The [[03]] finding that most needs updating is its §4 conclusion that "nothing exists" for
client-side JS. That was true in the sense it meant — no JS library does *geometric* layout
analysis over PDF.js output — and it is still true in that sense. But the escape hatch it noted
in a footnote and told us not to build on has become a working, MIT-licensed, typed, dual-target
package running Apache-2.0 weights. On this corpus, it works.

---

## Sources

**Run on this machine (primary, measured):**
- `ppu-doclayout@1.0.0` + `onnxruntime-node@1.29.0` + `PP-DocLayoutV2.onnx` (203 MiB), Node v22.16.0,
  CPU execution provider, over 40 rendered pages of the three `sample_books/` PDFs and the
  TraceMonkey paper. Scratch work at `/tmp/claude-1000/dla/` (`run.mjs`, `join.py`, `agg.py`,
  `straddle_detail.py`, `paddle_layout.py`, `out_sweep.json`, `out_150.json`, `out_200.json`,
  `out_tm150.json`, `out_paddle.json`).
- `paddleocr==3.3.2` / `paddlex==3.3.9` / `paddle==3.2.2`, `LayoutDetection(model_name="PP-DocLayout_plus-L", device="cpu")`.
- `pymupdf==1.28.2` for page rasterisation and for the text-layer word boxes used in the join.

**Model cards and repos (read directly):**
- [PaddlePaddle/PP-DocLayoutV2](https://huggingface.co/PaddlePaddle/PP-DocLayoutV2) — Apache-2.0; RT-DETR + pointer network for reading order; part of PaddleOCR-VL ([arXiv:2510.14528](https://arxiv.org/abs/2510.14528))
- [PaddlePaddle/PP-DocLayoutV3](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3) — Apache-2.0; ECCV 2026; [arXiv:2606.23344](https://arxiv.org/abs/2606.23344)
- [PaddleOCR PP-StructureV3 algorithm doc](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-StructureV3/PP-StructureV3.en.md) — OmniDocBench edit distances (overall 0.145 EN / 0.206 ZH; read-order 0.069 EN / 0.091 ZH), A100/V100/CPU timings
- [PaddleOCR PP-StructureV3 pipeline doc](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PP-StructureV3.en.md) — module list, model sizes, 20-category layout class list including "sidebar text"
- [PT-Perkasa-Pilar-Utama/ppu-doclayout](https://github.com/PT-Perkasa-Pilar-Utama/ppu-doclayout) — MIT; README, API, ~654 ms/page on M1; npm registry metadata for version/licence/deps
- [docling-project/docling](https://github.com/docling-project/docling) — MIT
- [docling-project/docling-layout-heron](https://huggingface.co/docling-project/docling-layout-heron) — RT-DETRv2, DocLayNet-trained, 17 classes, Apache-2.0
- [opendatalab/DocLayout-YOLO](https://github.com/opendatalab/DocLayout-YOLO) — AGPL-3.0; D4LA 70.3 / DocLayNet 79.7 mAP with DocSynth300K pretraining; last README milestone 2024.10.25; [arXiv:2410.12628](https://arxiv.org/abs/2410.12628)
- [datalab-to/surya `MODEL_LICENSE`](https://github.com/datalab-to/surya/blob/master/MODEL_LICENSE) — AI Pubs Open RAIL-M (Modified) v0.1, $5M revenue/funding ceiling, competing-product clause
- [opendatalab/MinerU licensing discussion #2863](https://github.com/opendatalab/MinerU/discussions/2863) — effective AGPL-3.0 via unlicensed YOLO
- [mozilla/pdf.js `web/compressed.tracemonkey-pldi-09.pdf`](https://github.com/mozilla/pdf.js/tree/master/web) — the two-column test document, fetched to scratch, not committed

**Sibling tickets relied on:**
- [[01]] corpus characterisation, [[02]] §1 and §4 text-layer geometry and the recommended
  per-word pipeline, [[03]] §4 (JS viability), §6 (classification) and §7 (failure modes),
  [[06]] scope, [[09]] equation-glyph findings.
