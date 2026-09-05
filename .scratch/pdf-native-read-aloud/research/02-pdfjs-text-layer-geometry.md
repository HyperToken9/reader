# PDF.js text layer geometry — what we actually get, and what we have to build

Research for `.scratch/pdf-native-read-aloud/issues/02-pdfjs-text-layer-geometry.md`.
Date: 2026-09-05. Sources are PDF.js **v6.3.289** (latest release, published ~2026-08-30;
tag `v6.3.289`, npm `pdfjs-dist@6.3.289`) unless noted. Line references are to that tag.

All claims below are from the PDF.js source, the JSDoc typedefs that generate the official
API docs, or a probe I ran against `pdfjs-dist@6.3.289` in Node. No blog posts were used.

---

## 0. TL;DR

- **Per-word boxes are not available from the API.** `getTextContent()` items are *runs*, not
  words. Measured on a real paper: **58% of items on a page contain internal whitespace**
  (multi-word), and **8% of adjacent item pairs join with no whitespace at all** (a word split
  across items by a font change). Per-glyph advances *are* computed in the worker but are not
  exposed.
- **The route that works is the one PDF.js itself uses**: render the stock text layer, build a
  page-level concatenated string, segment *that* into words/sentences, map character offsets
  back to `(textDiv, offset)`, build a DOM `Range`, and call **`range.getClientRects()`**.
  PDF.js does exactly this in `web/autolinker.js` and `src/display/draw_layer.js`.
- **Accuracy is exact at item boundaries and interpolated inside them.** The text-layer span is
  positioned at the item's true origin and `scaleX`-stretched so its total width equals the
  item's true width; positions *within* the span come from the browser laying out a **generic
  substitute font** (`sans-serif`/`monospace`). So a word box is right to within the drift
  between substitute-font advances and the PDF's real advances, redistributed across the run.
  This is **approximate, and honestly so**. It is good enough for a tinted band and a word
  cursor; it is not good enough for a text caret.
- **There is a substantial accuracy upgrade available**: PDF.js registers every embedded font
  as a CSS `@font-face` whose family name *is* `item.fontName`. Overriding the text layer's
  `font-family` with `item.fontName` makes the browser lay out the run in the **actual embedded
  font**, collapsing most of the drift. Residual error is then only PDF-level `TJ` kerning,
  `Tc`/`Tw` spacing and `/Widths`-vs-font-program mismatch.
- **Overlay substrate: draw into a separate SVG layer, not into the text divs.** Store rects in
  **normalised page fractions (0..1)** and render them into an `<svg viewBox="0 0 1 1"
  preserveAspectRatio="none">` pinned `inset: 0` over the page. Zoom then costs *nothing* —
  no recompute, no re-measure. This is precisely how `DrawLayer` renders PDF.js's own highlight
  annotations.

---

## 1. What `getTextContent()` actually returns

Public typedefs, `src/display/api.js:1145-1199`:

```js
// getTextContentParameters — ONLY these two are public
{ includeMarkedContent = false, disableNormalization = false }

// TextItem
{ str, dir, transform, width, height, fontName, hasEOL }

// TextStyle (keyed by fontName in textContent.styles)
{ ascent, descent, vertical, fontFamily }
// (undocumented but present: fontSubstitution, fontSubstitutionLoadedName)

// TextMarkedContent (only when includeMarkedContent: true)
{ type: "beginMarkedContent" | "beginMarkedContentProps" | "endMarkedContent", id, tag }
```

`streamTextContent()` (`api.js:1745-1758`) forwards **only** `includeMarkedContent` and
`disableNormalization` to the worker. Two internal options exist but are **not reachable**:
`keepWhiteSpace` and `intersector` (`src/core/evaluator.js:2393-2407`). More on `intersector`
in §3.

### Coordinate space

`transform` is a 6-element PDF text matrix `[a, b, c, d, e, f]` in **PDF user space**
(origin bottom-left, y up), *not* viewport space. `(e, f)` is the **baseline origin** of the
run. `Math.hypot(c, d)` is the effective font height; `Math.atan2(b, a)` is the run's angle.

