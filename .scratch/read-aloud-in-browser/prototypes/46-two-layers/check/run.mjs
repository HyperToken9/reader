// PROTOTYPE 46 — throwaway automated check. Launches its OWN Chrome for Testing with a throwaway
// profile, loads the unpacked extension, and drives it on the #45 pages.
// Usage: node check/run.mjs [profileDir] [onlyPageId]
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '../extension');
const shots = path.resolve(here, '../screenshots');
fs.mkdirSync(shots, { recursive: true });
const require = createRequire(process.env.P46_PUPPETEER || '/home/homefree/.npm/_npx/7d92d9a2d2ccc630/node_modules/');
const puppeteer = require('puppeteer');
const profile = process.argv[2] || '/home/homefree/.claude/jobs/ec2bb647/tmp/p46-profile';
const only = process.argv[3];

const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(fs.readFileSync(path.join(here, 'edge-cases.html'))); }).listen(0);
const port = server.address().port;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.P46_CHROME || '/home/homefree/.cache/puppeteer/chrome/linux-151.0.7922.47/chrome-linux64/chrome', // Chrome for Testing: still honours unpacked extensions
  userDataDir: profile,
  pipe: true,
  enableExtensions: [ext],
  args: ['--window-size=1280,900', '--lang=en-GB'],
  defaultViewport: { width: 1280, height: 900 },
});
const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
const worker = await swTarget.worker();

async function send(page, msg) {
  const url = page.url();
  return worker.evaluate(async (url, msg) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url === url) || tabs.find(t => t.active);
    return self.p46send(tab.id, msg);
  }, url, msg);
}

