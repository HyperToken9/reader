# 12 — Can a document-layout model do what ticket 06 planned to hand-write?

Type: research
Status: open
Blocked by: —

## Question

[[03]] found no JS library for reading order and concluded we write it ourselves: roughly 600–900 lines of geometry — running-head removal by cross-page repetition, line clustering, bands before columns, gutter detection by x-projection. It also found the hard half is not ordering but **classification**: sidebars and boxed worked-example panels are geometrically identical to a narrow column, and that is the dominant textbook failure.

Classification is exactly what a trained layout model does. So this ticket asks whether [[06]] should be written at all.

Named by the human: **PaddleOCR / PP-StructureV3**. Others to price alongside it: **docling** (IBM), **MinerU**, **marker**, **Surya**, **DocLayout-YOLO**, **LayoutLMv3**. Prefer current repos and model cards; this field turns over fast.

Establish, for the serious candidates:

- **What the output actually is.** Region boxes with class labels (text / title / figure / table / formula / caption / header / footer)? A reading order? Markdown or HTML? [[03]]'s vocabulary and this ticket's answer have to line up, because [[07]] fixes the region vocabulary the codebase uses.
- **Whether the coordinates can be joined back to the PDF.** This is the load-bearing risk. These models consume a *rasterised page image*, so their boxes are in image pixel space. Getting to PDF user space is a scale factor we control by choosing the render DPI — fine. The real join is **region box → text-layer items**, so we know which sentences live inside which region. State whether that intersection is clean in practice, or whether boxes are loose enough that items straddle two regions.
- **How it runs.** Python only? ONNX export? Anything that runs in a browser or in Node? Per-page latency on CPU. Model size. This lands straight on [[08]] alongside [[11]].
- **How well it does on *this* corpus** — three untagged textbook PDFs, one equation-dense and figure-heavy. Vendor benchmarks are on academic papers; textbooks are not papers.
- **Licence**, for both code and weights.
- **What it does NOT give us.** It returns regions, not text with per-character geometry — so it cannot draw the sentence band. The band still comes from PDF.js's text layer via [[02]]. Confirm this reading: the model **complements** the text layer and replaces only [[06]], it does not replace [[02]] or [[05]]'s mechanism.

Then answer the question this exists for: **does [[06]] survive?** Three possible shapes — the model replaces it outright; the model is the primary path with a geometric fallback for pages it fails; or the model is too slow, too heavy or too inaccurate on textbooks and [[03]]'s plan stands. Say which, with evidence.

Note the corpus gap [[01]] recorded: there is still no two-column PDF in `sample_books/`. That blocked [[06]] and it blocks a fair test here too.

## Answer
