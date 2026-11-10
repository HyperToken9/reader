# Research 44: Can Kokoro speak inside a Chrome extension, with word timings? (2026-11-10)

For [#44](https://github.com/HyperToken9/reader/issues/44) on the map [#43](https://github.com/HyperToken9/reader/issues/43).

**Method.** Primary sources: the Chrome extension docs, the onnxruntime-web docs, the `kokoro-js` 1.2.1 and `phonemizer` 1.2.1 npm tarballs (unpacked and read), the Hugging Face file listings (HF API), and espeak-ng's own repo. I also ran one quick throwaway measurement: onnxruntime-web's WASM backend, run in **Node**, on the same Kokoro graph Blitz ships. The script is [`44-checks/bench.mjs`](44-checks/bench.mjs). Labels:

- **[measured]**: run here.
- **[documented]**: quoted from a primary source.
- **[unknown]**: needs a prototype.

Third-party blog figures are flagged as low-trust.

**Test machine:** AMD Ryzen 7 5800H, 16 threads, Linux, Node 22.16, Google Chrome 157 installed. During the runs the machine was not idle: other sessions held the load average at 6 to 8. Absolute numbers carry that noise. The ratios between runs are the useful part.

---

## TL;DR

1. **Recommended route: the Node engine from [37](https://github.com/HyperToken9/reader/issues/37) as a Chrome native messaging host.** The extension's offscreen document plays the audio and keeps the word clock. Fully in-browser stays a prototype-gated upgrade, and only WebGPU could get there.
2. **In-browser WASM on CPU misses the bar, by a wide margin. [measured]** With onnxruntime-web 1.23.2 at 4 threads, on the same fp16 graph, **warm RTF is 0.95**. Native onnxruntime-node gets **0.385** at 4 threads in the same session. That makes WASM about 2.5x slower. The [27](https://github.com/HyperToken9/reader/issues/27) bar is RTF < ~0.6 on 4 cores. Single-threaded WASM is **RTF 2.39**, and that is what you get if cross-origin isolation is not in effect. The smallest build (q8f16, 86 MB) is *slower* on WASM: **RTF 1.52**.
3. **Durations are there, but not through `kokoro-js`.**
   - **The graphs carry them. [measured]** Both candidate graphs carry the duration output under onnxruntime-web: kokoro-onnx `model-files-v1.1` fp16 has `duration` (int64), and HF `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` has `durations` (float32), in every dtype.
   - **`kokoro-js` drops them. [documented]** Its `generate()` keeps only `waveform` and throws the rest away. So the in-browser route means driving onnxruntime-web directly, the way `engine.js` drives onnxruntime-node, not using `kokoro-js`.
4. **Phonemes are the second in-browser blocker.**
   - **`phonemizer` falls short.** `kokoro-js` uses the npm `phonemizer` (espeak-ng compiled to WASM). Prototype 17 measured it at **73% sentence parity** with Blitz's espeak-ng 1.52 path, because it exposes only espeak's trace-IPA mode and ships an older dictionary.
   - **Upstream espeak-ng's emscripten glue has the same limit. [documented]**
   - **The fix is unproven.** Parity would need our own emscripten build of 1.52 that exposes `espeak_TextToPhonemes`.
5. **Where it would run in MV3:**
   - **An offscreen document can host it.** It is a real DOM page, so it can use dynamic `import()`, Workers, AudioContext and, presumably, WebGPU.
   - **The service worker cannot.** It is killed after 30 s idle. Dynamic `import()` is disallowed there, and a service worker cannot spawn the Workers that WASM threads need. It is also not cross-origin isolated ("not fully implemented" per Chrome).
   - **CSP and storage are easy.** The needed CSP is `script-src 'self' 'wasm-unsafe-eval'`, which is Chrome's documented minimum. The model goes in Cache Storage or IndexedDB on the extension origin, with `unlimitedStorage`.
6. **Unknown until run:**
   - WebGPU speed and correctness in an offscreen document on this Linux Chrome, including whether the int64 `duration` output survives the WebGPU EP;
   - whether the offscreen document is actually `crossOriginIsolated`, so WASM threads work there;
   - real-Chrome WASM numbers, as opposed to Node's V8;
   - the offscreen `AUDIO_PLAYBACK` 30-second close when the reader pauses.

---

## 1. What "word timings from durations" means in Blitz

The Node engine on `dev` (`app/electron/speech/engine.js`) runs one ONNX session per window of up to 300 tokens:

```js
const out = await this.sess.run({ input_ids, style /*[1,256]*/, speed /*[1]*/ });
return [out.waveform.data, Array.from(out.duration.data, Number)];
```

`duration` gives frames per input token. `tokenEdges()` scales the cumulative frames to sample positions, which gives per-phoneme `[phoneme, start, end]`. `phonemeGroups()` splits those on the `' '` phoneme. `alignGroupsToWords()` then matches each group to a word by phoneme content (a difflib port). The engine **refuses a model without a `duration` output**, because the cursor would never move (`engine.js` `Kokoro.create`). The phonemes come from libespeak-ng **1.52** over FFI (koffi), byte-identical to kokoro-onnx on 206/206 sentences (prototype 17, finding A).

So the in-browser question has two parts:

- does the browser graph give per-token durations, under the same input names;
- can the browser produce *the same phonemes*?

## 2. Runtime and model builds

### `kokoro-js` (1.2.1, Apache-2.0, last published 2025-05-03) [documented]

- **Dependencies:** `@huggingface/transformers ^3.5.1` (the current Transformers.js is 4.3.2) and `phonemizer ^1.2.1`.
- **API:** `KokoroTTS.from_pretrained(model_id, { dtype: "fp32"|"fp16"|"q8"|"q4"|"q4f16", device: "wasm"|"webgpu"|"cpu" })`, from `types/kokoro.d.ts`.
- **WebGPU dtype:** the README says *"If using "webgpu", we recommend using dtype="fp32"."* fp32 is the 326 MB file.
- **No durations.** `dist/kokoro.js` `generate_from_ids` is:

  ```js
  const { waveform } = await this.model(inputs); return new RawAudio(waveform.data, 24e3);
  ```

  Durations, if the graph has them, are dropped. Using `kokoro-js` as-is gives no word cursor. Its sentence splitter and phonemizer are its own as well, which means different text handling from Blitz.

**Consequence:** use `onnxruntime-web` directly. The engine's `infer()` is a few lines and ports almost verbatim, since `ort.Tensor` and `InferenceSession.run` have the same shape in both packages. The rest of `engine.js`, the sliding window, pauses and alignment, is plain JS over Float32Arrays and needs no Node APIs. One exception: `loadVoices` uses `node:fs`, so in the browser it would read from an `ArrayBuffer` instead.

### Kokoro-82M ONNX builds and sizes [documented, from the HF API, 2026-11-10]

Both onnx-community repos are Apache-2.0. Sizes in bytes:

| file | `Kokoro-82M-v1.0-ONNX` | `Kokoro-82M-v1.0-ONNX-timestamped` |
|---|---|---|
| `model.onnx` (fp32) | 325,532,232 | 325,532,171 |
| `model_fp16.onnx` | 163,234,740 | 163,232,776 |
| `model_quantized.onnx` (q8) | 92,361,116 | 92,361,055 |
| `model_q8f16.onnx` | 86,033,585 | 86,072,942 |
| `model_uint8.onnx` | 177,464,632 | 177,464,571 |
| `model_uint8f16.onnx` | 114,209,226 | 114,182,909 |
| `model_q4.onnx` | 305,215,966 | 305,215,905 |
| `model_q4f16.onnx` | 154,586,422 | 154,584,426 |

Blitz already ships **kokoro-onnx `model-files-v1.1/kokoro-v1.0.fp16.onnx`** (163,527,961 bytes, sha256-pinned in `app/electron/speech/model.js`) and `voices-v1.0.bin` (28,214,398 bytes). That is ~192 MB in total.

### Do the browser builds still expose durations? [measured]

These were loaded in onnxruntime-web 1.23.2 (WASM EP) and run on a real token sequence of 43 ids:

| model | inputs | outputs | duration tensor |
|---|---|---|---|
| kokoro-onnx v1.1 fp16 (Blitz's) | `input_ids, style, speed` | `waveform, duration` | int64, len 43, `12,1,1,2,2,2…` |
| HF timestamped `model_fp16` | `input_ids, style, speed` | `waveform, durations` | float32, len 43, `12.41,1.06,1.14,2.00…` |
| HF timestamped `model_q8f16` | `input_ids, style, speed` | `waveform, durations` | float32, len 43, `12.37,1.05,1.15,2.00…` |

**The WASM build keeps the duration output.** The HF exports name it `durations` (plural) and return fractional float32. Prototype 17's `model_check.mjs` found that the rounded values match Blitz's export. Blitz's engine looks for `duration` and reads int64, so it would need a one-line rename-and-round to accept the HF files. The simplest choice is to keep Blitz's own fp16 file, which needs no change.

## 3. Speed

**Bar ([27](https://github.com/HyperToken9/reader/issues/27)):** RTF < ~0.6 on 4 cores, no crackle.

### Measured here [measured; onnxruntime-web WASM EP *running in Node*, not in Chrome]

These are the 6 `bench` sentences from prototype 17's corpus (37 to 218 characters), voice `bf_emma`, speed 1. Each sentence is one ONNX run (no sliding window, no pauses), over 2 passes. The RTF is taken from the second pass. "First run" is the first sentence (37 chars) right after the session loads.

| runtime | model | threads | warm RTF | first run | session create |
|---|---|---|---|---|---|
| onnxruntime-web 1.23.2 WASM | Blitz fp16 | 1 | **2.39** | 8.7 s | 2.3 s |
| onnxruntime-web 1.23.2 WASM | Blitz fp16 | 4 | **0.95** | 2.9 s | 2.5 s |
| onnxruntime-web 1.23.2 WASM | Blitz fp16 | 8 | 0.77 | 2.5 s | n/a |
| onnxruntime-web 1.23.2 WASM | HF timestamped fp16 | 4 | 0.94 | 3.0 s | 2.1 s |
| onnxruntime-web 1.23.2 WASM | HF timestamped q8f16 | 4 | **1.52** | 4.7 s | 1.9 s |
| onnxruntime-node 1.29 CPU | Blitz fp16 | 4 | **0.385** | 1.15 s | 1.3 s |
| onnxruntime-node 1.29 CPU | Blitz fp16 | 8 | 0.347 | 1.05 s | n/a |

The reference from [17](https://github.com/HyperToken9/reader/issues/17) is onnxruntime-node 1.23.2 at 8 threads, RTF 0.293, on an idle machine.

**What this shows:**

- **WASM is ~2.5x slower than native at the same thread count, and it misses the bar at 4 threads.** RTF 0.95 leaves almost no margin over playback.
- **The comparison is generous to WASM.** These are 4 *threads* on a 16-thread CPU, not a 4-core machine, so a real 4-core laptop would do worse.
- **Quantising does not help on WASM.** q8f16 is 60% slower than fp16, presumably because of the dequantise ops. Smaller downloads cost speed here.
- **Without threads, synthesis is 2.4x slower than playback.** Threads need cross-origin isolation (§4).
- **Time to first audio is long.** A cold start is roughly 2.5 s of session creation plus ~3 s for a short first sentence, about 5 to 6 s before any sound on WASM. That is before fetching the 163 MB model from storage.

**Caveat:** Node's V8 runs the same `.wasm` that Chrome would, but Chrome's own WASM numbers (worker scheduling, relaxed SIMD) are **[unknown]** until it runs in an offscreen document. I would expect them to be close, not better.

### WebGPU [unknown]

There is no first-party published RTF for Kokoro on WebGPU. The `kokoro-js` README and the HF model cards give no speed figures.

- **Low-trust third-party figures:** a third-party blog (offlinetts.pages.dev, "Browser TTS Showdown", 2026) gives Kokoro on WebGPU as "~1.5–2x realtime" on an M4 MacBook (RTF ~0.5 to 0.67), and on WASM as "0.8–1x". Its WASM figure agrees with the measurement above. Not usable as evidence for this machine.
- **The dev machine has an RTX 3060 Laptop GPU** ([27](https://github.com/HyperToken9/reader/issues/27)). Whether Chrome 157 on this Linux box exposes WebGPU by default (Vulkan/Dawn) is **[unknown]**. Linux WebGPU defaults have lagged Windows and macOS, and I could not find an authoritative current statement. `chrome://gpu` answers it in one look.
- **Two more questions only a run can answer:**
  - whether the **int64 `duration` output and the graph's random ops survive the WebGPU EP**, or fall back to CPU;
  - what fp16 sounds like there, given that the README recommends fp32 for WebGPU.
- **A GPU is a bonus, not the target.** [27](https://github.com/HyperToken9/reader/issues/27) settled that CPU-only is the target. Even a fast WebGPU path leaves CPU-only users on WASM at RTF ~1.

## 4. Where it runs in MV3

| context | can it host Kokoro? | why |
|---|---|---|
| **service worker** | **No** | It is terminated after "30 seconds of inactivity" and when "a single request … takes longer than 5 minutes" ([SW lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)). Dynamic `import()` is disallowed in `ServiceWorkerGlobalScope` by the HTML spec, and onnxruntime-web loads its `.mjs` glue that way. Transformers.js special-cases `ServiceWorkerGlobalScope` in `backends/onnx.js` for this reason. A service worker cannot construct a dedicated `Worker`, which Emscripten pthreads need, so it is single-threaded at best (RTF 2.39). It has no audio output. The official Transformers.js [browser-extension example](https://github.com/huggingface/transformers.js-examples/tree/main/browser-extension) does run models in a module service worker, but those are small classifiers, not 2.4x-slower-than-real-time TTS. |
| **offscreen document** | **Yes, the in-browser host** | It is "a hidden document" bundled with the extension, one per profile, available since Chrome 109 ([offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)). It has the full DOM, so dynamic `import()`, Workers, AudioContext, Cache Storage and IndexedDB all work. Only `chrome.runtime` is available as an extension API, so tab messaging goes through the service worker or a runtime port. Reasons: `AUDIO_PLAYBACK` ("close after 30 seconds without audio playing") and `WORKERS` (no lifetime limit). |
| extension page (popup, tab, side panel) | Technically yes | A popup dies when it closes, and a visible tab or side panel is UI the map doesn't want. |
| content script | No | It runs under the page's origin and rules. Its fetches "are subject to the same origin policy" even with host permissions ([network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)), and its WASM is subject to the page's CSP. |

**CSP [documented].** The MV3 default for extension pages is `script-src 'self'; object-src 'self';`. The minimum allowed is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';`, and that is what onnxruntime-web needs. Remote script is not allowed, so the ORT `.mjs` and `.wasm` files must be bundled and `env.wasm.wasmPaths` pointed at them ([manifest CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)). The Transformers.js example manifest uses exactly `"extension_pages": "script-src 'self' 'wasm-unsafe-eval'"`.

**Threads and SIMD:**

- **SIMD needs nothing.** The default onnxruntime-web WASM file is `ort-wasm-simd-threaded.wasm`.
- **Threads need cross-origin isolation.** onnxruntime-web enables multi-threading "only when the browser supports WebAssembly multi-threading and `crossOriginIsolated` mode is enabled". Its default thread count is "half of `navigator.hardwareConcurrency` or `4`, whichever is smaller" ([ORT env flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)).
- **The manifest keys exist.** An extension opts in with the `cross_origin_embedder_policy: {value: "require-corp"}` and `cross_origin_opener_policy: {value: "same-origin"}` keys. Chrome warns that "not all extension contexts will be cross-origin isolated" and that it is "not fully implemented" for service and shared workers ([cross-origin isolation](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation)).
- **[unknown]:** whether an *offscreen document* reports `crossOriginIsolated === true`. Without it the route is single-threaded at RTF ~2.4, which is dead on arrival.

**WebGPU in extensions [documented, partly].** Chrome 124 shipped WebGPU in service workers and shared workers, and the official extension sample uses it from a service worker. An offscreen document is an ordinary document, so `navigator.gpu` should exist there when the GPU and OS are supported. That is not separately documented. **[unknown]** on this Linux machine.

## 5. Phonemes in the browser

- **`kokoro-js` → npm `phonemizer` 1.2.1** (by Xenova, `"license": "Apache-2.0"`). It is a 1.3 MB single JS file with espeak-ng compiled in. **The espeak-ng code inside is GPL-3.0** whatever the wrapper's label says. That is irrelevant for one user loading unpacked, but it matters if this is ever distributed. Prototype 17 measured it against Blitz's libespeak-ng 1.52 path: **73% of sentences identical**. It only exposes espeak's trace-IPA mode, which stresses lone function words ("the" → ðˈə), and it carries an older dictionary. Alignment survived (0 of 4,032 groups moved words), but pronunciation changed, and timings moved by up to 200 ms.
- **espeak-ng's own emscripten glue** (`emscripten/espeakng_glue.cpp` on master; latest release 1.52.0, 2024-12-12) has the same limitation. Its `synth_ipa_` uses `espeak_SetPhonemeTrace` with IPA and a `' '` separator, not `espeak_TextToPhonemes` with the `'_'` separator that python-phonemizer, and so Blitz, use.
- **For parity**, build espeak-ng 1.52 with emscripten and our own two-function glue: `espeak_Initialize` plus `espeak_TextToPhonemes(…, phonememode = '_'<<8 | 0x02)`. Then run Blitz's `phonemize.js` post-processing over the result. The English-only data is 1.5 MB (prototype 17). This is **unproven work, not a download**. [unknown: build effort, and parity once built]

## 6. Model storage (in-browser route) [documented]

- The model goes on the **extension origin**: Cache Storage (Transformers.js's default), IndexedDB, or OPFS. All three are shared across "any extension pages … and offscreen documents" ([storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)).
- **The model survives clearing browsing data.** "Extension storage is not cleared when a user clears browsing data", and this "applies to any data stored using web storage APIs".
- **Quota:** default quota rules apply, and eviction under pressure is rare. **`"unlimitedStorage"` "affects both extension and web storage APIs and exempts extensions from both quota restrictions and eviction."** Ask for it: the model is 86 to 326 MB plus 28 MB of voices.
- **Persistence:** it survives browser restarts. It is lost when the extension is removed, and for an unpacked extension that includes removing it and loading it again.
- The download is ~192 MB on first play, as in [37](https://github.com/HyperToken9/reader/issues/37). The 28 MB `voices-v1.0.bin` is an uncompressed npz, which `loadVoices` already parses from bytes.

## 7. Audio out and the word clock (either route)

- **Play in the offscreen document** (reason `AUDIO_PLAYBACK`): Float32 PCM at 24 kHz goes into an `AudioBuffer` and is scheduled on one `AudioContext`, gapless, sentence after sentence.
- **The offscreen document owns the clock.** It knows each sentence's `AudioContext` start time and the word spans in seconds relative to it.
- **The content script paints.** It cannot read the offscreen `AudioContext` clock directly. So the offscreen document sends each sentence's word spans once, ahead of time, then sends cheap "sentence N started at `performance.now()` = t, rate r" and "paused at t" events. The content script runs its own `requestAnimationFrame` clock against those events. `performance.now()` is per-context, so the anchor should be wall time (`performance.timeOrigin + now()`). Messages route through `chrome.runtime` ports, since that is the only extension API the offscreen document has.
- **[unknown]:** the real message latency and drift between offscreen and content script, and whether that is visible at 1x.
- **[unknown]:** with `AUDIO_PLAYBACK` the document closes "after 30 seconds without audio playing", so a reader who pauses for longer may lose it. In the in-browser route that also throws away a loaded 163 MB session (2.5 s to recreate plus re-reading the model). Whether also listing `WORKERS` (no lifetime limit) keeps the document alive has to be tried. In the helper route a closed offscreen document only costs a few ms to re-create, because the model lives in the helper.

## 8. The helper route: reach the Node engine from 37

Both variants reuse `app/electron/speech/engine.js`, `phonemize.js` (koffi + libespeak-ng 1.52) and `model.js` as they are, so they keep **206/206 phoneme parity and native RTF** (0.385 at 4 threads measured here, ~0.29 at 8 threads per #17). The engine only has to be lifted out of the Electron `utilityProcess` into a plain Node entry point. It already uses only `node:` APIs, `ort-speech` (onnxruntime-node 1.23.2) and koffi.

### 8a. Chrome native messaging [documented]

- **Host manifest** (one JSON file) at `~/.config/google-chrome/NativeMessagingHosts/<name>.json` (Chromium: `~/.config/chromium/NativeMessagingHosts/`). Fields: `name`, `description`, `path` (absolute on Linux), `type: "stdio"` and `allowed_origins: ["chrome-extension://<id>/"]` ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)). `path` points at a small shell launcher: `#!/bin/sh` then `exec node /…/speech-host.mjs`.
- **Extension:** add the `"nativeMessaging"` permission, then call `chrome.runtime.connectNative(name)`. Chrome starts one host process and "keeps it running until the port is destroyed". **Connecting "will keep a service worker alive"** (Chrome 105+, SW lifecycle doc). So the service worker owns the port: no daemon, no open TCP port, and the host dies with the port.
- **Framing:** JSON, UTF-8, each message prefixed with a 32-bit length in native byte order. Max **1 MB per message host → Chrome** and 64 MiB Chrome → host.
- **The 1 MB cap means chunking audio.** A 10 s sentence is 240,000 samples. As float32 that is 960 KB, as int16 480 KB, and as int16 in base64 ~640 KB. Send int16 PCM base64 in chunks of ≤ ~256 KB, with the word spans in a small header message. The service worker relays to the offscreen document. The JSON and base64 overhead at this volume is negligible against synthesis time, but that is not measured.
- **Unpacked extension ID:** `allowed_origins` needs a stable ID. Chrome's docs say "Preserving a single ID is essential during development" and give the `"key"` manifest field as the way to pin it. Without a key, an unpacked extension's ID is derived from its directory path, so it stays stable as long as the folder doesn't move. That derivation is not stated on the page I read, so it is **[unverified]**.
- **Install story for one Linux user:**
  1. Load `extension/` unpacked and copy its ID, or pin it with `"key"`.
  2. Run one script that writes the host JSON into `~/.config/google-chrome/NativeMessagingHosts/` with the absolute launcher path and that ID.
  3. Have Node and the engine's `node_modules` present (`ort-speech`, `koffi`, plus `vendor/` libespeak-ng + data).
  4. The model downloads on first play into `~/.config/blitz/speech/` (or a new dir), as 37 does. The current user already has it there.

### 8b. localhost HTTP or WebSocket

- **The extension side is easy.** Add `host_permissions: ["http://127.0.0.1/*"]`, then fetch or open a WebSocket from the **offscreen document or service worker**. Those are extension origins, so the **page's CSP does not apply**. Do not fetch from the content script, which is held to the page's same-origin rules (§4). Binary streaming works (fetch body or WebSocket binary frames, with no 1 MB/base64 constraint). An active WebSocket also extends the service worker's lifetime (Chrome 116+).
- **The costs:**
  - **A long-running daemon.** It has to be started at login, for example with a systemd `--user` unit, or by hand.
  - **An open port.** Any web page can send requests to `127.0.0.1`, so the server must check the `Origin` header against the extension ID or require a token. Chrome's Private Network Access rules for localhost are still moving, and I did not verify their current state. **[unverified]**
- **Install story:** load unpacked, install a systemd user unit that runs `node speech-server.mjs`, and handle the port and token in config. That is more moving parts than 8a.

### Why native messaging over localhost

Chrome launches it, scopes it to the extension, and tears it down. There is no port, no daemon, no origin check and no autostart. The price is the 1 MB-per-message chunking and one JSON file to install, both small and documented. Localhost wins only if several browsers or apps must share one engine, which is out of scope on this map.

## 9. Recommendation

1. **v1: native messaging helper.** It is the Blitz Node engine as a stdio host, owned by the service worker, with audio and the word clock in the offscreen document.
   - **Why:**
     - **Speed:** it is the only route that clears the 4-core bar with margin (RTF ~0.39 at 4 threads).
     - **Parity:** it keeps espeak-ng 1.52 phoneme parity.
     - **No new model work:** it keeps the `duration`-based timings unchanged.
   - **Install:** one JSON file and Node.
2. **In-browser is not ruled out, but only WebGPU could make it viable, and it needs a prototype first.**
   - **WASM on CPU** is measured at RTF 0.95 with 4 threads, and 2.4 single-threaded. It fails the bar on a 4-core laptop, and q8 makes it worse.
   - **Two more costs come with any in-browser route:**
     - a custom espeak-ng 1.52 WASM build for phoneme parity;
     - dropping `kokoro-js` for raw onnxruntime-web.
3. **Suggested prototype ticket** (if in-browser is still wanted): an offscreen document that loads Blitz's fp16 graph through onnxruntime-web, built so it can answer:
   - **(a)** `crossOriginIsolated` and the thread count in the offscreen document;
   - **(b)** WASM RTF in real Chrome at 4 threads;
   - **(c)** `navigator.gpu` on this Linux Chrome 157, then the WebGPU RTF and time to first audio for fp32 and fp16, and whether `duration` comes back intact;
   - **(d)** whether the offscreen document survives a 60 s pause with `[AUDIO_PLAYBACK, WORKERS]`.

## 10. Still unknown until something runs

- WebGPU: availability on this Linux Chrome, speed, time to first audio, and whether the `duration` output survives the WebGPU EP.
- Whether an offscreen document is cross-origin isolated, so WASM threads work.
- WASM RTF in Chrome itself (measured here only in Node's V8).
- Offscreen document lifetime across long pauses with `AUDIO_PLAYBACK` (+ `WORKERS`).
- Offscreen → content-script word-clock latency and drift.
- Native messaging throughput with base64 PCM chunks, and the time to first audio including host process start. Node start, plus a 1.3 s session load, plus the first sentence, comes to about 2.5 s on a cold start, estimated from the native rows above. It is not measured end to end.
- Effort and parity for a custom espeak-ng 1.52 WASM build (only matters for in-browser).

## Sources

- Chrome: [offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [SW lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [manifest CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy), [cross-origin isolation](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation), [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), [storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies), [storage API](https://developer.chrome.com/docs/extensions/reference/api/storage), [manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key), [New in WebGPU 124](https://developer.chrome.com/blog/new-in-webgpu-124) (service-worker support).
- onnxruntime-web: [env flags and session options](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html), npm `onnxruntime-web@1.23.2` (run).
- `kokoro-js@1.2.1` npm tarball (`dist/kokoro.js`, `types/kokoro.d.ts`, `README.md`). `phonemizer@1.2.1` npm tarball.
- Hugging Face: [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), [onnx-community/Kokoro-82M-v1.0-ONNX-timestamped](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped), file sizes via `huggingface.co/api/models/<repo>/tree/main/onnx`.
- espeak-ng: [`emscripten/espeakng_glue.cpp`](https://github.com/espeak-ng/espeak-ng/blob/master/emscripten/espeakng_glue.cpp), release 1.52.0.
- Transformers.js: [browser-extension example](https://github.com/huggingface/transformers.js-examples/tree/main/browser-extension) (manifest CSP and service-worker host).
- Blitz: `app/electron/speech/{engine,model,phonemize}.js` on `dev`; prototype 17 README and `model_check.mjs` on `worktree-proto-17-node-speech`; research 11 (`.scratch/pdf-native-read-aloud/research/11-local-neural-tts.md`); tickets [17](https://github.com/HyperToken9/reader/issues/17), [27](https://github.com/HyperToken9/reader/issues/27), [37](https://github.com/HyperToken9/reader/issues/37).
- Low-trust, used only to show that no first-party figure exists: offlinetts.pages.dev "Browser TTS Showdown" (2026).
