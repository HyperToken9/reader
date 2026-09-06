# 02 — What geometry does the PDF.js text layer actually give us?

Type: research
Status: resolved

## Question

The whole highlight mechanism rests on being able to draw a rectangle over the exact pixels of a given word on a PDF.js-rendered page, and keep it correct across zoom and scroll. Establish what PDF.js hands us, and where it falls short.

Answer specifically:

- What `page.getTextContent()` returns per item: the `str`, `transform` matrix, `width`, `height`, `dir`, `fontName`, and what `includeMarkedContent` adds. What coordinate space are these in, and how do they relate to the viewport/canvas after `page.getViewport({ scale })`?
- **Item granularity is the crux**: a text item is *not* reliably one word. Items can span several words, or split a single word across items (kerning, ligatures, font changes). How do we get *per-word* boxes from this? Is per-glyph advance information reachable, or must word boxes be derived by measuring text against the item transform?
- How does the stock `TextLayerBuilder` position its divs, and is the standard approach (absolutely-positioned transparent text divs over the canvas) the right substrate for our highlights, or should we draw highlight rects into a separate overlay canvas/SVG layer?
- Zoom and scroll: what has to be recomputed on scale change, and what is the cost per page? Does PDF.js re-render or transform?
- Text direction, rotation, and vertical writing — do these break naive box math?
- Version specifics: what is the current PDF.js release as of 2026, is the legacy vs modern build distinction relevant, and has the text layer API changed recently in ways that make older guidance wrong?

Prefer the PDF.js source and official API docs over blog posts — the text layer is an area where third-party tutorials are frequently years out of date.

## Answer

Full findings, with source line references and probe numbers:
[`../research/02-pdfjs-text-layer-geometry.md`](../research/02-pdfjs-text-layer-geometry.md).
Researched against PDF.js **v6.3.289** (current release, 2026-09-05).

**Per-word boxes are not in the API, and the honest route is approximate.** A text item is a
*run*, flushed on font change, font-size change, EOL, or a heuristic gap — not a word. Measured
on a real two-column paper: 58% of items on a page contain internal whitespace, and **8% of
adjacent item pairs join with no whitespace at all** (a token split across items). Worse, the
character↔glyph bijection is already gone before we see it: default `disableNormalization:
false` NFKC-expands ligatures (151 ligature-bearing items became 0 on that document), spaces in
`str` are *synthesised* from advance heuristics rather than read from the content stream, and
RTL runs are reordered into visual order by `bidi()`. Per-glyph advances *are* computed in the
worker — `evaluator.js` calls `intersector.addGlyph(transform, advance, 0, unicode)` for every
glyph — but `Intersector` is worker-internal, exists only to serve highlight annotations, and is
mutually exclusive with normal extraction. Reaching it means forking PDF.js.

**Recommended mechanism** (PDF.js's own, from `web/autolinker.js` + `web/text_highlighter.js` +
`src/display/draw_layer.js`): render the stock `TextLayer`; concatenate
`textLayer.textContentItemsStr` into a page-level string; segment *that* into words and
sentences with `Intl.Segmenter`; map each `[start, end)` back to `(divIdx, offset)` the way
`_convertMatches` does; build a DOM `Range`; call **`range.getClientRects()`**. This sidesteps
item granularity entirely — a word split across a font change is one segment over two divs, and
a multi-word item is several segments in one div — and it returns one rect per line fragment,
which is exactly the shape a sentence band wants.

**Correction from [[05]] (2026-09-05), important because the recipe above is what gets copied**:
"concatenate `textContentItemsStr`" must not be a plain `join("")`. PDF.js emits **no whitespace
at a line break** — the break exists only as a `<br>` appended to the DOM — so a plain join welds
the last word of one line onto the first of the next (`"It is thispersonality that…"`),
mis-segmenting the sentence *and* feeding TTS a non-word. Inject a separator after every item
whose source `hasEOL` is true (and drop a trailing hyphen instead, for a word broken across
lines). The separator belongs to no item, so the `(divIdx, offset)` map simply steps over it,
and since sentence endpoints are always trimmed of whitespace no `Range` endpoint can land
inside one. Verified working in `../prototype-05/`.

**Accuracy, plainly**: exact at item boundaries (the span sits at the item's true origin and
`--scale-x` forces its total width to the item's true width), **interpolated inside them** —
because PDF.js lays the text layer out in a *generic* `sans-serif`/`monospace`, not the embedded
font, then stretches. Low single-digit CSS px on a ~40-char run at 100% zoom for ordinary body
text; worse for display, small-caps and math faces. Mitigate by padding the word cursor. One
cheap upgrade is available: PDF.js registers every embedded font as an `@font-face` whose family
name *is* `item.fontName`, so overriding the span's `font-family` lays the run out in the real
glyphs, leaving only PDF-level `TJ` kerning as error.

**Overlay substrate**: draw into a *separate* SVG layer, not into the text divs. Store rects as
normalised page fractions and render into `<svg viewBox="0 0 1 1" preserveAspectRatio="none">`
pinned `inset: 0` — verbatim `DrawLayer`. Zoom then costs zero recompute. (Text-layer positions
are already percentages since PR #20491, Dec 2025; `TextLayer.update()` on zoom only re-measures
`--scale-x`, ~170 `measureText` calls/page. The canvas re-render dominates.) Keep our overlay
`pointer-events: none` so PDF.js selection still works.

**Version notes**: `renderTextLayer()`/`updateTextLayer()` were **removed** July 2024 (PR
#18349) — use `new TextLayer({...})`. Percentage positioning landed Dec 2025 (#20491) and
`--total-scale-factor` (incl. `userUnit`) Feb 2025 (#19469), so any tutorial doing
`div.style.left = tx[4] + "px"` describes a version that no longer exists. Text-layer internals
changed again on **2026-09-02** (#21810). Pin an exact `pdfjs-dist` version; use the modern
build (note `.d.mts` types ship only under `legacy/`).

**Breaks naive box math**: arbitrary-angle text (rotated axis labels, watermarks) —
`getClientRects()` returns axis-aligned boxes, so a 45° run yields a fat diagonal bounding box;
detect `angle !== 0` from the item transform and skip or draw rotated. Vertical/CJK
(`style.vertical`, `dir: "ttb"`) puts the advance in `height`, not `width`. Page rotation and
RTL are safe *if* you use `getClientRects()` rather than hand-rolled transforms.
