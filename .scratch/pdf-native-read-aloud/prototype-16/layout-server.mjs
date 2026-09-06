/*
 * TICKET 06 — layout sidecar. THROWAWAY PROTOTYPE, not production code.
 *
 * Why this is a server and not browser code: an earlier revision ran
 * ppu-doclayout's browser build (onnxruntime-web/WASM) in the page. Measured
 * in the stress harness, that cost 86s on the first page (a 213 MB model
 * downloaded into the tab, every session) and ~7s per page after, all on the
 * browser's main thread -- with layout on, scrolling made the tab so
 * unresponsive that a trivial scroll loop couldn't complete in 180s. That is
 * the reported "crashing instantaneously."
 *
 * Native onnxruntime-node runs the same model at ~731ms/page ([[12]]'s
 * measurement) in a process that isn't the one painting the UI, and the
 * model is fetched once to a disk cache instead of into every tab. The
 * browser sends a PNG of the page it already rendered (a few hundred KB) and
 * gets boxes back.
 *
 * POST /analyze  (image/png body) -> { boxes: [{label, score, box:[x1,y1,x2,y2]}] }
 *   Boxes are in the submitted image's pixel space, in the model's reading order.
 * GET  /health -> { ok, ready }
 */
import { createServer } from "node:http";
import { DocLayoutService } from "ppu-doclayout";

const PORT = 5178;

let servicePromise = null;
function getService() {
  if (!servicePromise) {
    const svc = new DocLayoutService({ detection: { threshold: 0.4 } });
    servicePromise = svc.initialize().then(() => {
      console.log("[layout] model ready");
      return svc;
    });
  }
  return servicePromise;
}

// The ONNX session is not reentrant: two analyze() calls in flight throw
// "Session already started" / "Session mismatch" (reproduced in the browser
// version by rendering two pages back to back). One chain, same as the TTS
// sidecar's single worker, and for the same reason.
let queue = Promise.resolve();
function analyze(buf) {
  const run = queue.then(async () => {
    const svc = await getService();
    return svc.analyze(buf);
  });
  queue = run.then(() => {}, () => {});
  return run;
}

const cors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
};
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  cors(res);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

createServer((req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
  if (req.url === "/health") {
    return json(res, 200, { ok: true, ready: servicePromise !== null });
  }
  if (req.method !== "POST" || req.url !== "/analyze") return json(res, 404, { error: "not found" });

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const t0 = Date.now();
    try {
      const { boxes } = await analyze(Buffer.concat(chunks));
      console.log(`[layout] ${boxes.length} regions in ${Date.now() - t0}ms`);
      json(res, 200, { boxes });
    } catch (e) {
      console.error("[layout] analyze failed:", e);
      json(res, 500, { error: String(e?.message ?? e) });
    }
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[layout] sidecar on http://127.0.0.1:${PORT} (model loads on first request)`);
  getService().catch((e) => console.error("[layout] init failed:", e));
});