`width` / `height` are the run's total advance, accumulated glyph by glyph and multiplied by
`textAdvanceScale` (`evaluator.js:2660-2683`, `3160-3175`). For horizontal text `height` is the
font height and `width` is the advance; for vertical text it is the other way round
(`evaluator.js:2621-2635`).

To go to canvas/CSS pixels, `TextLayer` composes the item transform with a flip
(`src/display/text_layer.js:132-135`):

```js
const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
this.#transform = [1, 0, 0, -1, -pageX, pageY + pageHeight];
// then per item:
const tx = Util.transform(this.#transform, geom.transform);   // text_layer.js:334
```

`tx[4], tx[5]` is then the baseline origin in **unscaled page pixels** (top-left origin, y down),
and the span's top is `tx[5] - fontHeight * ascentRatio` (`text_layer.js:347-358`). Note this
uses the *browser-measured* `fontBoundingBoxAscent` of the substitute font, falling back to
`style.ascent` and finally `0.8` (`text_layer.js:523-561`) — so even the vertical placement of
the span is a best-effort approximation of the glyph box, not the true typographic box.

Note also `PageViewport` now folds `userUnit` into `scale` (`src/display/page_viewport.js:69`,
`scale *= userUnit`) — an api-major change from PR #19469 (merged 2025-02-11).

### `includeMarkedContent`

Adds no geometry. It interleaves `beginMarkedContent(Props)` / `endMarkedContent` markers so
you can associate runs with the structure tree (`evaluator.js`, and `text_layer.js:297-315`
which wraps them in nested `<span class="markedContent">`). Useful for §7 (reading order /
artifact detection — `tag === "Artifact"` is aria-hidden), useless for boxes.

### Empirical shape of the data

Probe against `web/compressed.tracemonkey-pldi-09.pdf` (a two-column pdfTeX paper, a fair
proxy for a textbook), `pdfjs-dist@6.3.289`, page 2:

```
viewport 612 792  rotation 0  userUnit 1
items: 214
items containing internal whitespace (multi-word): 124   single-token items: 44
```

First few items:

```json
{"str":"Hence, recording and compiling a trace","w":139.59,"h":8.97,"t":[8.97,0,0,8.97,54,712.03],"f":"g_d0_f1","eol":false}
{"str":" ",                                    "w":1.87,  "h":0,   "t":[8.97,0,0,8.97,193.59,712.03],"f":"g_d0_f1","eol":false}
{"str":"speculates",                           "w":37.35, "h":8.97,"t":[8.97,0,0,8.97,195.46,712.03],"f":"g_d0_f2","eol":false}
{"str":" ",                                    "w":1.87,  "h":0,   "t":[8.97,0,0,8.97,232.81,712.03],"f":"g_d0_f2","eol":false}
{"str":"that the path and",                    "w":58.42, "h":8.97,"t":[8.97,0,0,8.97,234.69,712.03],"f":"g_d0_f1","eol":true}
```

Read that carefully — it is the whole problem in five lines. One visual line of prose is five
items, because the italic word `speculates` forces a flush. Standalone `" "` items with
`height: 0` are synthesised gap markers, not real glyphs.

---

## 2. Item granularity — the crux

### Why items split and merge

An item is flushed (`flushTextContentItem`, `evaluator.js:3160`) when any of these happen:

| Trigger | Source |
| --- | --- |
| Font **or** font size change | `evaluator.js:2955-2963` |
| End of line / `Td`,`TD`,`T*`,`'`,`"` producing an EOL | `appendEOL`, `evaluator.js:3108-3125` |
| Horizontal advance larger than the accumulated run width (a big jump) | `evaluator.js:2833`, `2897` |
| Negative advance beyond `negativeSpaceMax` (`-0.59 * fontSize`) | `evaluator.js:2885-2897` |
| Vertical shift beyond `VERTICAL_SHIFT_RATIO * height` (superscripts, subscripts) | `evaluator.js:2946` |
| A gap outside the "space in flow" band | `addFakeSpaces`, `evaluator.js:3127-3148` |

