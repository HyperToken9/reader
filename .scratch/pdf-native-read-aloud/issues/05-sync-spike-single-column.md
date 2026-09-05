# 05 — Prototype: does audio + highlight over a native render feel right?

Type: prototype
Status: claimed
Blocked by: —

## Question

The core experience question, isolated from the reading-order problem. Build the smallest thing that renders a **single-column** page with PDF.js, speaks its prose with browser TTS, and moves a **sentence band** along the real rendered page as it goes.

Single-column deliberately: ordering is trivially top-to-bottom there, so this spike answers *only* whether the experience works, uncontaminated by [[06]]'s problem. Use `theCodeBook.pdf` from `sample_books/` — clean single-column narrative prose, the control [[01]] identified.

**Unblocked**: [[02]], [[04]] and [[10]] are resolved, and [[01]] has delivered the single-column control this needs. The corpus gap that remains (a two-column page) blocks [[06]], not this.

Mechanism is settled, so build it rather than rediscovering it:

- **Highlight geometry** ([[02]]): render the stock `TextLayer`; concatenate `textLayer.textContentItemsStr` into a page string; segment it with `Intl.Segmenter`; map offsets back to `(divIdx, offset)`; build a DOM `Range`; take `range.getClientRects()`. Store rects as normalised page fractions in a separate `<svg viewBox="0 0 1 1" preserveAspectRatio="none">` overlay pinned `inset: 0`, `pointer-events: none`. Zoom then costs zero recompute. Pin an exact `pdfjs-dist` version.
- **Timing** ([[10]]): one sentence per `SpeechSynthesisUtterance`. `onstart` moves the band, `onend` advances. No boundary events, no cadence estimation, no timing abstraction. Keep ~2 utterances in flight.

What it must make judgeable, by driving it against real pages:

- Is the sentence band the right weight — anchoring without obscuring the type underneath? This is now the *whole* highlight, so it carries more load than when it was backing a word cursor.
- Does the band land on the right sentence, and stay aligned down a full page?
- Does `Intl.Segmenter` actually agree with what a reader considers a sentence, on real prose with abbreviations, initials and quotation marks?
- Does `onend` fire promptly enough that the band doesn't visibly lag between sentences, or leave a gap?
- Does highlighting survive zoom and scroll without detaching from the text?
- What does auto-scroll feel like — does the page follow the voice pleasantly, or fight the reader?
- **Are the Linux speech-dispatcher voices actually listenable** for sustained textbook reading? [[10]] accepted an unnatural voice in principle; this is where that gets tested in practice.

Throwaway code. Local page, drag-dropped PDF, no persistence. The output is a judgement about the experience plus whatever the build taught us about the mechanism.

## Answer
