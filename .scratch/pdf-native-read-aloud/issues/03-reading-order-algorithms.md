# 03 — How is reading order recovered from a multi-column PDF?

Type: research
Status: open

## Question

This is the crux risk of the entire effort. PDF text is stored in content-stream order, which is the order a generator happened to emit drawing operations — for a two-column page that is frequently *not* reading order, and running headers, footers, page numbers, figure captions, footnotes and margin notes arrive interleaved with body text carrying no reliable labelling. If reading order can't be recovered acceptably, the audio jumps around the page and the product does not work.

Survey how this problem is actually solved:

- **Classical geometric algorithms**: recursive XY-cut, Docstrum, Voronoi-based segmentation, whitespace-density column detection. How well does each handle two-column text, figures interrupting a column, and spanning headers? What are their known failure modes?
- **What existing tools do**: how do PyMuPDF (`get_text("blocks")` / sort flag), pdfplumber, pdfminer.six's `LAParams`, Poppler's `pdftotext -layout`, `unstructured.io`, Marker, and Grobid recover order? Which of these have transplantable *algorithms* even though they're Python/C++?
- **Client-side JS viability** — the load-bearing question, since the prototype is a browser web app. Is there any JS library that does layout analysis on PDF.js output? If not, how much of an XY-cut or column-detection pass is realistic to implement directly against `getTextContent()` items? Roughly how much code?
- **Region classification**: how are running headers/footers distinguished from body text (repetition across pages, position bands)? How are figure captions, footnotes (font size, position, leading marker) and display equations identified? Note that equations in PDFs often appear as text items in a maths font, or as vector drawings with no text at all — which is it typically, and how is it detected?
- **Marked content / tagged PDFs**: some PDFs carry a structure tree giving explicit reading order and semantic roles. How often do real textbooks have this, can PDF.js expose it (`getStructTree`), and is it trustworthy enough to use as a fast path when present?
- Is there a pragmatic 80% approach — e.g. detect column count via vertical whitespace, sort within columns top-to-bottom, drop repeated header/footer bands — that gets acceptable results without full document-layout ML?

Report the recommended approach for a browser-side prototype, with its expected failure modes stated plainly.

## Answer
