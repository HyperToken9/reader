# 16 — Kokoro reading loop (THROWAWAY PROTOTYPE)

Answers one question: **what does a word cursor look like inside variant C's
punched-out spotlight, without breaking the calm that made it win?**

Not production code. No tests, no persistence, minimal error handling. The
ticket is `../issues/16-kokoro-reading-loop.md`.

## Run it (two processes)

```sh
# 1. the Kokoro sidecar — synthesizes audio + word timings
npm run server        # = ./run_server.sh, uses the venv from tickets 11/14

# 2. the app itself
npm install
npm run dev
```

Then drop a textbook PDF onto the page, pick a Kokoro voice, and press
**Play**. Space also plays/pauses. If the sidecar isn't running you'll see
the error surfaced in the **State** panel rather than silence.

### Rebuilding the venv

The sidecar expects `/tmp/claude-1000/tts/venv` (built for ticket 11) with
`kokoro-onnx`, `onnxruntime`, and `/tmp/claude-1000/tts/kokoro/kokoro-timestamped-fp16.onnx`
(ticket 14's `-timestamped` export, not the plain 325 MB one — the plain
export has no `durations` output at all). If that venv is gone: `pip install
kokoro-onnx onnxruntime`, then re-run the export script from ticket 11's
research branch to regenerate the fp16 timestamped model.

## What to drive, and what to look for

| Control | Judges |
| --- | --- |
| The **second, amber floating bar** (`c`, or `?cursor=`) | **The word cursor style itself** — this ticket's actual question. `dim` / `underline` / `tint` / `off`. Only visible inside variant C (spotlight); switching to A/B hides it, since [[05]]'s tint/underline bands have no "inside" to nest a cursor in. |
| The first floating bar (`←`/`→`, or `?variant=`) | Still [[05]]'s band-style judgement. Kept for A/B comparison against the word-cursor-bearing C. |
| **Native speed** | Kokoro's own `speed` — better-sounding, pitch-preserved, but re-synthesizes. Takes effect from the *next* not-yet-fetched sentence, not the one playing (see "What's simplified" below). |
| **Playback rate (live)** | `audio.playbackRate` + `preservesPitch` — instant, no gap, and the word cursor stays correct because every span scales by the same constant. Judge whether this feels different from Native speed. |
| **Voice** | Fetched live from the sidecar's `/voices` — all 54 Kokoro voices, not just the 7 sampled in ticket 14. Defaults to `bf_emma`. |
| **State** panel | Sentence position, active word index/indices, sentences-spoken count and mean time, and how many sentences are currently prefetched. |

Also worth judging, per the ticket: does the voice hold up over a **chapter**,
not just a paragraph — and is the ~1-in-25 double-width highlight (below)
actually noticeable in use, or invisible the way the ticket predicted.

Clicking a sentence in the list or **on the page itself** starts playback there.

## Mechanism

- **Geometry, spotlight, page rendering**: unchanged from [[05]]. Word-level
  geometry is new: `buildSentences` now also slices each sentence's raw text
  on `\S+` and runs the *same* Range → `getClientRects()` pipeline per word,
  stored as `sentence.words[i].rects`.
- **Synthesis**: `server.py`, a ~200-line stdlib `http.server` (no Flask in
  the venv, and this is one route). `POST /synthesize {text, voice, speed}`
  returns a WAV (base64) plus `spans: [{start, end, words: [idx,...]}]` —
  phoneme groups aligned to word indices.
- **Playback**: one `<audio>` element. `speakOne()` fetches (or reuses a
  prefetch of) the sentence's synthesis, sets `audio.src` to a blob URL, and
  plays. `audio.onended` chains to the next sentence — exactly [[10]]'s
  one-sentence-per-unit invariant, now driven by a DOM event instead of
  `SpeechSynthesisUtterance.onend`.
- **Word cursor**: `requestAnimationFrame` reads `audio.currentTime`, binary
  searches the sentence's `spans` (already time-ordered), and repaints only
  when the active word index set changes.
- **Prefetch**: the sentence *after* the one now playing is fetched as soon
  as the current one starts, cached by `"pn:si"`. This is deliberately a
  1-sentence lookahead, not the ticket's general "N seconds ahead" — see
  below.

## The alignment problem, and why counting groups doesn't work

[[11]] and this ticket both warned that Kokoro's phoneme groups and
orthographic words disagree in both directions in the same sentence: espeak
cliticises function words (`"on the"` → one group) and expands numbers
(`"55"` → `"fifty five"`, one word → two groups). An early version of
`align_groups_to_words` tracked a running count of "groups owed" and merged
whenever the tally ran short — **and it was wrong**: because the corpus-wide
deficit from cliticisation is spread across the whole sentence, a global
running-count check goes negative from word one, so it merges the *first*
two words of every sentence regardless of where the real merge is.

