// A minimal speech-only repair pass (prototype, to cost it). Operates on the
// string handed to TTS only -- never the index space -- so geometry is untouched.
export const SYMBOLS = {
  "∈": " in ", "∉": " not in ", "∀": " for all ", "∃": " there exists ", "≜": " is defined as ", "≔": " is defined as ",
  "′": " prime", "″": " double prime", "∥": " parallel ", "⊤": " transpose", "∇": " del ", "∂": " partial ", "𝜕": " partial ",
  "·": " dot ", "∘": " composed with ", "◦": " circle ", "⇒": " implies ", "⇐⇒": " if and only if ", "⇔": " if and only if ",
  "∼": " distributed as ", "∝": " proportional to ", "⊂": " subset of ", "⊆": " subset of ", "∪": " union ", "∩": " intersection ",
  "⟨": " ", "⟩": " ", "ˆ": " hat ", "−": " minus ",
};
const SYM_RE = new RegExp(Object.keys(SYMBOLS).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu");

export function cleanSpeech(s, stats = {}) {
  const bump = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };
  let t = s;
  // 1. math alphanumerics -> plain letters (NFKC does exactly this). 1 line, no FP risk.
  t = t.replace(/[\u{1d400}-\u{1d7ff}ℎ]/gu, (c) => { bump("mathAlnum"); return c.normalize("NFKC"); });
  // 2. bracket/box drawing pieces + private use -> nothing. 1 line, no FP risk.
  t = t.replace(/[⎛-⎳─-▟-]/gu, () => { bump("bracketPUA"); return " "; });
  // 3. micro: pdf.js NFKC already turned U+00B5 into Greek mu; before a unit it means micro.
  t = t.replace(/(\d\s?)μ(?=(g|m|mol|M|L|l|s|A|V)\b)/gu, (_, d) => { bump("micro"); return d + "micro"; });
  // 4. numeric en dash range -> "to". FP: sports scores, page "3–2" in an index.
  t = t.replace(/(\d)\s?–\s?(\d)/gu, (_, a, b) => { bump("enRange"); return `${a} to ${b}`; });
  // 5. symbol table for things Kokoro is silent on or mangles.
  t = t.replace(SYM_RE, (c) => { bump("symbol"); return SYMBOLS[c]; });
  // 6. dot leaders
  t = t.replace(/(?:\s?\.){4,}/g, () => { bump("leader"); return " "; });
  return t.replace(/\s{2,}/g, " ").trim();
}
