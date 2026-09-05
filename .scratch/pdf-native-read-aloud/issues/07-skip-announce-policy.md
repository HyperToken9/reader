# 07 — What exactly gets skipped, announced, or read?

Type: grilling
Status: open
Blocked by: 06

## Question

The policy is settled in principle — headers and footers skipped silently; equations, figures and footnotes get a brief spoken placeholder then are stepped over. This ticket turns that into a mechanism, once [[06]] has established what can actually be *detected*.

Decide:

- What the placeholder utterances actually say. "Equation." — or does it try "equation five" when a number is detectable? "Figure four." versus "figure"? Does a footnote get read at all, deferred to end of page, or only announced?
- What the highlight does during a placeholder. Does the band sit over the skipped region so your eye is drawn to the equation while the voice says "equation" — which would be the point — or does highlighting simply jump ahead? Now that the band is the *only* highlight ([[10]]), this carries more weight.
- Behaviour when classification is uncertain, which [[06]] will likely show is common. Is unclassified text read as prose (risking gibberish) or skipped (risking silent loss)? Which failure is more tolerable while reading a textbook?
- Whether the reader can override — tap a skipped region to have it read anyway, or a setting to read footnotes inline.
- Tables. Left unresolved at charting time and genuinely hard: read cell by cell, announce "table" and skip, or something else? [[03]] argues cell-by-cell audio is useless regardless of ordering, so detect-and-skip is the likely answer.
- **Sidebars and boxed "worked example" panels.** [[03]] names these the dominant textbook-specific failure — geometrically indistinguishable from a narrow column, so they get read as body prose in the wrong place. Decide what the reader experiences when this happens, and whether an explicit "read this panel" affordance beats trying to classify them automatically.

Hooks [[03]] found that this ticket can use: a tagged PDF's `role: "Formula"` (with `mathML`) identifies equations directly, and `Caption` / `Note` / `H1`–`H6` cover much of the rest — free where present, absent in the ~87% of PDFs that aren't tagged. The cheapest reliable caption signal in untagged PDFs is a leading `Figure N` / `Table N` token.

Consult `grilling` and `domain-modeling`.

**Do not invent the vocabulary — adopt the model's ([[12]], 2026-09-05).** This ticket was going to define the region taxonomy the codebase uses. [[12]] found a trained 25-label set that is stable, real, and already produces `header`, `footer`, `number` (folio), `text`, `paragraph_title`, `figure_title`, `image`, `chart`, `table`, `footnote`, `algorithm`, `display_formula`, `inline_formula`, `formula_number` and `aside_text` on this corpus. Any taxonomy defined alongside it becomes a translation layer that can only lose information. So this ticket stops being a taxonomy question and becomes a **policy** question: for each of those 25 labels, read / announce-and-skip / skip silently.

Three consequences for the questions above:

- **`display_formula` vs `inline_formula` are separate labels**, which the ticket's phrasing did not anticipate. Inline maths inside a prose sentence is a different problem from a standalone equation block: you cannot skip an inline formula without leaving a hole mid-sentence. Decide these separately.
- **`algorithm` covers code listings**, the case [[01]] flagged and this ticket had not planned for. It fired 73 times in a 40-page sweep, mostly in Crafting Interpreters. Reading code aloud is almost certainly wrong; decide what it says instead.
- **`aside_text` is the sidebar label** — the case [[03]] called the dominant textbook failure. It is real but fired only once in 40 pages, so the *policy* can be decided here while the *detection* stays unvalidated until [[01]] gains a sidebar-heavy book.

## Evidence from [[05]] (2026-09-05)

Driving the prototype over the corpus produced two concrete instances of what this ticket has to decide about, worth keeping because they are the *typical* cases, not edge cases:

- **Running heads weld into the first sentence of a page.** Millington p60's first "sentence" is `"2.2 Calculus 37 FIGURE 2.8 Same average velocity, different instantaneous velocity. acc…"` — section head, page number, figure caption and body prose in one utterance, because none of them ends in a full stop. So "skip headers and footers silently" is not a filter applied to a finished sentence list; it has to happen *before* segmentation, or the header takes a sentence of real prose down with it.
- **Blocks with no terminating punctuation swallow the prose that follows them.** On `theCodeBook.pdf` p40 a ciphertext block runs straight into `"…CPe PiDhLK This simple step helps us to identify…"`. Same mechanism, and the same conclusion: region boundaries must cut the string before `Intl.Segmenter` sees it.

[[09]] also found a cheap detector this ticket can use: unmapped glyphs arrive as **C0 control characters**, so a run of them is a strong signal that a region is not speakable prose.

## Answer