The fix, in `server.py`, drops counting entirely. It phonemizes every word
**alone** (reproducing number expansion, which needs no neighbour, but not
cliticisation, which does) and diffs the concatenation of those against the
concatenation of the real per-group phonemes with `difflib.SequenceMatcher`.
Matching blocks recover, per group, which word(s) actually contributed
characters to it — content, not count. Verified on
`"There are 55 cats in the house."`:

```
0.078-0.139  The
0.190-0.431  cat
0.493-0.706  sat
0.753-0.902  on, the        <- cliticised: one group, two words
0.952-1.601  mat.
1.650-1.861  There, are     <- cliticised
1.911-2.165  55             <- number expansion: two groups, same word
2.215-2.472  55
2.523-2.808  cats
2.838-2.977  in, the        <- cliticised
3.027-3.499  house.
```

Every word lands on the right span; the only imprecision is the predicted
one — three cliticised pairs light up together, exactly [[11]]'s ~1-in-25 and
never a wrong word.

## What's simplified relative to the ticket, on purpose

This is a prototype whose job is to answer the cursor-design question, not
to ship the buffer manager:

- **Buffer depth is "3 sentences ahead," not "N seconds ahead."** The ticket
  asks for a memory-bounded, seconds-based queue; a fixed sentence count is
  a stand-in for that. It's driven from the playback cursor
  (`prefetchAhead`, called from `speakOne`), not from what's merely scrolled
  into view — an earlier version prefetched from `renderPage` instead, which
  meant *scrolling* a long document (never mind reading it) queued audio for
  every page that passed the viewport, backed up behind whatever was already
  synthesizing. A real build should still do the seconds-based version.
- **The synthesis queue runs one request at a time.** Measured directly:
  the sidecar pins each ONNX session to every CPU thread, so two requests in
  parallel *oversubscribe* the machine and both get slower — a cold click
  went from ~2-4s to 6-8s with two workers. A priority queue (`ensurePrefetch`
  / `pumpFetchQueue`) still lets an explicit `play()` cut ahead of background
  reader-ahead, just onto a single worker instead of two contending ones.
- **Per-word geometry is computed lazily, not at page-render time.** An
  earlier version ran a DOM `Range` + `getClientRects()` per word for every
  sentence the moment a page rendered — including pages that only scrolled
  into view and were never going to be read. That's a forced synchronous
  layout reflow per word, hundreds of them per page; fast-scrolling a long
  document visibly stalled. `getWordRects()` now computes and caches a
  sentence's word boxes only once it's about to speak.
- **The playback unit is exactly one `Intl.Segmenter` sentence — never
  smaller.** An earlier version of this prototype additionally split long
  sentences at clause punctuation (commas, semicolons) to shorten synth
  latency per click. That was wrong: it produced subtitle-style fragments
  cut mid-sentence ("In the two thousand years since Herodotus," / "various
  forms of steganography have been used…" as two separate spoken units),
  which reads and sounds worse than a long sentence read whole. Reverted —
  latency is addressed by prefetching ahead of the reading position, not by
  cutting the unit smaller. `guardSentenceBoundaries()` is the one thing
  kept from that detour: it catches the opposite failure, where
  `Intl.Segmenter` itself treats two real sentences (an abbreviation, an
  odd quotation pattern) as a single segment, and splits there. It has not
  found a real case in this corpus — it's a guard against a failure mode,
  not a fix for an observed one.
- **Changing Native speed does not resynthesize what's already prefetched
  or playing.** It only affects sentences not yet fetched. The ticket
  accepted a gap on baseline-speed changes; this prototype accepts a
  *longer* one (up to a sentence) rather than building the interrupt-and-
  resync path, since judging the cursor doesn't need it.
- **The PyTorch word-level timestamp path ([[11]]'s alternative to phoneme
  grouping) was not evaluated.** The difflib alignment above turned out
  cheap enough — one call to `tokenizer.phonemize` per word, on top of audio
  that's already being synthesized — that pulling in `torch` never became
  necessary. Worth remembering if a real build hits a corpus where this
  alignment misbehaves.
- **No watchdog, no stall detection beyond `audio.onerror`.** [[05]]'s
  wedged-queue guard existed because `speechSynthesis` silently stops
  delivering events on Linux; `<audio>`'s `ended`/`error` events don't have
  that failure mode, so the guard was dropped rather than ported. If a real
  build sees stalls, look at network/CORS first, not drift.
- **The known desync between per-word geometry and the server's word list**
  (README's other doc comment, in `main.js`): a run of unmapped equation
  glyphs with no surrounding whitespace collapses to one space in
  `.speech`, splitting what was one word into two there while `buildSentences`
  still sees it as one. Rare — equation-bearing sentences are the corpus's
  minority per [[09]]/[[15]] — and not fixed here, since it's the same
  equation-handling gap [[06]]/[[07]] already own.

## Verdict

See the ticket's `## Answer` for the recorded judgement on which cursor
style won and why.