And spaces are **manufactured**, not read: with the default `keepWhiteSpace: false`, real space
glyphs are skipped and their advance folded into the cursor move (`evaluator.js:3012-3030`); a
space is then re-inserted later only if the measured gap falls in a heuristic window
(`TRACKING_SPACE_FACTOR = 0.102`, `NOT_A_SPACE_FACTOR = 0.03`, `evaluator.js:2511-2517`,
`addFakeSpaces`). So **the spaces in `item.str` are inferences about geometry, not facts about
the content stream.**

### How bad is it, in numbers

Probe over all 14 pages of the same PDF:

```
pages: 14   adjacent item pairs: 3268
standalone " " items:            684  (21%)
pairs joining with NO whitespace: 262  (8%)   <- a token split across two items
items containing ligature chars, disableNormalization:true : 151
items containing ligature chars, default (normalized)      : 0
```

8% of item joins are mid-token. On page 1 these are footnote markers welded onto author names
(`"Andreas Gal"` + `"∗"`), which is benign; in a textbook the same mechanism produces
`"coeffi"` + `"cient"` across an `fi`-ligature font switch, `"H"` + `"2"` + `"O"` across
sub/superscript flushes, and inline-math splits everywhere. **You cannot treat an item as a
word, and you cannot treat an item boundary as a word boundary.**

### The normalization trap

`disableNormalization: false` (the default) runs `normalizeUnicode()` before returning the run
(`evaluator.js:2685-2700`, `src/shared/util.js:1052-1067`). Its regex covers `ﬀ-ﬄ`
etc. and NFKC-normalizes them, so a single `ﬃ` glyph becomes the three characters `ffi`. The
151-vs-0 counts above are that effect on a real document.

Consequence: **`item.str.length` is not the glyph count.** There is no index from a character in
`str` back to a glyph. Setting `disableNormalization: true` restores roughly 1 char = 1 glyph,
but then your string contains `ﬁ`/`ﬂ` and both TTS and your own word segmentation will choke on
it. Either way you have lost the bijection.

Also `runBidiTransform` runs the string through `bidi()` (`src/core/bidi.js:120`), which
**reorders characters into visual order** for RTL runs. So for RTL, `str` index order is visual,
not logical.

### Is per-glyph advance information reachable? No.

It exists. `evaluator.js:3052-3072` calls, for every single glyph:

```js
intersector?.addGlyph(getCurrentTextTransform(), scaledDim, 0, glyph.unicode);
```

That is exactly the data we want — per-glyph transform, advance and unicode. But `Intersector`
(`src/core/intersector.js`) is worker-internal, constructed only by
`src/core/document.js:782` to extract the text under highlight annotations, and it is
mutually exclusive with normal extraction (`evaluator.js:3091`: `if (!intersector)
textChunk.str.push(glyphUnicode)`). It is not exported from `src/pdf.worker.js`, not reachable
through any `messageHandler` action, and not in the public API.

**Getting true per-glyph boxes therefore requires forking PDF.js** (patching `evaluator.js` to
emit glyph geometry and adding a worker message). That is a real option — the patch is small
and localised — but it means pinning a fork and re-applying it on every upgrade of a library
that ships roughly monthly. Not recommended for the prototype; worth remembering if word-cursor
precision turns out to be the thing that kills the experience.

---

## 3. How the stock text layer positions its divs (and why that's good news)

`src/display/text_layer.js:360-368`:

