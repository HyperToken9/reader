/*
 * Headless smoke check for the ticket-05 spike. THROWAWAY.
 *
 * The *experience* has to be judged by a human, but the geometry pipeline can
 * be checked mechanically: does every sentence get plausible page-fraction
 * rects, do they run down the page in order, and does zoom leave them alone?
 *
 *   npm run verify -- "../../../sample_books/theCodeBook.pdf" 40
 */
import { createServer } from "vite";
import puppeteer from "puppeteer-core";
import path from "node:path";

const pdf = path.resolve(process.argv[2] ?? "../../../sample_books/theCodeBook.pdf");
const pageNo = Number(process.argv[3] ?? 40);

const server = await createServer({ server: { port: 5199 } });
await server.listen();

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [browser]", m.text()); });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.setViewport({ width: 1400, height: 1000 });
await page.goto("http://localhost:5199/", { waitUntil: "networkidle0" });

await (await page.$("#file")).uploadFile(pdf);
await page.waitForFunction("window.__spike?.pages.get(1)?.rendered === true", { timeout: 60000 });

const probe = async (pn) =>
  page.evaluate(async (pn) => {
    const p = await window.__spike.renderPage(pn);
    return {
      pn,
      count: p.sentences.length,
      sample: p.sentences.slice(0, 12).map((s) => ({
        text: s.text.length > 90 ? s.text.slice(0, 87) + "…" : s.text,
        rects: s.rects.length,
        y: +s.rects[0].y.toFixed(4),
        x: +s.rects[0].x.toFixed(4),
        w: +s.rects[0].w.toFixed(4),
        h: +s.rects[0].h.toFixed(4),
      })),
      outOfBounds: p.sentences.filter((s) =>
        s.rects.some((r) => r.x < -0.02 || r.y < -0.02 || r.x + r.w > 1.02 || r.y + r.h > 1.02)),
      tallRects: p.sentences.filter((s) => s.rects.some((r) => r.h > 0.06)).length,
      ys: p.sentences.map((s) => +s.rects[0].y.toFixed(5)),
      firstRects: JSON.stringify(p.sentences[0]?.rects ?? []),
    };
  }, pn);

console.log(`\npdfjs-dist ${await page.evaluate("window.__spike.version")}`);
console.log(`file: ${path.basename(pdf)}   probing page ${pageNo}\n`);

const before = await probe(pageNo);
console.log(`sentences on page ${pageNo}: ${before.count}`);
console.log(`rects out of 0..1 bounds: ${before.outOfBounds.length}`);
console.log(`sentences with an over-tall rect (>6% of page): ${before.tallRects}`);

const inversions = before.ys.filter((y, i) => i > 0 && y < before.ys[i - 1] - 0.005).length;
console.log(`reading-order inversions (a sentence starting above its predecessor): ${inversions}`);

console.log("\nfirst sentences as Intl.Segmenter cut them:");
for (const s of before.sample) {
  console.log(`  [${String(s.rects).padStart(2)} rect] y=${s.y.toFixed(3)} h=${s.h.toFixed(4)}  ${JSON.stringify(s.text)}`);
}

// zoom must cost the overlay nothing (02 §6)
await page.evaluate(() => {
  const z = document.getElementById("zoom");
  z.value = "2.4";
  z.dispatchEvent(new Event("input"));
});
await new Promise((r) => setTimeout(r, 2500));
const after = await probe(pageNo);
console.log(`\nafter zoom 1.2 -> 2.4: sentence count ${after.count}, rects identical: ${after.firstRects === before.firstRects}`);

const voices = await page.evaluate(() => speechSynthesis.getVoices().map((v) => `${v.name} (${v.lang})`));
console.log(`\nvoices visible to this (headless) browser: ${voices.length ? voices.join(", ") : "none — check in a real browser"}`);

await browser.close();
await server.close();
