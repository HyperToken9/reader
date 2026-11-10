/*
 * Text -> phonemes, exactly as kokoro-onnx's Tokenizer.phonemize() did it:
 *
 *   phonemizer.phonemize(text, "en-us", preserve_punctuation=True, with_stress=True)
 *   (python-phonemizer 3.x: Punctuation.preserve -> espeak per chunk ->
 *    _postprocess_line -> Punctuation.restore -> "\n".join)
 *   then keep only vocab characters, then strip.
 *
 * The espeak underneath is libespeak-ng 1.52 -- the same build kokoro-onnx
 * loads through espeakng-loader -- called through koffi. Prototype 17 measured
 * this at 206/206 sentences and 3969/3969 words byte-identical to the Python
 * path. The npm `phonemizer` package (espeak compiled to WASM) is NOT a
 * substitute: it only exposes espeak's trace-IPA mode and an older dictionary,
 * and matched 73% of sentences.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const VOCAB = require("./vocab.json");

// python-phonemizer's _DEFAULT_MARKS = ';:,.!?¡¿—…"«»“”(){}[]'; a ',' or '.'
// next to a digit is part of a number, not punctuation.
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
  // One input line, sep.word = ' ', strip = False.
  text = [...text];
  marks = [...marks];
  const res = [];
  while (text.length || marks.length) {
    if (!marks.length) {
      for (const l of text) res.push(l.endsWith(" ") ? l : l + " ");
      text = [];
    } else if (!text.length) {
      res.push(marks.map((m) => m.mark).join(""));
      marks = [];
    } else {
      // With a single line every mark is at index 0, and python's
      // index == pos test is always true; what is left is the pos switch.
      const { mark, pos } = marks.shift();
      if (text[0].endsWith(" ")) text[0] = text[0].slice(0, -1);
      if (pos === "B") text[0] = mark + text[0];
      else if (pos === "E") {
        res.push(text[0] + mark + (mark.endsWith(" ") ? "" : " "));
        text = text.slice(1);
      } else if (pos === "A") {
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
  for (const w of line.split(" ")) out += w.trim().replace(/_/g, "") + " ";
  return out;
}

// str.strip(): python's whitespace includes the \x1c-\x1f separators and \x85.
const pyStrip = (s) => s.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/gu, "");

/** `raw(chunk)` -> espeak's phoneme string for one chunk of text. */
export function makePhonemize(raw) {
  return function phonemize(text) {
    text = pyStrip(text); // Tokenizer.normalize_text
    const outLines = [];
    for (const line of text.split("\n").filter((l) => l.trim())) {
      const [chunks, marks] = preserveLine(line);
      const ph = chunks.filter(Boolean).map((c) => postprocessLine(raw(c)));
      outLines.push(...restore(ph, marks));
    }
    return pyStrip([...outLines.join("\n")].filter((ch) => ch in VOCAB).join(""));
  };
}

/**
 * libespeak-ng through koffi. `dataPath` is the espeak-ng-data directory.
 * Returns raw(text): espeak_TextToPhonemes over every clause of `text`, IPA
 * with '_' between phones, clauses joined by ' ' -- what python-phonemizer's
 * espeak backend hands its post-processing.
 */
export async function espeakBackend(libPath, dataPath) {
  const koffi = (await import("koffi")).default;
  const lib = koffi.load(libPath);
  const init = lib.func("int espeak_Initialize(int, int, const char *, int)");
  const setVoice = lib.func("int espeak_SetVoiceByName(const char *)");
  const textToPhonemes = lib.func(
    "const char *espeak_TextToPhonemes(_Inout_ void **textptr, int textmode, int phonememode)",
  );
  // AUDIO_OUTPUT_SYNCHRONOUS: we never ask espeak for sound, only phonemes.
  if (init(0x02, 0, dataPath, 0) <= 0) throw new Error(`espeak could not initialise from ${dataPath}`);
  if (setVoice("gmw/en-US") !== 0) throw new Error("espeak has no gmw/en-US voice");
  // espeakCHARS_UTF8 text; IPA phonemes (bit 1) with '_' as the phone separator (bits 8+).
  const mode = ("_".codePointAt(0) << 8) | 0x02;
  return function raw(text) {
    const bytes = Buffer.from(text + "\0", "utf8");
    const mem = koffi.alloc("char", bytes.length);
    koffi.encode(mem, "char", Array.from(bytes, (b) => (b > 127 ? b - 256 : b)), bytes.length);
    // espeak advances the pointer one clause per call and nulls it at the end.
    const box = [mem];
    const clauses = [];
    while (box[0] !== null) {
      const p = textToPhonemes(box, 1, mode);
      if (p) clauses.push(p);
    }
    koffi.free(mem);
    return clauses.join(" ");
  };
}
