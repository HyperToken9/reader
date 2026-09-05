# 13 — What is the overlay made of, once there is structure worth rendering?

Type: grilling
Status: open
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

**Still open, and still blocked on [[12]]**: whether the SVG band survives alongside an HTML layer or gets absorbed into it; whether the layer is keyed to regions or to sentences; what it does when extraction is wrong; and how it keeps [[02]]'s zoom-costs-nothing property, which per-region HTML does not get for free.

## Answer
