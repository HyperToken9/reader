// Build sample_books/testbench/report.html from bench/results.json,
// bench/synth.json, verdicts.json and out/measure*.json.
import fs from "node:fs";
const B = process.argv[2] || "bench";
const res = JSON.parse(fs.readFileSync(`${B}/results.json`, "utf8"));
const syn = JSON.parse(fs.readFileSync(`${B}/synth.json`, "utf8"));
const V = JSON.parse(fs.readFileSync("verdicts.json", "utf8"));
const part2 = JSON.parse(fs.readFileSync("part2.json", "utf8"));

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// make invisible / control / private-use characters visible
const show = (s) => esc(s).replace(/[\u0000-\u001f­​-‏⁠﻿-]/g,
  (c) => `<span class="cp" title="U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}">U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}</span>`);

const TAGS = ["OK", "junk spoken", "symbol lost", "symbol mangled", "welded", "dropped silently"];
const slug = (t) => t.replace(/\s+/g, "-");
const all = [...res.synthetic, ...res.real];
const counts = { synthetic: {}, real: {} };
for (const c of all) {
  const v = V[c.id];
  if (!v) throw new Error("no verdict for " + c.id);
  const k = c.section === "R" ? "real" : "synthetic";
  counts[k][v.tags[0]] = (counts[k][v.tags[0]] || 0) + 1;
}

function caseCard(c) {
  const v = V[c.id];
  const s = syn[c.id] || { strings: [] };
  const sents = c.sentences;
  const extracted = sents.map((x) => `<li class="${x.scaffold ? "scaf" : ""}">${show(x.text)}${x.scaffold ? ' <span class="muted">(bench label, not voiced in the clip)</span>' : ""}</li>`).join("");
  const sent = sents.filter((x) => !x.scaffold).map((x) => {
    if (x.dropped) return `<li><b class="drop">DROPPED SILENTLY</b> ${show(x.text)}</li>`;
    if (!/[A-Za-z]/.test(x.speech)) return `<li><b class="drop">DROPPED SILENTLY</b> (no letters; ensurePrefetch skips it) ${show(x.speech)}</li>`;
    return `<li><code>${show(JSON.stringify(x.speech))}</code></li>`;
  }).join("") || '<li class="muted">(nothing)</li>';
  const ph = s.strings.map((x) => `<li>${esc(x.phonemes)}${x.error ? ` <b class="drop">synth error: ${esc(x.error)}</b>` : ""}</li>`).join("");
  const tags = v.tags.map((t) => `<span class="tag t-${slug(t)}">${esc(t)}</span>`).join(" ");
  const tickets = (v.tickets || []).map((t) => `<span class="tk">#${t}</span>`).join(" ");
  return `<article class="case" data-tags="${esc(v.tags.join("|"))}" data-section="${c.section}">
  <header><span class="cid">${c.id}</span> <span class="label">${esc(c.label)}</span> <span class="tags">${tags}</span> ${tickets}</header>
  <dl>
   <dt>On the page</dt><dd>${esc(c.on_page)}${c.note ? ` <span class="muted">${esc(c.note)}</span>` : ""}</dd>
   <dt>Ideal reader says</dt><dd>${esc(c.ideal)}</dd>
   <dt>Extracted (sentences)</dt><dd><ol class="str">${extracted}</ol></dd>
   <dt>Sent to the synthesiser</dt><dd><ol class="str">${sent}</ol></dd>
   <dt>Listen</dt><dd>${s.clip ? `<audio controls preload="none" src="${s.clip}"></audio>` : '<span class="muted">no audio (nothing sent)</span>'}</dd>
   <dt>Why</dt><dd>${esc(v.why)}</dd>
  </dl>
  <details><summary>Phonemes Kokoro actually voiced</summary><ol class="str">${ph}</ol></details>
</article>`;
}

