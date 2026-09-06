import { createServer } from "vite";
import puppeteer from "puppeteer-core";
import path from "node:path";
const pdf = path.resolve(process.argv[2]);
const pn = Number(process.argv[3]), si = Number(process.argv[4]);
const server = await createServer({ root: process.cwd(), server: { port: 5198 } });
await server.listen();
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", e => console.log("[pageerror]", e.message));
await page.setViewport({ width: 1500, height: 1100, deviceScaleFactor: 1 });
await page.goto("http://localhost:5198/", { waitUntil: "networkidle0" });
await (await page.$("#file")).uploadFile(pdf);
await page.waitForFunction("window.__spike?.pages.get(1)?.rendered === true", { timeout: 60000 });
await page.evaluate(async (pn) => { await window.__spike.renderPage(pn); }, pn);
for (const [i, key] of [[0,"A"],[1,"B"],[2,"C"]]) {
  const s = await page.evaluate((i, pn, si) => {
    window.__spike.setVariant(i);
    const s = window.__spike.preview(pn, si);
    document.getElementById("pages").children[pn-1].scrollIntoView();
    return s?.text.slice(0, 70);
  }, i, pn, si);
  await new Promise(r => setTimeout(r, 700));
  await page.screenshot({ path: `/tmp/claude-1000/band-${key}.png` });
  console.log(key, "->", JSON.stringify(s));
}
await browser.close(); await server.close();
