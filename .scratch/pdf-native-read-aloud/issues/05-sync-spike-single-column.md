# 05 — Prototype: does audio + highlight over a native render feel right?

Type: prototype
Status: open
Blocked by: 01, 02, 04, 10

## Question

The core experience question, isolated from the reading-order problem. Build the smallest thing that renders a **single-column** page from the corpus with PDF.js, speaks its prose with browser TTS, and highlights along — sentence band plus word cursor — over the real rendered page.

Single-column deliberately: ordering is trivially top-to-bottom there, so this spike answers *only* whether the experience works, uncontaminated by [[03]]'s problem.

What it must make judgeable, by driving it against real pages:

- Does the word cursor land on the right word, and stay there over a full page?
- Is the sentence band the right weight — anchoring without obscuring the type underneath?
- How bad is drift when boundary events are absent or coarse, and is the sentence band enough to hide it?
- Does highlighting survive zoom and scroll without visibly detaching from the text?
- What does auto-scroll feel like — does the page follow the voice pleasantly, or fight the reader?
- Is the native voice tolerable for sustained reading, or does [[the deferred cloud-TTS question|map]] need reopening sooner than assumed?

Throwaway code. Local page, drag-dropped PDF, no persistence. The output is a judgement about the experience plus whatever the build taught us about the mechanism.

## Answer
