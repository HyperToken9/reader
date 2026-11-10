// PROTOTYPE 48: the service worker only owns the offscreen document and relays
// messages between it and the tab (an offscreen document has chrome.runtime only).
let reasons = ["AUDIO_PLAYBACK"];

// A new offscreen document's module takes a moment to load; a message sent before its
// listener exists is lost. So wait for its "ready".
let readyWaiters = [];
async function ensureOffscreen() {
  const t = performance.now();
  if (await chrome.offscreen.hasDocument()) return { created: false, ms: performance.now() - t };
  const ready = new Promise((r) => readyWaiters.push(r));
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons, justification: "Kokoro speech: run the model and play audio" });
  const createdMs = performance.now() - t;
  await ready;
  return { created: true, createdMs, ms: performance.now() - t, reasons };
}
self.ensureOffscreen = ensureOffscreen;
self.setReasons = (r) => (reasons = r);
self.offscreenAlive = async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0;
self.closeOffscreen = () => chrome.offscreen.closeDocument();

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.to === "sw" && m.type === "speak") {
    // from the content script: make sure the offscreen document exists, then hand over
    ensureOffscreen().then((o) => {
      chrome.runtime.sendMessage({ to: "offscreen", type: "speak", tabId: sender.tab.id, offscreen: o, ...m.payload });
      reply(o);
    });
    return true;
  }
  if (m.to === "sw" && m.type === "offscreen-ready") {
    readyWaiters.splice(0).forEach((r) => r());
    return;
  }
  if (m.to === "tab") {
    // from the offscreen document: relay to the content script
    chrome.tabs.sendMessage(m.tabId, m);
  }
});
