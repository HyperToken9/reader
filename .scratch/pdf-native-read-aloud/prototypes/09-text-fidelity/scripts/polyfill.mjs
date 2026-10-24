// Node 22 lacks a few ES2025+ builtins the modern (non-legacy) pdfjs build uses.
// Polyfill them so we run the SAME build/pdf.mjs the app bundles, not legacy/.
if (!Promise.try) Promise.try = function (fn, ...a) { return new Promise((r) => r(fn(...a))); };
if (!Map.prototype.getOrInsertComputed) Map.prototype.getOrInsertComputed = function (k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); };
if (!Map.prototype.getOrInsert) Map.prototype.getOrInsert = function (k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); };
if (!WeakMap.prototype.getOrInsertComputed) WeakMap.prototype.getOrInsertComputed = Map.prototype.getOrInsertComputed;
if (!Uint8Array.prototype.toHex) Uint8Array.prototype.toHex = function () { return Buffer.from(this).toString("hex"); };
if (!Uint8Array.fromBase64) Uint8Array.fromBase64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
if (!Uint8Array.prototype.toBase64) Uint8Array.prototype.toBase64 = function () { return Buffer.from(this).toString("base64"); };
if (!Math.sumPrecise) Math.sumPrecise = (it) => { let s = 0; for (const x of it) s += x; return s; };