const countTable = (k) => TAGS.map((t) => `<td>${counts[k][t] || 0}</td>`).join("");
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blitz Text Bench</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6b66;--card:#ffffff;--line:#e3e0d8;--code:#f2efe7;
--ok:#2e7d32;--junk:#b45309;--lost:#b91c1c;--mangled:#7c3aed;--welded:#0e7490;--drop:#be123c}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#171716;--fg:#ecebe6;--muted:#a3a29b;--card:#20201e;--line:#34332f;--code:#2a2926;
--ok:#66bb6a;--junk:#f59e0b;--lost:#f87171;--mangled:#a78bfa;--welded:#22d3ee;--drop:#fb7185}}
:root[data-theme="dark"]{--bg:#171716;--fg:#ecebe6;--muted:#a3a29b;--card:#20201e;--line:#34332f;--code:#2a2926;
--ok:#66bb6a;--junk:#f59e0b;--lost:#f87171;--mangled:#a78bfa;--welded:#22d3ee;--drop:#fb7185}
body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:0 16px 80px}
main{max-width:980px;margin:0 auto}
h1{font-size:26px;margin:28px 0 4px}h2{font-size:20px;margin:34px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:16px;margin:20px 0 6px}
.muted{color:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0}
th,td{border:1px solid var(--line);padding:4px 7px;text-align:left;vertical-align:top}
th{background:var(--code)}
.scroll{overflow-x:auto}
code,.str{font-family:ui-monospace,"DejaVu Sans Mono",monospace;font-size:13px}
code{background:var(--code);padding:1px 4px;border-radius:3px;word-break:break-word}
.case{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:12px 0}
.case header{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.cid{font-weight:700;font-family:ui-monospace,monospace}.label{font-weight:600}
dl{display:grid;grid-template-columns:170px 1fr;gap:4px 12px;margin:10px 0 4px}
dt{color:var(--muted);font-size:13px}dd{margin:0;min-width:0}
@media (max-width:640px){dl{grid-template-columns:1fr}dt{margin-top:6px}}
ol.str{margin:0;padding-left:20px}ol.str li{margin:2px 0;word-break:break-word}
li.scaf{color:var(--muted)}
.cp{display:inline-block;font-size:10px;border:1px solid var(--drop);color:var(--drop);border-radius:3px;padding:0 2px;margin:0 1px;line-height:14px}
.tag{font-size:12px;font-weight:600;border-radius:10px;padding:1px 8px;border:1px solid currentColor}
.t-OK{color:var(--ok)}.t-junk-spoken{color:var(--junk)}.t-symbol-lost{color:var(--lost)}.t-symbol-mangled{color:var(--mangled)}.t-welded{color:var(--welded)}.t-dropped-silently{color:var(--drop)}
.tk{font-size:12px;color:var(--muted);border:1px dashed var(--line);border-radius:10px;padding:0 6px}
.drop{color:var(--drop)}
audio{width:100%;max-width:420px;height:34px}
.filters{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);z-index:2;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}
.filters label{font-size:13px;white-space:nowrap}
.hidden{display:none}
.find{background:var(--card);border-left:3px solid var(--junk);padding:6px 10px;margin:8px 0}
</style></head><body><main>
<h1>Blitz text test bench: report</h1>
<p class="muted">Prototype for issue #9. Each string below is exactly what the current app (dev, pdfjs-dist 6.3.289) would send to the synthesiser, recomputed in Node with a faithful copy of the app's pipeline. Each clip is that string synthesised by the app's own Python engine (Kokoro fp16, voice bf_emma, speed 1.0, continuous=True). Generated ${new Date().toISOString().slice(0, 10)}.</p>
<p>Open <code>blitz-text-testbench.pdf</code> (synthetic, original text) and <code>real-excerpts.pdf</code> (single pages from the sample books) in Blitz to hear the same cases in the reader.</p>

<h2>Verdict counts</h2>
<div class="scroll"><table><tr><th></th>${TAGS.map((t) => `<th>${t}</th>`).join("")}<th>cases</th></tr>
<tr><th>Synthetic bench</th>${countTable("synthetic")}<td>${res.synthetic.length}</td></tr>
<tr><th>Real excerpts</th>${countTable("real")}<td>${res.real.length}</td></tr></table></div>
<p class="muted">The first tag is the primary verdict, and the counts use it. "OK" means the listener hears the right thing, even when the string still holds junk that Kokoro happens to voice as silence. "dropped silently" means text on the page that never reaches the ear and gives no sign that it is missing.</p>

${part2.html}

<h2>Cases</h2>
<div class="filters" id="filters"><b>Show:</b>
${TAGS.map((t) => `<label><input type="checkbox" data-tag="${t}" checked> <span class="tag t-${slug(t)}">${t}</span> (${(counts.synthetic[t] || 0) + (counts.real[t] || 0)})</label>`).join("")}
<label>Section <select id="sec"><option value="">all</option><option>J</option><option>S</option><option>P</option><option>M</option><option value="R">R (real)</option></select></label>
</div>
<h3>Synthetic bench (blitz-text-testbench.pdf)</h3>
${res.synthetic.map(caseCard).join("\n")}
<h3>Real excerpts (real-excerpts.pdf)</h3>
${res.real.map(caseCard).join("\n")}
</main>
<script>
const boxes=[...document.querySelectorAll('#filters input[data-tag]')];const sec=document.getElementById('sec');
function apply(){const on=new Set(boxes.filter(b=>b.checked).map(b=>b.dataset.tag));const s=sec.value;
for(const a of document.querySelectorAll('.case')){const t=a.dataset.tags.split('|')[0];a.classList.toggle('hidden',!on.has(t)||(s&&a.dataset.section!==s));}}
boxes.forEach(b=>b.addEventListener('change',apply));sec.addEventListener('change',apply);
</script></body></html>`;
fs.writeFileSync(process.argv[3] || `${B}/report.html`, html);
console.log("report written", counts);
