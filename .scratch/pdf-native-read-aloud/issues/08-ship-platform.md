# 08 — What platform does the real app ship on?

Type: grilling
Status: open
Blocked by: 05, 06

## Question

Deliberately deferred at charting time, and blocked on both spikes — because how heavily the prototype leans on PDF.js internals, browser text-layer geometry and Web Speech API behaviour *is* the evidence this decision needs. Deciding it before the spikes would be guessing.

The candidates, with the concern each carries:

- **Web app / PWA** — the prototype grows up in place, no port. Best PDF.js and text-layer story by far. Weakest offline, install and mobile-reading story.
- **Electron (or Tauri)** — same web core, real desktop app, filesystem access, offline. Tauri is far lighter than Electron and worth considering alongside it. Neither gets you to mobile.
- **Flutter** — the only candidate that credibly reaches mobile *and* desktop from one codebase. But its PDF tooling is much rougher: getting per-word bounding boxes out of a Flutter PDF widget is a genuinely open question, and if the answer is bad, everything the spikes proved has to be rebuilt on worse foundations.
- **Native mobile** — best reading ergonomics on a tablet, which is arguably where textbook reading actually happens. Highest cost, one platform at a time.
- **Capacitor-wrapped web** — keeps the web core, reaches mobile app stores. Compromise on both ends.

[[10]] narrowed this: development and use are Linux-only, which removes macOS/Windows-first options from serious contention and weakens the mobile-reach argument that was Flutter's main draw. It also means any candidate must carry a TTS story that works without word-boundary events.

Decide against real weight: where does textbook reading actually happen for this user — desk, laptop, tablet? Does that override the porting cost? And how much of the spike work survives each choice?

Consult `grilling` and `domain-modeling`.

## Answer
