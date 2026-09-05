# 06 — Prototype: can we recover reading order on a real two-column page?

Type: prototype
Status: open
Blocked by: 01

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

## Rescoped by [[12]] (2026-09-05) — read this before the section above

**Do not write the 600–900 lines. [[12]] measured a layout model on this corpus and it does the hard half.** `PP-DocLayoutV2.onnx` under `onnxruntime-node` returns labelled region boxes *already sorted in reading order* — a pointer network, not a post-hoc XY-cut — at ~731 ms/page on CPU. On genuine two-column pages it produced left column then right with no interleaving, put full-width spanning bands **first** (that is [[03]]'s "bands before columns", produced unasked), and emitted a footnote **last** despite it sitting mid-page. Zero straddles on all three of those pages.

So this ticket survives as **shape 2: model primary, geometric fallback** — but the fallback is **150–250 lines, not 600–900**. [[03]]'s Passes 2–4 (line clustering, gutter detection by x-projection, column assembly) are not needed at all. Cross-page repetition for running heads is not needed — the model labels them `header` and `number` on a single page. Caption, footnote and equation heuristics all fall away.

What this ticket is now for:

- **Regions in order is not yet sentences in order.** The model returns rectangles; [[02]] returns per-character geometry. Joining them — assign each text item to a region by max area overlap, then order sentences by region order and by position within a region — is the actual remaining work, and it is what this spike should build and eyeball.
- **Verify the join from the PDF.js side.** [[12]] measured it with PyMuPDF word boxes, not PDF.js. Same coordinate space per [[02]] §1, but re-verify on one page before trusting it.
- **Decide what the fallback does** on pages where the model returns nothing useful, and how you detect that case.
- **`aside_text` is unvalidated.** It fired once in 40 pages because the corpus has no sidebar-heavy book. [[03]]'s central worry is still untested, and [[01]] now records that as the highest-value corpus gap.

Still blocked on [[01]] — for the sidebar case now, rather than the two-column one, which [[12]] worked around.

The honest possible outcome is that this is harder than hoped. Say so plainly if it is, with what specifically fails — a no-go here reshapes the map, and is a genuine result rather than a failure of the spike.

## Answer
