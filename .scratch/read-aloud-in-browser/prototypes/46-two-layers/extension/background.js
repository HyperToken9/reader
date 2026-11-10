// PROTOTYPE 46 — throwaway. Context menus, toolbar button, and a CSP-proof CSS fallback.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'p46-here', title: 'Read from here (P46)', contexts: ['page', 'link'] });
    chrome.contextMenus.create({ id: 'p46-this', title: 'Read this (P46)', contexts: ['selection'] });
  });
});

async function send(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch (e) {
    // Page was open before the extension loaded: inject, then retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['Readability.js', 'content.js'] });
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }
}
self.p46send = send; // used by the automated check (check/run.mjs)

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'p46-here') send(tab.id, { cmd: 'readFromHere' });
  if (info.menuItemId === 'p46-this') send(tab.id, { cmd: 'readThis' });
});
chrome.action.onClicked.addListener(tab => send(tab.id, { cmd: 'toolbar' }));

// Fallback route for the highlight rules if an adopted stylesheet doesn't apply.
const lastCss = new Map();
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.cmd !== 'insertCSS') return;
  const tabId = sender.tab.id, target = { tabId, frameIds: [0] };
  (async () => {
    const old = lastCss.get(tabId);
    if (old) await chrome.scripting.removeCSS({ target, css: old }).catch(() => {});
    if (msg.css) await chrome.scripting.insertCSS({ target, css: msg.css });
    lastCss.set(tabId, msg.css);
    reply({ ok: true });
  })();
  return true;
});
