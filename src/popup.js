const $ = (id) => document.getElementById(id);
let tabId = null, S = null;

function send(msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => null);
}

function paint() {
  document.querySelectorAll('[data-toggle]').forEach((el) => {
    el.setAttribute('aria-pressed', String(!!(S && S[el.dataset.toggle])));
  });
  if (S) $('font').value = S.font;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  tabId = tab.id;

  let origin = '—';
  try { origin = new URL(tab.url).origin; } catch (e) {}
  $('site').textContent = origin;

  const { pausedSites = [] } = await chrome.storage.local.get('pausedSites');
  $('pause').checked = pausedSites.includes(origin);

  const state = await send({ type: 'state' });
  if (!state) {
    $('stat').textContent = 'No page to read here — Chrome blocks extensions on this URL.';
    document.querySelectorAll('button, select').forEach((b) => (b.disabled = true));
    $('pause').disabled = true;
    return;
  }
  S = state.settings;
  $('stat').textContent = state.paused
    ? 'Paused on this site.'
    : state.words + ' words wrapped · Alt+R for the full panel';
  paint();

  $('pause').addEventListener('change', async () => {
    const list = new Set((await chrome.storage.local.get('pausedSites')).pausedSites || []);
    $('pause').checked ? list.add(origin) : list.delete(origin);
    await chrome.storage.local.set({ pausedSites: [...list] });
    await send({ type: 'pause', value: $('pause').checked });
    $('stat').textContent = $('pause').checked ? 'Paused on this site.' : 'Active on this site.';
  });
}

document.querySelectorAll('[data-toggle]').forEach((el) => {
  el.addEventListener('click', async () => {
    const k = el.dataset.toggle;
    S[k] = !S[k];
    paint();
    await send({ type: 'patch', patch: { [k]: S[k] } });
  });
});
$('font').addEventListener('change', async () => {
  S.font = $('font').value;
  await send({ type: 'patch', patch: { font: S.font } });
});
document.querySelector('[data-preset="crowd"]').addEventListener('click', async () => {
  await send({ type: 'patch', patch: { ls: 0.08, ws: 0.26, lh: 1.75, size: 20, measure: 62 } });
});
$('panel').addEventListener('click', async () => { await send({ type: 'panel' }); window.close(); });
$('rsvp').addEventListener('click', async () => { await send({ type: 'rsvp' }); window.close(); });
$('reset').addEventListener('click', async () => { await send({ type: 'reset' }); S = null; window.close(); });

init();
