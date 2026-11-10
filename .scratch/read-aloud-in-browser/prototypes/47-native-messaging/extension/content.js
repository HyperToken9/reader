/*
 * PROTOTYPE 47 content script. Remembers where the context menu was opened,
 * hands the service worker the sentence there plus every sentence after it,
 * and logs each word as the offscreen clock fires it.
 *
 * Each word is also posted to the page (window.postMessage) so a test page
 * can collect them; the content script's own world is not reachable from it.
 */
const BLOCKS = "p,li,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,td,th,pre,figcaption";
const seg = new Intl.Segmenter("en", { granularity: "sentence" });
let lastClick = null;

addEventListener("contextmenu", (e) => (lastClick = { x: e.clientX, y: e.clientY, target: e.target }), true);

function sentencesOf(text) {
  return [...seg.segment(text)].map((x) => ({ index: x.index, text: x.segment }));
}

function sentencesFromClick() {
  if (!lastClick) return [];
  const { x, y, target } = lastClick;
  const pos = document.caretPositionFromPoint?.(x, y);
  const node = pos?.offsetNode ?? target;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const block = el.closest(BLOCKS) ?? target;
  let at = 0;
  if (pos && block.contains(pos.offsetNode)) {
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(pos.offsetNode, pos.offset);
    at = r.toString().length;
  }
  const own = sentencesOf(block.textContent);
  const i = Math.max(0, own.findIndex((s) => at >= s.index && at < s.index + s.text.length));
  const out = own.slice(i).map((s) => s.text);
  for (const b of document.querySelectorAll(BLOCKS)) {
    if (b === block || block.contains(b) || b.contains(block)) continue;
    if (!(block.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (b.querySelector(BLOCKS)) continue; // read leaf blocks only
    out.push(...sentencesOf(b.textContent).map((s) => s.text));
    if (out.length > 400) break;
  }
  return out.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.type === "sentences-from-click") {
    reply(sentencesFromClick());
    return;
  }
  if (m.type === "word") {
    const tRecv = performance.timeOrigin + performance.now();
    console.log(`[blitz] word "${m.text}" s${m.k}#${m.i} at ${(m.ctxT).toFixed(3)} s audio, ${(tRecv - m.tAudio).toFixed(1)} ms after it was heard`);
    postMessage({ p47: "word", ...m, tRecv }, "*");
  }
  if (m.type === "sentence-playing") {
    postMessage({ p47: "sentence", ...m, tRecv: performance.timeOrigin + performance.now() }, "*");
  }
});

console.log("[blitz] content script up");
chrome.runtime.sendMessage({ to: "sw", type: "hello" }).catch(() => {});
