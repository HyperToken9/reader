# 04 — How reliable are Web Speech API word-boundary events in 2026?

Type: research
Status: open

## Question

Sync accuracy depends entirely on `SpeechSynthesisUtterance`'s `onboundary` events firing, and firing with usable character offsets. This repo's own Reading Lenses README already records that some voices emit no boundary events at all, forcing an estimated-cadence fallback — establish how bad this really is before the sync design leans on it.

Start by reading `src/content.js` in this repo, which contains a working `speechSynthesis` + `onboundary` → word-mapping implementation with 220-word utterance chunking and a cadence fallback. Understand what it already solved, then research what remains:

- Current cross-browser and cross-platform state of `onboundary`: Chrome, Edge, Safari, Firefox, on macOS/Windows/Linux. Which voice families (local OS voices vs. remote/network voices) emit `word` boundary events, and which emit nothing? Is `charIndex` reliable, and is `charLength` populated?
- Chrome's long-utterance behaviour — the documented habit of silently dropping utterances past a length threshold. What is the actual limit, is it still present, and is ~220 words the right chunk size?
- What breaks at chunk boundaries: does splitting text into utterances audibly distort prosody, insert pauses, or misreport `charIndex` (per-utterance vs. absolute)?
- `pause()` / `resume()` / `cancel()` reliability, and behaviour on tab backgrounding — does synthesis keep running, and do boundary events keep arriving, when the tab isn't focused?
- Rate changes: does altering `rate` mid-utterance work, and does it corrupt boundary timing?
- If boundary events are absent for a voice, what is the best estimated-cadence model — and how badly does it drift over a paragraph?
- Is there a way to *detect* up front, before playback, whether a selected voice will emit boundary events, so the UI can steer the user to a working voice rather than degrading silently?

Report which voices/browsers to target for the prototype and what the fallback must cover.

## Answer
