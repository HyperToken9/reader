// PROTOTYPE 48 (throwaway): is WebGPU available in this Linux Chrome, and with which flags?
// node scripts/gpu_probe.mjs <headless|headed> <flagset-name>
import puppeteer from "puppeteer-core";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
const srv = createServer((q, r) => r.end("<!doctype html><title>probe</title>")).listen(0);
const PORT = srv.address().port;
const TMP = "/home/homefree/.claude/jobs/ec2bb647/tmp";
export const FLAGSETS = {
  none: [],
  unsafe: ["--enable-unsafe-webgpu"],
  vulkan: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
  vulkan_angle: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"],
  angle_vk_native: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan", "--use-vulkan=native"],
  ignore: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist"],
};
const [mode = "headless", set = "none"] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: mode === "headless",
  userDataDir: mkdtempSync(TMP + "/chrome48-probe-"),
  args: ["--no-first-run", "--no-default-browser-check", "--mute-audio", ...FLAGSETS[set]],
});
const page = await browser.newPage();
await page.goto("chrome://gpu");
await new Promise((r) => setTimeout(r, 2000));
const gpuText = await page.evaluate(() => {
  const walk = (n) => {
    let s = "";
    if (n.shadowRoot) s += walk(n.shadowRoot);
    for (const c of n.childNodes) s += c.nodeType === 3 ? c.textContent : walk(c);
    if (n.nodeType === 1 && /^(TR|DIV|LI|H\d|P)$/.test(n.tagName)) s += "\n";
    return s;
  };
  return walk(document.body).replace(/[ \t]+/g, " ");
});
const pick = (re) => (gpuText.match(re) || [])[0];
await page.goto(`http://localhost:${PORT}/`);
const res = await page.evaluate(async () => {
  if (!navigator.gpu) return { navigatorGpu: false };
  const out = { navigatorGpu: true };
  for (const pp of [undefined, "high-performance", "low-power"]) {
    const a = await navigator.gpu.requestAdapter(pp ? { powerPreference: pp } : undefined);
    out[pp ?? "default"] = a
      ? { vendor: a.info?.vendor, architecture: a.info?.architecture, device: a.info?.device, description: a.info?.description, f16: a.features.has("shader-f16"), maxBuf: a.limits.maxBufferSize, fallback: a.info?.isFallbackAdapter }
      : null;
  }
  return out;
});
console.log(JSON.stringify({ mode, set, flags: FLAGSETS[set], version: await browser.version(), webgpuStatus: pick(/WebGPU:[^\n]*/), vulkanStatus: pick(/Vulkan:[^\n]*/), glRenderer: pick(/GL_RENDERER[^\n]*/), ...res }));
await browser.close();
srv.close();
