// Build the Part 2 findings section (HTML) for the report -> part2.json
import fs from "node:fs";
const M = JSON.parse(fs.readFileSync("out/measure.json", "utf8")).summary;
const W2 = JSON.parse(fs.readFileSync("out/welds2.json", "utf8"));
const CH = JSON.parse(fs.readFileSync("out/chars_classified.json", "utf8"));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const books = ["millington", "biochem", "crafting", "lejepa", "codebook"];
const name = { millington: "Millington, Game Physics", biochem: "Vasudevan, Biochemistry", crafting: "Nystrom, Crafting Interpreters", lejepa: "LeJEPA paper", codebook: "Singh, The Code Book" };
const trueWeld = (x) => /^[a-z][xyz][a-z][xyz]$/.test(x.tok) || ["dkurt", "ISBk", "eitX", "iteitXi", "IWELCOME"].includes(x.tok);
const hy = { // from the EOL-hyphen classifier run (see out/ notes)
  millington: { drops: 167, word: 149, compound: 9, other: 9, missed: 1 },
  biochem: { drops: 6, word: 0, compound: 2, other: 4, missed: 64 },
  crafting: { drops: 10, word: 0, compound: 10, other: 0, missed: 1 },
  lejepa: { drops: 202, word: 149, compound: 17, other: 36, missed: 0 },
  codebook: { drops: 9, word: 1, compound: 5, other: 3, missed: 0 },
};
const header = { millington: "77 sentences (≈ every page)", biochem: "27 of 75 pages", crafting: "≈20 (margin section numbers)", lejepa: "139 sentences (nav bar on every page)", codebook: "0" };
const gib = {}, silentMeaning = {};
for (const [c, r] of Object.entries(CH)) for (const b of books) {
  const n = r.counts[b] || 0;
  if (r.class === "codepoint gibberish") gib[b] = (gib[b] || 0) + n;
}
const SILENT_MEANINGFUL = ["–", "∥", "∇", "⊤", "′", "∈", "·", "⟨", "⟩", "∀", "∃", "≜", "∂", "𝜕", "″", "∉", "⊆", "∝"];
for (const b of books) silentMeaning[b] = SILENT_MEANINGFUL.reduce((a, c) => a + ((CH[c]?.counts[b]) || 0), 0);

const row = (b) => {
  const s = M[b];
  const w = W2.ex.weld.filter((x) => x.book === b);
  const tw = w.filter(trueWeld).length;
  const j = s.junk;
  return `<tr><th>${name[b]}</th><td>${s.pages}</td><td>${s.words.toLocaleString()}</td><td>${s.sentences.toLocaleString()}</td>
<td>${s.weldCandidates} → <b>0</b></td><td>${w.length} → <b>${tw}</b></td><td>${hy[b].drops} / <b>${hy[b].compound}</b> / ${hy[b].missed}</td>
<td>${s.normDiffPages}</td><td>${(j["bracket/box pieces"] || 0)}</td><td>${(j["C0 controls (unmapped glyph, stripped before TTS)"] || 0)} (${s.unmappedSentences} sents)</td>
<td>${(j["math alphanumerics"] || 0)}</td><td>${(j["private-use"] || 0)}</td><td>${gib[b] || 0}</td><td>${silentMeaning[b]}</td><td>${header[b]}</td><td>${s.droppedSilently}</td></tr>`;
};
const charRows = Object.entries(CH).sort((a, b) => b[1].counts.total - a[1].counts.total).slice(0, 40)
  .map(([c, r]) => `<tr><td>${esc(c)}</td><td>${r.cp}</td><td>${esc(r.name.toLowerCase())}</td><td>${r.class}</td><td>${r.counts.total}</td><td><code>${esc(r.alone || "(nothing)")}</code></td></tr>`).join("");

