#!/usr/bin/env node
/*
 * Put libespeak-ng 1.52 and its English data in vendor/espeak-ng/.
 *
 * The speech engine turns text into phonemes with libespeak-ng, called through
 * koffi (see electron/speech/phonemize.js). It has to be *this* build: 1.52,
 * the one kokoro-onnx itself loads through espeakng-loader, because a
 * different espeak (an older distro package, or the npm WASM build) changes
 * pronunciation and timings. So we take the library and data straight out of
 * espeakng-loader's own wheel, pinned by URL and sha256, rather than whatever
 * the build machine has installed.
 *
 * Only English is kept: the full data is ~10 MB across a hundred languages,
 * and English is ~1 MB. Kokoro is only ever asked for en-us.
 *
 * Runs on `npm install` (postinstall) and before `npm run dist`. Does nothing
 * when the vendored copy is already there and complete.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const WHEEL = {
  url: "https://files.pythonhosted.org/packages/de/1e/25ec5ab07528c0fbb215a61800a38eca05c8a99445515a02d7fa5debcb32/espeakng_loader-0.2.4-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
  sha256: "08721baf27d13d461f6be6eed9a65277e70d68234ff484fd8b9897b222cdcb6d",
};
const LIB = "espeakng_loader/libespeak-ng.so.1.52.0";
const DATA = "espeakng_loader/espeak-ng-data/";
// What espeak reads to speak en-us: the phoneme tables, intonation, the
// English dictionary and the English voice definitions.
const KEEP = [/^phon(data|index|tab)$/, /^intonations$/, /^en_dict$/, /^lang\/gmw\/en(-|$)/];

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(app, "vendor/espeak-ng");
const stamp = join(out, ".wheel-sha256");

if (process.platform !== "linux" || process.arch !== "x64") {
  console.log(`[espeak] no pinned build for ${process.platform}-${process.arch}; speech will be unavailable`);
  process.exit(0);
}
if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === WHEEL.sha256) process.exit(0);

console.log("[espeak] fetching libespeak-ng 1.52 from the espeakng-loader wheel");
const res = await fetch(WHEEL.url);
if (!res.ok) throw new Error(`[espeak] ${WHEEL.url}: HTTP ${res.status}`);
const wheel = new Uint8Array(await res.arrayBuffer());
const got = createHash("sha256").update(wheel).digest("hex");
if (got !== WHEEL.sha256) throw new Error(`[espeak] wheel sha256 ${got}, expected ${WHEEL.sha256}`);

const files = unzipSync(wheel, {
  filter: (f) => f.name === LIB || (f.name.startsWith(DATA) && KEEP.some((re) => re.test(f.name.slice(DATA.length)))),
});
rmSync(out, { recursive: true, force: true });
for (const [name, bytes] of Object.entries(files)) {
  const to = name === LIB ? join(out, "libespeak-ng.so") : join(out, "espeak-ng-data", name.slice(DATA.length));
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, bytes);
}
writeFileSync(stamp, WHEEL.sha256 + "\n");
console.log(`[espeak] ${Object.keys(files).length} files in ${out}`);