async function bbcUrl(page) {
  await page.goto('https://www.bbc.com/news', { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page.evaluate(() => { const a = [...document.querySelectorAll('a[href*="/news/articles/"]')][0]; return a && a.href; });
}

const pages = [
  { id: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Range' },
  { id: 'bbc', url: null },
  { id: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Speech_synthesis' },
  { id: 'rustbook-coal', url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', theme: 'coal' },
  { id: 'paulgraham', url: 'https://paulgraham.com/greatwork.html' },
  { id: 'github', url: 'https://github.com/mozilla/readability' },
  { id: 'edge-cases', url: `http://127.0.0.1:${port}/edge-cases.html` },
];

// The k-th long visible text node in the page's main area (paragraph-ish prose), scrolled to centre.
const longText = k => {
  const root = document.querySelector('article, main, [role=main]') || document.body;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const ts = []; let n;
  while ((n = tw.nextNode())) if (n.data.trim().length > 70 && n.parentElement.checkVisibility() && !n.parentElement.closest('pre,code,a,nav,figcaption,header')) ts.push(n);
  const t = ts[Math.min(k, ts.length - 1)];
  if (t) { // scroll the text itself (not its parent: on PG the parent is the whole essay) to mid-screen
    const r = document.createRange(); r.selectNodeContents(t);
    window.scrollBy({ top: r.getBoundingClientRect().top - innerHeight / 2, behavior: 'instant' });
  }
  return t;
};
const pointAt = (page, k) => page.evaluate((k, src) => {
  const t = eval(src)(k); if (!t) return null;
  const off = t.data.search(/\S/);
  const r = document.createRange(); r.setStart(t, off); r.setEnd(t, off + 1);
  const rect = r.getClientRects()[0];
  return { x: rect.left + 2, y: rect.top + rect.height / 2, text: t.data.trim().slice(0, 80) };
}, k, longText.toString());

const results = {};
for (const pg of pages) {
  if (only && pg.id !== only) continue;
  const page = await browser.newPage();
  const res = (results[pg.id] = { errors: [] });
  page.on('console', m => { if (m.text().startsWith('[p46]')) res.errors.push(m.text()); });
  page.on('pageerror', e => res.errors.push('pageerror: ' + e.message));
  try {
    if (pg.theme) await page.evaluateOnNewDocument(t => { try { localStorage.setItem('mdbook-theme', t); } catch (e) {} }, pg.theme);
    let url = pg.url;
    if (pg.id === 'bbc') url = await bbcUrl(page);
    res.url = url;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => res.errors.push('goto: ' + e.message));
    await sleep(1500);
    // dismiss cookie banners crudely
    await page.evaluate(() => { for (const b of document.querySelectorAll('button')) if (/^(accept|agree|i agree|yes, i agree|ok)$/i.test(b.innerText.trim())) b.click(); }).catch(() => {});
    await sleep(500);
    // BBC's "Register for a free BBC account" wall: close it
    await page.evaluate(() => { for (const b of document.querySelectorAll('button[aria-label], [role=dialog] button')) if (/close|dismiss|not now|maybe later/i.test(b.getAttribute('aria-label') || b.innerText)) b.click(); }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(500);
    if (pg.id === 'edge-cases') {
      // Read this inside an open shadow root -> getComposedRanges
      await page.evaluate(() => { const t = document.querySelector('open-card').shadowRoot.querySelector('p').firstChild; getSelection().setBaseAndExtent(t, 5, t, 40); });
      res.readThisShadow = await send(page, { cmd: 'readThis' });
      await sleep(1200);
      await page.screenshot({ path: path.join(shots, 'edge-cases-shadow-readthis.png') });
      await send(page, { cmd: 'stop' });
    }
    // idle baseline for the frame metric (same double-rAF measure, nothing painting)
    res.baselineFrameMs = await page.evaluate(async () => {
      const a = []; for (let i = 0; i < 30; i++) { const t0 = performance.now(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); a.push(performance.now() - t0); await new Promise(r => setTimeout(r, 60)); }
      a.sort((x, y) => x - y); return { p50: +a[15].toFixed(1), p95: +a[28].toFixed(1) };
    });
    // 1) Read from here: a real right-click (captures coordinates), then the menu's message
    const pt = await pointAt(page, 2);
    res.clickedParagraph = pt && pt.text;
    if (pt) await page.mouse.click(pt.x, pt.y, { button: 'right' });
    await page.keyboard.press('Escape').catch(() => {});
    res.readFromHere = await send(page, { cmd: 'readFromHere' });
    await sleep(2500);
    await send(page, { cmd: 'set', s: { info: true } });
    await sleep(800);
    res.midRead = await send(page, {});
    await page.screenshot({ path: path.join(shots, `${pg.id}-1-read-from-here.png`) });
    // 2) click-to-jump on a later paragraph
    const pt2 = await pointAt(page, 5);
    if (pt2) { await page.mouse.click(pt2.x + 1, pt2.y); await sleep(300); res.jump = { clicked: pt2.text, ...(await send(page, {})) }; }
    await send(page, { cmd: 'set', s: { place: 'near', cursor: 'tint', dim: 'strong' } });
    await sleep(1500);
    await page.screenshot({ path: path.join(shots, `${pg.id}-2-jump-near-tint-strong.png`) });
    // 3) perf: per word, incremental vs full re-registration, at 2x
    for (const perf of ['incremental', 'full']) {
      await send(page, { cmd: 'set', s: { perf, speed: 2, place: 'bottom', cursor: 'dim', dim: 'medium' } });
      await page.evaluate(() => window.dispatchEvent(new Event('p46-reset-timings')));
      await sleep(6000);
      const st = await send(page, {});
      res['perf_' + perf] = { wordMs: st.wordMs, frameMs: st.frameMs, dimRebuildMs: st.dimRebuildMs, runs: st.runs, colours: st.colours };
    }
    await send(page, { cmd: 'set', s: { perf: 'incremental', speed: 1, dim: 'light' } });
    await sleep(800);
    await page.screenshot({ path: path.join(shots, `${pg.id}-3-light-bottom.png`) });
    await send(page, { cmd: 'stop' });
    // 4) Read this on a selection inside a later paragraph
    await page.evaluate(src => {
      const t = eval(src)(8); if (!t) return;
      const off = t.data.search(/\S/);
      getSelection().setBaseAndExtent(t, off + 3, t, Math.min(t.data.length, off + 60));
      window.__p46sel = getSelection().toString();
    }, longText.toString());
    res.selection = await page.evaluate(() => window.__p46sel);
    res.readThis = await send(page, { cmd: 'readThis' });
    await sleep(1200);
    await page.screenshot({ path: path.join(shots, `${pg.id}-4-read-this.png`) });
    await send(page, { cmd: 'stop' });
  } catch (e) { res.errors.push(String(e && e.stack || e)); }
  console.log(pg.id, JSON.stringify(res, null, 1).slice(0, 4000));
  await page.close();
}
fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 1));
await browser.close();
server.close();
