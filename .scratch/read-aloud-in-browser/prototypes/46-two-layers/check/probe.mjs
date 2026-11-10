// PROTOTYPE 46 — debugging aid: node check/probe.mjs <url> [js-to-run-in-page-main-world-returning-{x,y}]
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire('/home/homefree/.npm/_npx/7d92d9a2d2ccc630/node_modules/');
const puppeteer = require('puppeteer');
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [path.resolve(here, '../extension')],
  executablePath: '/home/homefree/.cache/puppeteer/chrome/linux-151.0.7922.47/chrome-linux64/chrome',
  userDataDir: '/home/homefree/.claude/jobs/ec2bb647/tmp/p46-probe', defaultViewport: { width: 1280, height: 900 } });
const sw = await browser.waitForTarget(t => t.type() === 'service_worker');
const worker = await sw.worker();
const page = await browser.newPage();
await page.goto(process.argv[2], { waitUntil: 'networkidle2', timeout: 60000 });
const pt = process.argv[3] ? await page.evaluate(process.argv[3]) : { x: 400, y: 400 };
const out = await worker.evaluate(async msg => { const [t] = await chrome.tabs.query({ active: true }); return self.p46send(t.id, msg); }, { cmd: 'probe', ...pt });
console.log(JSON.stringify({ pt, out }, null, 1));
if (process.argv[4]) console.log(await page.evaluate(process.argv[4]));
await browser.close();
