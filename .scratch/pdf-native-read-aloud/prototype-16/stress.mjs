/* Stress harness for ticket 16. THROWAWAY. Drives the real app hard and
   reports crashes, console errors, unhandled rejections and memory growth. */
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

const pdf = process.argv[2] ?? "/home/homefree/Development/blitz/sample_books/theCodeBook.pdf";
const server = await createServer({ server: { port: 5899 } });
await server.listen();

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

const errors = [], warnings = [];
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error") errors.push(t);
  else if (m.type() === "warning" && !t.includes("[vite]")) warnings.push(t);
});
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on("error", (e) => errors.push(`CRASH: ${e.message}`));
page.on("requestfailed", (r) => {
  const f = r.failure()?.errorText ?? "";
  if (!f.includes("ERR_ABORTED")) errors.push(`REQFAIL ${r.url().slice(-60)} ${f}`);
});

const mem = async (label) => {
  try {
    const m = await page.evaluate(() => performance.memory
      ? { used: Math.round(performance.memory.usedJSHeapSize / 1e6), limit: Math.round(performance.memory.jsHeapSizeLimit / 1e6) }
      : null);
    console.log(`  [mem ${label}] ${m ? m.used + "MB / " + m.limit + "MB" : "n/a"}`);
    return m?.used ?? 0;
  } catch (e) { console.log(`  [mem ${label}] FAILED: ${e.message}`); return -1; }
};

const alive = async () => {
  try { return await page.evaluate(() => Boolean(window.__spike)); }
  catch (e) { return `DEAD: ${e.message}`; }
};

console.log(`\n=== stress: ${pdf.split("/").pop()} ===`);
await page.goto("http://localhost:5899/", { waitUntil: "networkidle0" });
await (await page.$("#file")).uploadFile(pdf);
await page.waitForFunction("window.__spike?.pages.get(1)?.rendered === true", { timeout: 90000 });
const numPages = await page.evaluate(() => window.__spike.pages.size);
console.log(`loaded, ${numPages} pages`);
const m0 = await mem("after load");

// --- 1. fast scroll, the reported "scroll test" ---
console.log("\n[1] fast scroll through 60 pages");
const t1 = Date.now();
await page.evaluate(async () => {
  const v = document.getElementById("viewer");
  for (let i = 0; i < 60; i++) {
    v.scrollTop += 1400;
    await new Promise((r) => setTimeout(r, 30));
  }
});
console.log(`  scrolled in ${Date.now() - t1}ms, alive=${await alive()}`);
const m1 = await mem("after scroll");

// --- 2. playback + interruptions ---
console.log("\n[2] play, then interrupt with 12 rapid sentence jumps");
await page.evaluate(() => { document.getElementById("viewer").scrollTop = 0; });
await page.evaluate((n) => window.__spike.renderPage(n), 12);
await page.evaluate(() => window.__spike.play({ pn: 12, si: 0 }));
await new Promise((r) => setTimeout(r, 2500));
for (let i = 0; i < 12; i++) {
  await page.evaluate((si) => {
    const p = window.__spike.pages.get(12);
    if (p && si < p.sentences.length) { window.__spike.stop(); window.__spike.play({ pn: 12, si }); }
  }, i % 8);
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`  alive=${await alive()}`);
const m2 = await mem("after jumps");

// --- 3. zoom while playing ---
console.log("\n[3] zoom churn while playing");
for (const z of [2.0, 0.7, 1.6, 1.2]) {
  await page.evaluate((zz) => {
    const el = document.getElementById("zoom");
    el.value = String(zz);
    el.dispatchEvent(new Event("input"));
  }, z);
  await new Promise((r) => setTimeout(r, 600));
}
console.log(`  alive=${await alive()}`);
const m3 = await mem("after zoom");

// --- 4. let it read continuously ---
console.log("\n[4] continuous playback for 20s");
await page.evaluate(() => { window.__spike.stop(); window.__spike.play({ pn: 12, si: 0 }); });
let lastState = "";
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await page.evaluate(() => document.getElementById("state").textContent.split("\n")[1]);
  if (s !== lastState) { console.log(`  ${s}`); lastState = s; }
}
console.log(`  alive=${await alive()}`);
const m4 = await mem("after 20s read");

console.log(`\n=== RESULT ===`);
console.log(`memory: ${m0} -> ${m1} -> ${m2} -> ${m3} -> ${m4} MB`);
console.log(`errors: ${errors.length}`);
[...new Set(errors)].slice(0, 20).forEach((e) => console.log("  ERR:", e.slice(0, 200)));
console.log(`warnings: ${warnings.length}`);
[...new Set(warnings)].slice(0, 8).forEach((w) => console.log("  WARN:", w.slice(0, 160)));

await browser.close();
await server.close();
