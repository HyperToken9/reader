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

- `game-physics-engine-development.pdf` — Ian Millington, *Game Physics Engine Development*. Added by the human; moved here from the repo root. Covers the **equation-dense** case and likely the **figure-heavy** one. Text layer presence not yet verified.

Corpus files are gitignored (size and licensing) — this file is the record of what the corpus holds.

Still wanted: a single-column prose control, a two-column academic page, and a page with footnotes plus running headers.

## Answer
