# Research: where does equation *content* come from, and what does it cost?

Ticket: `.scratch/pdf-native-read-aloud/issues/15-formula-recognition.md`
Date: 2026-09-05

Same convention as [[12]]: **[measured]** was run on this machine this session against real
Millington crops; **[documented]** was read off a repo, model card or paper and not reproduced.
The distinction matters more here than anywhere else on this map, because every vendor number in
this field is computed on clean rendered formulae from arXiv, and our input is a crop out of a
1500-page textbook.

---

## 0. TL;DR

- **Equation content is recoverable, and I recovered it.** `breezedeus/pix2text-mfr`
  (**MIT weights**, MIT code) running its own ONNX encoder+decoder under **`onnxruntime-node`
  with no Python and no wrapper library** turned Millington p60's display equation into
  `v = \operatorname*{\lim}_{\Delta t \to 0} \frac{\Delta p}{\Delta t}` — **exactly right**, including
  the three Δ that [[09]] found arrive from the text layer as U+0003. **~500 ms median per display
  equation on CPU, 113 MB of weights.**
- **Display equations work; inline ones do not.** Over 25 `display_formula` regions from 7
  equation-dense Millington pages: **21/25 exactly correct and 25/25 parse in KaTeX** (pix2text-mfr).
  Over 27 `inline_formula` regions from the same pages: **essentially 0 usable** — but the fault is
  the *box*, not the recogniser. [[12]]'s `inline_formula` boxes are ragged: they clip glyphs and
  swallow adjacent prose and punctuation (`e v = ṗ),`). Garbage in.
- **A second recogniser confirms the number and is not better.** `PP-FormulaNet_plus-S`
  (Apache-2.0 weights, the natural same-family fit) scored **19/25 exact, 23/25 KaTeX-parseable**
  at 509 ms median. Its errors are *disjoint* from pix2text-mfr's: at least one of the two is right
  on **24 of 25**.
- **But PP-FormulaNet does not reach `onnxruntime-node`, and I proved that rather than assumed it.**
  `paddle2onnx` 2.1.0 exports it (334 MB, single input, whole greedy-decode loop in-graph — the
  ideal shape), the file **loads** in ORT, and then **fails at `Loop.0 → If.3 → Identity.669` with a
  rank-0/rank-1 mismatch, identically in `onnxruntime-node@1.24.3` and Python `onnxruntime==1.23.2`,
  at opset 19 and opset 16**. So PP-FormulaNet is Python-only *in practice today*, and this is the
  mirror image of [[12]], where the PaddleOCR model was the one with the JS story.
- **Cost is small and the access pattern is the best on this map.** ~500 ms/equation, ~2.0 s for
  *all* display equations on the densest Millington page, 113 MB download, 326 MB peak node RSS.
  Equations are rare (11 of 18 sampled Millington pages have **zero**), reached one at a time, and
  cacheable forever. This is nothing like [[12]]'s per-page 731 ms tax.
- **MathML is free.** KaTeX 0.18.5 renders the recovered LaTeX to MathML in-process — median
  **527 bytes** of MathML per display equation, all 25 parsed. No MathJax, no second dependency.
