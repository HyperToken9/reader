/* Service worker: keyboard commands, context menu, and first-run defaults. */

const MENUS = [
  { id: 'rl-rsvp',  title: 'RSVP this selection',        contexts: ['selection'] },
  { id: 'rl-panel', title: 'Reading Lenses panel',       contexts: ['page'] },
  { id: 'rl-mask',  title: 'Toggle reading mask',        contexts: ['page'] },
  { id: 'rl-reset', title: 'Remove all lenses from this page', contexts: ['page'] }
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    MENUS.forEach((m) => chrome.contextMenus.create(m));
  });
});

function send(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    /* No content script here — chrome:// pages, the Web Store, PDFs. */
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const map = { 'rl-rsvp': 'rsvp', 'rl-panel': 'panel', 'rl-mask': 'mask', 'rl-reset': 'reset' };
  send(tab && tab.id, { type: map[info.menuItemId] });
});

chrome.commands.onCommand.addListener((cmd, tab) => {
  const map = { 'toggle-panel': 'panel', 'toggle-mask': 'mask', 'rsvp': 'rsvp' };
  if (map[cmd]) send(tab && tab.id, { type: map[cmd] });
});
