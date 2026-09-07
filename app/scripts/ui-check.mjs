/*
 * The gate for the reading chrome: can the library be searched, does a book
 * open where it was left, and does the page behave like a document?
 *
 *   node scripts/ui-check.mjs
 *
 * Not part of `npm run smoke`: it drives the real library, so it wants a
 * shelf with something on it -- ideally a PDF with a saved position and a
 * site. The interaction half is the load-bearing part. Reading aloud used to
 * start on hover and on any left click, which made the page impossible to
 * simply *use*; these checks exist so it cannot come back.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { WebSocket } from "ws";
const PORT=Number(process.env.P||9461), OUT=process.env.OUT||".";
const app=spawn("npx",["electron",".",`--remote-debugging-port=${PORT}`],{stdio:["ignore","pipe","pipe"]});
const done=(c,m)=>{if(m)console.log(m);app.kill("SIGKILL");process.exit(c);};
let t=null;
for(let i=0;i<120;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json`,{signal:AbortSignal.timeout(800)});[t]=(await r.json()).filter(x=>x.type==="page");if(t)break;}catch{}await new Promise(r=>setTimeout(r,250));}
const ws=new WebSocket(t.webSocketDebuggerUrl);const pend=new Map();let id=0;
const send=(m,p={})=>new Promise(r=>{const n=++id;pend.set(n,r);ws.send(JSON.stringify({id:n,method:m,params:p}));});
const errs=[];
ws.on("message",raw=>{const m=JSON.parse(raw);if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}
 if(m.method==="Runtime.exceptionThrown")errs.push(m.params.exceptionDetails?.exception?.description??m.params.exceptionDetails?.text);
 if(m.method==="Runtime.consoleAPICalled"&&m.params.type==="error")errs.push(m.params.args.map(a=>a.value??a.description).join(" "));});
await new Promise(r=>ws.on("open",r));await send("Runtime.enable");await send("Page.enable");
const ev=async e=>{const r=await send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});
 if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
const shot=async n=>{const x=await send("Page.captureScreenshot",{format:"png"});writeFileSync(`${OUT}/${n}`,Buffer.from(x.data,"base64"));console.log("  shot",n);};
for(let i=0;i<160;i++){try{if(await ev("typeof window.__spike!=='undefined'"))break;}catch{}await new Promise(r=>setTimeout(r,250));}

// ---- library search --------------------------------------------------
const search = await ev(`(async()=>{
  await new Promise(r=>setTimeout(r,900));
  const all = document.querySelectorAll('.shelfCard').length;
  const s = document.getElementById('shelfSearch');
  s.value = 'spinning'; s.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,120));
  const hits = [...document.querySelectorAll('.shelfCard .cardTitle')].map(t=>t.textContent);
  s.value = 'zzzznope'; s.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,120));
  const none = { cards: document.querySelectorAll('.shelfCard').length, msg: document.getElementById('shelfEmpty').textContent };
  s.value = ''; s.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,120));
  return { all, hits, none, back: document.querySelectorAll('.shelfCard').length };
})()`);
console.log("search:", JSON.stringify(search));
await ev(`document.getElementById('shelfSearch').value='spinning';document.getElementById('shelfSearch').dispatchEvent(new Event('input'))`);
await shot("ui-1-home.png");
await ev(`document.getElementById('shelfSearch').value='';document.getElementById('shelfSearch').dispatchEvent(new Event('input'))`);

// ---- open a shelved book and check the new chrome ---------------------
const open1 = await ev(`(async()=>{
  const l = await window.blitz.library.list();
  const b = l.find(x=>x.kind==='pdf' && x.position?.pn>3) || l[0];
  window.__want = b.position?.pn ?? 1;
  [...document.querySelectorAll('.shelfCard')].find(c=>c.dataset.id===b.id).querySelector('.cardOpen').click();
  for(let i=0;i<80 && document.body.dataset.view!=='reader';i++) await new Promise(r=>setTimeout(r,100));
  await new Promise(r=>setTimeout(r,2500));
  const v=document.getElementById('viewer');
  return { title: document.getElementById('docTitle').textContent,
           counter: document.getElementById('pageNowText').textContent,
           counterShown: !document.getElementById('pageNow').hidden,
           at: window.__spike.pageAtOffset(v.scrollTop+v.clientHeight/2)?.pn,
           want: window.__want,
           exitVisible: !!document.getElementById('toLibrary').getBoundingClientRect().width,
           noPlayButton: !document.getElementById('play') && !document.getElementById('stop'),
           siteLink: !document.getElementById('openSite').hidden };
})()`);
console.log("reader:", JSON.stringify(open1));
await shot("ui-2-reader.png");

// ---- the way out survives the panel being shut ------------------------
// This is the whole point of moving it out of that panel: the control that
// leaves must never be inside the thing it can hide.
const chrome = await ev(`(async()=>{
  const exitOpen = document.getElementById('toLibrary').getBoundingClientRect();
  document.getElementById('railHandle').click();
  await new Promise(r=>setTimeout(r,400));
  const exitShut = document.getElementById('toLibrary').getBoundingClientRect();
  const handle = document.getElementById('railHandle').getBoundingClientRect();
  const rail = document.getElementById('leftPanel').getBoundingClientRect();
  document.getElementById('railHandle').click();
  await new Promise(r=>setTimeout(r,400));
  return { exitOpenW: Math.round(exitOpen.width), exitShutW: Math.round(exitShut.width),
           handleLeft: Math.round(handle.left), handleMidY: Math.round(handle.top+handle.height/2),
           windowMidY: Math.round(innerHeight/2), railShutW: Math.round(rail.width) };
})()`);
console.log("chrome:", JSON.stringify(chrome));

// ---- hover does nothing; right-click offers to read -------------------
const inter = await ev(`(async()=>{
  const p = window.__spike.pages.get(window.__want);
  const box = p.div.getBoundingClientRect();
  const x = Math.round(box.left+box.width/2), y = Math.round(box.top+box.height/2);
  const before = p.svg.childElementCount;
  p.div.dispatchEvent(new MouseEvent('mousemove',{clientX:x,clientY:y,bubbles:true}));
  await new Promise(r=>setTimeout(r,250));
  const afterHover = { overlay: p.svg.childElementCount, menu: !document.getElementById('pageMenu').hidden };
  p.div.dispatchEvent(new MouseEvent('click',{clientX:x,clientY:y,bubbles:true}));
  await new Promise(r=>setTimeout(r,400));
  const afterClick = { playing: document.getElementById('state').textContent.startsWith('speaking') };
  p.div.dispatchEvent(new MouseEvent('contextmenu',{clientX:x,clientY:y,bubbles:true,cancelable:true}));
  await new Promise(r=>setTimeout(r,200));
  const m = document.getElementById('pageMenu');
  return { before, afterHover, afterClick, menuOpen: !m.hidden,
           items: [...m.querySelectorAll('button')].map(b=>b.textContent.replace(/\\s+/g,' ').trim()) };
})()`);
console.log("interaction:", JSON.stringify(inter));
await shot("ui-3-menu.png");

// ---- the same, inside a site's sandboxed chapter iframe ---------------
// Events inside an iframe never reach the parent, so every one of these is a
// separate path from the PDF case above and has to be checked separately.
await ev(`document.getElementById('toLibrary').click()`);
const site = await ev(`(async()=>{
  await new Promise(r=>setTimeout(r,900));
  const l = await window.blitz.library.list();
  const b = l.find(x=>x.kind==='site');
  const want = b.position?.pn ?? 1;
  [...document.querySelectorAll('.shelfCard')].find(c=>c.dataset.id===b.id).querySelector('.cardOpen').click();
  for(let i=0;i<200 && document.body.dataset.view!=='reader';i++) await new Promise(r=>setTimeout(r,150));
  await new Promise(r=>setTimeout(r,3000));

  const v=document.getElementById('viewer');
  const landed = window.__spike.pageAtOffset(v.scrollTop+v.clientHeight/2)?.pn;

  // find a page with a real internal link and right-click it inside the iframe
  let linkMenu=null, plainMenu=null, hoverSafe=null;
  // Land on a page that actually has prose and a link to right-click.
  let p=null, idoc=null, pn=landed;
  for (const cand of [landed, ...Array.from({length: window.__spike.pages.size}, (_,i)=>i+1)]) {
    const q = await window.__spike.renderPage(cand);
    const d = q?.iframe?.contentDocument;
    if (d && [...d.querySelectorAll('p')].some(e=>e.textContent.trim().length>120) && d.querySelector('a[data-external]')) {
      p=q; idoc=d; pn=cand; break;
    }
  }
  if (!idoc) return { fail: 'no page with prose and a link' };
  const fire = (el, type) => {
    const b = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent(type, {clientX:Math.round(b.left+b.width/2), clientY:Math.round(b.top+b.height/2), bubbles:true, cancelable:true}));
  };
  const para = [...idoc.querySelectorAll('p')].find(e=>e.textContent.trim().length>120);
  fire(para,'mousemove');
  await new Promise(r=>setTimeout(r,200));
  hoverSafe = { overlay: p.svg.childElementCount, menu: !document.getElementById('pageMenu').hidden };
  fire(para,'click');
  await new Promise(r=>setTimeout(r,300));
  const clickSafe = document.getElementById('state').textContent.startsWith('speaking');
  fire(para,'contextmenu');
  await new Promise(r=>setTimeout(r,200));
  plainMenu = [...document.getElementById('pageMenu').querySelectorAll('button')].map(x=>x.textContent.replace(/\\s+/g,' ').trim());
  document.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));

  const ext = idoc.querySelector('a[data-external]');
  if (ext) { fire(ext,'contextmenu'); await new Promise(r=>setTimeout(r,200));
    linkMenu = [...document.getElementById('pageMenu').querySelectorAll('button')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()); }

  return { probedPage: pn, title: document.getElementById('docTitle').textContent,
           siteLink: !document.getElementById('openSite').hidden,
           siteHref: document.getElementById('openSite').title,
           counter: document.getElementById('pageNowText').textContent,
           want, landed, hoverSafe, clickSafe, plainMenu, linkMenu,
           selectable: (()=>{ const rr=idoc.createRange(); rr.selectNodeContents(para);
             idoc.getSelection().removeAllRanges(); idoc.getSelection().addRange(rr);
             return (window.__spike.liveSelection()?.text??'').length; })() };
})()`);
console.log("site:", JSON.stringify({ ...site, plainMenu: undefined, linkMenu: undefined }));
await shot("ui-4-site.png");

const siteChecks = site?.fail ? [] : [
  ["site shows an open-in-browser link", site.siteLink && /^https?:/.test(site.siteHref)],
  ["site opens where it was left", site.landed === site.want],
  ["hover inside a chapter does nothing", site.hoverSafe.overlay === 0 && !site.hoverSafe.menu],
  ["click inside a chapter does not read", !site.clickSafe],
  ["right click in a chapter offers to read", (site.plainMenu || []).some(x => /Play from here/.test(x))],
  ["right click on a link offers to open it", (site.linkMenu || []).some(x => /Open link in browser/.test(x))],
  ["chapter text is still selectable", site.selectable > 50],
];
if (site?.fail) console.log("  (site phase skipped:", site.fail + ")");

const checks=[
  ["search filters the shelf", search.hits.length>0 && search.hits.length<search.all],
  ["search can find nothing, and says so", search.none.cards===0 && /matches/.test(search.none.msg)],
  ["clearing search restores the shelf", search.back===search.all],
  ["title in the rail", open1.title.length>4 && !/^\d+ pages/.test(open1.title)],
  ["counter shows page out of total", /^\d+ \/ \d+$/.test(open1.counter) && open1.counterShown],
  ["opens on the page it was left", open1.at===open1.want],
  ["no play/stop buttons", open1.noPlayButton],
  ["hover paints nothing", inter.afterHover.overlay===inter.before && !inter.afterHover.menu],
  ["left click does not start reading", !inter.afterClick.playing],
  ["right click offers to read", inter.menuOpen && inter.items.some(t=>/Play from here/.test(t))],
  ["and offers copy + note", inter.items.some(t=>/Copy/.test(t)) && inter.items.some(t=>/Note/.test(t))],
  ["exit is visible with the panel open", chrome.exitOpenW > 40],
  ["exit is still visible with the panel shut", chrome.exitShutW > 40],
  ["the panel collapses completely", chrome.railShutW === 0],
  ["its handle sits on the left edge, centred", chrome.handleLeft === 0 && Math.abs(chrome.handleMidY - chrome.windowMidY) < 40],
  ...siteChecks,
  ["no page errors", errs.length===0],
];
let bad=0; for(const[n,ok] of checks){console.log(`${ok?"  ok  ":"FAIL  "}${n}`);if(!ok)bad++;}
if(errs.length) console.log("errors:", errs.slice(0,4).join(" | "));
done(bad?1:0,bad?`\n${bad} failed`:"\nall checks passed");
