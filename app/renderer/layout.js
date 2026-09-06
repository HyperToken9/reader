/*
 * Document layout, browser half.
 *
 * The model itself runs in the Electron main process (electron/layout.js) --
 * running it in the page under onnxruntime-web cost 86s on the first page and
 * made scrolling unusable. All this file does is hand the already-rendered
 * page canvas across the IPC bridge as a PNG and normalise what comes back.
 */

const canvasToPng = (canvas) =>
  new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))), "image/png");
  });

/**
 * Analyze a rendered page canvas. Returns regions as page-fraction rects, in
 * the model's reading order (index 0 = read first). Rejects if the model
 * isn't available -- the caller keeps DOM order in that case.
 */
export async function analyzeLayout(canvas) {
  const png = await canvasToPng(canvas);
  const boxes = await window.blitz.analyzeLayout(await png.arrayBuffer());

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

/** Has the layout model finished loading? Used to keep the checkbox honest. */
export async function layoutServerReady() {
  try {
    return await window.blitz.layoutReady();
  } catch {
    return false;
  }
}
