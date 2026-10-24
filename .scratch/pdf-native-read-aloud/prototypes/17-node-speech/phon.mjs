/*
 * A line-for-line JS port of what kokoro-onnx's Tokenizer.phonemize() does:
 *   phonemizer.phonemize(text, "en-us", preserve_punctuation=True, with_stress=True)
 *   (python phonemizer 3.x: Punctuation.preserve -> EspeakBackend per chunk ->
 *    _postprocess_line -> Punctuation.restore -> "\n".join)
 *   then keep only vocab characters, then strip.
 * The espeak call itself is pluggable (`raw(chunk)` returns espeak_TextToPhonemes
 * output for one chunk, '_' phone separators, clauses joined by ' ').
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const VOCAB = JSON.parse(
  readFileSync(new URL("./vocab.json", import.meta.url), "utf8"),
);

// _DEFAULT_MARKS = ';:,.!?¡¿—…"«»“”(){}[]', decimals ',.' only when not next to a digit
const MARKS_RE =
  /(\s*(?:[;:!?¡¿—…"«»“”(){}\[\]]|(?<![0-9])[,.]|[,.](?![0-9]))+\s*)+/gu;

function preserveLine(line) {
  const matches = [...line.matchAll(MARKS_RE)];
  if (!matches.length) return [[line], []];
  if (matches.length === 1 && matches[0][0] === line) return [[], [{ mark: line, pos: "A" }]];
  const marks = matches.map((m, i) => {
    let pos = "I";
    if (i === 0 && line.startsWith(m[0])) pos = "B";
    else if (i === matches.length - 1 && line.endsWith(m[0])) pos = "E";
    return { mark: m[0], pos };
  });
  const out = [];
  for (const { mark } of marks) {
    const at = line.indexOf(mark);
    out.push(at < 0 ? line : line.slice(0, at)); // python: split(mark)[0]
    line = at < 0 ? "" : line.slice(at + mark.length);
  }
  out.push(line);
  return [out, marks];
}

function restore(text, marks) {
  // single input line, sep.word = ' ', strip = False
  text = [...text];
  marks = [...marks];
  const res = [];
  while (text.length || marks.length) {
    if (!marks.length) {
      for (let l of text) res.push(l.endsWith(" ") ? l : l + " ");
      text = [];
    } else if (!text.length) {
      res.push(marks.map((m) => m.mark).join("")); // re.sub(' ', ' ', ...)
      marks = [];
    } else {
      // all marks are index 0 and pos stays 0 until an E/A, which python
      // handles identically for one line; index==pos is always true here
      const m = marks.shift();
      const mark = m.mark;
      if (text[0].endsWith(" ")) text[0] = text[0].slice(0, -1);
      if (m.pos === "B") text[0] = mark + text[0];
      else if (m.pos === "E") {
        res.push(text[0] + mark + (mark.endsWith(" ") ? "" : " "));
        text = text.slice(1);
      } else if (m.pos === "A") {
        res.push(mark + (mark.endsWith(" ") ? "" : " "));
      } else if (text.length === 1) text[0] = text[0] + mark;
      else {
        const first = text.shift();
        text[0] = first + mark + text[0];
      }
    }
  }
  return res;
}

function postprocessLine(line) {
  line = line.trim().replace(/\n/g, " ").replace(/  /g, " ");
  line = line.replace(/_+/g, "_").replace(/_ /g, " ");
  if (!line) return "";
  let out = "";
  for (let w of line.split(" ")) out += w.trim().replace(/_/g, "") + " ";
  return out;
}

const pyStrip = (s) => s.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/gu, "");

/** `raw(chunk)` -> espeak phoneme string; may be async. */
export function makePhonemize(raw) {
  return async function phonemize(text) {
    text = pyStrip(text); // Tokenizer.normalize_text
    const lines = text.split("\n").map((l) => l).filter((l) => l.trim());
    const outLines = [];
    for (const line of lines) {
      let [chunks, marks] = preserveLine(line);
      chunks = chunks.filter(Boolean);
      const ph = [];
      for (const c of chunks) ph.push(postprocessLine(await raw(c)));
      outLines.push(...restore(ph, marks));
    }
    const joined = outLines.join("\n");
    return pyStrip([...joined].filter((ch) => ch in VOCAB).join(""));
  };
}

/* ---------- backend 1: libespeak-ng via FFI (koffi) ---------- */
export async function ffiBackend(libPath, dataPath, voice = "gmw/en-US") {
  const koffi = (await import("koffi")).default;
  const lib = koffi.load(libPath);
  const init = lib.func("int espeak_Initialize(int, int, const char *, int)");
  const setVoice = lib.func("int espeak_SetVoiceByName(const char *)");
  const t2p = lib.func(
    "const char *espeak_TextToPhonemes(_Inout_ void **textptr, int textmode, int phonememode)",
  );
  const info = lib.func("const char *espeak_Info(_Out_ const char **path)");
  if (init(0x02, 0, dataPath, 0) <= 0) throw new Error("espeak init failed");
  if (setVoice(voice) !== 0) throw new Error("voice " + voice);
  const version = info([null]);
  const mode = ("_".codePointAt(0) << 8) | 0x02;
  return {
    version,
    raw(text) {
      const bytes = Buffer.from(text + "\0", "utf8");
      const mem = koffi.alloc("char", bytes.length);
      koffi.encode(mem, "char", [...bytes].map((b) => (b > 127 ? b - 256 : b)), bytes.length);
      const box = [mem];
      const res = [];
      while (box[0] !== null) {
        const p = t2p(box, 1, mode);
        if (p) res.push(p);
      }
      koffi.free(mem);
      return res.join(" ");
    },
  };
}

/* ---------- backend 2: npm `phonemizer` (espeak-ng WASM, kokoro-js) ---------- */
export async function wasmBackend() {
  const { phonemize } = await import("phonemizer");
  return {
    version: "npm phonemizer (WASM)",
    // it returns one string per clause line, no '_' separators
    raw: async (text) => (await phonemize(text, "en-us")).join(" "),
    npm: phonemize,
  };
}

/* ---------- backend 3: an espeak-ng CLI binary ---------- */
export function cliBackend(bin, env) {
  return {
    version: spawnSync(bin, ["--version"], { env, encoding: "utf8" }).stdout.trim(),
    raw(text) {
      const r = spawnSync(bin, ["-q", "--ipa", "--sep=_", "-v", "en-us", "--", text], {
        env,
        encoding: "utf8",
      });
      return r.stdout.split("\n").filter((l) => l.trim()).map((l) => l.trim()).join(" ");
    },
  };
}
