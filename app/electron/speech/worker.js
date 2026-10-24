/*
 * The speech engine's own process: an Electron utilityProcess, forked by
 * electron/tts.js, which is the only thing that talks to it.
 *
 * Why a process of its own rather than the main process:
 *  - onnxruntime. Speech needs 1.23.2 and the layout model is on 1.29, and two
 *    versions of the native library cannot be loaded into one process.
 *  - Synthesis runs WHILE speech plays, on several cores. Here it cannot
 *    stall the main process's IPC, the renderer, or the audio thread.
 *
 * Messages in:  {id, op: "init", model, voices, espeakLib, espeakData, threads}
 *               {id, op: "synthesize", text, voice, speed}
 * Messages out: {id, ok: true, result} | {id, ok: false, error}
 */
import { Kokoro, toWav } from "./engine.js";
import { espeakBackend, makePhonemize } from "./phonemize.js";

let engine = null;

// The ONNX session runs one request at a time; anything else queues here.
let queue = Promise.resolve();

const ops = {
  async init({ model, voices, espeakLib, espeakData, threads }) {
    const phonemize = makePhonemize(await espeakBackend(espeakLib, espeakData));
    engine = await Kokoro.create({ model, voices, phonemize, threads });
    return { voices: engine.voiceNames() };
  },

  async synthesize({ text, voice, speed }) {
    if (!engine) throw new Error("speech engine not initialised");
    const { sr, audio, words, spans } = await engine.synthesize(text, voice, Number(speed ?? 1));
    return { sr, audio_b64: toWav(audio, sr).toString("base64"), words, spans };
  },
};

process.parentPort.on("message", ({ data }) => {
  const { id, op } = data;
  const run = queue.then(async () => {
    try {
      process.parentPort.postMessage({ id, ok: true, result: await ops[op](data) });
    } catch (e) {
      console.error(`[speech] ${op} failed:`, e);
      process.parentPort.postMessage({ id, ok: false, error: e?.message ?? String(e) });
    }
  });
  queue = run;
});
