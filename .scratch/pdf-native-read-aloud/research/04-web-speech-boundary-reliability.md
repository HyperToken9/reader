# Research — Web Speech API word-boundary reliability (2026-09)

For ticket `.scratch/pdf-native-read-aloud/issues/04-web-speech-boundary-reliability.md`.

Method: browser/engine **source code** and spec text as primary evidence wherever a behaviour could be
read off implementation; MDN `browser-compat-data` JSON (not the rendered page) for support claims;
bug trackers for known defects. Secondary write-ups are used only to locate primary sources, never as
the claim's authority. No live browser test was run — every empirical claim below is labelled
`[verify in spike]` where source reading cannot settle it.

---

## 0. What `src/content.js` already solved (do not re-derive)

Read `src/content.js:461-552`. Already handled there, correctly:

- Voice enumeration through `voiceschanged`, because `getVoices()` returns `[]` on first call in
  Chrome (`src/content.js:466-479`).
- Text split into fixed 220-word utterances, each carrying `base` (absolute word offset) and
  `starts[]` (per-utterance character offsets), so `e.charIndex` — which is **per-utterance** — is
  rebased to an absolute word index (`src/content.js:481-494, 511-517`).
- Ignoring non-`word` boundary names (`if (e.name && e.name !== 'word') return;`).
- Swallowing `error === 'interrupted'`, which is the normal consequence of `cancel()`.
- A 1400 ms watchdog: if no boundary has arrived, tell the user and switch to a flat
  `60000 / (170 * rate)` ms/word interval (`src/content.js:535-544`).
- A trailing `' '` utterance whose `onend` marks completion of the whole queue — a neat trick that
  survives the fact that per-chunk `onend` ordering is unreliable.

Everything in §4 onward is what remains **on top of** that.

---

## 1. The spec makes boundary events optional. This is the root of everything.

