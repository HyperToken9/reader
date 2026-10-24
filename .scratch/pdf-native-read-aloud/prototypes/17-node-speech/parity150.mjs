// Question A, extra row: system espeak-ng 1.50 *library* through the same FFI + port.
import { readFileSync } from "node:fs";
import { ffiBackend, makePhonemize } from "./phon.mjs";
const ref = JSON.parse(readFileSync(new URL("./out/py_phon.json", import.meta.url)));
const A = new URL("./dl/apt/root/usr/lib/x86_64-linux-gnu", import.meta.url).pathname;
const b = await ffiBackend(A + "/libespeak-ng.so.1", A + "/espeak-ng-data");
const ph = makePhonemize(b.raw);
let s = 0, w = 0, n = 0;
for (const r of ref) {
  if ((await ph(r.text)).split(/\s+/).join(" ") === r.sent) s++;
  for (const [x, p] of r.words) { n++; if ((await ph(x)) === p) w++; }
}
console.log(`espeak-ng ${b.version} lib via FFI: sentences ${s}/${ref.length}, words ${w}/${n} (${(100*w/n).toFixed(2)}%)`);
