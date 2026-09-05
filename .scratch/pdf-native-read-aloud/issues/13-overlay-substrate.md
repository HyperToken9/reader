# 13 — What is the overlay made of, once there is structure worth rendering?

Type: grilling
Status: open
Blocked by: 12

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

Blocked on [[12]] because the substrate question is downstream of what structure actually exists: an overlay keyed to regions is only worth building if regions are reliable.

Consult `grilling` and `domain-modeling`.

## Answer