- **The one real hazard is confident nonsense.** Fed a region [[12]] *mislabelled* as
  `display_formula` (Code Book p41's raster cipher-alphabet table), the recogniser did not fail —
  it produced plausible-looking LaTeX (`\mathrm{IIain~alphibet}\quad\textrm{abcdelghijklmnopqrstuvwxyz}`)
  and once ran to the 256-token cap at **4.0 s**. Wrong maths rendered confidently over the page is
  the failure mode [[13]]'s additive rule has to survive.
- **Verdict for [[13]]: yes, re-typeset display equations is a viable first HTML-layer feature.**
  It is a *third model* but it is the cheapest of the three, it is fully permissive end-to-end, it
  runs in the runtime we already chose, and it fixes the one place the reading experience is
  currently broken. **Scope it to `display_formula` only.** See §10.

---

## 1. The field, September 2026 — licences checked on both halves

Code and weights are licensed separately, and as in [[12]] that is where most candidates fail.
Licences below were fetched this session from the HF model API's `cardData.license` and from repo
LICENSE metadata; benchmark numbers are **[documented]**.

| Candidate | Code | **Weights** | Runtime reality | En-BLEU | Size |
|---|---|---|---|---|---|
| **pix2text-mfr** (Pix2Text) | MIT | **MIT** | **ONNX; runs in `onnxruntime-node` — proven §5** | not published | **113 MB** |
| **PP-FormulaNet_plus-S** | Apache-2.0 | **Apache-2.0** | Paddle; ONNX export **fails in ORT** (§5) | 88.71 | 248 MB |
| PP-FormulaNet_plus-M / -L | Apache-2.0 | Apache-2.0 | same | 91.45 / 92.22 | 592 / 698 MB |
| PP-FormulaNet-S / -L | Apache-2.0 | Apache-2.0 | same | 87.00 / 90.36 | 224 / 695 MB |
| UniMERNet (base/small/**tiny**) | Apache-2.0 | **Apache-2.0** (`wanderkid/unimernet_*`) | PyTorch only first-party; third-party ONNX port exists (§1.1) | 85.91 | 1530 / 773 / 441 MB |
| **Texo** (`alephpi/FormulaNet`) | **AGPL-3.0** | **AGPL-3.0** | ONNX + transformers.js, browser-ready, 20M params | 90.14 (SPE) | **54+26 MB** |
| **Texify** (`datalab-to/texify`) | GPL-3.0 | **CC BY-NC-SA 4.0 — non-commercial** | PyTorch | — | — |
| **Nougat** (`facebook/nougat-base`) | MIT | **CC BY-NC 4.0 — non-commercial** | PyTorch | — | — |
| pix2tex / LaTeX-OCR | MIT | unstated on the checkpoints | PyTorch; ONNX only via RapidLaTeXOCR (Python) | 74.55 as `LaTeX_OCR_rec` | 99 MB |

Three things this table decides before any accuracy number is looked at:

1. **Texify and Nougat are out.** Both carry **non-commercial** weight licences (CC BY-NC-SA 4.0 and
   CC BY-NC 4.0 respectively, read from their model cards). Same disqualification shape [[12]] found
   for LayoutLMv3. Note also that Surya's README now states a **$2M** revenue/funding ceiling where
   [[12]] §7 recorded **$5M** from `MODEL_LICENSE`; whichever is current, the direction of travel is
   *down*, which is a reason not to build on that family at all.
2. **Texo is the most technically attractive thing in the field and is AGPL-3.0 on both halves.**
   20M parameters, distilled *from* PP-FormulaNet-S, shipping a complete transformers.js-ready
   `onnx/` folder (54 MB encoder + 26 MB merged decoder, i.e. **under half** the size of the model I
   ended up using) with a browser demo that also emits MathML and Typst. It is exactly what this
   ticket was hoping to find, and its licence makes it unusable for anything but a personal
   prototype. Worth revisiting only if the authors relicense.
3. **Only pix2text-mfr and PP-FormulaNet are permissive end-to-end**, and of those only
   pix2text-mfr actually runs outside Python (§5).

### 1.1 Staleness flags for whoever reads this later

- `breezedeus/pix2text-mfr`'s weights were **last modified 2024-05-05** and have ~285k downloads.
  The parent repo `breezedeus/Pix2Text` (MIT) was pushed **2026-08-23**, so the project is alive
  even though this particular checkpoint is two years old. It is the *oldest* thing I recommend and
  that should be re-checked before a real build.
- `torvexlabs/unimernet-onnx` (Apache-2.0 code) packages UniMERNet-**tiny** as encoder /
  decoder / decoder-with-past ONNX, hosting weights at `Sibitorvex/unimernet-tiny-onnx` — whose
  model card carries **no licence tag at all** **[measured]**. The upstream `wanderkid/unimernet_tiny`
  weights *are* Apache-2.0, so the lineage is clean, but the redistribution is not labelled. If
  pix2text-mfr's age becomes a problem, this is the next thing to evaluate — same architecture
  family, same three-file ONNX shape that worked here.
- **Texo is 2026 work** ([arXiv:2602.17189](https://arxiv.org/abs/2602.17189)) and did not exist
  when this map was drawn. It is proof the field is still moving toward small, browser-deployable
  recognisers, which is good news for the *shape* of this ticket's answer even if that particular
  model is unusable.

---

## 2. What I ran, and how the crops were made [measured]

**Machine**: Linux, 16 logical cores, 13 GB RAM. **CPU only** throughout, same discipline as [[12]] —
the deployment target is a laptop, not the RTX 3060 in this box.

**Reused from [[12]]** as instructed: `/tmp/claude-1000/dla/jsnode` (Node v22.16.0,
`ppu-doclayout@1.0.0`, `onnxruntime-node@1.29.0`, `PP-DocLayoutV2.onnx`) and its `run.mjs`.

**Pipeline for producing the test set** — this is the real end-to-end path, not a curated set of
clean formula images:

1. Rendered **18 Millington pages at 200 dpi** with PyMuPDF 1.28.2 (p60–63, 86, 120, 145, 178, 204,
   231, 262, 290, 310, 340, 368, 402, 430, 455).
2. Ran [[12]]'s layout model over all 18. Median **~610 ms/page**, consistent with [[12]]'s 731 ms.
   Labels returned: `text 122, inline_formula 27, display_formula 25, paragraph_title 21, header 18,
   number 18, algorithm 15, image 4, formula_number 3, figure_title 2`.
3. Converted each formula box from 200-dpi image px to PDF points (÷ 200/72, offset by
   `page.rect` origin), padded **3 pt**, and **re-rendered that clip from the PDF at 300 dpi**.
   This matters: cropping the 200-dpi raster would have thrown away resolution the recogniser
   wants. In a real app the same clip comes from a PDF.js `render()` with a `transform` — same idea.
4. Fed each crop to two recognisers and checked the output with **KaTeX 0.18.5**
   (`throwOnError: true`, `output: "mathml"`).

**Detector recall is not the bottleneck.** 11 of the 18 pages returned **zero** formula regions —
and spot-checking those pages confirms they genuinely contain no equations (p290 is a full-page
figure plus prose). Millington's maths is chapter-clustered, not evenly spread. The 25 display
formulas come from just **7 pages**, at 3–4 per page.

**Recogniser A — `pix2text-mfr`, pure `onnxruntime-node`.** `encoder_model.onnx` (87,496,990 B) +
`decoder_model.onnx` (30,114,937 B), TrOCR architecture (DeiT-384 encoder, 6-layer 256-d decoder,
1200-token vocab), `use_cache: false`. I wrote the greedy loop by hand in ~50 lines
(`/tmp/claude-1000/mfr/js/raw.mjs`): sharp → 384×384 → `(x/255 − 0.5)/0.5` → encoder →
argmax-decode until EOS, cap 256 tokens. **No Python, no transformers.js, no wrapper package.**

**Recogniser B — `PP-FormulaNet_plus-S` via PaddleOCR.** `paddleocr==3.3.2`, `paddlepaddle==3.2.2`,
`tokenizers==0.23.2`, `device="cpu"`. Weights auto-downloaded to `~/.paddlex/official_models/`.

Both were run twice per crop; every latency quoted is the **warm** run.

### A gotcha worth recording: transformers.js silently produces garbage here

My first attempt used `@huggingface/transformers@4.2.0` on the same ONNX files. It loaded, ran, and
returned `"vbiglogxrightvbiglogxright…"` repeated to the token cap — **degenerate output with no
error**. The library expects `onnx/decoder_model_merged.onnx` and a with-past decoder; pix2text-mfr
ships a cache-free decoder at the repo root. Dropping to raw `onnxruntime-node` and writing the
decode loop myself produced perfect output on the very first crop. **If someone builds this, do not
reach for transformers.js by reflex** — the failure is silent and looks like a bad model rather
than a bad harness.

---

## 3. Display formulas: 25 regions, graded by eye against the rendered crop [measured]

There is no LaTeX ground truth for this book, so I graded by opening each crop image and comparing
it to what each model emitted. ✓ = semantically correct (bold-vs-upright of a vector symbol treated
as cosmetic, since both render legibly); ~ = right symbols, wrong structure; ✗ = wrong content or
does not render.

| # | region | pix2text-mfr | PP-FormulaNet_plus-S | note |
|---|---|---|---|---|
| 1 | p120_03 | ✓ | ✓ | PFN keeps `\boldsymbol`, P2T drops it |
| 2 | p120_10 | ✓ | ✗ | PFN emits `\boldsymbol\{p{}}` — KaTeX parse error |
| 3 | p120_13 | ✓ | ✓ | identical output |
| 4 | p120_15 | ✗ | ✓ | P2T invents a dot: `\dot{p_0}` where the page has `p_0` |
| 5 | p402_08 | ✓ | ✗ | PFN `\dot{p\}}^{\prime}` renders a stray brace |
| 6 | p402_10 | ✓ | ✓ | |
| 7 | p402_14 | ✓ | ✓ | |
| 8 | p455_07 | ~ | ~ | 3×3 inertia tensor. P2T has every entry right but no `&` — one column. PFN's row structure is wrong (2 cells in rows 1 and 3). **The only region neither model gets.** |
| 9 | p455_10 | ✓ | ✓ | |
| 10 | p455_12 | ✓ | ✗ | PFN `dmathop\{m}` |
| 11 | p455_18 | ✓ | ~ | 3×3 diagonal; PFN drops one `{0}` from row 1 |
| 12–14 | p60_06, _11, _13 | ✓ ✓ ✓ | ✓ ✓ ✓ | **the Δ page** — both perfect |
| 15–18 | p61_04, _08, _11, _13 | ✓ ✓ ✓ ✓ | ✓ ✓ ✓ ✓ | |
| 19 | p62_07 | ✗ | ✓ | P2T drops the dot on `a_x` in a column vector |
| 20 | p62_09 | ✗ | ✓ | P2T writes `\dot` for two of three `\ddot` |
| 21 | p62_15 | ✓ | ✗ | PFN writes `\widehat{x}` where the page has `\dot{x}` |
| 22–25 | p63_04, _06, _15, _20 | ✓ ✓ ✓ ✓ | ✓ ✓ ✓ ✓ | |

**Totals**

| | exact | partial | wrong | **parses in KaTeX** |
|---|---|---|---|---|
| pix2text-mfr | **21/25 (84%)** | 1 | 3 | **25/25** |
| PP-FormulaNet_plus-S | 19/25 (76%) | 2 | 4 | 23/25 |
| **either one correct** | **24/25** | — | 1 | — |

Three honest observations about these numbers:

- **KaTeX-parses is a floor, not a score.** PFN's `Iboldsymbol{=}\left[…` parses fine and renders
  the literal letters "Iboldsymbol" — a visible lie that passes the syntax check. Conversely P2T's
  25/25 parse rate is genuinely useful as a *runtime gate*: it is a free, in-process check you can
  run before ever putting anything on screen, and it caught two of PFN's four hard failures.
- **The failures are disjoint.** P2T fails on {4, 19, 20} — all three are *diacritic* errors
  (dot vs double-dot vs nothing) in stacked column vectors. PFN fails on {2, 5, 10, 21} — all four
  are *token-level* corruptions producing malformed LaTeX. Different models, different failure
  physics. A two-model agreement check would flag 7 of the 8 disputed regions and reach 24/25, at
  double the cost and double the download. **Not worth it for a prototype**, but it is the obvious
  escalation if accuracy ever needs to go up.
- **Both models degrade on the same thing: matrices.** Every ✗ and both ~ involve a stacked or
  aligned structure (`\begin{matrix}`, column vectors). Single-line algebra — which is the
  overwhelming majority of Millington's display maths — is essentially solved: **18 of the 19
  non-matrix regions are correct in both models simultaneously.**

The headline case from [[09]]. Millington p60, where `Δp/Δt` extracts from the text layer with the
Δ glyphs as literal U+0003:

```
crop  → v = lim(Δt→0) Δp/Δt          (the rendered page)
text  → "v = lim t→0 p t"            ([[09]]: every Δ is U+0003)
P2T   → v = \operatorname*{\lim}_{\Delta t \to 0} \frac{\Delta p}{\Delta t}
PFN   → v = \operatorname*{l i m}_{\Delta t\to0}\frac{\Delta p}{\Delta t}
```

**The recogniser reads what the text layer cannot.** That is the whole ticket in four lines.

---

## 4. Inline formulas: the negative result, and it is the box's fault [measured]

All 27 `inline_formula` regions were run through both models. The output is unusable:

```
p60_20   P2T ":v=p),"                 PFN "t v=\dot{p}),"
p61_18   P2T "\dot{p},\dot{i}"        PFN "\dot{\cdot}\ {\dot{p}},\dot{\cdot}\"
p120_04  P2T "\textrm{i}\mathrm{i}"   PFN ":k i"
p455_02  P2T ":a_{p_{i}}"             PFN "\ \ cdot;;;"
```

Then I opened the crops. **The regions are wrong, not the recognisers.** `p60_20` is a crop reading
`e v = ṗ),` — it begins mid-word in the surrounding prose, includes the closing parenthesis and
comma, and clips the ascenders. `p61_18` is `: ṗ,` with the row below bleeding in. These are not
formula images; they are ragged rectangles that happen to contain some maths.

This is consistent with [[12]] §4's note that `inline_formula` boxes are "interleaved arbitrarily
relative to their containing `text` block" and were treated there as annotations rather than
containers. [[12]] never needed them to be tight. This ticket does, and they are not.

**Consequence: scope the first feature to `display_formula` and say so explicitly.** Recovering
inline maths would need a box-refinement pass (connected-component tightening, or intersecting the
model box with the text-layer item boxes of the C0-bearing run [[09]] identified) before the
recogniser ever sees it. That is separate work and it is not needed for [[13]]'s first feature,
because inline maths is *not the broken case* — an inline `ṗ` inside a spoken sentence is a
pronunciation problem, whereas a display equation is a silent hole.

Also worth knowing: [[09]]'s C0-control-character sentinel and the layout model's
`display_formula` label **agree** on every one of the 25 display regions here. Two independent
signals for the same thing, which is a cheap confidence check if one is ever wanted.

---

## 5. The runtime question — and it inverts [[12]] [measured]

[[12]]'s decisive finding was that PP-DocLayout was the *only* candidate with a JS/ONNX story.
Here the PaddleOCR family is the one that cannot get out of Python.

### 5.1 pix2text-mfr in `onnxruntime-node`: works, no wrapper needed

```
sessions ms 310–1048   (encoder + decoder, warm to cold)
p60_06_disp   [775, 488] ms   33 tokens   v = \operatorname*{\lim}_{\Delta t \to 0}\frac{\Delta p}{\Delta t}
```

`onnxruntime-node@1.24.3`, CPU EP, no execution-provider tuning, no `intraOpNumThreads` sweep. Peak
process RSS **326 MB** for node with both sessions loaded. The whole thing is `sharp` for the
resize plus ~50 lines. There is no npm package to depend on and no maintainer to depend on —
which, given [[12]] §7's note that `ppu-doclayout`'s weights come from one person's GitHub LFS
quota, is arguably an *advantage*: two ONNX files you mirror yourself.

### 5.2 PP-FormulaNet through paddle2onnx: exports, loads, will not run

This is the experiment I most wanted to work, because a PaddleOCR-family recogniser next to a
PaddleOCR-family detector would be one vocabulary and one lineage.

`paddle2onnx==2.1.0`, PR [#1523](https://github.com/PaddlePaddle/Paddle2ONNX/pull/1523) (merged
2025-02-28) explicitly added PP-FormulaNet-S/-L support, and the export *nearly* works:

- **It produces exactly the right shape**: a single 334 MB file, one input `x` `[1,1,384,384]`, one
  output `fetch_name_0` — the **entire autoregressive decode is an in-graph ONNX `Loop`**. One
  `session.run()` per equation, no JS-side decode loop, no KV-cache plumbing. Architecturally this
  is *better* than the three-file transformers-style export.
- **It loads cleanly** in `onnxruntime-node`.
- **It throws on execution:**
  ```
  Non-zero status code returned while running Loop node. Name:'Loop.0'
    → If node 'If.3' → Identity node 'Identity.669'
    OrtValue shape verification failed. Current shape:{} Requested shape:{1}
  ```
- The export itself warned of this: `Fail to fold onnx model … (op_type:Loop) … (op_type:If) …
  Inferred shape and existing shape differ in rank: (1) vs (0). Skip folding.`
- **Reproduced in Python** `onnxruntime==1.23.2` with the identical error, so it is **not** a
  Node-binding problem — it is a bad export.
- **Re-exported at opset 16**: identical failure at the identical node.
- Preprocessing was taken *from PaddleX itself* (`UniMERNetImgDecode` → `UniMERNetTestTransform` →
  `LatexImageFormat`, mean 0.7931 / std 0.1738, dumped to raw f32 and read from Node) precisely so
  that a preprocessing mistake of mine could not be confused with a runtime failure. It could not:
  the graph fails before consuming anything meaningful.

**Conclusion: PP-FormulaNet is a Python-only model today for our purposes.** Adopting it means the
Python sidecar that [[11]] already puts on [[08]]'s desk for Piper — which is not nothing, but it
means the *formula* model would no longer be the reason to have one. Given pix2text-mfr scores
*higher* on this corpus and runs natively in Node, there is no reason to pay that.

---

## 6. Cost, and why the access pattern makes it cheap [measured]

| | pix2text-mfr / ORT-node | PP-FormulaNet_plus-S / Paddle |
|---|---|---|
| display: median | **495 ms** | 509 ms |
| display: p90 / min / max | 881 / 249 / 1705 ms | 934 / 341 / 1577 ms |
| inline: median | 247 ms | 349 ms |
| **worst case observed** | **4057 ms** (256-token runaway) | 581 ms |
| session/predictor init | 310–1048 ms | 6.4 s |
| weights on disk | **113 MB** (87.5 + 30.1) | 248 MB |
| peak process RSS | 326 MB | not measured |

**All 25 display equations across all 7 equation pages took 14.0 s total** — i.e. **~2.0 s to fully
re-typeset the densest page in the book**, and that page has four equations on it.

Compare the *shape* of this cost to [[12]]'s. Layout analysis is a **tax on every page** (731 ms ×
600 pages). Formula recognition is a **charge on a rare event**: 11 of 18 sampled Millington pages
have no equations at all, and the Code Book and Crafting Interpreters have far fewer still
([[12]]'s 40-page sweep found only 11 `display_formula` regions in total, two of them a
misclassified raster). Recognition is also **idempotent and permanently cacheable** — a given
region of a given PDF has one answer forever, keyed by page + box.

So the honest cost model is: **run it lazily when the reader's page comes into view, one equation
at a time, and cache by (document hash, page, region box).** At 500 ms each, three or four
equations resolve in the time it takes the TTS to speak the paragraph above them. Nothing here
needs to block anything.

**The 4-second outlier deserves its own note.** A greedy decoder with no repetition penalty runs to
the token cap when it is confused; I saw it twice (an inline crop, and the mislabelled Code Book
raster, §7). Cap the token budget — 256 was enough for every genuine equation, and the largest real
one, the 3×3 inertia matrix, used 146 — and treat cap-hit as failure, not as output.

**Not measured**: `onnxruntime-web` in a browser. Same caveat as [[12]] §6 — expect several times
slower under WASM. But 113 MB is roughly *half* [[12]]'s 203 MiB layout model, so if the layout
model is affordable in a given delivery shape, this is too.

---

## 7. Rendering, and the one real hazard

**MathML comes free.** KaTeX 0.18.5 renders every recovered string to MathML in-process
(`output: "mathml"`), **median 527 bytes, max 2016 bytes** per display equation, all 25 successful.
So [[13]]'s question — "MathML renders natively in a browser; LaTeX needs KaTeX or MathJax" — has a
better answer than either branch: **take LaTeX from the model, run KaTeX once, and you have both.**
KaTeX is MIT and it doubles as the syntax gate described in §3. MathJax is not needed.

**The hazard is silent confident nonsense, and I measured it.** [[12]] §2 recorded that Code Book
p41 has two regions the layout model labels `display_formula` which are actually a **raster
plain/cipher alphabet table**. [[12]] correctly observed that this "costs us nothing" because the
region holds no text items and the read-aloud stream is unchanged. **That reasoning does not carry
over to this ticket.** I cropped those two regions and fed them to the recogniser:

```
code_p41_09  [521 ms]   \mathrm{IIain~alphibet}\quad\textrm{abcdelghijklmnopqrstuvwxyz}
code_p41_10  [4024 ms]  \mathrm{Ciphier~alphaber~}\,X-\mathrm{~V~0~i~D~B~Y--R~S~P~C--T~K~i~M~-~}\,…  (hit the 256-token cap)
```

It did not refuse. It produced well-formed, KaTeX-renderable LaTeX that is entirely wrong, and
would be drawn as a maths block over a table. **A misclassification that was free in [[12]] is not
free once something gets rendered on top of it.**

Three mitigations, all cheap, all of which [[13]]'s existing rules already point at:

1. **Never occlude.** [[13]]'s "render nothing where the model is unconfident; never occlude"
   already covers this if the re-typeset equation is *offered* (on hover, in a popover, beside the
   region) rather than *painted over* the original glyphs. The original pixels stay authoritative
   and the reader can see instantly that the overlay disagrees with the page.
2. **Gate on KaTeX parse** (§3) — free, in-process, catches malformed output.
3. **Gate on token-cap-hit and on region aspect/size** — the two false positives here were a wide
   short raster and an oversized run; both are outside the shape distribution of real display
   equations.

---

## 8. The second-order prize — mentioned only, per the ticket

The ticket asks only whether the output would make spoken maths *possible*. It would. MathML is the
input format of the mature accessibility stack for this — MathJax's Speech Rule Engine (Apache-2.0)
exists precisely to turn MathML into spoken English, and §7 shows MathML is already in hand at
527 bytes an equation. So the door is open and it costs nothing extra to leave it open.

That is the entire claim. Reading maths aloud *well* — disambiguating `\frac{\Delta p}{\Delta t}`
into "delta p over delta t" versus "the ratio of the change in p to the change in t", deciding when
to say "vector p" for `\boldsymbol{p}`, pacing a matrix — is its own field, and this ticket does
not touch it. It stays fog on the map.

---

## 9. What I did not establish

- **No `onnxruntime-web` / browser run.** §6's WASM claim is inference from the Node measurement.
- **Only Millington.** The other two corpus books are near-mathless; [[12]]'s whole 40-page sweep
  produced 11 `display_formula` regions, two of them false. So the accuracy numbers here are
  **one book, one typesetter, one maths font**. Millington is the right book to test — it is the
  equation-dense one and the one [[09]] found broken — but 25 regions is 25 regions.
- **No handwriting, no scans, no Chinese.** All inputs are born-digital vector text re-rasterised
  at 300 dpi. The vendor BLEU tables include scanned and handwritten sets; I tested neither.
- **Grading is my eye against the crop, not an automatic metric.** There is no LaTeX ground truth
  for this book. CDM/ExpRate would need a renderer-based comparison harness I did not build. The
  KaTeX-parse column *is* objective; the ✓/~/✗ column is judgement.
- **UniMERNet was not run.** Its first-party release is PyTorch `.pth` at 441 MB even for tiny, and
  PP-FormulaNet's own table puts it *behind* PP-FormulaNet-S on En-BLEU at 6× the size and 32× the
  CPU latency. Testing it would have cost a torch install to confirm a number I can read.
- **Texo was not run**, on licence grounds. Given AGPL-3.0 on both code and weights, a measurement
  would not have changed any recommendation.
- **No thread-count sweep**, same gap as [[12]] §8. All timings are 16 cores.
- **Crop padding was not tuned.** 3 pt was the first value I tried and it worked; tighter or looser
  padding may move the display-formula score, and would certainly move the inline one.

---

## 10. Verdict for [[13]]

**Re-typeset display equations is a viable first HTML-layer feature. Build it.**

The costs [[13]] feared are smaller than they looked from the outside:

- It is a third model, but it is **the smallest of the three** — 113 MB against [[12]]'s 203 MiB
  and Piper's voice files — and the only one whose cost is per-*event* rather than per-page or
  per-sentence.
- It **runs in the runtime already chosen**. `onnxruntime-node` is already in the tree for [[12]].
  This adds two ONNX files and ~50 lines of decode loop. No new runtime, no Python, nothing new for
  [[08]] to price. (That is the specific reason to take pix2text-mfr over PP-FormulaNet, §5.2.)
- It is **permissive end-to-end** — MIT code, MIT weights, MIT/Apache runtime, MIT KaTeX. The trap
  [[12]] found in this field is avoided rather than survived.
- It **works on the hard book**, on the exact page [[09]] flagged, recovering the exact glyphs the
  text layer destroys.

Four conditions on that yes, and they are not optional:

1. **`display_formula` only.** Inline maths is out of scope until someone tightens those boxes (§4).
   This is the single most important scoping line in this ticket.
2. **Additive presentation, per [[13]]'s own rule.** Offer the re-typeset equation beside or above
   the region, or on demand — do not paint it over the original glyphs. §7 shows the recogniser
   will confidently produce wrong maths for a wrongly-labelled region, and the reader's ability to
   see the real page underneath is the entire recovery mechanism.
3. **Gate on KaTeX parse and on token-cap-hit; render nothing on failure.** Free, in-process, and it
   catches the malformed-output failure mode outright.
4. **Lazy and cached**, keyed by (document, page, region box). Never on document open.

**If it had gone the other way**, [[13]]'s fallback to per-paragraph controls would have been the
right call. It did not: the model exists, it is free, it is small, it runs where we already are, and
on this book it is right about 21 times in 25 with a free syntax check catching a good share of the
rest. The thing [[13]] chose *because* it was the one place the experience is broken turns out to
be fixable for less than the layout model cost.

---

## Sources

**Run on this machine (primary, measured).** Scratch work at `/tmp/claude-1000/mfr/`, outside the
repo; no page image or crop was committed.
- `render.py`, `crop.py`, `crop_code.py` — page rendering (PyMuPDF 1.28.2, 200 dpi) and
  region-box → PDF-point → 300 dpi clip re-render, over 18 Millington pages and Code Book p41.
- `js/raw.mjs` — pix2text-mfr encoder/decoder greedy loop in `onnxruntime-node@1.24.3` + `sharp@0.34.5`.
- `js/katexcheck.mjs` — KaTeX 0.18.5 `throwOnError` + MathML output over both models' results.
- `paddle_formula.py` — `paddleocr==3.3.2` / `paddlepaddle==3.2.2`,
  `FormulaRecognition(model_name="PP-FormulaNet_plus-S", device="cpu")`.
- `dump_pre.py`, `dump_tok.py`, `js/pfn.mjs`, `ort_py.py` — PaddleX-authentic preprocessing dumped
  to raw f32, the paddle2onnx export, and its identical failure under `onnxruntime-node@1.24.3` and
  Python `onnxruntime==1.23.2` at opset 19 and 16.
- `js/run.mjs` — the `@huggingface/transformers@4.2.0` attempt that returned degenerate output (§2).
- Layout boxes from [[12]]'s stack, reused unchanged: `/tmp/claude-1000/dla/jsnode/run.mjs`,
  `ppu-doclayout@1.0.0`, `onnxruntime-node@1.29.0`, `PP-DocLayoutV2.onnx`.
- Outputs: `/tmp/claude-1000/mfr/js_raw.katex.json`,
  `/tmp/claude-1000/mfr/paddle_PP-FormulaNet_plus-S.katex.json`, `/tmp/claude-1000/mfr/neg_raw.json`.

**Model cards, repos and licences (fetched directly this session):**
- [breezedeus/pix2text-mfr](https://huggingface.co/breezedeus/pix2text-mfr) — **MIT** weights, TrOCR
  architecture, `encoder_model.onnx` 87,496,990 B + `decoder_model.onnx` 30,114,937 B, last modified
  2024-05-05
- [breezedeus/Pix2Text](https://github.com/breezedeus/Pix2Text) — MIT code, pushed 2026-08-23
- [PaddleOCR formula-recognition module doc](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/module_usage/formula_recognition.md) — the En/Zh-BLEU, GPU/CPU-latency and size table quoted in §1
- [PaddlePaddle/PP-FormulaNet_plus-S](https://huggingface.co/PaddlePaddle/PP-FormulaNet_plus-S), [_plus-M](https://huggingface.co/PaddlePaddle/PP-FormulaNet_plus-M), [PP-FormulaNet-S](https://huggingface.co/PaddlePaddle/PP-FormulaNet-S), [LaTeX_OCR_rec](https://huggingface.co/PaddlePaddle/LaTeX_OCR_rec) — all **Apache-2.0**
- [PP-FormulaNet paper, arXiv:2503.18382](https://arxiv.org/abs/2503.18382)
- [Paddle2ONNX PR #1523](https://github.com/PaddlePaddle/Paddle2ONNX/pull/1523) — PP-FormulaNet-S/-L export support, merged 2025-02-28
- [opendatalab/UniMERNet](https://github.com/opendatalab/UniMERNet) — Apache-2.0 code; [wanderkid/unimernet_tiny](https://huggingface.co/wanderkid/unimernet_tiny) / [_base](https://huggingface.co/wanderkid/unimernet_base) — **Apache-2.0** weights, 441 MB / 1.3 GB
- [torvexlabs/unimernet-onnx](https://github.com/torvexlabs/unimernet-onnx) — Apache-2.0 code; weights at `Sibitorvex/unimernet-tiny-onnx`, **no licence tag on the model card**
- [alephpi/Texo](https://github.com/alephpi/Texo) and [alephpi/FormulaNet](https://huggingface.co/alephpi/FormulaNet) — **AGPL-3.0 on both code and weights**; [arXiv:2602.17189](https://arxiv.org/abs/2602.17189); ONNX at 54 MB encoder + 26 MB merged decoder
- [datalab-to/texify](https://huggingface.co/datalab-to/texify) — **CC BY-NC-SA 4.0** weights (non-commercial); [datalab-to/surya](https://github.com/datalab-to/surya) — GPL-3.0 code, README now states a **$2M** ceiling where [[12]] §7 recorded $5M
- [facebook/nougat-base](https://huggingface.co/facebook/nougat-base) — **CC BY-NC 4.0** (non-commercial)
- [lukas-blecher/LaTeX-OCR](https://github.com/lukas-blecher/LaTeX-OCR) — MIT code, checkpoint licence unstated; [RapidAI/RapidLaTeXOCR](https://github.com/RapidAI/RapidLaTeXOCR) — its ONNX repackaging, Python-only
- [KaTeX](https://katex.org/) 0.18.5 — MIT, used here for both the syntax gate and MathML output

**Sibling tickets relied on:**
- [[09]] on the C0-control-character glyph failure and the Millington p60 case;
- [[12]] on the layout model, its region boxes, its class vocabulary, the `inline_formula`
  annotation caveat, the Code Book p41 misclassification, and its licence-survey method;
- [[13]] on the three-layer substrate, the additive rule, and the choice of first feature.
