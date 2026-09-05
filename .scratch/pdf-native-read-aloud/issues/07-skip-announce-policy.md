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

Consult `grilling` and `domain-modeling` — this ticket also fixes the vocabulary the codebase will use for regions.

## Answer
