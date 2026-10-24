# Prototype 09: text fidelity, and a listening test bench

Throwaway prototype for [#9](https://github.com/HyperToken9/reader/issues/9), run 2026-10-24. Evidence, not shippable code.

## The test bench

`blitz-text-testbench.pdf` is 77 original cases, typeset with Typst (`blitz-text-testbench.typ`), each with a visible ID. Open it in Blitz and listen.

- **J (15):** junk that should not be spoken.
- **S (23):** symbols that must be spoken meaningfully.
- **P (26):** prose mechanics.
- **M (13):** maths in context.

`cases.json` holds, for each case, what is on the page and what a good reader should say. J-07 and J-08 were patched with pypdf, so one glyph maps to private-use U+F0E0 and Δ maps to U+0003 (the Millington failure). `pdfinfo` complains about the result, but PDF.js reads it.

**Kept locally only** (in the gitignored `sample_books/testbench/`, because they quote copyrighted books): `real-excerpts.pdf` (18 cases from real pages), `report.html` (every case: the page, the ideal spoken form, the exact string sent to the synthesiser, a verdict and an audio clip) and `audio/`. Rebuild them with `scripts/` (`gen_bench.py` → `build_real.py` → `collect.mjs` → `synth_bench.py` → `build_report.mjs`). `scripts/pipeline.mjs` replicates the app's extraction pipeline in Node, with file:line notes.

## Findings

- **The string is fine for highlighting; speech needs a cleanup pass on the synthesiser's copy only.** No design reshape.
- **Tracking welds don't happen in prose.** Of 712 dictionary-flagged candidates, about 200 were hand-checked and none were real. Poppler as referee found 24 real welds, all inside maths. Whole-line welds appear only at −0.12em tracking, which none of the books use.
- **Line-end hyphen bugs:**
  - 67 missed: `hasEOL` sits on an empty item *after* the hyphen, giving `detoxifi- cation`.
  - 43 real compound hyphens deleted, giving `objectoriented`.
  - 11 minus signs eaten.
- **Keep `disableNormalization: false`.** Turning it off makes `ﬃ` be read out by code point. NFKC's cost is µ → μ, which a speech rule fixes.
- **Junk reaching the synthesiser:**
  - 102 characters are read as hex code points ("letter one D four five B"), 4,564 occurrences, mostly maths italics.
  - 51 characters are voiced as silence (∈ ∀ ′ ≜, numeric en dash).
  - Wingdings bullets come through as `¾¾` and are read "three three".
  - Running headers and page numbers are glued into sentences.
  - The letter guard drops nothing; it merges junk into neighbouring sentences.
- **Segmentation:** splits after "Dr.", "et al." and initials; splits a URL at `?`; reads a final "3.14." as "three. fourteen".

Ticket routing: [#7](https://github.com/HyperToken9/reader/issues/7) gets maths regions and page furniture (what is spoken at all); [#23](https://github.com/HyperToken9/reader/issues/23) gets symbols, maths letters, units and numbers (what string is spoken); the hyphen and segmentation fixes become a build ticket.
