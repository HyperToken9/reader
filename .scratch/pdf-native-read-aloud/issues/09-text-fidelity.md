# 09 — Is the extracted text string clean enough to segment and to speak?

Type: prototype
Status: open
Blocked by: 01

## Question

Surfaced by [[02]]. The page-level concatenated string is load-bearing twice over: it is what gets segmented into words and sentences to drive highlighting, *and* it is what gets handed to the TTS engine. So corruption in it damages both, and the TTS damage is the kind you notice as gibberish in your ear.

[[02]] found the character-to-glyph correspondence is already broken before we see it:

- Default `disableNormalization: false` **NFKC-expands ligatures** — 151 ligature-bearing items became 0 on the probe document.
- Spaces in `str` are **synthesised from advance heuristics**, not read from the content stream. Tight tracking — common in textbook typesetting — can weld adjacent words together.
- RTL runs are reordered into visual order by `bidi()`.

**Already confirmed worse than [[02]] predicted.** A spot check during [[01]] found that on p.60 of the Millington physics book, the **Δ glyphs vanish entirely** from extraction: `Δp/Δt` comes out as `p`/`t`, and U+0394 appears nowhere in pages 58–64 despite the prose requiring it. This is a maths font with an encoding that yields no usable Unicode — so the character doesn't arrive garbled, it arrives *missing*, which is the failure mode you cannot detect downstream. Meanwhile matrix bracket glyphs (`⎡⎣⎢⎤⎦⎥`) *do* survive and would be read aloud as gibberish.

That combination — silent drops plus surviving junk — means equation regions cannot be sanitised by cleaning the string. They have to be **detected and skipped** as regions, which makes [[07]]'s announce-and-skip policy load-bearing rather than a nicety, and makes equation *detection* a correctness requirement rather than a polish item.

Measure this against the real corpus rather than assuming. Build a small harness that dumps the concatenated page string for corpus pages and answers:

- How often do words weld together, and does it correlate with particular books or fonts?
- Does `disableNormalization: true` improve or worsen matters — do we get real ligatures back, and does that then break `Intl.Segmenter` or TTS pronunciation?
- What do equations look like in the string? [[06]] asks whether they are text at all; this asks what garbage they contribute when they *are* text and land in the TTS input.
- Do hyphenated line-breaks appear as `-` plus a newline, and will TTS read them as two half-words?
- Is there residual damage that survives cleanup, and how much would a heuristic repair pass cost?

The output is a judgement on whether the string is usable as-is, needs a cleanup pass, or is bad enough to reshape the highlight/TTS design. Cheap to run, and it de-risks both [[05]] and [[06]].

## Answer
