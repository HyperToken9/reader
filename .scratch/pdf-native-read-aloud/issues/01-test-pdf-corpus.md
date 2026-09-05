# 01 — Assemble a test corpus of textbook PDFs

Type: task
Status: open

## Question

Nothing to decide — but every prototype ticket is blocked until real material exists to run against. Synthetic or article-shaped PDFs will hide exactly the failures this effort is about.

Gather a small corpus (4–6 PDFs) into `.scratch/pdf-native-read-aloud/corpus/`, spanning deliberately:

- **A single-column, prose-heavy textbook chapter** — the easy case, needed as the control for the sync spike so ordering problems don't contaminate it.
- **A two-column academic/textbook page** — the hard case for reading order.
- **An equation-dense page** — inline maths mixed into prose, plus display equations.
- **A figure-heavy page** — diagrams with captions, ideally with text wrapping around them.
- **A page with footnotes and running headers/footers** — the classification problem.

All must be born-digital or already-OCR'd, i.e. have a real embedded text layer (verify: text is selectable, not a scan). Record for each: filename, what it is, which hard case it covers, and confirmation the text layer is present.

Human-driven — the agent cannot source textbooks. If the human prefers, freely-licensed sources (OpenStax, arXiv papers for the two-column/equation cases) are fine substitutes and avoid any licensing question about committing them.

## Progress

Corpus lives at `sample_books/` in the repo root (human-supplied, gitignored for size and licensing). This file is the record of what it holds. Characterised with `pdfinfo` / `pdftotext -layout`:

| File | Producer | Pages | Tagged | Covers |
| --- | --- | --- | --- | --- |
| `theCodeBook.pdf` — Singh, *The Code Book* | calibre 3.42 | 427 | no | **Single-column prose control.** Clean narrative text, the easy case [[05]] wants. |
| `crafting-interpreters-….pdf` — Nystrom, *Crafting Interpreters* | Safari → Quartz (HTML print) | 611 | no | Single-column prose with **code listings and grammar snippets** — a skip-policy case [[07]] did not anticipate. |
| `Game Physics Engine Development….pdf` — Millington | Elsevier / Distiller 7 | 481 | no | **Equation-dense and figure-heavy.** Real typeset book, 540×665pt (`page.rect`; cropbox `(36, 36.2)–(576, 701.2)`) — an earlier reading of 336×414pt here was wrong, corrected by [[12]] — wide left margin, `FIGURE N.N` captions, display equations, matrix brackets. |

**All three are untagged.** So the tagged-PDF fast path [[03]] found is unavailable across the entire corpus — geometry-first isn't just the recommended route, it's the only one here. Consistent with [[03]]'s finding that only ~12.6% of PDFs are tagged and STEM skews lower.

**All three have real, extractable text layers.** Verified by extraction, not by assumption.

**Two gaps remain:**

- **No two-column page.** All three are single-column, so the corpus cannot currently exercise [[06]] — the go/no-go spike — at all. An open-access arXiv paper or an OpenStax chapter would close this, and licensing is clean.

  **Still open, but worked around once (2026-09-05).** [[12]] needed a two-column page and used PDF.js's own bundled `compressed.tracemonkey-pldi-09.pdf`, fetched to `/tmp/claude-1000/dla/twocol.pdf` and deliberately not committed. Worth knowing before repeating the search: **arXiv 1706.03762 is not two-column** — it is NeurIPS single-column, and [[12]] tried it first. A permanent addition to `sample_books/` is still wanted.

- **No sidebar-heavy textbook, and this now matters more than the two-column gap.** [[03]] named boxed panels and sidebars as the dominant textbook-specific failure. [[12]] found the layout model has an `aside_text` label for exactly that case — but it fired **once in 40 pages** across this corpus, so the label is real and untested. A modern undergraduate textbook full of worked-example boxes is the single highest-value addition to the corpus now.
- **No page with footnotes or running headers** as a deliberate case. Partially covered incidentally by the Millington book's running heads.

**Finding that changes [[09]]:** extraction on Millington p.60 silently **drops the Δ glyphs** — `Δp/Δt` extracts as `p`/`t`, and no U+0394 appears anywhere in pages 58–64 despite the prose plainly requiring it. Matrix bracket glyphs (`⎡⎣⎢⎤⎦⎥`) *do* survive and would be spoken as gibberish. See [[09]].

## Answer