const html = `
<h2>Part 2: measurements on the real corpus</h2>
<p>356 pages, evenly spread through the five PDFs in <code>sample_books/</code> (every page of the 50-page paper; Millington pp. 58–64 added on purpose), run through the app-faithful pipeline. That is 127,594 words in 7,132 TTS strings.</p>
<div class="scroll"><table>
<tr><th>Book</th><th>pages</th><th>words</th><th>TTS strings</th><th>weld candidates: dictionary → true</th><th>weld candidates: vs poppler → true</th><th>EOL hyphen drops / compound lost / missed</th><th>pages changed by NFKC</th><th>⎡⎢⎣ pieces</th><th>C0 sentinels</th><th>math-italic letters</th><th>private use</th><th>chars read as code points</th><th>meaningful symbols voiced as silence</th><th>running header / page no. in a spoken sentence</th><th>dropped by the letter guard</th></tr>
${books.map(row).join("")}
</table></div>

<h3>1. Word welds from spacing heuristics: effectively none in prose</h3>
<div class="find">There are <b>no tracking welds in the prose of any of the five books.</b> The dictionary detector (a token that is not a word but splits into two words) flagged 712 candidates. Every one I hand-checked (about 200, including all 85 non-recurring lowercase ones) was a real compound or a technical term: <i>interpenetration, bytecode, ciphertext, hyperparameter, runtime</i>. Precision for actual welds was 0%. A second referee, poppler's <code>pdftotext</code>, flagged 120 more. 24 of those are real welds, and every one is in maths: subscript runs such as <code>axbx + ayby + azbz</code> (Millington p.53 and p.462), <code>dkurt</code>, <code>ISBkernel</code> and <code>eitX</code> (LeJEPA), plus one decorative heading (<code>→ IWELCOME</code>). The other 96 were poppler's own errors, where pdf.js was right: small-caps headings, which poppler splits as <i>A BOUT</i>. No weld rate correlates with font. The per-font rates the dictionary detector produced just track how much jargon each font sets.</div>
<p><b>Where welds do appear.</b> The synthetic bench shows the threshold. At −0.05em tracking, words stay apart. At −0.12em and −0.2em, whole lines weld (<code>Trackingminustwelvehundredthsmaystarttoweld.</code>, P-04). None of the five books goes that tight. <b>The opposite fault is real:</b> 4 of the 75 sampled biochemistry pages (pp. 329, 339, 350, 460) are scans with an OCR text layer, and 55–78% of their tokens are fragments (<code>A m is ta k e is an avoidable error.</code>). Poppler shows the same fragments, so the damage is in the PDF's own text layer, not in pdf.js. A repair would have to be per-page OCR detection, not a spacing fix.</p>

<h3>Line-end hyphens (the existing fix), measured</h3>
<p>The fix drops a hyphen when the item that carries <code>hasEOL</code> ends in one (main.js:2220). Across the corpus it dropped 394 hyphens. 299 rejoined a real word. <b>43 deleted a real compound hyphen</b>, producing <code>nineteenthcentury</code>, <code>closedover</code>, <code>objectoriented</code>, <code>selfsupervised</code> and <code>socalled</code>; in Crafting Interpreters all 10 of 10 drops were wrong, and in The Code Book 5 of 9. Eleven more ate a non-letter: <code>-4</code> and <code>-8</code> lost their minus signs, and <code>ImageNet-1K</code> became <code>ImageNet1K</code>. In the other direction, <b>67 line-end hyphens were missed</b> (64 of them in the biochemistry book). Both Typst bench cases (P-02, P-03) miss too. The reason: pdf.js puts <code>hasEOL</code> on an empty <code>""</code> item <i>after</i> the hyphen item, so the hyphen is kept and a space is added: <code>detoxifi- cation</code>, <code>trouble- some</code>, <code>self- contained</code>. Kokoro reads those as two half-words.</p>

<h3>2. disableNormalization: keep the default, but fix micro on the speech side</h3>
<p>pdf.js NFKC only touches a small set: NBSP and the U+2000–200A spaces, µ, Ω, the ligatures U+FB00–FB06, and Arabic and Hebrew presentation forms (pdf.worker.mjs:722). Turning it off changed 57 of 81 Millington pages (187 ligature glyphs ﬁ ﬂ), 5 LeJEPA pages (ﬁ ﬂ ﬃ), and 2 biochemistry pages (µ instead of μ). Crafting Interpreters and The Code Book were unchanged. <b>The number of Intl.Segmenter sentences was identical in every book</b> (delta 0), so segmentation does not care. Speech does. With normalisation off, Kokoro's espeak reads ﬁ and ﬂ correctly, but <b>ﬃ comes out as "letter F B zero three"</b> (<code>ﬃcient</code> → <code>lˌɛɾɚˈɛfbˈiːzˈiəɹoʊθɹˈiːʃənt</code>), so turning normalisation off is worse. With normalisation on, the <b>micro sign is turned into Greek mu, and "5 µg/dL" is spoken "five myoog slash dee-ell"</b> instead of "five micro-gee" (biochemistry p.536, 558 and 689; bench S-08). Recommendation: keep the default, and add a speech-side unit rule under #23.</p>

<h3>3. Residual junk that reaches the synthesiser</h3>
<p>Two different things happen to non-prose characters, and only one of them is audible. Of the 224 distinct non-ASCII characters that reach TTS strings, Kokoro treats them as follows:</p>
<ul>
<li><b>Codepoint gibberish:</b> 102 characters, 4,564 occurrences. Mathematical alphanumerics (𝑛 𝑥 𝜃 𝒙 ℎ…) are read aloud as their hex code point: 𝑛 is spoken "letter one D four five B". 4,557 of these are in LeJEPA alone, and they are the single worst audible failure in the corpus. NFKC would fix them in one line.</li>
<li><b>Silent:</b> 51 characters, 2,353 occurrences. Bracket pieces ⎡⎢⎣, ∈ ∀ ′ ∥ ∇ ⊤ ≜ ⟨⟩ and the en dash are voiced as nothing. For the pieces that is harmless. For ∈ ∀ ′ ≜ and "10–20" the meaning is lost and nothing flags it (bench S-13, S-15, S-17, S-20).</li>
<li><b>Mis-mapped glyphs that are spoken:</b> the biochemistry book's Wingdings bullets arrive as <code>¾¾</code> and are read "three three" before every topic (all 27 chapter openers). LeJEPA's large-operator glyphs arrive as Õ Í © « ª ® ¬ and are read "O tilde", "I acute", "copyright".</li>
<li><b>C0 sentinels:</b> 77 strings (Millington 17, LeJEPA 60). This confirms #9's resolution comment: Δ on Millington p.60 is U+0003, and the app strips it to a space, so <code>Δp/Δt</code> is spoken "p slash t". The Typst bench adds a second source. Its tall-bracket extension pieces also come through as U+0002/U+0003 (J-01), which supports using C0 as a "this is maths" flag.</li>
<li><b>Page furniture inside sentences:</b> running headers and page numbers are glued onto the first or last sentence of a page on almost every Millington and LeJEPA page, and on 27 of 75 biochemistry pages. Examples: <code>10 Chapter 1 Introduction 1.4.3 THE MATH WE'LL INTRODUCE Finally…</code> and <code>This demonstrates that principled 2</code>. Sentences that cross a page are cut in two (bench J-06).</li>
<li><b>Dropped by the <code>!/[A-Za-z]/</code> guard: 0 of 7,132.</b> The guard (main.js:2307) almost never drops anything. It merges a letterless span into the next sentence, so the junk is spoken rather than lost: <code>2 . 2 . 3 2 . 2 . 4 Some people use…</code> (Crafting p.17). The only text that disappears without warning is unmapped glyphs (C0) and the symbols Kokoro voices as silence.</li>
</ul>
<details><summary>Top 40 non-ASCII characters in TTS strings, and what Kokoro does with each</summary><div class="scroll"><table><tr><th>char</th><th>code point</th><th>name</th><th>Kokoro</th><th>count</th><th>phonemes alone</th></tr>${charRows}</table></div></details>

<h3>4. What a repair pass would cost</h3>
<div class="scroll"><table>
<tr><th>Repair</th><th>Size</th><th>False-positive risk</th><th>Effect measured on the 7,132 strings</th></tr>
<tr><td>Math alphanumerics → NFKC letters; drop bracket pieces, box drawing and private-use characters</td><td>2 lines</td><td>none</td><td>4,523 + 234 characters fixed; LeJEPA goes from gibberish to readable but still meaningless maths</td></tr>
<tr><td>Symbol table for things Kokoro is silent on or mangles (∈ ∀ ′ ≜ ∥ ⊤ · ˆ …)</td><td>~30 entries, 3 lines of code</td><td>low in prose; in maths it produces "cos minus 1" for cos⁻¹, which is pronounceable but wrong</td><td>1,140 replacements</td></tr>
<tr><td>Numeric en dash → "to"; µ/μ before a unit → "micro"</td><td>2 lines</td><td>low (scores, and Greek μ before a unit letter)</td><td>222 + 7</td></tr>
<tr><td>Line-end hyphen: look past an empty EOL item</td><td>~5 lines</td><td>none</td><td>fixes 67 missed joins</td></tr>
<tr><td>Line-end hyphen: keep compound hyphens</td><td>~15 lines plus a wordlist (~1 MB) or hyphenation patterns</td><td>moderate (jargon not in the list)</td><td>would recover ≈43 compounds; the cheap rule "keep it when the next line starts with a digit or capital" recovers the minus signs and ImageNet-1K</td></tr>
<tr><td>Weld splitting</td><td>not worth building</td><td>high (0% precision on real data)</td><td>no prose welds to fix</td></tr>
<tr><td>Running header and page-number removal</td><td>~40–60 lines, needs cross-page repetition and band position</td><td>moderate (could drop a real first line)</td><td>affects most pages of three of the five books; this is region work (#7), not string work</td></tr>
</table></div>
<p>The prototype pass (<code>cleanup.mjs</code>, 28 lines) changed 43 of 1,119 Millington strings, 65 of 2,351 biochemistry, 6 of 1,455 Crafting, 458 of 1,179 LeJEPA and 1 of 1,028 Code Book.</p>
<div class="find"><b>Verdict.</b> For prose, the string is usable as-is for segmentation and highlighting. Ordinary text has no welds and normalisation does no harm. For speech it <b>needs a cleanup pass</b>: a speech-only map that never touches the index space, so geometry stays right. It does <b>not</b> need the highlight/TTS design reshaped. Maths cannot be cleaned into meaning, though. Pages with C0 sentinels, math-italic letters or bracket pieces should be detected as regions and announced or skipped (#7). That detector is cheap from the string alone: C0 count plus the density of characters in U+1D400–1D7FF and U+239B–23AD.</div>
`;
fs.writeFileSync("part2.json", JSON.stringify({ html }));
console.log("ok");