Web Speech API, `boundary` event
([spec](https://webaudio.github.io/web-speech-api/#eventdef-speechsynthesisutterance-boundary)):

> "Fired when the spoken utterance reaches a word or sentence boundary. **The user agent must fire
> this event if the speech synthesis engine provides the event.**"

The obligation is conditional on the engine. There is no conformance requirement that any engine
provide word boundaries, no way to require them at `speak()` time, and **no attribute on
`SpeechSynthesisVoice` that advertises them**. Attribute definitions
([spec](https://webaudio.github.io/web-speech-api/#dom-speechsynthesisevent-charindex)):

- `charIndex` — "the zero-based character index into the original utterance string that most closely
  approximates the current speaking position". Note *approximates*; index into **the utterance
  string**, i.e. per-utterance, not per-document.
- `charLength` — "the length of the text (word or sentence) that will be spoken corresponding to
  this event."
- `elapsedTime` — seconds since this utterance began speaking.

**Stale-guidance flag:** MDN's `charLength` page currently describes it as "the number of characters
*left to be spoken* after the character at `charIndex`"
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisEvent/charLength)). That
contradicts the spec and contradicts every implementation read below (all pass the *word's own*
length). Treat `charLength` as the length of the current word. MDN also badges `charLength` as
"Baseline widely available" — misleading, since it is only meaningful when a boundary event fires at
all, which is exactly what is not widely available.

---

## 2. Per-engine ground truth, read from source

This is the core of the report. Each row was established by reading the browser's own TTS platform
backend, not by testing.

| Browser | Platform | Backend | `word` boundary? | `charLength`? |
|---|---|---|---|---|
| Chrome / Edge | Windows | SAPI 5 (`tts_win.cc`) | **Yes** | **Yes** |
| Chrome / Edge | macOS | `AVSpeechSynthesizer` (`tts_mac.mm`) | **Yes** | **Yes** |
| Chrome / Edge | **Linux** | speech-dispatcher (`tts_linux.cc`) | **NO — never, any voice** | n/a |
| Chrome / Edge | *any* — "Google …" voices | Google Network Speech component ext. | **NO — never** | n/a |
| Chrome | Android | Android TTS bridge | **No** (crbug 40715888) | n/a |
| Firefox | Windows | SAPI (`SapiService.cpp`) | **Yes** | Yes |
| Firefox | macOS | `OSXSpeechSynthesizerService.mm` | **Yes** (buggy, §2.4) | Yes |
| Firefox | **Linux** | speech-dispatcher (`SpeechDispatcherService.cpp`) | **NO — never** | n/a |
| Firefox | Android | `SpeechSynthesisService.cpp` | **Yes** | Yes |
| Safari | macOS / iOS | `AVSpeechSynthesizer` (`PlatformSpeechSynthesizerCocoa.mm`) | **Yes** | **Yes** |
| Android WebView / Opera Android | — | — | **No** (`version_added: false` in BCD) | n/a |

### 2.1 Linux emits no word boundaries in any browser. Source-verified.

`content/browser/speech/tts_linux.cc` (Chromium main). The full set of events the Linux backend
declares per voice:

```
voice.events.insert(TTS_EVENT_START);
voice.events.insert(TTS_EVENT_END);
voice.events.insert(TTS_EVENT_CANCELLED);
voice.events.insert(TTS_EVENT_MARKER);
voice.events.insert(TTS_EVENT_PAUSE);
voice.events.insert(TTS_EVENT_RESUME);
```

There is no `TTS_EVENT_WORD` in the file at all — neither declared on a voice nor ever sent. The
`SendTtsEvent` call sites are `START`, `RESUME`, `END`, `PAUSE`, `CANCELLED`, `MARKER` only.
([source](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/speech/tts_linux.cc))

Firefox is the same, for the same reason — speech-dispatcher's notification set has no word event.
`dom/media/webspeech/synth/speechd/SpeechDispatcherService.cpp` handles exactly
`SPD_EVENT_BEGIN / END / PAUSE / RESUME / CANCEL / INDEX_MARK`, and `DispatchBoundary` is called only
from the Windows, macOS and Android backends — never the speechd one
([searchfox](https://searchfox.org/mozilla-central/search?q=DispatchBoundary&path=webspeech)).

**Consequence: on a Linux dev machine, no browser will ever produce word-boundary highlighting with
native TTS.** This is not a voice-selection problem and no voice install fixes it. It is a
speech-dispatcher protocol limitation both engines inherit.

### 2.2 Chrome's "Google …" voices emit no word events. Source-verified, and this is the detection key.

`chrome/browser/resources/network_speech_synthesis/manifest.json` — the component extension that
supplies every voice named "Google …". Every voice entry is literally:

```json
{ "event_types": [ "start", "end", "error" ],
  "lang": "en-US", "voice_name": "Google US English", "remote": true }
```

`word` is absent from `event_types` for **all** of them, and every one is `"remote": true`
([source](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/resources/network_speech_synthesis/manifest.json)).

Because `SpeechSynthesisVoice.localService` is `!remote`, this yields an **exact, free, up-front
test** on Chrome:

> `voice.localService === false` ⟹ that voice will emit zero boundary events.

`localService` is defined by spec as "whether the voice is supplied by a local speech synthesizer
service (`true`), or a remote one (`false`)"
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService)) and is
widely available. This is the single highest-value finding for the UI question in the ticket.

The same `remote` flag also governs Chrome's pause/resume/stop routing — `TtsControllerImpl::Pause`,
`Resume` and `StopCurrentUtterance` each branch on `IsUtteranceSpokenByRemoteEngine()`
([`tts_controller_impl.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/speech/tts_controller_impl.cc)),
which is why remote voices are also the ones with the flaky transport behaviour in §5.

The Chrome **extension** API does expose the full capability list — `TtsVoice.eventTypes`, "all of the
callback event types that this voice is capable of sending", with the docs warning that "some voices
may not support all event types, and some voices may not send any events at all"
([chrome.tts](https://developer.chrome.com/docs/extensions/reference/api/tts)). **The Web Speech API
does not expose this.** A web app gets only `localService` as a proxy. This is a genuine capability
the existing extension had and the app will not.

### 2.3 Windows and macOS are the good cases, and both populate `charLength`

Windows, `tts_win.cc` — subscribes to `SPFEI(SPEI_WORD_BOUNDARY)` and forwards both offset and
length:

```cpp
case SPEI_WORD_BOUNDARY:
  utterance_char_position_ = static_cast<size_t>(event.lParam) - utterance_prefix_length_;
  SendTtsEvent(utterance_id_, TTS_EVENT_WORD, utterance_char_position_,
               static_cast<ULONG>(event.wParam));
```

Note `- utterance_prefix_length_`: Chromium prepends SAPI XML for rate/pitch and subtracts it back
out, so `charIndex` is already relative to *your* string. No correction needed on our side.

macOS, `tts_mac.mm` — `data.events.insert(content::TTS_EVENT_WORD)` unconditionally for every local
voice, fed from the AVSpeechSynthesizer delegate. WebKit does the same in
`PlatformSpeechSynthesizerCocoa.mm`:

```
boundaryEventOccurred(utterance, SpeechBoundary::SpeechWordBoundary,
                      characterRange.location, characterRange.length);
```

So **Safari gets both `charIndex` and `charLength`** — the sentence-band + word-cursor design has
everything it needs on Apple platforms.

### 2.4 macOS `charIndex` is genuinely buggy at the OS level — and Chromium works around it, Firefox doesn't

Chromium's macOS delegate carries this filter, with the comment intact:

```objc
// Ignore bogus ranges. The Mac speech synthesizer is a bit buggy and
// occasionally returns a number way out of range.
if (characterRange.location > utterance.speechString.length ||
    characterRange.length == 0) {
  return;
}
```

Firefox has no equivalent guard, and the resulting user-visible defect is open to this day:
[bugzilla 1441503](https://bugzilla.mozilla.org/show_bug.cgi?id=1441503) (NEW, filed 2018, macOS only,
not reproducible on Windows) — after certain words, `charIndex` **freezes at a stale value** for
every subsequent boundary event, so highlighting stops advancing. Accented words shift the index by a
few characters. Also [bugzilla 1167543](https://bugzilla.mozilla.org/show_bug.cgi?id=1167543),
`charIndex` not adhering to spec.

**Design consequence:** never trust `charIndex` to be monotonic. Reject any boundary whose `charIndex`
is less than or equal to the previous one, or beyond the utterance length. Cheap, and it converts the
Firefox/macOS freeze from "highlight sticks and then lies" into "highlight stops advancing and the
watchdog notices".

### 2.5 Chrome Android: no. And BCD's headline entry is misleading.

BCD `api/SpeechSynthesisUtterance.json` → `boundary_event`:

```json
"chrome": { "version_added": "33", "partial_implementation": true,
            "notes": "The `boundary` event does not fire as expected. See [bug 40715888](https://crbug.com/40715888)." },
"chrome_android": "mirror",
"webview_android": { "version_added": false },
"opera_android":   { "version_added": false }
```

The open BCD issue [mdn/browser-compat-data#28419](https://github.com/mdn/browser-compat-data/issues/28419)
establishes that the `partial_implementation` flag on *desktop* Chrome is wrong: the linked crbug
"only mentions Android Chrome", and the reporter's CodePen "runs fine on current desktop Chrome; on
android, the boundary events fail to fire (no highlighting)". The proposed correction is desktop
Chrome full support, `chrome_android: false`. That matches the source reading in §2.3 and §2.1
exactly (desktop = Windows/macOS good, Linux bad, Android bad) — with the caveat that BCD has never
modelled the per-platform-backend split at all, which is why its Chrome row cannot be right.

**So: do not read "Chrome partially supports boundary" as "desktop Chrome is unreliable". Desktop
Chrome on Windows/macOS with a local voice is reliable. Desktop Chrome on Linux is 0%.**

---

## 3. Chrome's long-utterance failure — what it actually is

Two distinct, often-conflated problems.

**(a) The hard character cap.** `chrome.tts` documents a maximum of 32,768 characters per utterance
([chrome.tts](https://developer.chrome.com/docs/extensions/reference/api/tts)). This is not the one
that bites; 220 words is nowhere near it.

**(b) The ~15-second silent death.** [crbug 41346274](https://issues.chromium.org/issues/41346274),
"speechSynthesis fails for long text without warning **and blocks the API**" — synthesis "stops after
38 words … without triggering `onend` or `onerror`", and subsequently `speechSynthesis.speak()` stays
dead until browser restart. Still open. The community-standard reading is that the trigger is
*elapsed speaking time* (~15 s), not word count, and that it is concentrated on **non-local voices**.

That last point ties (b) back to §2.2: **the same `localService === false` test predicts both the
missing boundary events and the 15 s cut-off.** Avoiding remote voices avoids both.

The widespread workaround — `pause(); resume();` on a ~10-14 s timer — has a mechanical explanation
in the source. `TtsControllerImpl::Resume()` ends with:

```cpp
} else {
  SpeakNextUtterance();
}
```

i.e. a `resume()` with no current utterance kicks the queue. So the hack works by un-wedging a
stalled queue, not by resetting a timer.

**Is 220 words the right chunk size?** No — for two reasons, and the second is the important one:

1. It is the wrong *unit*. 220 words at ~170 wpm is ~78 s, five times past the ~15 s danger zone.
   If the cut-off is time-based, a word count is not a safe bound at all: it scales the wrong way
   with `rate` (a slow rate makes each chunk *longer* in seconds).
2. It cuts **mid-sentence**. `buildChunks()` slices `words` every 220 entries with no regard for
   punctuation (`src/content.js:481-494`). See §4.

**Recommendation:** chunk on sentence boundaries, target ~8-12 s of estimated audio per utterance
(roughly 1-3 sentences), and hard-cap at ~200 words as a backstop. This is below the 15 s threshold
by construction and aligns chunk edges with prosodic edges. It also makes the cadence fallback far
better (§6) and mid-read rate changes cheap (§5.3).

---

## 4. Chunk boundaries: what actually breaks

**`charIndex` is per-utterance, always.** Confirmed by spec wording ("into the original utterance
string") and by all three backends read above (Windows subtracts its own prefix; macOS/WebKit pass
`characterRange.location` into `utterance.speechString`). `content.js`'s `c.base + k` rebasing is the
correct pattern and transfers unchanged.

**Prosody does break at chunk edges.** Each `SpeechSynthesisUtterance` is an independent synthesis
request: the engine resets sentence-level intonation, applies terminal-declination to the last word,
and the queue inserts a scheduling gap between utterances. Splitting mid-sentence therefore produces
an audible stumble — a falling pitch and a pause in the middle of a clause. Splitting *at* a sentence
end hides the artefact inside a pause the listener expects anyway. **This alone justifies changing
the chunker for the reading app**, independent of the 15 s issue. `[verify in spike — measure the
inter-utterance gap on the target platform]`

**Queue-everything-up-front is the wrong shape here.** `content.js` calls `synth.speak()` for every
chunk immediately (`src/content.js:506-524`). For a whole textbook page that is fine; for a reading
app it means voice/rate changes and seek-to-word require a full `cancel()` + rebuild, and it maximises
exposure to the wedged-queue bug in §3. Prefer keeping **at most two** utterances in flight (current +
one prefetched, so there is no gap) and sequencing the rest on `end`.

---

## 5. Transport: pause / resume / cancel / backgrounding / rate

### 5.1 pause/resume

Desktop Chrome, Firefox, Safari: fine. BCD carries one explicit note, on **Android** (both Chrome
Android and Firefox Android): *"In Android, `pause()` ends the current utterance. `pause()` behaves
the same as `cancel()`."* So on Android, pause is destructive — a resume must be reimplemented as
"re-speak from the last known word".

`cancel()` per spec "removes all utterances from the queue; if an utterance is being spoken, speaking
ceases immediately". WebKit's implementation fires `speakingErrorOccurred()` synchronously and then
`canceled` events for the queued remainder. Practically: `cancel()` produces an `error` event with
`error === 'interrupted'` on the in-flight utterance, which `content.js` already swallows
(`src/content.js:518-519`) — keep that.

### 5.2 Tab backgrounding — the subtle one

Two separate behaviours, and getting them confused will produce a bug that only appears when the user
switches tabs.

- **Synthesis and boundary events keep running.** Audio is produced in the browser process (SAPI /
  AVSpeechSynthesizer / speech-dispatcher), not the renderer, and `boundary` delivery is an IPC
  message, not a page timer. A hidden tab keeps speaking and keeps receiving boundaries.
- **The cadence fallback stops working.** Chrome throttles chained `setTimeout`/`setInterval` in
  hidden pages to **once per second**, and after 5 minutes hidden to **once per minute**
  ([Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)).
  `requestAnimationFrame` stops entirely.

The documented exemption is a page that "has made noises in the past 30 seconds". **`speechSynthesis`
almost certainly does not count** — its audio does not go through the renderer's audio pipeline,
which is why Chrome shows no speaker icon on a tab that is speaking. `[verify in spike — this is the
one inference in this document I would most want tested, because if wrong it changes §6]`

**Consequence:** the estimated-cadence highlight degrades from "drifting" to "frozen, then jumping a
minute at a time" the moment the tab loses focus. It must be suspended on `visibilitychange` and
re-seeded on return, not left running.

This asymmetry is a real argument in favour of boundary events beyond accuracy: they are the only
timing source that survives backgrounding.

Also, iOS specifically: "on iOS, speech synthesis stops working when Safari is put into the
background" ([Apple Developer Forums](https://developer.apple.com/forums/thread/694847)).

### 5.3 Rate changes mid-utterance

`rate` is read by the engine when the utterance is dispatched; there is no path in any of the four
backends read above to mutate an in-flight synthesis. Mutating `utterance.rate` after `speak()` is a
no-op on the current utterance. On Chrome/Windows the rate is baked into the SAPI XML *prefix*
prepended to the text — the same `utterance_prefix_length_` seen in §2.3 — so it is fixed at
dispatch by construction.

Worse, `content.js` sets `u.rate = S.rate` on every chunk at build time
(`src/content.js:509`) but queues them all immediately, so a rate change applies to *nothing already
queued* — i.e. to nothing at all until the next `startTts()`.

**Recommendation:** a rate change must `cancel()` and re-`speak()` from the current word. With
sentence-sized chunks and only two utterances in flight, that is a sub-second, near-inaudible
re-dispatch. With 220-word chunks queued in bulk it is a visible restart. Another point for §3's
chunk-size change.

Boundary timing is not "corrupted" by rate — `charIndex` is a text offset, rate-independent — but the
**cadence fallback's** ms/word constant obviously is, and `content.js` does scale it
(`60000 / (170 * S.rate)`, `src/content.js:538`). Note the engines do not treat `rate` linearly
(Chromium's Linux backend maps it as `100 * log10(rate) / log10(3)`), so a linear scaling of the
fallback is itself an error source.

### 5.4 iOS: `speak()` silently does nothing outside a user gesture

WebKit's `SpeechSynthesis::speak()`:

```cpp
if (UserGestureIndicator::processingUserGesture())
    removeBehaviorRestriction(BehaviorRestrictionFlags::RequireUserGestureForSpeechStart);
else if (userGestureRequiredForSpeechStart())
    return;                       // <- silent. no error event, no start event.
```

The restriction is installed at construction when `document->requiresUserGestureForAudioPlayback()`
— i.e. on iOS
([source](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/speech/SpeechSynthesis.cpp)).
It is a bare `return`: no `error`, no `start`, nothing. Any "did it start?" watchdog must treat
"no `start` event within N ms" as a failure mode in its own right, distinct from "no `boundary`
event". This also means the boundary-capability probe in §7 cannot run speculatively on iOS — it must
be spent inside the user's first tap.

---

## 6. The cadence fallback: what it can and cannot carry

`content.js`'s model is a flat interval: every word gets `60000 / (170 * rate)` ms
(`src/content.js:535-544`). Two independent error sources:

**(a) Calibration error.** The 170 wpm constant is a guess. Real native voices span roughly 150-200
wpm at `rate = 1`. A 15% mismatch is typical.

**(b) Distribution error.** Every word gets the same time, but "the" and "photosynthesis" do not take
the same time to say, and a sentence-final period adds a pause the model does not know about.

(b) is bounded and self-correcting — it oscillates around the truth. **(a) is unbounded and
accumulates linearly.** Over one 220-word chunk (~78 s), a 15% rate error is ~12 s of drift, i.e. the
cursor ends up **20-30 words** away from the voice. That is not "degraded", it is actively
misleading — worse than no cursor.

Over a single sentence (~18 words, ~6.5 s), the same 15% error is ~1 s, i.e. **2-3 words**. Still too
loose for a word cursor, but comfortably inside a sentence band.

**Two improvements worth making, in priority order:**

1. **Re-seed at every chunk `end`.** You cannot know a chunk's duration in advance, but the moment its
   `end` fires you know its *true* duration and its character count exactly. Feed that back as the
   ms-per-character estimate for the next chunk. This converts unbounded linear drift into drift
   bounded by one chunk's length — the first chunk is guessed, every chunk after is calibrated. With
   sentence-sized chunks (§3) the re-sync happens every few seconds and (a) essentially disappears.
   This is the single biggest fallback improvement available and it costs almost nothing.
2. **Allocate time per character, not per word,** with multiplicative holds at punctuation. The pacer
   already in this repo does exactly this — `1.55×` on commas, `2.1×` on sentence ends
   (README, *Digital meta-guiding*). Reuse those constants; they were tuned for the same perceptual
   job.

Even improved, the honest position is:

> **The cadence fallback can carry the sentence band. It cannot carry the word cursor.**

So the fallback's real job is not "estimate word positions". It is: **detect that boundary events are
absent, tell the user plainly, drop the word cursor entirely, and run the sentence band off a
per-sentence re-seeded estimate.** A visibly coarser but honest highlight beats a word cursor that is
confidently wrong — and it degrades exactly the way the map's design already anticipates ("the band
… degrades gracefully when word sync drifts").

---

## 7. Detecting boundary support up front — yes, in three tiers

The ticket flags this as the UX-critical question. Answer: **yes, and it can be made essentially
free.**

**Tier 1 — static, zero cost, exact for the dominant failure case.**

```js
// Chrome: guaranteed no boundary events (network_speech_synthesis manifest, §2.2).
// Also the voices implicated in the ~15s cut-off (§3).
if (voice.localService === false) return 'none';
```

This one test removes the "Google …" voices, which are Chrome's *defaults* on many systems — i.e.
the most likely thing a user hits without intervention.

**Tier 2 — platform knockout, zero cost.** From §2.1 / §2.5, these are unconditional:

- Linux, any browser, any voice → no boundary events. Ever.
- Chrome on Android → no boundary events.
- Android WebView → no boundary events.

Worth encoding as a table, because on these platforms Tier 3's probe is pure wasted latency.

**Tier 3 — empirical probe, for everything Tiers 1-2 do not settle.** There is no declarative API
(`eventTypes` exists only on `chrome.tts`, §2.2), so the remaining question must be answered by
speaking:

```js
async function probeBoundary(voice) {
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance('one two three four');
    u.voice = voice; u.lang = voice.lang;
    u.volume = 0;          // inaudible
    u.rate = 2;            // ~0.5s
    let got = false;
    u.onboundary = e => { if (!e.name || e.name === 'word') got = true; };
    u.onend = () => resolve(got);
    u.onerror = () => resolve(false);
    setTimeout(() => resolve(got), 3000);   // engine never ended
    speechSynthesis.speak(u);
  });
}
```

Notes on making this actually work:

- `volume = 0` keeps it silent while still driving a real synthesis, so the engine's real event
  behaviour is exercised. `[verify in spike — confirm boundary events still fire at volume 0 on each
  target; a plausible failure is an engine short-circuiting silent synthesis]`
- Cost is ~0.5 s, once per voice. **Cache by `voice.voiceURI` + `navigator.userAgent` in
  `localStorage`** so it is paid once ever, not once per session.
- Run it when the user *selects* a voice, not at page load — probing 100+ system voices serially
  would take a minute.
- On iOS it must run inside the user's first tap (§5.4). Practical shape: on first play, probe, then
  immediately start the real utterance in the same gesture.
- Also treat "no `start` event within ~1.5 s" as `'none'` — that catches the silently-dropped case.

**Then the UI can do the thing the ticket asks for:** mark voices in the picker
(word-sync ✓ / sentence-only), default to a `word`-capable local voice, and if the user picks a
sentence-only voice say so *before* playback rather than degrading silently 1.4 s in.

Keep `content.js`'s runtime watchdog as well — but with the probe in front of it, it becomes a rare
safety net (catching e.g. the Firefox/macOS mid-paragraph freeze in §2.4) rather than the primary
mechanism. Its 1400 ms constant is also too tight as a primary detector at slow rates: the first word
of a chunk can legitimately take longer. Scale it, or better, key it off the `start` event rather
than off `speak()`.

---

## 8. What in `src/content.js` does *not* transfer to an app

The speech code itself is context-neutral — a content script runs `speechSynthesis` in the page's own
realm, so the API surface is identical. The dependencies that do not transfer are around it:

1. **`chrome.storage.local`** (`src/content.js:772`) for settings and the voice choice → `localStorage`
   / IndexedDB. Relevant here because the §7 probe cache wants exactly this.
2. **The manifest content-script stylesheet** (README: "Page rules come from a manifest content-script
   stylesheet, exempt from the page's CSP"). Gone. Not a loss — the app owns its own document and CSP,
   so ordinary `<style>` is fine. The shadow-root / `all: initial` isolation and the `<rl-*>` custom
   elements exist to survive a *hostile host page*; over our own PDF.js canvas none of that armour is
   needed, and the overlay should be plain DOM.
3. **`chrome.tts`'s `eventTypes`.** Not used by `content.js` today, but worth stating explicitly: the
   extension form factor *could* have queried per-voice capability declaratively. The app cannot, which
   is precisely why §7 needs a probe. This is a capability the move to an app **loses**.
4. **The error message.** `'The speech engine refused to start on this page.'`
   (`src/content.js:520`) is extension-shaped and will mislead in an app. Distinguish at minimum:
   `not-allowed` (missing user gesture — §5.4), `synthesis-unavailable` / empty `getVoices()`
   (Linux without speech-dispatcher installed — a first-class state on the likely dev machine),
   `language-unavailable`, and `interrupted` (ignore).
5. **The `chrome://` and built-in-PDF-viewer blocks** in the README stop applying — that is the point
   of the app. But note the replacement hazard: serve over `http://localhost`, not `file://`, or the
   PDF.js worker and module loading break independently of TTS.
6. Not extension-specific but load-bearing: `getVoices()` returns `[]` on the first call in Chrome.
   The `voiceschanged` handling at `src/content.js:466-479` must survive the port. In an app it also
   needs a timeout fallback, since `voiceschanged` never fires when there are genuinely no voices.

---

## 9. Recommendation

**Target for the prototype:** desktop **Chrome, Edge or Safari on macOS**, or **Chrome/Edge on
Windows**, with a **local** voice (`localService === true`). Those are the four combinations where
source reading says `word` boundaries and `charLength` are both delivered. macOS is the strongest —
Safari and Chrome share the same AVSpeechSynthesizer path, so one platform validates two browsers.

**Two traps to state plainly:**

- **Linux is a total dead end for word sync** (§2.1) — and this repo's development machine is Linux.
  Word-level sync **cannot be evaluated on the dev box** with native TTS. Any spike that needs to
  judge the word cursor has to run on macOS or Windows.
- **In Edge on Windows, the good-sounding voices are exactly the ones that don't work.** The
  "Microsoft … Online (Natural)" voices are remote; the local SAPI voices (David, Zira, Mark) give
  boundaries but sound a decade old. There is a real quality-vs-sync trade-off inside a single
  browser, and native TTS cannot escape it.

**What the fallback must cover** — five things, not one:

1. No boundary events at all (Linux, remote voices, Android) → sentence band only, word cursor off,
   said out loud in the UI.
2. Boundaries that start and then stop or freeze (Firefox/macOS, §2.4) → non-monotonic-`charIndex`
   rejection + a live watchdog, not just a start-up one.
3. `speak()` silently doing nothing (iOS without a gesture, §5.4) → "no `start` within N ms".
4. The wedged-queue / ~15 s cut-off (§3) → sentence-sized, time-bounded chunks; treat a missing
   `end` as a failure and re-dispatch.
5. Tab backgrounding freezing the estimator (§5.2) → suspend and re-seed on `visibilitychange`.

**Is native TTS good enough?** For the prototype's stated purpose — judging whether
audio-plus-highlight over a native PDF render works at all — **yes, conditionally**: on macOS or
Windows with a local voice, `charIndex` + `charLength` give everything the sentence-band + word-cursor
design needs, and the sync problem reduces to mapping a character offset onto a PDF.js text-layer
word, which is issue 02's problem and not TTS's.

**Does the cloud-TTS question need reopening?** Not the whole decision — but **one part of it, now**:

- Build the timing source as a **named seam** from the start: something that emits
  `{ wordIndex, atTime }` and nothing else, with three implementations — `BoundaryEventTiming`,
  `EstimatedCadenceTiming`, and a stub `TimestampTiming`. The overlay must not know which it is
  talking to. This is cheap now and expensive to retrofit, and it is what makes the cloud decision
  reversible rather than a rewrite.
- Reopen it **early** if either of these is true: (a) the prototype must be demoed or developed on
  Linux, where native word sync is structurally impossible; or (b) the local voices that *do* emit
  boundaries prove too unpleasant to listen to for the hours a textbook demands — which the map
  already lists as the trigger for the deferred "voice quality upgrade path", and which §9's Edge trap
  says is not avoidable by voice-shopping within native TTS.

The honest summary: **native TTS's boundary events are better than their reputation on
Windows/macOS with local voices, and completely absent everywhere else.** The risk to this prototype
is not that `onboundary` is imprecise. It is that the set of configurations where it exists at all is
narrow, does not include the development machine, and correlates negatively with voice quality.

---

## Sources

Primary — source code:
- [`content/browser/speech/tts_linux.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/speech/tts_linux.cc)
- [`content/browser/speech/tts_win.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/speech/tts_win.cc)
- [`content/browser/speech/tts_mac.mm`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/speech/tts_mac.mm)
- [`content/browser/speech/tts_controller_impl.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/speech/tts_controller_impl.cc)
- [`chrome/browser/resources/network_speech_synthesis/manifest.json`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/resources/network_speech_synthesis/manifest.json)
- [`third_party/blink/renderer/modules/speech/speech_synthesis.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/speech/speech_synthesis.cc)
- [WebKit `PlatformSpeechSynthesizerCocoa.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/cocoa/PlatformSpeechSynthesizerCocoa.mm)
- [WebKit `Modules/speech/SpeechSynthesis.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/speech/SpeechSynthesis.cpp)
- [Firefox `webspeech/synth` — `DispatchBoundary` call sites](https://searchfox.org/mozilla-central/search?q=DispatchBoundary&path=webspeech)
- [Firefox `SpeechDispatcherService.cpp`](https://searchfox.org/mozilla-central/source/dom/media/webspeech/synth/speechd/SpeechDispatcherService.cpp)

Primary — spec and compat data:
- [Web Speech API spec](https://webaudio.github.io/web-speech-api/)
- [BCD `api/SpeechSynthesisUtterance.json`](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/SpeechSynthesisUtterance.json)
- [BCD `api/SpeechSynthesis.json`](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/SpeechSynthesis.json)
- [MDN — `SpeechSynthesisVoice.localService`](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService)
- [MDN — `boundary` event](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/boundary_event)
- [MDN — `charLength`](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisEvent/charLength) *(contradicts spec — see §1)*
- [chrome.tts API reference](https://developer.chrome.com/docs/extensions/reference/api/tts)
- [Chrome timer throttling in background tabs](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)

Primary — bug trackers:
- [crbug 41346274 — speechSynthesis fails for long text and blocks the API](https://issues.chromium.org/issues/41346274)
- [crbug 40715888 — boundary event does not fire as expected](https://crbug.com/40715888)
- [bugzilla 1441503 — charIndex not updated after certain words (macOS)](https://bugzilla.mozilla.org/show_bug.cgi?id=1441503)
- [bugzilla 1167543 — charIndex does not adhere to the spec](https://bugzilla.mozilla.org/show_bug.cgi?id=1167543)
- [mdn/browser-compat-data#28419 — desktop Chrome boundary support](https://github.com/mdn/browser-compat-data/issues/28419)
- [mdn/browser-compat-data#6772 — Chrome Android onboundary doesn't work](https://github.com/mdn/browser-compat-data/issues/6772)
- [Apple Developer Forums — Web Speech API bugs, iOS 15.1 / Monterey](https://developer.apple.com/forums/thread/694847)
