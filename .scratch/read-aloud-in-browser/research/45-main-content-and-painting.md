# 45: Finding and painting the main content of a web page

Ticket: [#45](https://github.com/HyperToken9/reader/issues/45). Map: [#43](https://github.com/HyperToken9/reader/issues/43). Blocks the prototype [#46](https://github.com/HyperToken9/reader/issues/46).
Vocabulary is from `extension/GLOSSARY.md`: main content, sentence spotlight, word cursor, Read from here, Read this, reading pill.

**Question:** on an arbitrary web page, how do we find the main content, put its sentences and words in reading order, and paint the two layers on the live page without breaking the page?

**Short answer:**
1. Run **Mozilla Readability on a clone** of the page. Map what it keeps back to live elements by walking the clone and the live tree side by side. Fall back to `<article>`/`<main>` plus the paragraph-density scorer from Reading Lenses.
2. Build a **flat text model per block** (paragraph, list item, heading, cell). Each text node gets its offset in the block string. Segment each block with `Intl.Segmenter`, apply the merge rules from #42, then turn offsets back into `Range`s.
3. Paint with the **CSS Custom Highlight API**.
   - **Dim:** a highlight over the main content minus the sentence.
   - **Nested dim:** a lighter highlight over the sentence minus the word. The spoken word is simply left unhighlighted.
   - The dim colour cannot be derived from each element's own colour with `color-mix(currentColor …)`; that fails, measured below. Instead, bucket text runs by their computed colour and register one highlight per colour. This works on light and dark pages.
4. **Hit-testing:** `document.caretPositionFromPoint(x, y, {shadowRoots})` gives a point in a text node. Look that up in the flat model to get the sentence.
5. **Selection:** take the selection's start and end, map both into the flat model, and widen to whole sentences.

Nothing here needs DOM mutation. The page's own text, nodes and listeners are untouched.

---

## 1. Main content

### Mozilla Readability (recommended primary)

- **It mutates whatever document you give it.** "The `parse()` method works by modifying the DOM… pass a clone… `document.cloneNode(true)`" ([README](https://github.com/mozilla/readability#usage)).
- **What it returns.** `content` is an HTML string by default. With `serializer: el => el`, `content` is a DOM element ([README options](https://github.com/mozilla/readability#new-readabilitydocument-options)). That element belongs to the *clone*, though, not to the live page. Readability gives no live node references.
- **How to map back to live nodes, without touching the live DOM:**
  1. `const clone = document.cloneNode(true)`.
  2. Walk `document` and `clone` in lockstep. A fresh clone is structurally identical, so one `TreeWalker` per tree advanced together works.
  3. Stamp each **clone** element with `data-ra-i="<n>"` and keep `live[n] = element`.
  4. Run `new Readability(clone, { serializer: el => el }).parse()`.
  5. The `data-ra-i` values that survive in the result name the live elements Readability kept. Any live element under a kept ancestor whose id did *not* survive was cleaned out (share bars, forms, "related" boxes, and so on).
- **The ids survive cleaning. Checked in the [source](https://github.com/mozilla/readability/blob/main/Readability.js):**
  - Attributes are removed only by `_cleanClasses` (`class`, unless kept) and `_cleanStyles` (the `PRESENTATIONAL_ATTRIBUTES` list, plus `width`/`height`).
  - `_setNodeTag` copies every attribute onto the replacement element (`replacement.setAttributeNode(node.attributes[i].cloneNode())`, ~L780). So `data-*` survives a `div`→`p` retag.
  - Elements Readability *creates*, such as the wrapping `<div id="readability-page-1">` and the `<p>`s it wraps loose phrasing content in, have no id. That doesn't matter, because their children do.
- **`isProbablyReaderable(doc)`** is a cheap pre-check. The README warns it "is likely to produce both false positives and false negatives", so use it only to choose a fallback, never to refuse to read.
- **Coverage evidence.** The Readability regression corpus ([`test/test-pages`](https://github.com/mozilla/readability/tree/main/test/test-pages)) is mostly news and blogs:
  - news: nytimes ×5, bbc, guardian, wapo, cnn, lemonde, theverge, medium ×3;
  - Wikipedia ×4;
  - a few docs-like pages: `google-sre-book-1`, `ietf-1`, `mozilla-1/2`, `mercurial`, `v8-blog`, `gitlab-blog`, `lwn-1`;
  - RTL ×4, plus `mathjax`, `hidden-nodes` and `remove-aria-hidden`.

  There are **no modern docs-framework pages** (Docusaurus, MkDocs, Sphinx, MDN-style sidebars). Those are where a prototype should look hardest.
- **Cost and limits:**
  - About 90 KB of plain JS that needs no bundler and runs in the content script.
  - Parsing is O(page). It has a `maxElemsToParse` guard.
  - `cloneNode` does not copy shadow roots (except clonable ones) or iframe documents, so text inside web components or iframes is invisible to it.
  - It drops content it judges to be boilerplate. Sometimes that is real content: short pages, code-heavy docs, tables. See `keep-tabular-data` in the corpus.

### Chromium DOM Distiller (not recommended)

- The repo [chromium/dom-distiller](https://github.com/chromium/dom-distiller) was **archived on 2 Feb 2023** and is read-only.
- It is Java compiled to JS with an Ant/GWT build (`ant gwtc`, `ant extractjs` → `out/domdistiller.js`). Its documented output is extracted HTML.
- Chrome does not expose it to extensions.
- Taking it on means vendoring a dead GWT bundle that does the same job as Readability. That is no gain.

### Simple heuristics (fallback)

Reading Lenses `src/content.js` `pickScope()`:
1. Take `article, main, [role="main"]` if it holds more than 500 characters.
2. Otherwise score each ancestor (up to 3 levels) of every `<p>` longer than 60 characters by the paragraph text it holds.
3. Take the deepest element holding at least 75% of the top score.

This is cheap, works on the live DOM directly, and does well on docs sites, which almost always have a `<main>` or `<article>`. It does badly on sites that put sidebars inside `<main>`.

**Recommendation:** Readability on a clone first. Use the result if it is non-null and its text length is at least about 40% of the `<main>`/`<article>` candidate, so that it hasn't thrown away most of a docs page. Otherwise fall back to `pickScope()`. Either way, apply the same exclusion filter during the text walk:
- hidden elements (`!el.checkVisibility()`);
- `script, style, noscript, template, svg, math, button, input, select, textarea, nav, [aria-hidden=true], [contenteditable]`;
- our own UI.

**Read from here** on a sentence *outside* the chosen main content should still work. Start at the clicked block and continue through the main content after it if that is downstream, or else just to the end of that block's container. Whether that is good enough is a #46 question.

## 2. Text to ranges

### Walking text across inline elements

- **Build one model per block.** A block is the nearest ancestor whose computed `display` is not `inline*`/`contents`, in practice `p, li, h1–h6, td, th, blockquote, figcaption, dd, dt` and `div`s holding bare text.
- **Inline elements belong to their block.** `a, em, strong, code, span, sub, sup, abbr` stay inside the block string.
- **Sentences never cross a block boundary.** This alone prevents a whole class of bad merges: headings without full stops, list items, table cells.
- **Each block record holds:**
  - `text`, the concatenation of its text nodes' data with whitespace runs collapsed;
  - `runs`, a list of `{node, start, end, color}` where `start`/`end` are offsets in `text`. A binary search over `runs` maps offset → `(node, offset)`, and a `Map<Text, run>` maps the other way.
- **Collapse whitespace with a per-run offset table**, or simply keep the raw data and let the segmenter treat `\n`/runs of spaces as whitespace. Raw is simpler and the offsets stay trivial. Normalise only the string sent to the voice.
- **`<br>` inside a block** becomes a `"\n"` pseudo-run so that a line break inside a block (poetry, addresses) is not glued into a single word.
- **Shadow DOM.** `TreeWalker` does not descend into shadow roots. To include them, recurse into `el.shadowRoot` explicitly. For closed roots, extension content scripts have [`chrome.dom.openOrClosedShadowRoot(el)`](https://developer.chrome.com/docs/extensions/reference/api/dom).

### Segmenting with `Intl.Segmenter`

Measured in headless Chrome 157 (check `45-checks/01-highlight-currentcolor.html`):

```
"Dr. Smith went home, e.g. by bus. J. R. R. Tolkien wrote it. Pi is 3.14.
 See https://ex.com/a?b=1 now. Smith et al. agree. See Fig. 3 below. It costs $3.50 today."
→ |Dr. |Smith went home, e.g. by bus. |J. |R. |R. |Tolkien wrote it. |Pi is 3.14. |
  |See https://ex.com/a?|b=1 now. |Smith et al. agree. |See Fig. 3 below. |It costs $3.50 today.|
```

- **The #42 faults reproduce on the web.**
  - It breaks after a title abbreviation followed by a capital (`Dr. |Smith`).
  - It breaks between initials (`J. |R. |R. |Tolkien`).
  - It breaks inside a URL at `?`.
- **Some #42 cases did *not* break here,** because the next token is lowercase or a digit: `e.g. by`, `et al. agree`, `Fig. 3`, `3.14.`, `$3.50`.
- **Fix:** post-merge with the same rules #42 asks Blitz for: an abbreviation list (`Dr Mr Mrs Ms Prof St vs etc e.g i.e et al Fig Eq No`), a single capital letter plus `.`, and "no break inside a URL token". Port the rules, not the Blitz code.
- **Better than merging:** web pages often mark URLs and code as `<a>`/`<code>`. Forbid breaks inside any `<a>` or `<code>` run.

Word granularity (`isWordLike`) splits `e-mail`, `U.S.` and `co-op` into pieces (`e / mail / U / S / co / op`). For the **word cursor**, use **whitespace-delimited tokens** with surrounding punctuation trimmed, not segmenter words:
- Kokoro word timings are produced by splitting phonemes on the literal space (#16), so whitespace tokens are the unit that aligns.
- Reading Lenses also splits on `/(\s+)/`.

Keep the sequence alignment of spoken groups to page tokens that #16 calls for, since espeak expands numbers and cliticises function words.

Per [MDN `Intl.Segmenter.prototype.segment()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter/segment), each segment carries `{segment, index, input, isWordLike?}`, and `segments.containing(i)` gives the segment at an offset, which is useful for hit-testing too.

### Back to `Range`s

`new Range()`, then `setStart(...locate(block, a))` and `setEnd(...locate(block, b))`. A single `Range` may span many text nodes and inline elements. `getClientRects()` returns one rect per line box fragment: 5 for a 2-line sentence crossing `<em>` in the check.

**Live `Range` or `StaticRange`?** The [Highlight API §5.2](https://drafts.csswg.org/css-highlight-api-1/#range-invalidation) says "The user agent will adjust the boundary points of Ranges in response to DOM changes", while it "must not adjust… StaticRanges". Live `Range`s cost the browser bookkeeping on every DOM mutation. Use **`StaticRange`** for the big, short-lived dim ranges, which are rebuilt every sentence. Use `Range` only for the sentence and word ranges we also need geometry from (`getClientRects` exists only on `Range`).

### What Reading Lenses does (reference, not to copy)

`src/content.js`:
- `wrap()` walks visible text nodes in the scope and **replaces each one** with an `<rl-t>` holder that holds one `<rl-w>` element per whitespace token.
- `startTts()` builds chunks with a `starts[]` table of each word's character offset in the utterance. `onboundary` binary-searches `e.charIndex` into it and toggles a class on the `<rl-w>`.
- `unwrap()` restores the original text nodes.

It works, but it mutates the page:
- it breaks React/Vue reconciliation on SPAs;
- it changes `textContent` lengths;
- it multiplies nodes by about 10×.

The Highlight API makes all of this unnecessary. The offset-table idea carries over unchanged.

## 3. Painting: CSS Custom Highlight API

### What it allows

- **Allowed properties** (CSS Pseudo 4 §3.2; [MDN `::highlight()`](https://developer.mozilla.org/en-US/docs/Web/CSS/::highlight)):
  - `color`, `background-color`;
  - `text-decoration` and its sub-properties, `text-shadow`;
  - `-webkit-text-stroke-color`, `-webkit-text-fill-color`, `-webkit-text-stroke-width`;
  - (spec) `stroke-color`, `fill-color`, `stroke-width`, custom properties.

  `background-image` is ignored. **`opacity`, `filter`, `box-shadow` and any layout property do not apply.** Confirmed: `::highlight(op){opacity:.2;filter:blur(2px)}` rendered the text unchanged.
- **The spec only promises two properties.** It notes "only color and background-color have been interoperably supported."
- **Overlap and priority.** Within one highlight, overlapping ranges paint as their union (§4.2.4). Across highlights, `priority` orders them; with equal priority, the one registered later wins (§4.2.5). `::selection` paints above every `::highlight` (Pseudo 4 §3.6.1), so a reader's own selection stays visible.
- **One registry per document.** It "represents all the custom highlights registered for the current global object's associated Document" (§3.2). Ranges whose root isn't the document are ignored (§5.2).

### Can it do "dim everything except the spoken sentence"? Yes, by colouring the text, not by opacity

Blitz's look (#16, `app/renderer/main.js` ~2750–2805):
- **Spotlight:** an SVG mask that lays `rgba(10,12,18,.42)` over the page with the sentence's rects punched out.
- **Nested dim:** a second, fainter `rgba(10,12,18,.24)` mask over the sentence rects with the word punched out.

On the web, the Highlight API can't lay a veil over the page. It can fade the **text colour** of everything that isn't lit:

| Highlight | Ranges | Style |
|---|---|---|
| `ra-dim-<k>` | main content start → sentence start, and sentence end → main content end (as per-colour runs, see below) | text colour at about 40% alpha |
| `ra-wdim-<k>` | sentence start → word start, and word end → sentence end | text colour at about 72% alpha |
| (none) | the spoken word | the page's own styling, untouched |

The ranges are disjoint, so priority doesn't matter. The spoken word and the lit sentence keep the page's own colours. Only main content is dimmed, which is what the glossary's *sentence spotlight* says.

**The obvious rule does not work in Chrome.** I first tried `::highlight(dim){ color: color-mix(in srgb, currentColor 35%, transparent) }`. It failed (check 01, screenshot `45-checks/01-highlight-currentcolor.png`):
- The text on a dark (`#111`) block turned **almost black on black**, so it was unreadable.
- `getComputedStyle(p, '::highlight(dim)').color` returned `color(srgb 0 0 0 / 0.042875)`, which is 0.35³.
- So in Chrome, `currentColor` inside `color-mix()` resolved through highlight *inheritance*: each ancestor's `::highlight` re-mixed its parent's highlight colour, starting from the root's black. It did not resolve to the originating element's own colour.

The spec says `currentColor` here should be "the color of the next active highlight pseudo-element layer below", falling back to the normal text colour (Pseudo 4 §3.6.3). Chrome 157 does that for a bare `color: currentColor`: in check 02 a link stayed blue. It does not do it inside `color-mix()`.

**What does work: bucket by computed colour** (check 02, screenshot `45-checks/02-per-colour-dim.png`):
1. When the model is built, record `getComputedStyle(textNode.parentElement).color` on each run.
2. When painting, merge adjacent same-colour runs into ranges, then register one highlight per distinct colour with a generated rule: `::highlight(ra-dim-3){ color: rgb(from rgb(6,69,173) r g b / calc(alpha * .4)) }`.

The rendered result:
- links fade as faded blue, and code as faded red;
- dark-theme text fades toward its dark background;
- underlines fade with their text, because decorations are redrawn in the highlight colour (§3.6.3);
- nested dim inside the sentence works the same way.

A typical article has fewer than 15 distinct text colours.

**Set `-webkit-text-fill-color` to the same value as `color`.** Pages that set `-webkit-text-fill-color` (gradient text, some dark themes) would otherwise ignore the `color` change. Not tested yet; #46 should check it.

**How it differs from Blitz's veil:**
- Only glyphs dim. Images, code-block backgrounds, borders, rules and video stay at full strength.
- The lit sentence has no "hole"; it is simply the text left at full colour.

That is arguably calmer on busy web pages, but it is not pixel-identical to #16. #46 should judge it on a real page.

### Page CSS, dark sites, shadow DOM, iframes

- **Page CSS.**
  - Highlight pseudos cascade like any other rule. A page could style `::highlight(ra-…)` only by guessing our names, so prefix them.
  - Inject the rules as a constructed stylesheet: `new CSSStyleSheet()`, `replaceSync()`, then push it onto `document.adoptedStyleSheets`. A `<style>` element can be blocked by a strict page CSP (`style-src` without `'unsafe-inline'`). Whether a stylesheet constructed from an *isolated-world* content script paints and survives every CSP is **not verified here**; check it in #46 on a strict-CSP site.
  - The fallback is `chrome.scripting.insertCSS`, which is not subject to page CSP, with a fixed palette of bucket names.
- **Dark sites.** Handled by the per-colour buckets: the faded colour is always the element's own colour with less alpha, so it fades toward whatever background is behind it.
- **Shadow DOM.**
  - In check 01, text inside an **open** shadow root was dimmed by a rule in the *document* stylesheet. The shadow `<p>`'s highlight pseudo inherits from its host chain (Pseudo 4 §3.5, highlight inheritance).
  - An adopted sheet inside the shadow root also works.
  - Ranges into shadow trees are painted, because their shadow-including root is the document.
  - The work is in *walking* there (see §2), not painting.
- **Iframes.**
  - The registry is per document. A content script paints only its own frame's document.
  - Injecting into frames needs `all_frames: true`, with `match_about_blank`/`match_origin_as_fallback` for `about:`/`blob:` frames ([manifest docs](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)). Each frame then runs its own copy, so a cross-frame reading order needs messaging through the service worker.
  - Recommend **top frame only for v1**: main content in an iframe is rare outside embeds and some legacy docs sites.
- **Isolated world.** Content scripts run in `ISOLATED` world by default (same doc). They share the DOM but not JS objects with the page. `CSS.highlights` should be backed by the document. This was **not checked from a real content script here**; #46 should confirm it on the first run.

### Alternatives if the Highlight API is ruled out

| Approach | What it gives | What it costs |
|---|---|---|
| **Overlay from `Range.getClientRects()`**: a fixed, `pointer-events:none` full-viewport SVG with a mask, as in Blitz | Exactly Blitz's veil: dims images and backgrounds too | Must be redrawn on scroll, resize, font load, reflow and lazy images, which a `ResizeObserver` alone can't catch. z-index fights with sticky headers and modals. It covers the page's own fixed UI unless we punch that out too. Rects go stale during animation. Selection colour sits *under* the veil. |
| **Wrapping in spans** (the Reading Lenses route) | Any CSS, including `opacity` | Mutates the page: breaks framework reconciliation, `:first-child`-style selectors and some copy behaviour. Must be undone perfectly. Node count grows about 10×. SPAs re-render and silently drop our spans. |
| **Highlight API (recommended)** | Text-colour dim, no DOM mutation, follows reflow for free, paints in shadow DOM | Text-only dim. Per-colour bucket bookkeeping. Rules injected through a CSP-safe route. |

## 4. Hit-testing: Read from here and click-to-jump

- **`document.caretPositionFromPoint(x, y, { shadowRoots })`** returns `CaretPosition{offsetNode, offset}` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document/caretPositionFromPoint); Baseline 2025, and present in Chrome 157).
  - Without `shadowRoots`, a point inside shadow content is "remapped to the node that is the host of the shadow root". Measured: it returned `BODY`.
  - With `{shadowRoots:[sr]}` it returned the shadow text node. So pass every shadow root found while walking.
- **`caretRangeFromPoint`** is non-standard, takes no shadow option, and is a fallback only.
- **`CSS.highlights.highlightsFromPoint(x, y)`** exists in Chrome 157. It returned `["dim"]` at a dimmed point. It says *which highlight* is under the point, not the offset, so it doesn't replace the caret lookup.
- **Read from here.**
  - `chrome.contextMenus.onClicked` does not give coordinates. The content script must remember the last `contextmenu` event's `clientX/clientY`. Listen in the capture phase, because pages may stop propagation.
  - On the menu click, run `caretPositionFromPoint`, then `runOf(node)` → block offset → `sentences.containing(offset)`. If the node isn't in the model (outside main content, or in whitespace between blocks), take the nearest following block.
- **Click-to-jump while reading.**
  - A `click` listener on the main-content root does the same lookup.
  - Ignore clicks on `a[href]`, form controls, or when `getSelection()` is non-collapsed, so the reader can still follow links and select text.
  - The cursor hits whitespace past the end of a line at the nearest offset, which belongs to that line's sentence. That is fine.

## 5. Selection: Read this

- **Map the selection to sentences.**
  1. Take `getSelection().getRangeAt(0)`. Chrome supports a single range only.
  2. Map `startContainer/startOffset` and `endContainer/endOffset` into the flat model.
  3. If an endpoint is an element rather than a text node, resolve it to the first or last text run inside it.
- **Widen to whole sentences.** Read from the sentence containing the start to the sentence containing the end, inclusive. If the selection lies inside one sentence, read that sentence.
- **Selections outside the main content** (a sidebar quote, say) still read. Build an ad-hoc block model from the selection's own common ancestor, so Read this never depends on main-content detection.
- **Shadow DOM.** `getRangeAt` doesn't cross shadow boundaries. The standard `Selection.getComposedRanges()` does. Its availability in the target Chrome was **not checked here**; check it in #46 if a test page uses web components.

## Known limits

- **Main content detection** is a heuristic and will sometimes be wrong. Docs frameworks are untested by Readability's corpus. Read from here and Read this are the escape hatch.
- **Dimming is text-only.** Images and backgrounds don't dim. This differs visibly from Blitz's veil, and it is a judgement call for #46.
- **`color-mix(currentColor …)` in `::highlight` is broken in Chrome 157,** so the per-colour bucketing workaround is needed. If Chrome fixes it, one rule replaces the buckets.
- **Pages that change underneath** (SPAs, infinite scroll) invalidate the model. Live `Range`s survive small edits, but the flat model must be rebuilt on a `MutationObserver` signal. That decision belongs to the map's "pages that change underneath" item.
- **Iframes:** top frame only for v1. **Closed shadow roots** need `chrome.dom.openOrClosedShadowRoot`.
- **Segmenter fixes are needed** for abbreviations, initials and URLs (#42's list). Don't break inside `<a>` or `<code>`.
- **Not verified here, for #46 to check:**
  - highlights and adopted stylesheets from an isolated-world content script;
  - behaviour under a strict CSP;
  - `-webkit-text-fill-color` pages;
  - `getComposedRanges`;
  - the cost of re-registering highlights per word on a long page.

## Pages to try the prototype (#46) on

1. **Docs site with sidebar, TOC and code:** MDN, `https://developer.mozilla.org/en-US/docs/Web/API/Range`. Tests `<main>`/sidebar exclusion, `<code>` runs, and code blocks.
2. **News article:** BBC News, any `https://www.bbc.com/news/articles/...` story. Tests ads, related links, captions and bylines, and Readability's home ground.
3. **Wikipedia:** `https://en.wikipedia.org/wiki/Speech_synthesis`. Tests footnote markers `[1]`, infobox and table exclusion, and abbreviations.
4. **Dark-themed site:** the Rust Book in its dark theme (`https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html`, pick "Coal" or "Ayu"), or GitHub in dark mode on a README. Tests per-colour dim on a dark background.
5. **Long-form blog / Substack-style:** Paul Graham, `https://paulgraham.com/greatwork.html`. Tests table-layout HTML with no `<article>` or `<main>` and `<br>`-separated text, the worst case for heuristics.
6. **Strict CSP and SPA:** a GitHub issue or README page (`https://github.com/mozilla/readability`). Tests strict CSP for the injected rules, Turbo navigation replacing the content, and dark mode.

## Throwaway checks in this folder

- `45-checks/01-highlight-currentcolor.html` + `.png`:
  - `color-mix(currentColor)` failing;
  - nested dim;
  - `opacity` ignored;
  - shadow-root painting;
  - `Intl.Segmenter` output;
  - `caretPositionFromPoint` with and without `shadowRoots`;
  - `highlightsFromPoint`.
- `45-checks/02-per-colour-dim.html` + `.png`: per-colour buckets on light and dark blocks.

Run either with `google-chrome --headless=new --dump-dom file://…` (results print into `<pre id=out>`), or `--screenshot`.
