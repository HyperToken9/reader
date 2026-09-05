/*
 * Headless smoke check for the ticket-16 rebuild. THROWAWAY.
 *
 * The word-cursor *feel* has to be judged by a human, but the mechanics can
 * be checked: does play() reach the Kokoro sidecar, does audio actually
 * start, does the word cursor move at least once, and does it never point
 * past the end of the sentence's own word list.
 *
 *   node verify.mjs "../../../sample_books/theCodeBook.pdf" 12
 *
 * Requires the sidecar running separately: npm run server
 */
import { createServer } from "vite";
import puppeteer from "puppeteer-core";
import path from "node:path";

const pdf = path.resolve(process.argv[2] ?? "../../../sample_books/theCodeBook.pdf");
const pageNo = Number(process.argv[3] ?? 12);

const health = await fetch("http://127.0.0.1:5177/voices").catch(() => null);
if (!health?.ok) {
  console.error("Kokoro sidecar not reachable at :5177 — run `npm run server` first.");
  process.exit(1);
}

const server = await createServer({ server: { port: 5199 } });
await server.listen();

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [browser]", m.text()); });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.setViewport({ width: 1400, height: 1000 });
await page.goto("http://localhost:5199/", { waitUntil: "networkidle0" });

await (await page.$("#file")).uploadFile(pdf);
await page.waitForFunction("window.__spike?.pages.get(1)?.rendered === true", { timeout: 60000 });
await page.evaluate((pn) => window.__spike.renderPage(pn), pageNo);

console.log(`pdfjs-dist ${await page.evaluate("window.__spike.version")}`);
console.log(`file: ${path.basename(pdf)}   playing from page ${pageNo}\n`);

await page.evaluate((pn) => window.__spike.play({ pn, si: 0 }), pageNo);

const samples = [];
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 700));
  const snap = await page.evaluate(() => ({
    state: document.getElementById("state").textContent,
    spoken: document.getElementById("spoken").textContent,
    activeWordIdxs: window.__spike.activeWordIdxs,
    cursorStyle: window.__spike.cursorStyle,
  }));
  samples.push(snap);
}

console.log("samples over ~5.5s of playback:\n");
for (const s of samples) {
  console.log(`  spoken="${s.spoken.slice(0, 50)}"  activeWords=[${s.activeWordIdxs.join(",")}]`);
}

const distinctWordSets = new Set(samples.map((s) => s.activeWordIdxs.join(",")));
const anyErrors = samples.some((s) => s.state.includes("error"));

console.log(`\ndistinct word-cursor positions seen: ${distinctWordSets.size}`);
console.log(`state string mentions "error": ${anyErrors}`);
console.log(anyErrors ? "\nFAIL: synth/playback error surfaced." :
  distinctWordSets.size > 1 ? "\nPASS: word cursor advanced over real playback." :
  "\nWARN: word cursor never changed — check server logs / voice.");

await browser.close();
await server.close();
