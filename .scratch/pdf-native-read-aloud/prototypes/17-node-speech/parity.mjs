/*
 * Question A: phonemizer parity against out/py_phon.json (the Python path).
 * node parity.mjs  -> out/parity.json + a summary on stdout
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { makePhonemize, ffiBackend, wasmBackend, cliBackend, VOCAB } from "./phon.mjs";
import { kokoroJsPhonemize } from "./kokorojs_phon.mjs";

const ref = JSON.parse(readFileSync(new URL("./out/py_phon.json", import.meta.url)));
const SP = homedir() + "/.local/share/blitz-tts/venv/lib/python3.10/site-packages/espeakng_loader";
const APT = new URL("./dl/apt/root/usr/", import.meta.url).pathname;
const vocabOnly = (s) => [...s].filter((c) => c in VOCAB).join("").trim();

const variants = {};
const ffi = await ffiBackend(SP + "/libespeak-ng.so", SP + "/espeak-ng-data");
variants["ffi-1.52 (bundled lib, same as python)"] = makePhonemize(ffi.raw);
const wasm = await wasmBackend();
variants["wasm + python-phonemizer port"] = makePhonemize(wasm.raw);
// What a naive caller of the npm package gets: whole text, lines joined
variants["wasm raw (npm phonemize, no punct handling)"] = async (t) =>
  vocabOnly((await wasm.npm(t.trim(), "en-us")).join(" "));
variants["kokoro-js phonemize()"] = async (t) => vocabOnly(await kokoroJsPhonemize(t, "a"));
const cliEnv = { ...process.env, LD_LIBRARY_PATH: APT + "lib/x86_64-linux-gnu", ESPEAK_DATA_PATH: APT + "lib/x86_64-linux-gnu" };
const cli = cliBackend(APT + "bin/espeak-ng", cliEnv);
variants["system espeak-ng 1.50 CLI + port"] = makePhonemize(cli.raw);
console.error("ffi espeak version:", ffi.version, "| cli:", cli.version);

const summary = {};
const diffs = {};
for (const [name, ph] of Object.entries(variants)) {
  let sOk = 0, wOk = 0, wN = 0, wOkNoSpace = 0, sOkNoStress = 0;
  const ex = [];
  const t0 = performance.now();
  for (const r of ref) {
    const got = " " + "" ; // placeholder to keep shape obvious
    const s = (await ph(r.text)).split(/\s+/).join(" "); // Kokoro._prepare
    if (s === r.sent) sOk++;
    else ex.push({ id: r.id, kind: "sent", text: r.text, py: r.sent, js: s });
    const strip = (x) => x.replace(/[ˈˌ]/g, "");
    if (strip(s) === strip(r.sent)) sOkNoStress++;
    for (const [w, pw] of r.words) {
      wN++;
      const jw = await ph(w);
      if (jw === pw) wOk++;
      else ex.push({ id: r.id, kind: "word", text: w, py: pw, js: jw });
      if (jw.replace(/ /g, "") === pw.replace(/ /g, "")) wOkNoSpace++;
    }
  }
  const ms = performance.now() - t0;
  summary[name] = {
    sentences: `${sOk}/${ref.length} (${((100 * sOk) / ref.length).toFixed(1)}%)`,
    sentencesIgnoringStress: `${sOkNoStress}/${ref.length}`,
    words: `${wOk}/${wN} (${((100 * wOk) / wN).toFixed(2)}%)`,
    wordsAsAligned: `${wOkNoSpace}/${wN} (${((100 * wOkNoSpace) / wN).toFixed(2)}%)`,
    ms: Math.round(ms),
  };
  diffs[name] = ex;
  console.error(name, summary[name]);
}
writeFileSync(new URL("./out/parity.json", import.meta.url), JSON.stringify({ summary, diffs }, null, 1));
console.log(JSON.stringify(summary, null, 1));