```js
divStyle.left = `${((100 * left) / this.#pageWidth).toFixed(2)}%`;
divStyle.top  = `${((100 * top)  / this.#pageHeight).toFixed(2)}%`;
divStyle.setProperty("--font-height", `${fontHeight.toFixed(2)}px`);
divStyle.fontFamily = fontFamily;
```

and `web/text_layer_builder.css`:

```css
.textLayer { position: absolute; inset: 0; line-height: 1;
             letter-spacing: normal; word-spacing: normal; overflow: clip; }
.textLayer :is(span, br) { color: transparent; position: absolute;
                           white-space: pre; transform-origin: 0% 0%; }
.textLayer > :not(.markedContent) {
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1; --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
```

Three things matter here:

1. **`left`/`top` are percentages of the page.** They are scale-independent. This is recent —
   PR #20491 "Move text layer scaling logic to CSS" (merged 2025-12-11). Any tutorial that
   shows `div.style.left = tx[4] + "px"` and a `transform: scale()` on the layer is describing
   a version that no longer exists.
2. **`--scale-x` is the fudge factor.** `#layout()` (`text_layer.js:424-443`) measures the span's
   text with `ctx.measureText()` at `fontSize * scale` in the *substitute* font, then sets
   `--scale-x = item.width * scale / measuredWidth`. The span is horizontally stretched so its
   **total** width is exactly right. Interior character positions are whatever the substitute
   font produced, linearly rescaled.
3. **The substitute font is generic.** `style.fontFamily` from `getTextContent()` is
   `"sans-serif"` or `"monospace"` (confirmed in the probe output — every style in the
   tracemonkey paper is one of those two). PDF.js is *not* using the embedded font in the text
   layer; it is using a system font stretched to fit.

That third point is the source of essentially all intra-item positional error. It is also
fixable — see §5.

Two further gotchas:

- A span whose `str` is `""` is created and pushed to `textDivs` but **never appended to the
  DOM** (`text_layer.js:414-416`, `hasText` guard). Index alignment with `textContentItemsStr`
  holds; DOM presence does not. A `Range` endpoint landing in one of those throws.
- `hasEOL` items get a trailing `<br role="presentation">` appended (`text_layer.js:417-421`),
  which sits in the DOM between spans and shows up in Range traversal.
- Since Jan 2026 (PR #20567) text belonging to MathML struct-tree elements is *hidden* in the
  text layer. Directly relevant to the equation-skipping policy in ticket 07 — worth a look
  when that ticket comes up.

---

## 4. Getting per-word boxes: the recommended pipeline

This is PDF.js's own technique, assembled from `web/autolinker.js`, `web/text_highlighter.js`
and `src/display/draw_layer.js`. It is first-party, currently shipping, and it is the only
approach in the browser that gets item-boundary-exact results without a fork.

```
1. const tc = await page.getTextContent();            // default normalization
2. const textLayer = new TextLayer({ textContentSource: tc, container, viewport });
   await textLayer.render();
   const divs  = textLayer.textDivs;                  // index-aligned with...
   const strs  = textLayer.textContentItemsStr;       // ...this
3. const pageText = strs.join("");                    // page-level concatenated string
4. Segment pageText into words and sentences (Intl.Segmenter, granularity "word" /
   "sentence"), producing [startIndex, endIndex) character ranges.
5. Map each [start, end) back to (divIdx, offset) pairs by walking strs and
   accumulating lengths — this is exactly PDFFindController/TextHighlighter's
   `_convertMatches` (web/text_highlighter.js:100-140).
6. const range = new Range();
   range.setStart(...textPosition(divs[begin.divIdx], begin.offset));
   range.setEnd(  ...textPosition(divs[end.divIdx],   end.offset));
   // textPosition() descends into text nodes — web/autolinker.js:84-106
7. const rects = range.getClientRects();              // <- the geometry
8. Normalise against the text layer's own rect and store as fractions:
   const box = textLayerDiv.getBoundingClientRect();
   rects.map(r => ({ x:(r.x-box.x)/box.width, y:(r.y-box.y)/box.height,
                     w: r.width/box.width,    h: r.height/box.height }));
   // this is verbatim DrawLayer's `rotator` — src/display/draw_layer.js:573-583
```

Why this is right rather than merely convenient:

- **Step 3-5 sidesteps item granularity entirely.** Words are defined over the page string, so a
  word split across a font change is one segment spanning two divs, and a multi-word item is
  several segments inside one div. Both cases fall out for free.
- **`getClientRects()` returns one rect per line fragment.** For a sentence spanning three lines
  and two columns you get three rects — which is exactly the shape a "sentence band" wants. For
  a word you get one.
- **It accounts for the CSS transforms.** `getClientRects()` returns post-transform viewport
  boxes, so the `scaleX`/`rotate`/`min-font-size-inv` chain on the span is already applied. You
  do not reimplement it.
- **Step 8 makes it zoom-proof.** Fractions of the page are invariant under scale.

Two mechanical notes: `<br>` elements between spans can contribute zero-area rects — filter
`width === 0 || height === 0` as autolinker does (`autolinker.js:20-22`, `draw_layer.js:589`).
And do all of this *after* `await textLayer.render()`, with the layer attached and visible —
`getClientRects()` on a `display: none` subtree returns nothing.

### Accuracy, stated plainly

- **Exact** at item start and item end. The span's origin is derived from the item's true
  transform, and `--scale-x` forces its total width to the item's true width.
- **Interpolated** inside the item. A word box's left edge is at `(sum of substitute-font
  advances before it) × scaleX` from the item origin. The error at any interior offset is the
  accumulated difference between substitute-font advances and the PDF's real advances, minus
  the linear correction `scaleX` applies. It is zero at both ends and largest in the middle of
  a long run.
- **Magnitude**: for body text in a Times/Helvetica-metric font rendered against generic
  `sans-serif`, expect low single-digit CSS pixels at 100% zoom on a ~40-character run — small
  relative to a word, visible if you draw a tight 1px-fitted box. For a run in a display face,
  a small-caps face, or a math font mapped to `sans-serif`, it can be much worse.
- **Mitigations that cost nothing**: pad the word cursor box by a few percent of the font height
  and round its corners, so drift reads as "generous highlight" rather than "misaligned". The
  sentence band is nearly immune — it spans whole lines, and its endpoints are typically at or
  near item boundaries.

---

## 5. The accuracy upgrade: lay the text layer out in the real embedded font

`src/display/font_loader.js:453-461` registers each embedded font as:

```js
rule = `@font-face {font-family:"${this.loadedName}";src:url(data:${mimetype};base64,...)}`;
```

and `src/display/canvas.js:2419` confirms the canvas draws with `fontObj.loadedName ||
"sans-serif"`. **`loadedName` is exactly the value returned as `item.fontName`** (set at
`evaluator.js:2619`, `textContentItem.fontName = loadedName`) — the `g_d0_f1` strings in the
probe output.

So after the page has rendered, `font-family: "g_d0_f1"` is a live, valid CSS family containing
the actual glyphs the canvas drew. Overriding each text-layer span's `fontFamily` with
`item.fontName` (and letting `--scale-x` still do its residual correction) makes the browser lay
the run out with **the PDF's own glyph advances**. Interior positions then match the canvas to
within:

- **`TJ` kerning adjustments inside a word.** pdfTeX and friends emit these routinely; PDF.js
  folds them into `textChunk.width` (`evaluator.js:2933`, `2942`) rather than flushing, so they
  are invisible in the string. Not recoverable without per-glyph data.
- **`Tc` / `Tw` / `Tz`** (char spacing, word spacing, horizontal scaling) applied in the content
  stream — the text layer neutralises `letter-spacing`/`word-spacing` in CSS
  (`text_layer_builder.css`, and PR #21321 "Prevent inherited spacing from affecting text
  layer", 2026-05-25) but does not reproduce PDF-level spacing operators.
- **`/Widths` disagreeing with the font program** — legal in PDF, and the canvas honours
  `/Widths`.

Caveats before relying on it:
- Fonts are only registered once the page's render task has loaded them, so sequence
  `page.render()` before measuring.
- `disableFontFace: true` (or a CSP with no `data:` fonts) kills it — `createFontFaceRule()`
  returns `null` (`font_loader.js:454`).
- Non-embedded fonts get *substituted* (`style.fontSubstitution` /
  `fontSubstitutionLoadedName`), so the family may be a standard-font approximation anyway.
- `FontLoader.clear()` (`font_loader.js:96-99`) removes the faces on document cleanup.

**Recommendation**: build the prototype on the stock generic-font text layer (§4), and keep this
as a one-line experiment to run against real textbook PDFs. If the word cursor looks loose,
flip it on and re-measure. Don't do both at once — you want to know which one you're paying for.

---

## 6. Zoom, scroll and cost

**Zoom.** `PDFPageView.update()` (`web/pdf_page_view.js:797-880`) clones the viewport at the new
scale, sets `--scale-factor` on the container, applies a CSS-transform preview
(`cssTransform()`), and then — unless scaling is restricted — **fully re-renders the canvas** at
the new resolution via `reset({ keepTextLayer: true, ... })`. The canvas is re-rasterised; the
text layer is not rebuilt.

For the text layer, `TextLayer.update({ viewport })` (`text_layer.js:219-243`) does only:
- if rotation changed: reset `data-main-rotation` on the container;
- if scale changed: for every div with `canvasWidth !== 0`, re-run `ctx.measureText()` and reset
  `--scale-x`.

Everything else — `left`, `top`, `font-size` — is CSS, driven off
`--total-scale-factor: calc(var(--scale-factor) * var(--user-unit))`
(`web/pdf_viewer.css:180`). So the per-page cost of a zoom is **one `measureText()` per
multi-character item**: ~170 calls on the probe page, with a hard cap of `MAX_TEXT_DIVS_TO_
RENDER = 100000` (`text_layer.js:50`). Sub-millisecond. It is not the bottleneck; the canvas
re-raster is.

**Our overlay.** If rects are stored as page fractions and rendered into an SVG with
`viewBox="0 0 1 1"` / `preserveAspectRatio="none"` / `inset: 0`, **zoom costs zero recompute**.
This is verbatim what `DrawLayer` does: `_svgFactory.create(1, 1, skipDimensions=true)` produces
`preserveAspectRatio="none" viewBox="0 0 1 1"` (`src/display/svg_factory.js:28-42`), positioned
with percentage `top`/`left`/`width`/`height` (`draw_layer.js:658-664`), and paths written in
normalised units (`draw_layer.js:588-595`).

The one reason to re-derive on zoom is that `--scale-x` is re-measured at the new pixel size and
can shift by a subpixel. Recompute lazily on zoom-settle if you care; skip it otherwise.

**Scroll.** Nothing, provided the overlay lives inside the page's own positioned wrapper. Never
cache viewport-absolute coordinates from `getBoundingClientRect()` across a scroll — normalise
immediately (step 8), which the recommended pipeline does anyway.

**Extraction cost.** `getTextContent()` streams in 100-item chunks (`api.js:1748`) and is
worker-side. Prefer `streamTextContent()` if you want to start segmenting before a dense page
finishes.

---

## 7. Direction, rotation, vertical writing

| Case | What happens | Does naive box math break? |
| --- | --- | --- |
| LTR horizontal | `dir: "ltr"`, `angle = 0` | No. |
| RTL | `bidi()` reorders `str` into **visual** order (`bidi.js:120`) and sets `dir: "rtl"` | Boxes are fine (visual order matches geometry) but your char indices are visual, so logical-order TTS is a separate problem. |
| Page rotation (90/180/270) | Handled entirely in `PageViewport` (`page_viewport.js:80-108`) plus `data-main-rotation` attributes; `getClientRects()` reports post-rotation boxes | No, if you use `getClientRects()`. Yes, if you compute from `item.transform` by hand. |
| Arbitrary-angle text (rotated headings, watermarks, axis labels) | `angle = Math.atan2(tx[1], tx[0]) !== 0`; span gets `--rotate` and its origin shifts by `fontAscent * sin/cos` (`text_layer.js:351-358`) | **Yes.** `getClientRects()` returns axis-aligned boxes, so a 45° run yields a big diagonal bounding box. A sentence band over it will look wrong. Detect `angle !== 0` and either skip or draw a rotated rect from the transform. |
| Vertical / CJK (`style.vertical`, `dir: "ttb"`) | `angle += π/2` (`text_layer.js:337-339`); `item.height` carries the advance and `item.width` is 0; `canvasWidth` is taken from `geom.height` (`text_layer.js:405`) | **Yes** for any code assuming `width` is the advance. `getClientRects()` still returns correct boxes; hand-rolled math does not. |

For a Western textbook corpus the practical exposure is arbitrary-angle text (figure axis
labels, rotated wide tables) — which is exactly the kind of thing the read-aloud should be
skipping anyway. Detecting `angle !== 0` is a cheap and useful signal for ticket 03/07.

---

## 8. Version specifics, and what old guidance gets wrong

- **Current release: 6.3.289** (npm `pdfjs-dist@6.3.289`, GitHub tag `v6.3.289`). Recent line:
  5.7.284 (2026-04-27), 6.0.227 (2026-05-30), 6.1.200 (2026-06-27).
- **Modern vs legacy build.** `build/pdf.mjs` (modern, assumes current-browser JS) vs
  `legacy/build/pdf.mjs` (Babel-transpiled + polyfilled; README:26-31, `gulpfile.mjs`
  `generic-legacy`). For a local prototype in a current browser, **use the modern build**.
  Two practical asymmetries in the shipped package: the TypeScript declarations
  (`pdf.d.mts`) are only under `legacy/build/`, and Node-based extraction scripts are easier on
  the legacy build. Both builds share identical text-layer semantics.
- **Things older tutorials get wrong:**
  - `renderTextLayer()` / `updateTextLayer()` — **removed** in PR #18349, merged 2024-07-02.
    Use `new TextLayer({...}).render()` / `.update({ viewport })`. `TextLayer` is exported from
    `src/pdf.js:90, 156`.
  - `div.style.left = tx[4] + "px"` and scaling the whole layer with `transform: scale()` —
    superseded by percentage positioning + `--font-height`, PR #20491 (2025-12-11).
  - `--scale-factor` alone — the text layer now reads
    `--total-scale-factor = --scale-factor * --user-unit` (PR #19469, api-major, 2025-02-11).
  - Advice to compute the span's font size in JS — it is CSS-derived now.
  - Very recent churn worth knowing about: PR #21810 "Account for the Firefox font size
    quantization in the text layer" landed **2026-09-02, three days ago**, adding
    `--min-font-size` / `--min-font-size-inv` (`text_layer.js:505-521`). Pin your version.
- Anything written before mid-2024 about the text layer should be assumed wrong. This is a file
  that changes several times a year.

---

## 9. Residual risks for this project

1. **Interior-of-item drift is irreducible without a fork.** Word cursor precision is capped by
   substitute-font metrics (or, with §5, by unrecoverable `TJ` kerning). Design the cursor to be
   forgiving. If it isn't good enough, the fallback ladder is: (a) real embedded font in the
   text layer, (b) fork `evaluator.js` to emit per-glyph geometry, (c) drop the word cursor and
   lean on the sentence band. The band was already chosen partly to degrade gracefully — that
   judgement holds up.
2. **Character indices are not glyph indices** (ligature normalization, synthesised spaces,
   bidi reordering). Everything downstream must key off the page-level concatenated string, and
   that string is the *only* stable index space. Do not try to build a glyph-level model.
3. **Synthesised spaces are heuristic.** Tight-tracked textbook typesetting can drop a space,
   welding two words into one segment; loose tracking can insert one mid-word. Word segmentation
   inherits these errors, and so does TTS. Worth measuring on the ticket-01 corpus before
   trusting it.
4. **Two text layers must not fight.** If you keep PDF.js's text layer for selection *and* draw
   your own overlay, the overlay must be `pointer-events: none` and z-ordered below the text
   layer, or selection breaks.
5. **The version moves fast.** Pin an exact `pdfjs-dist` version; the text layer's internals
   changed three days before this was written.

---

## Sources

All source references are `mozilla/pdf.js` at tag `v6.3.289` unless stated.

- `src/display/api.js:1145-1199` — `TextItem` / `TextStyle` / `TextMarkedContent` /
  `getTextContentParameters` typedefs (these generate the official API docs).
- `src/display/api.js:1738-1795` — `streamTextContent()` / `getTextContent()`, showing only two
  public options.
- `src/display/text_layer.js` — the whole `TextLayer` class; esp. `132-135` (flip transform),
  `278-320` (`#processItems`), `322-422` (`#appendText`), `424-443` (`#layout` / `--scale-x`),
  `219-243` (`update`), `505-561` (`#ensureMinFontSizeComputed`, `#getAscent`).
- `web/text_layer_builder.css` — span positioning, `--text-scale-factor`, `--font-height`.
- `web/pdf_viewer.css:120-180` — `--scale-factor`, `--total-scale-factor`.
- `src/display/display_utils.js` — `setLayerDimensions()`.
- `src/display/page_viewport.js:49-118` — viewport transform, `userUnit`.
- `src/core/evaluator.js:2393-3180` — `getTextContent`: item state, `TRACKING_SPACE_FACTOR`
  et al (`2511-2517`), `runBidiTransform` (`2685`), `compareWithLastPosition` (`2726`),
  `buildTextContentItem` glyph loop (`2990-3105`), `appendEOL` (`3108`), `addFakeSpaces`
  (`3127`), `flushTextContentItem` (`3160`).
- `src/shared/util.js:1050-1067` — `normalizeUnicode()` ligature regex.
- `src/core/bidi.js:120` — `bidi()` visual reordering.
- `src/core/intersector.js` + `src/core/document.js:782-792` — worker-internal per-glyph
  geometry, not exported.
- `web/autolinker.js:16-129` — `DOMRectToPDF`, `calculateLinkPosition`, `textPosition`,
  `createLinkAnnotation`: first-party char-range → pixel-rects recipe.
- `web/text_highlighter.js:100-140` — `_convertMatches`, global index → `(divIdx, offset)`.
- `src/display/draw_layer.js:560-600, 654-672` — normalised `getClientRects()` → SVG paths.
- `src/display/svg_factory.js:28-42` — `viewBox="0 0 1 1"`, `preserveAspectRatio="none"`.
- `src/display/font_loader.js:96-99, 185-199, 453-466` — `@font-face` named by `loadedName`.
- `src/display/canvas.js:2385-2438, 2667-2740` — canvas uses `loadedName`; per-glyph advance
  from `/Widths` via `widthAdvanceScale`.
- `web/pdf_page_view.js:780-880` — zoom path: cssTransform preview, then canvas re-render.
- `src/pdf.js:90, 156, 221` — `TextLayer` export (and absence of `renderTextLayer`).
- `README.md:26-31, 89-93` — modern vs legacy builds.
- PRs (mozilla/pdf.js): #18349 removal of `renderTextLayer`/`updateTextLayer` (merged
  2024-07-02); #19469 `[api-major]` apply `userUnit` via CSS (2025-02-11); #20491 move text
  layer scaling logic to CSS (2025-12-11); #21321 prevent inherited spacing (2026-05-25);
  #20567 hide MathML text in the text layer (2026-01-14); #21810 Firefox font size quantization
  (2026-09-02).
- Release/version data: `https://api.github.com/repos/mozilla/pdf.js/releases/latest` →
  `v6.3.289`; `npm i pdfjs-dist@latest` → `6.3.289`.
- Probe: `pdfjs-dist@6.3.289` under Node against `web/compressed.tracemonkey-pldi-09.pdf`
  (shipped in the PDF.js repo). Counts in §1 and §2 are from that run.
