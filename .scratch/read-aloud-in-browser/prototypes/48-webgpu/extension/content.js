// PROTOTYPE 48: the page side. Asks for speech, then keeps a word cursor from the
// timings the offscreen document sends, on the page's own clock. Everything it sees is
// logged in window.__p48 (read by the harness through a DOM attribute).
const now = () => performance.timeOrigin + performance.now();
const log = { sent: null, events: [], highlights: [] };
const flush = () => document.documentElement.setAttribute("data-p48", JSON.stringify(log));

window.addEventListener("message", (e) => {
  if (e.data?.p48 !== "speak") return;
  log.sent = now();
  log.events = [];
  log.highlights = [];
  chrome.runtime.sendMessage({ to: "sw", type: "speak", payload: { ...e.data.payload, tSent: log.sent } });
});

// The cursor: on each "sentence" message (start time on the offscreen's audio clock, mapped
// to wall time there), schedule highlights with this page's own setTimeout clock.
chrome.runtime.onMessage.addListener((m) => {
  if (m.to !== "tab") return;
  const tRecv = now();
  if (m.type === "sentence") {
    for (const sp of m.spans) {
      const at = m.wallStart + sp.start * 1000;
      setTimeout(() => log.highlights.push({ s: m.index, w: sp.words[0], planned: at, shown: now() }), Math.max(0, at - now()));
    }
  }
  log.events.push({ ...m, tRecv });
  flush();
});
