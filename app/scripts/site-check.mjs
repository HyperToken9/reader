/*
 * The gate for the documentation-site path: does a site come across whole,
 * does re-opening it actually re-check the site, and does a note survive the
 * page it was written on moving?
 *
 *   node scripts/site-check.mjs [url]
 *
 * Not part of `npm run smoke` -- it needs the network and a real docs site to
 * point at. Run it by hand when touching renderer/site.js, electron/net.js or
 * the chapter render path.
 *
 * It uses the real library on purpose: the conditional-request path only
 * exists when there is a previous snapshot to compare against, so a site left
 * on the shelf by an earlier run is the interesting case rather than a dirty
 * one. A note it has to create for the test, it deletes afterwards.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { WebSocket } from "ws";
const PORT = Number(process.env.P || 9431);
const URL_ = process.argv[2] ?? "https://spinningup.openai.com/en/latest/";
const OUT = process.env.OUT ?? ".";
const app = spawn("npx", ["electron", ".", `--remote-debugging-port=${PORT}`], { stdio: ["ignore","pipe","pipe"] });
const log=[]; const keep=s=>{for(const l of String(s).split("\n")) if(l.trim()&&!/Reciprocal|onnxruntime|vaapi|npm warn|constant_folding/i.test(l)) log.push(l);};
app.stdout.on("data",keep); app.stderr.on("data",keep);
const done=(c,m)=>{ if(m)console.log(m); app.kill("SIGKILL"); process.exit(c); };
let t=null;
for(let i=0;i<120;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json`,{signal:AbortSignal.timeout(800)});[t]=(await r.json()).filter(x=>x.type==="page");if(t)break;}catch{}await new Promise(r=>setTimeout(r,250));}
if(!t) done(1,"no window\n"+log.join("\n"));
const ws=new WebSocket(t.webSocketDebuggerUrl); const pend=new Map(); let id=0;
const send=(m,p={})=>new Promise(r=>{const n=++id;pend.set(n,r);ws.send(JSON.stringify({id:n,method:m,params:p}));});
const warns=[];
ws.on("message",raw=>{const m=JSON.parse(raw);if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}
 if(m.method==="Runtime.exceptionThrown")console.log("PAGE EXCEPTION:",m.params.exceptionDetails?.exception?.description);
 if(m.method==="Runtime.consoleAPICalled"&&m.params.type==="warning"){const s=m.params.args.map(a=>a.value??a.description).join(" ");if(/overflow/.test(s))warns.push(s);}});
await new Promise(r=>ws.on("open",r));
await send("Runtime.enable"); await send("DOM.enable"); await send("Page.enable");
const ev=async e=>{const r=await send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});
 if(r.exceptionDetails)throw new Error(r.exceptionDetails.text+" "+(r.exceptionDetails.exception?.description??""));return r.result.value;};
const shot=async n=>{const r=await send("Page.captureScreenshot",{format:"png"});writeFileSync(`${OUT}/${n}`,Buffer.from(r.data,"base64"));console.log("  shot",n);};
for(let i=0;i<160;i++){try{if(await ev("typeof window.__spike!=='undefined'"))break;}catch{}await new Promise(r=>setTimeout(r,250));}

// Keep whatever is already shelved for this address: re-opening it is the
// conditional-request path, which is the thing under test.
// One normaliser, installed in the page, so the harness picks the same shelf
// entry the app would for this address.
await ev(`window.norm = (u) => String(u ?? '').toLowerCase().replace(/#.*$/,'').replace(/\\/index\\.html?$/,'/').replace(/\\/+$/,'')`);
const already = await ev(`(async()=>{const l=await window.blitz.library.list();
  return l.some(b=>b.kind==='site'&&norm(b.url)===norm(${JSON.stringify(URL_)}));})()`);
console.log(already ? "already shelved — re-opening" : "first add:", URL_);
const t0 = Date.now();
await ev(already
  ? `(async()=>{const l=await window.blitz.library.list();
      const b=l.find(x=>x.kind==='site'&&norm(x.url)===norm(${JSON.stringify(URL_)}));
      [...document.querySelectorAll('.shelfCard')].find(c=>c.dataset.id===b.id).querySelector('.cardOpen').click();
      return 1})()`
  : `(()=>{document.getElementById('siteUrl').value=${JSON.stringify(URL_)};document.getElementById('siteAdd').click();return 1})()`);
let last="";
for(let i=0;i<500;i++){const st=await ev(`({n:document.getElementById('siteNote').textContent,bad:document.getElementById('siteNote').classList.contains('bad'),v:document.body.dataset.view})`);
 if(st.n!==last){last=st.n;if(last)console.log("  ",last);} if(st.bad)done(1,"add failed: "+st.n); if(st.v==="reader")break; await new Promise(r=>setTimeout(r,1000));}
const addMs = Date.now() - t0;
console.log("first add took", (addMs/1000).toFixed(1), "s");
await new Promise(r=>setTimeout(r,3000));

// ---- fidelity: render a spread of pages, check nothing is clipped ---------
const fidelity = await ev(`(async () => {
  const d = window.__spike;
  const n = d.pages.size;
  const picks = [...new Set([1, 2, Math.ceil(n/3), Math.ceil(n/2), n-1, n])].filter(p=>p>=1&&p<=n);
  const out = [];
  for (const pn of picks) {
    await d.renderPage(pn);
    const p = d.pages.get(pn);
    const idoc = p.iframe.contentDocument;
    const de = idoc.documentElement;
    out.push({
      pn,
      overflowX: de.scrollWidth - de.clientWidth,
      textLen: idoc.body.textContent.replace(/\\s+/g,' ').trim().length,
      imgs: idoc.querySelectorAll('img').length,
      broken: [...idoc.querySelectorAll('img')].filter(i=>i.complete && i.naturalWidth===0).length,
      markers: idoc.querySelectorAll('.blitzMissing').length,
      sentences: p.sentences.length,
      pilcrow: p.sentences.filter(s=>s.text.includes('\\u00b6')).length,
    });
  }
  return out;
})()`);
console.log("fidelity:", JSON.stringify(fidelity));

// ---- compare a snapshot page against the live page it came from ----------
const coverage = await ev(`(async () => {
  const d = window.__spike;
  const pn = Math.ceil(d.pages.size/3);
  await d.renderPage(pn);
  const p = d.pages.get(pn);
  const mine = p.iframe.contentDocument.body.textContent.replace(/\\s+/g,' ').trim();
  const href = window.__spike.chapterHref?.(pn) ?? null;
  const url = href ?? d.toc?.[pn-1]?.url ?? null;
  return { pn, mineLen: mine.length, url };
})()`);
// fetch the live page from node and compare against the main region's text
let ratio = null, liveLen = null;
if (fidelity.length) {
  const res = await ev(`(async () => {
    const d = window.__spike;
    const pn = ${coverage.pn};
    const src = d.chapterHref(pn);
    if (!src) return null;
    const r = await window.blitz.fetch(src);
    if (!r.ok) return null;
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(r.bytes), 'text/html');
    const main = doc.querySelector('[role=main]') || doc.querySelector('main') || doc.body;
    return { src, liveLen: main.textContent.replace(/\\s+/g,' ').trim().length };
  })()`);
  if (res) { liveLen = res.liveLen; ratio = coverage.mineLen / res.liveLen; console.log("coverage:", res.src, coverage.mineLen, "vs live", liveLen, "=", ratio.toFixed(3)); }
}
await shot("f-1-page.png");

// ---- a note, then prove it does not depend on its page number ------------
const note = await ev(`(async () => {
  const d = window.__spike;
  const pn = ${fidelity[2]?.pn ?? 2};
  await d.renderPage(pn);
  const p = d.pages.get(pn);
  const idoc = p.iframe.contentDocument;
  const para = [...idoc.querySelectorAll('p')].find(el => el.textContent.trim().length > 140);
  const r = idoc.createRange();
  r.setStart(para.firstChild, 0); r.setEnd(para.firstChild, Math.min(80, para.firstChild.length));
  idoc.getSelection().removeAllRanges(); idoc.getSelection().addRange(r);
  const ctx = d.noteContext();
  document.querySelector('[data-tab="notes"]').click();
  const had = document.querySelectorAll('#notesList li').length;
  if (!had) document.getElementById('addNote').click();
  return { truePn: pn, ctx, mine: !had };
})()`);
console.log("note:", JSON.stringify(note.ctx).slice(0,200));

// point the note at a deliberately wrong page and see if it still finds itself
const relocated = await ev(`(async () => {
  const d = window.__spike;
  const fake = { ...${JSON.stringify(note.ctx)}, pn: 1 };
  const found = d.locateNote(fake);
  await d.goToNote(fake);
  return { found, cursorPn: d.pages.size && document.querySelector('#toc li.current')?.textContent };
})()`);
console.log("relocated:", JSON.stringify(relocated));

// ---- reopen from the shelf: must go back to the network ------------------
const t1 = Date.now();
const fresh = await ev(`(async () => {
  document.getElementById('toLibrary').click();
  await new Promise(r=>setTimeout(r,1000));
  const before = (await window.blitz.library.list()).find(b=>b.kind==='site'&&norm(b.url)===norm(${JSON.stringify(URL_)}));
  window.__phases = [];
  const note = document.getElementById('siteNote');
  new MutationObserver(() => {
    const t = note.textContent;
    if (t && !window.__phases.includes(t)) window.__phases.push(t);
  }).observe(note, { childList: true, characterData: true, subtree: true });
  const card = [...document.querySelectorAll('.shelfCard')].find(c=>c.dataset.id===before.id);
  card.querySelector('.cardOpen').click();
  for (let i=0;i<800 && document.body.dataset.view!=='reader'; i++) await new Promise(r=>setTimeout(r,50));
  await new Promise(r=>setTimeout(r,2500));
  const after = (await window.blitz.library.list()).find(b=>b.id===before.id);
  return {
    refetched: after.fetchedAt > before.fetchedAt,
    sawFetching: window.__phases.some(p=>/fetching|checking|saving/.test(p)),
    phases: window.__phases.slice(0,6),
    notes: document.querySelectorAll('#notesList li').length,
    view: document.body.dataset.view,
    status: document.getElementById('state').textContent.split('\\n')[0],
    tally: window.__spike.siteTally,
  };
})()`);
const reopenMs = Date.now() - t1;
console.log("fresh:", JSON.stringify(fresh), "in", (reopenMs/1000).toFixed(1), "s");
await shot("f-2-reopen.png");

const worstOverflow = Math.max(...fidelity.map(f=>f.overflowX));
const checks = [
  ["nothing clipped horizontally", worstOverflow <= 2, `worst ${worstOverflow}px`],
  ["no overflow warnings", warns.length === 0, warns.join(" | ")],
  ["no broken images", fidelity.every(f=>f.broken===0), JSON.stringify(fidelity.map(f=>f.broken))],
  ["every page has text", fidelity.every(f=>f.textLen>200), JSON.stringify(fidelity.map(f=>f.textLen))],
  ["pilcrows not spoken", fidelity.every(f=>f.pilcrow===0), "¶ leaked into a sentence"],
  ["page text matches the live page", ratio !== null && ratio > 0.9 && ratio < 1.1, `ratio ${ratio}`],
  ["note quotes the selection", (note.ctx?.quote ?? "").length > 30, ""],
  ["note labelled by page name, not number", !!note.ctx?.title && note.ctx.label === note.ctx.title, JSON.stringify(note.ctx?.label)],
  ["note finds its page despite a wrong number", relocated.found === note.truePn, `got ${relocated.found}, wanted ${note.truePn}`],
  ["shelf open re-fetches", fresh.refetched, "fetchedAt did not move"],
  ["and says so while it does", fresh.sawFetching, JSON.stringify(fresh)],
  ["notes survive the refetch", fresh.notes >= 1, `${fresh.notes} notes`],
  // Only meaningful against a genuine cold download; when the site was
  // already shelved both opens are conditional and there is nothing to
  // compare.
  ["re-check downloads almost nothing", (fresh.tally?.unchanged ?? 0) >= (fresh.tally?.pages ?? 1) - 1, JSON.stringify(fresh.tally)],
  ...(already ? [] : [["re-check is quicker than the first fetch", reopenMs < addMs, `${(reopenMs/1000).toFixed(1)}s vs ${(addMs/1000).toFixed(1)}s`]]),
];
// Put the shelf back the way it was found: a test note is not a reader's note.
if (note.mine) await ev(`(()=>{document.querySelector('#notesList .noteDrop')?.click(); return 1})()`);

let bad=0; for(const[n,ok,d]of checks){console.log(`${ok?"  ok  ":"FAIL  "}${n}${ok?"":" — "+d}`);if(!ok)bad++;}
done(bad?1:0,bad?`\n${bad} failed`:"\nall checks passed");
