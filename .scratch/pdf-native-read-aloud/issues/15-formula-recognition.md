# 15 — Where does equation *content* come from?

Type: research
Status: open
Blocked by: —

## Question

Surfaced by [[13]], which chose re-typeset equations as the first HTML-layer feature and then found nothing in the pipeline produces the equation itself.

The gap is specific. [[09]] found equation glyphs extract as **C0 control characters** — the Δ in `Δp/Δt` arrives as U+0003 — so the text layer yields no usable maths. [[12]]'s layout model yields a **rectangle and a label** (`display_formula`, `inline_formula`), not content. Between "here is a box containing an equation" and "here is the equation" sits a model nobody has priced.

Establish, for the serious candidates — **PP-FormulaNet** (the natural fit, same PaddleOCR family as [[12]]'s detector), **UniMERNet**, **Texify**, **pix2tex/LaTeX-OCR**, and whatever else is current:

- **What it outputs** — LaTeX, MathML, or both? MathML renders natively in a browser; LaTeX needs KaTeX or MathJax, which is another dependency but a well-understood one.
- **How it runs.** ONNX-exportable and usable from `onnxruntime-node`, the way [[12]]'s detector turned out to be? Or Python-only? This is the same question that decided [[12]], and the answer matters just as much for [[08]].
- **Cost per equation** — latency on CPU, and model size. Note the access pattern is favourable: equations are a small fraction of a page and only need recognising when the reader reaches them, so this can be lazy and cached in a way full-page OCR cannot.
- **Accuracy on this corpus**, especially Millington, which is the equation-dense book and the one whose Δ glyphs are already known to be broken. Vendor benchmarks are on clean rendered formulae; a scanned-quality textbook crop is harder.
- **Licence**, code and weights separately. [[12]] found this is where most of the field disqualifies itself.

Then answer the question [[13]] needs: **is re-typeset equations a viable first HTML-layer feature, or does it cost a third model too many?** If the answer is no, [[13]] falls back to per-paragraph controls, which need only region boxes and no new model.

Note the second-order prize, and do not overreach for it: an equation recovered as LaTeX or MathML could in principle be *spoken* rather than skipped, which is the "real equation speech" item the map lists as fog. That is a much harder problem — reading maths aloud well is its own field — and it is not this ticket. Mention only whether the output would make it possible.

## Answer
