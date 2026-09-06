/*
 * Document layout (PP-DocLayoutV2) in the Electron main process.
 *
 * This is prototype 16's layout-server.mjs with the HTTP hop removed: in the
 * prototype the model had to live outside the browser tab (running it in-page
 * under onnxruntime-web cost 86s on the first page and froze scrolling), so it
 * became a localhost sidecar. Under Electron the main process IS the outside,
 * so the renderer reaches it over IPC and nothing listens on a port.
 */
import { DocLayoutService } from "ppu-doclayout";

let servicePromise = null;

function getService() {
  if (!servicePromise) {
    const svc = new DocLayoutService({ detection: { threshold: 0.4 } });
    servicePromise = svc.initialize().then(() => svc);
  }
  return servicePromise;
}

// The ONNX session is not reentrant: two analyze() calls in flight throw
// "Session already started". One chain, same as the TTS engine's single worker.
let queue = Promise.resolve();

export function analyze(pngBuffer) {
  const run = queue.then(async () => {
    const svc = await getService();
    const { boxes } = await svc.analyze(pngBuffer);
    return boxes;
  });
  queue = run.then(() => {}, () => {});
  return run;
}

/** Warm the model without blocking startup. Resolves false if it can't load. */
export async function warm() {
  try {
    await getService();
    return true;
  } catch (e) {
    console.error("[layout] init failed:", e);
    return false;
  }
}

export const isReady = () => servicePromise !== null;
