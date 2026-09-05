# 06 — Prototype: can we recover reading order on a real two-column page?

Type: prototype
Status: open
Blocked by: 01, 02, 03

## Question

Take the approach [[03]] recommends and actually run it against the hard pages in the corpus. This is the go/no-go spike for the effort.

**[[03]] recommends scoping this tightly**: implement only the ordering pipeline — line clustering, bands-before-columns, gutter detection by x-projection, read L→R then T→B — with **no classification at all**, and score page-level order against the corpus. Roughly 80–85% closes this ticket. Classification is the hard half and belongs to [[07]]; conflating them here hides which one is failing.

Check the corpus composition early: if it skews to sidebar-heavy modern textbooks, classification moves onto the critical path and this ticket's scoping assumption needs revisiting.

Build a spike that, given a page, emits an **ordered stream of body-prose spans with their bounding boxes** — and renders that order visibly (numbered overlay boxes, or a step-through) so the order can be *eyeballed* against the real page rather than trusted.

What it must establish:

- On a two-column page, does the stream read down column one then down column two — or does it interleave?
- Do spanning elements (title, running head, a full-width figure interrupting both columns) land in a sensible place?
- Are running headers, footers and page numbers reliably separable from body text?
- Are footnotes and figure captions distinguishable from body prose at all, and by what signal?
- Do equation regions get detected — and are they text items in a maths font, or vector drawings with no text?
- How much of this is heuristic guesswork versus something that holds across all corpus pages?

The honest possible outcome is that this is harder than hoped. Say so plainly if it is, with what specifically fails — a no-go here reshapes the map, and is a genuine result rather than a failure of the spike.

## Answer
