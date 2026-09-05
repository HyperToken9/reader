# 05 — Prototype: does audio + highlight over a native render feel right?

Type: prototype
Status: resolved
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

## Progress

**Built (2026-09-05).** `../prototype-05/` on branch `prototype/05-sync-spike`. `npm install && npm run dev`, drop `theCodeBook.pdf`, press Play. Its README says what to drive and why.

Everything mechanical it can answer without a human, it has answered:

- **The geometry pipeline works, unchanged from [[02]].** On `theCodeBook.pdf` p41 the band lands on the right sentence, starts and ends mid-line correctly, and wraps four lines as four rects. Screenshots in the commit history; the `shot.mjs` script regenerates them.
- **Zoom genuinely costs nothing.** 1.2 → 2.4 with the rects deliberately never recomputed: `JSON.stringify(rects)` is byte-identical and the band stays attached. [[02]] §6 holds.
- **No out-of-bounds rects and no reading-order inversions** on either `theCodeBook.pdf` (p40, p41) or the equation-dense `Millington` p60.
- **`Intl.Segmenter` looks right on clean prose.** p41 of the control cut into 20 sentences with no visible mis-splits on abbreviations or quotes. It cannot see block boundaries, though — where a ciphertext block or a figure caption abuts prose with no terminating full stop, it welds them into one sentence. That is [[06]]/[[07]]'s problem, not the segmenter's.

**Two corrections to the mechanism this ticket specified**, both found by driving the corpus, both now in the prototype:

1. **`strs.join("")` is wrong.** PDF.js emits no whitespace at a line break — it appends a `<br>` to the DOM instead — so a plain join welds the last word of one line onto the first of the next: *"It is thispersonality that allows us…"*. Sentences then segment wrong **and TTS speaks nonsense**. Fix: inject a separator after every `hasEOL` item. It belongs to no item, so the offset map steps over it and no `Range` endpoint can land inside one. This is load-bearing for anything downstream that reads the page string, so it belongs in [[02]]'s record too.
2. **Hyphenated line breaks need the hyphen dropped**, or that separator turns `"accelerat-"` + `"ing"` into *"accelerat- ing"*. Excluded from the index space; the `Range` still covers it visually.

**Evidence handed to other tickets**: unmapped glyphs surface as **C0 control characters, not as nothing** — see [[09]]. Running heads weld into the first sentence of a page — see [[07]].

**Still open, and the reason this ticket is not resolved: everything that needs ears and eyes.** Band weight (three styles are switchable — A tint, B underline, C spotlight), whether `onend` lags audibly between sentences, how auto-scroll feels, and above all **whether the Linux speech-dispatcher voices are listenable** for sustained reading. Headless Chrome sees no voices at all, so that last one cannot be faked.

## Answer

**The experience works. Audio plus a highlight over a native render is worth building on.** Driven against `theCodeBook.pdf` by the human, 2026-09-05.

Point by point, against the questions this ticket was opened to ask:

- **Band weight: variant C, the spotlight, wins** — dim the whole page and punch the spoken sentence out of the mask. Not the tint, not the underline. Now the default. This is the single most reusable output of the spike: the highlight that reads best over a real PDF is *subtractive*, dimming everything else, rather than additive colour laid on top of type. That is worth remembering when [[13]]'s HTML layer starts adding things to the same page.
- **The band lands on the right sentence.** Confirmed by eye, matching the mechanical check.
- **`Intl.Segmenter` is imperfect and tolerable.** What a single click selects is "a bit off" — accepted for now. This is the known block-welding problem: nothing terminates a ciphertext block, a code listing or a figure caption, so it fuses with the prose that follows. It is not a segmenter bug and it is not fixable in the segmenter. [[06]]'s region boundaries are what cut the string before segmentation ever sees it, and [[07]] records the two concrete instances.
- **`onend` does not stall.** "Doesn't stall that much between sentences." So [[10]]'s bet holds: one sentence per utterance driven by `onstart`/`onend` gives adequate timing with no estimation, no cadence model and no drift.
- **Auto-scroll is good.** No change wanted.
- **Zoom does not detach the band**, confirming [[02]] §6 by eye as well as by measurement.
- **Voice is bearable but wants expression.** Not a blocker; the human explicitly said they are happy to ship on it for now. It is the one dimension where the cheap thing is merely adequate rather than good, which is exactly what [[14]] now decides.

**One defect found, and fixed rather than recorded.** The control panel is a fixed 330px column, so zooming the page in made it impossible to see the document clearly — the panel ate the width the page needed. The panel is scaffolding, not product, so it now collapses (`☰` top-left, or `h`). Worth carrying into any real UI: **reading chrome must get out of the way of the page**, because the page is the whole point.

**What this unblocks.** [[14]] (adopt local neural TTS) was blocked on exactly this verdict and is now takeable, with a clear brief: the band is settled, so TTS is the only remaining weak spot in the core loop. [[08]] (ship platform) loses one of its two blockers.

**Consequence for the destination.** The map's destination is reached when the prototype "has been driven against real textbook PDFs, well enough to judge whether the audio+highlight-over-native-render experience actually works". It has, and it does. What remains on the map is no longer *whether* to build this but *how well* — reading order, skip policy, voice, platform.
