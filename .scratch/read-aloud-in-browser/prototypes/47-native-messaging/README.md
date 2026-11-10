# PROTOTYPE 47: the voice through native messaging, end to end

**Throwaway.** It answers [#47](https://github.com/HyperToken9/reader/issues/47): does Blitz's Node speech engine ([#37](https://github.com/HyperToken9/reader/issues/37)) work as a Chrome native messaging host behind an MV3 extension, and what does it cost? The results and verdict are in the comment on #47. Nothing here is production code.

## What is here

| path | what |
|---|---|
| `engine/` | `engine.js`, `phonemize.js`, `vocab.json`, copied verbatim from `app/electron/speech/` on `origin/dev` @ 489272f. `app/` is untouched. |
| `host/speech-host.mjs` | The native messaging host. It is a thin wrapper that runs the same init as `worker.js` and speaks length-prefixed JSON on stdio. Audio goes out as int16 PCM in base64 chunks of 4 s (256 KB per message, under Chrome's 1 MB cap), after a `start` message that carries `words` and `spans`. |
| `install.sh` | A one-command install of the host manifest and launcher. |
| `extension/` | The unpacked MV3 extension. Its `"key"` pins the ID to `agdejbojbbncecmipiedhfefmpkmcmba`. |
| `extension/background.js` | The service worker. It holds `connectNative`, relays audio to the offscreen document and word events to the tab, and owns the "Read from here" and "Stop reading" context menu items. |
| `extension/offscreen.js` | The offscreen document (`AUDIO_PLAYBACK`). It plays the audio on one `AudioContext`, with the chunks scheduled back to back. It also keeps the word clock: each span fires when `getOutputTimestamp()` says its first sample is being heard. |
| `extension/content.js` | Finds the clicked sentence (caret from point plus `Intl.Segmenter`) and the sentences after it, and logs each word as it fires (`[blitz] word "…"` in the page console). |
| `bench/` | The measurements: `host-direct.mjs` (the host without a browser), `reference.mjs` (the engine in-process), `browser.mjs` (headless Chrome driven over CDP) and `run-all.sh` (everything, under the shared bench lock). |
| `fetch-espeak.mjs` | `app/scripts/fetch-espeak.mjs`, pointed at `./vendor`. |

## Install (one Linux user, Google Chrome)

You need Node 20 or later on `PATH`, and the Kokoro weights in `~/.config/blitz/speech/`. Blitz downloads them the first time you press play; `BLITZ_SPEECH_DIR` overrides the location.

```sh
cd .scratch/read-aloud-in-browser/prototypes/47-native-messaging
./install.sh                 # npm install, espeak-ng 1.52, launcher, and the host manifest
                             # -> ~/.config/google-chrome/NativeMessagingHosts/dev.blitz.speech.json
# Chromium: ./install.sh --chromium
# A throwaway profile: ./install.sh --user-data-dir /path/to/profile
```

Then go to `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick `extension/`. The ID is `agdejbojbbncecmipiedhfefmpkmcmba` because of the pinned key, so the manifest's `allowed_origins` is right without editing. Right-click any paragraph and choose **Read from here**. To uninstall, run `./install.sh --uninstall`.

## Re-run the measurements

```sh
npm install
bench/run-all.sh                      # rtf exact ttfa passage survival idle ids
bench/run-all.sh ttfa passage         # or a subset
```

The browser runs are headless Chrome with `--mute-audio`, using a fresh `--user-data-dir` per launch under the job's tmp dir, with the host installed into `<user-data-dir>/NativeMessagingHosts/`. The extension goes in through CDP `Extensions.loadUnpacked`, because branded Chrome 137 and later ignores `--load-extension`.
