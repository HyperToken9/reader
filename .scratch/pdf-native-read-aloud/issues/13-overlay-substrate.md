# 13 — What is the overlay made of, once there is structure worth rendering?

Type: grilling
Status: resolved
Blocked by: —

## Question

Today the overlay is the minimum that works: normalised rects in an `<svg viewBox="0 0 1 1">`, chosen by [[02]] because it makes zoom free, and enough for a sentence band and nothing else. The human's proposal is to render extracted structure as **HTML (or HTML into a canvas) laid over the original PDF**, on the grounds that it gives more room to build features on later.

The pull is real. An HTML layer positioned per-region gets you the whole browser toolbox — text selection you control, hover targets, popovers anchored to a paragraph, a re-rendered equation via MathML, a note in the margin — none of which is comfortable in a bag of SVG rects. The cost is that HTML in front of a PDF is one CSS mistake away from being the thing this project exists to avoid.

So the boundary has to be drawn explicitly, because the map's founding constraint is *"the visual surface stays the real PDF"* and the difference between honouring it and breaking it is a design decision, not an implementation detail.

Decide:

- **Where the line sits.** An invisible structural layer that only drives overlays keeps the PDF pixels authoritative. A visible HTML layer that renders extracted text — even styled to match — means the reader is looking at our reconstruction, which is Nook. Between them sits the interesting case: HTML that renders things the PDF *doesn't* have (a definition popover, a translation, a re-typeset equation) while every original pixel stays untouched underneath. Which of these is in?
- **Whether SVG rects survive alongside it, or get replaced.** The band works today and zoom costs nothing. Don't pay to rebuild that unless HTML buys something the band can't.
- **What the layer is keyed to.** Regions from [[12]], or sentences from [[02]]? These have different lifetimes and different failure modes: a wrong region is a visible block in the wrong place, a wrong sentence is a band on the wrong line.
- **What happens when extraction is wrong.** [[03]]'s argument for tolerating classification error was that the reader sees the real page, so the band is the recovery UI. A richer overlay has more ways to be conspicuously wrong. Does that argument still hold at higher fidelity?
- **Zoom and reflow.** [[02]]'s fraction trick makes the band free at any scale. HTML positioned per-region needs the same discipline, or zoom becomes expensive and the layer drifts off the type underneath.

**Unblocked (2026-09-05): regions are reliable.** [[12]] measured the join at 0.12% of words unassigned and 0.84% in more than one region, of which only 0.015% straddled a prose region and a skip region, across 40 pages and 19,760 words. So "an overlay keyed to regions" is a real option rather than a hope, and the substrate question can now be decided. Two facts from [[12]] bear directly on it: regions come back **already sorted in reading order**, and the model returns rectangles only — never per-character geometry — so anything text-shaped in the overlay still has to come from [[02]]'s `getClientRects()`.

Consult `grilling` and `domain-modeling`.

## Progress

**The scope line is settled (2026-09-05): additive HTML only.**

An HTML layer may render things the PDF does **not** contain — a definition popover, a re-typeset equation, a margin note, per-paragraph controls — positioned per-region and transparent. It may **never** re-render the PDF's own body text. Every original pixel stays visible and untouched underneath, so the reader is never looking at our reconstruction. A reflowed view, even as an opt-in toggle, was considered and rejected: it is two renderers, two sets of bugs, and the one option that puts a reconstruction in front of the reader at all.

This is a refinement of the map's founding constraint, not a departure from it. The constraint was always on the *view*; this says what may be added to the view without replacing it.

## Answer

**Three layers, not one. Each keeps the job it is already good at.**

1. **PDF canvas** — authoritative, untouched, always visible.
2. **SVG overlay, keyed to sentences** — the reading band. Stays exactly as [[02]] built it and [[05]] verified it: normalised rects in `viewBox="0 0 1 1"`. It works, and zoom costs literally nothing — [[05]] measured the rects coming back byte-identical from 1.2× to 2.4×. There is no reason to pay to rebuild a working thing, and moving per-line boxes into HTML would forfeit precisely the property [[02]] chose SVG to get.
3. **HTML layer, keyed to regions** ([[12]]) — block features only. Coarse, stable, already in reading order, 0.84% straddle. This is the right grain for something that sits *on* a paragraph or an equation rather than inside a line of type.

The split is the point: **sentences are a reading-time concept, regions are a page-structure concept.** They have different lifetimes and different failure modes — a wrong sentence is a band on the wrong line, a wrong region is a visible block in the wrong place — so keying one substrate to both would couple two things that fail independently.

**Zoom discipline for the HTML layer is the same trick, and it is not optional.** Store region boxes as page fractions and position with percentage `left`/`top`/`width`/`height` inside the page wrapper, exactly as the text layer does since PR #20491. Never write pixel offsets. Then zoom stays free for all three layers and nothing can drift off the type underneath.

**Failure behaviour.** [[03]]'s argument — classification error is cheap because the reader sees the real page — holds, but *only* because of the additive rule. An HTML layer that adds a wrong popover is ignorable; one that replaced text would be a lie. So the rule from Progress above is what keeps the tolerance argument alive at higher fidelity, and it is load-bearing rather than stylistic. Concretely: `pointer-events: none` on the layer, re-enabled per element; render nothing where the model is unconfident; never occlude.

**First feature: re-typeset equations.** Chosen because it is the one place the reading experience is currently *broken* rather than merely plain. [[09]] found equation glyphs arrive as C0 control characters, so [[07]]'s policy can only announce and skip — you hear "equation" and then nothing. [[12]] labels them `display_formula` and `inline_formula`. Rendering real maths over that region turns a hole into content, and it exercises the layer properly: a block element, positioned on a region, adding what the PDF's text layer could not give us.

**But it has an uncosted prerequisite, and this is the main thing this ticket surfaces.** Nothing in the pipeline produces equation *content*. The text layer yields control characters; the layout model yields a rectangle and a label, not LaTeX. Re-typesetting therefore needs a **formula-recognition model** (PP-FormulaNet, UniMERNet and similar) — a third model, on top of layout and TTS. That is a real cost and it was invisible when this choice was made. It is now [[15]], and **the substrate decision above does not depend on it**: the three-layer split, the region keying and the fraction discipline all stand whatever [[15]] concludes. If formula recognition proves too heavy, the first HTML feature falls back to per-paragraph controls, which need only region boxes.

**Build order.** Nothing here is needed for [[05]]'s verdict. The design is settled so it is not re-litigated; the code waits for [[15]] and for the prototype to prove the core experience.
