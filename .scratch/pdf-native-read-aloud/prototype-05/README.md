# 05 — sync spike (THROWAWAY PROTOTYPE)

Answers one question: **does audio + a sentence band over a native PDF render feel right?**

Not production code. No tests, no error handling, no persistence. It exists to be
driven and judged, then thrown away. The ticket is
`../issues/05-sync-spike-single-column.md`.

## Run it

```sh
npm install
npm run dev
```

Then drop `sample_books/theCodeBook.pdf` onto the page (or use **Choose a PDF…**),
pick a voice, and press **Play**. Space also plays/pauses.

## What to drive, and what to look for

The ticket lists the judgements this is here to make. Concretely:

| Control | Judges |
| --- | --- |
| The floating bar (`←` / `→`, or `?variant=`) | **Band weight.** A = tint, B = underline, C = spotlight (dim the page, punch the sentence out). Radically different on purpose — pick one, or steal from two. |
| **Show every sentence band** | **Alignment down a whole page**, all at once, without waiting for the voice. Also shows where `Intl.Segmenter` cut. |
| The **Segmentation** list | **Does `Intl.Segmenter` agree with a reader?** Every sentence it found on the page in view, verbatim. Click one to speak from there. Orange entries contain unmapped glyphs. |
| **Zoom** | Whether the band stays attached. The rects are page fractions and are deliberately *never* recomputed on zoom, so this is a real test of the 02 claim, not a re-render. |
| **Rate** | Rate cannot change mid-utterance, so this cancels and re-dispatches from the current sentence. Judge whether that seam is noticeable. |
| **Auto-scroll** | Whether the page follows the voice pleasantly or fights you. |
| **State** panel | `inFlight`, current position, and mean utterance duration — the last one is how you tell whether `onend` is lagging between sentences. |

Clicking a sentence **on the page itself** also starts playback there.

## Mechanism

Exactly as settled, no more:

- **Geometry** (02): stock `TextLayer` → `textContentItemsStr` joined into a page string →
  `Intl.Segmenter` → char offsets mapped back to `(divIdx, offset)` → DOM `Range` →
  `range.getClientRects()` → stored as **page fractions** in a separate
  `<svg viewBox="0 0 1 1" preserveAspectRatio="none">` overlay.
- **Timing** (10): one sentence per `SpeechSynthesisUtterance`, ~2 in flight.
  `onstart` moves the band, `onend` advances. No boundary events, no cadence model.

`pdfjs-dist` is pinned to `6.3.289`.

## Two departures from the ticket's spec, both forced by the corpus

1. **A plain `strs.join("")` is wrong.** PDF.js emits no whitespace at a line break —
   it appends a `<br>` to the DOM instead — so joining welds the last word of one line
   onto the first of the next (`"It is thispersonality that..."`). Sentences segment
   wrong and TTS speaks nonsense. Fixed by injecting a separator after every `hasEOL`
   item; it belongs to no item, so the offset map steps over it.
2. **Hyphenated line breaks need the hyphen dropped**, or that separator turns
   `"accelerat-"` + `"ing"` into `"accelerat- ing"`. The hyphen is excluded from the
   index space; the `Range` still covers it visually.

## Checking it without a human

```sh
npm run verify -- "../../../sample_books/theCodeBook.pdf" 41   # geometry smoke test
npm run shot   -- "../../../sample_books/theCodeBook.pdf" 41 7 # screenshot each variant
```

`verify` drives the real page in headless Chrome and reports sentence counts,
out-of-bounds rects, reading-order inversions, how `Intl.Segmenter` cut the page, and
whether the rects survive a zoom **byte-identically**. It cannot judge the experience,
and it sees no voices — that part needs a real browser and a human.
