# 02 — What geometry does the PDF.js text layer actually give us?

Type: research
Status: open

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
