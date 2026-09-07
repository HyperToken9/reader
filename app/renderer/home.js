/*
 * The home view: a greeting, a way in, and the shelf of what you have read.
 *
 * This is a real route, not an overlay on the viewer (21). Going home closes
 * the open document outright -- the render queue, the rasterised canvases and
 * the speech all belong to a book you are reading, and keeping a 30 MB
 * textbook warm behind a screen you are not looking at is exactly the memory
 * the eviction work went to lengths to avoid. Reopening is cheap; the
 * position comes back with it.
 *
 * The shelf card is typographic rather than a cover thumbnail. A PDF's page 1
 * is often a plain title page and an EPUB's cover is often absent, so a
 * thumbnail pipeline would cost a render pass per book to produce a worse,
 * less consistent shelf than a hue drawn from the book's own hash.
 */

const $ = (id) => document.getElementById(id);

/** The one status line on this page: what the fetch is doing, or why it failed. */
function say(text, bad = false) {
  const note = $("siteNote");
  note.textContent = text;
  note.classList.toggle("bad", bad);
  note.hidden = !text;
}

let handlers = { open: () => {}, pick: () => {}, addSite: async () => {} };

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Still up. Begin where you left off.";
  if (h < 12) return "Good morning. Begin where you left off.";
  if (h < 17) return "Good afternoon. One chapter today.";
  return "Good evening. Begin where you left off.";
}

/*
 * A stable, gentle hue per book, so a shelf is recognisable at a glance.
 * Mixed over the whole hash rather than its first bytes: two hashes that
 * happen to start close together would otherwise give two books nearly the
 * same cover, which is the one thing this is for.
 */
function hueOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return Math.abs(h) % 360;
}

const KIND_LABEL = { epub: "EPUB", site: "SITE", pdf: "PDF" };

function metaLine(b) {
  if (b.missing) return b.kind === "site" ? "saved copy is gone" : "file moved or deleted";
  const unit = b.kind === "epub" ? "chapter" : "page";
  const at = b.position?.pn;
  if (at && b.pages) return `${unit} ${at} of ${b.pages}`;
  if (b.pages) return `${b.pages} ${unit}${b.pages === 1 ? "" : "s"}`;
  return KIND_LABEL[b.kind] ?? "PDF";
}

function percent(b) {
  if (b.missing || !b.pages || !b.position?.pn) return "new";
  return `${Math.min(100, Math.round((b.position.pn / b.pages) * 100))}%`;
}

/*
 * Progress for a card that is about to go and fetch something. A PDF opens
 * instantly and needs none; a site is tens of seconds of network and the
 * shelf would otherwise look frozen.
 */
function progress(b) {
  if (b.kind !== "site") return () => {};
  return ({ phase, done, total }) => {
    if (phase === "index") say(`checking ${b.title} for changes…`);
    else if (phase === "pages") say(`fetching ${done + 1} of ${total}`);
    else if (phase === "assets") say(`saving ${done + 1} of ${total}`);
    else if (phase === "done") say("");
  };
}

function card(b) {
  const wrap = document.createElement("div");
  wrap.className = `shelfCard${b.missing ? " gone" : ""}`;
  wrap.dataset.id = b.id;
  wrap.innerHTML = `
    <button class="cardOpen" style="--hue:${hueOf(b.id)}">
      <span class="cover">
        <span class="coverKind">${KIND_LABEL[b.kind] ?? "PDF"}</span>
        <span class="coverMeta">${percent(b)}</span>
      </span>
      <span class="cardTitle"></span>
      <span class="cardMeta"></span>
    </button>
    <button class="cardForget" title="Remove from the library">×</button>`;
  // textContent, not innerHTML: a title comes from a book's own metadata.
  const title = wrap.querySelector(".cardTitle");
  title.textContent = b.title;
  title.title = b.title; // the card clamps to three lines; hover for the rest
  wrap.querySelector(".cardMeta").textContent = metaLine(b);
  // Opening a site goes back to the network for it every time, which takes
  // real seconds, so a card hands the same progress line the URL field uses.
  wrap.querySelector(".cardOpen").onclick = async () => {
    try {
      say("");
      await handlers.open(b, progress(b));
    } catch (e) {
      say(String(e?.message ?? e), true);
    }
  };
  wrap.querySelector(".cardForget").onclick = async (e) => {
    e.stopPropagation();
    await window.blitz.library.forget(b.id);
    refreshShelf();
  };
  return wrap;
}

/*
 * The shelf, and what is showing of it.
 *
 * Held here rather than re-read per keystroke: filtering is a view over the
 * same list, so typing should not go back to the main process for it.
 */
let shelf = [];
let query = "";

/* Matched on the title and, for a site, its address -- "mkdocs" should find
 * a site called MkDocs and one that merely lives at mkdocs.org. Every term
 * has to appear somewhere, so words can be typed in any order. */
function matches(b) {
  if (!query) return true;
  const hay = `${b.title ?? ""} ${b.url ?? ""} ${b.kind ?? ""}`.toLowerCase();
  return query.split(/\s+/).every((term) => hay.includes(term));
}

function paintShelf() {
  const shown = shelf.filter(matches);
  $("shelfGrid").replaceChildren(...shown.map(card));
  $("shelf").hidden = shelf.length === 0;
  const empty = $("shelfEmpty");
  empty.hidden = !!shown.length || !shelf.length;
  empty.textContent = shown.length ? "" : `Nothing on the shelf matches “${query}”.`;
}

export async function refreshShelf() {
  shelf = await window.blitz.library.list().catch(() => []);
  paintShelf();
}

/*
 * Adding a documentation site is the one way in that takes real time -- tens
 * of seconds of network for a forty-page site -- so it reports as it goes
 * and the field stays put while it does. Everything else here is instant.
 */
function initSiteInput() {
  const field = $("siteUrl");
  const button = $("siteAdd");
  let busy = false;

  async function go() {
    const url = field.value.trim();
    if (!url || busy) return;
    busy = true;
    field.disabled = button.disabled = true;
    say("reading the contents…");
    try {
      await handlers.addSite(url, ({ phase, done, total, title }) => {
        if (phase === "index") say("reading the contents…");
        else if (phase === "pages") say(`fetching ${done + 1} of ${total}${title ? ` — ${title}` : ""}`);
        else if (phase === "assets") say(`saving ${done + 1} of ${total}`);
      });
      field.value = "";
      say("");
    } catch (e) {
      // A site that will not load is worth an explanation in the place the
      // address was typed, not a status line inside a reader that never
      // opened.
      say(String(e?.message ?? e), true);
    } finally {
      busy = false;
      field.disabled = button.disabled = false;
    }
  }

  button.onclick = go;
  field.onkeydown = (e) => { if (e.key === "Enter") go(); };
}

export function initHome({ onOpen, onPick, onAddSite }) {
  handlers = { open: onOpen, pick: onPick, addSite: onAddSite };
  $("greeting").textContent = greeting();
  $("homePick").onclick = () => handlers.pick();
  initSiteInput();
  const search = $("shelfSearch");
  search.oninput = () => { query = search.value.trim().toLowerCase(); paintShelf(); };
  // Escape clears rather than closing anything -- there is nothing to close.
  search.onkeydown = (e) => { if (e.key === "Escape") { search.value = ""; query = ""; paintShelf(); } };
  refreshShelf();
}

/** "home" or "reader" -- CSS shows exactly one, keyed off the body. */
export function setView(view) {
  document.body.dataset.view = view;
  if (view === "home") refreshShelf();
}
