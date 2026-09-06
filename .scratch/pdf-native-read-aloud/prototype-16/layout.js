/*
 * TICKET 06 — reading order via the layout model, browser half.
 * THROWAWAY PROTOTYPE.
 *
 * This used to run the model in the page via onnxruntime-web. Measured, that
 * was 86s on the first page (213 MB model pulled into the tab) and ~7s per
 * page after, on the main thread -- enough to make the tab unresponsive
 * while scrolling. All this file does now is hand the already-rendered page
 * canvas to layout-server.mjs as a PNG and normalise what comes back.
 * See layout-server.mjs for the numbers.
 */
const LAYOUT_SERVER = "http://127.0.0.1:5178";

const canvasToPng = (canvas) =>
  new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))), "image/png");
  });

/**
 * Analyze a rendered page canvas. Returns regions as page-fraction rects, in
 * the model's reading order (index 0 = read first). Rejects if the sidecar
 * isn't running -- the caller keeps DOM order in that case.
 */
export async function analyzeLayout(canvas) {
  const png = await canvasToPng(canvas);
  const res = await fetch(`${LAYOUT_SERVER}/analyze`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: png,
  });
  if (!res.ok) throw new Error(`layout ${res.status}: ${await res.text()}`);
  const { boxes } = await res.json();

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

/** Is the sidecar up? Used to keep the checkbox honest. */
export async function layoutServerReady() {
  try {
    const res = await fetch(`${LAYOUT_SERVER}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
