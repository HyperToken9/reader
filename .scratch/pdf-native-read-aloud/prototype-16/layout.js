/*
 * TICKET 06 — reading order via the layout model. THROWAWAY PROTOTYPE.
 *
 * [[12]] measured PP-DocLayoutV2.onnx returning region boxes already sorted
 * in reading order (a pointer network, not a post-hoc XY-cut) at ~731ms/page
 * via onnxruntime-node. ppu-doclayout also ships a browser build on
 * onnxruntime-web (WASM) -- slower, but it means this runs inside the same
 * Vite app with no second sidecar. It takes the already-rendered PDF.js
 * <canvas> directly; no re-encode to PNG needed.
 */
import { DocLayoutService } from "ppu-doclayout/web";

let servicePromise = null;
function getService() {
  if (!servicePromise) {
    const svc = new DocLayoutService({ detection: { threshold: 0.4 } });
    servicePromise = svc.initialize().then(() => svc);
  }
  return servicePromise;
}

// DocLayoutService's session is not reentrant: two analyze() calls in
// flight at once on the same service throw "Session already started" /
// "Session mismatch" (reproduced by rendering two pages in quick
// succession — [[16]]'s own IntersectionObserver-driven prefetch does
// exactly that). Serialize every call through one promise chain, same
// shape as server.py's synthesis queue and for the same underlying reason:
// this is one shared inference session, not a pool.
let queue = Promise.resolve();

/**
 * Analyze a rendered page canvas. Returns regions as page-fraction rects,
 * in the model's reading order (index 0 = read first).
 */
export function analyzeLayout(canvas) {
  const run = queue.then(() => runAnalyze(canvas));
  queue = run.then(() => {}, () => {}); // never let one page's failure jam the queue
  return run;
}

async function runAnalyze(canvas) {
  const svc = await getService();
  const { boxes } = await svc.analyze(canvas);
  const w = canvas.width, h = canvas.height;
  return boxes.map((b) => ({
    label: b.label,
    score: b.score,
    x: b.box[0] / w,
    y: b.box[1] / h,
    w: (b.box[2] - b.box[0]) / w,
    h: (b.box[3] - b.box[1]) / h,
  }));
}
