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

let handlers = { open: () => {}, pick: () => {} };

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

function metaLine(b) {
  if (b.missing) return "file moved or deleted";
  const unit = b.kind === "epub" ? "chapter" : "page";
  const at = b.position?.pn;
  if (at && b.pages) return `${unit} ${at} of ${b.pages}`;
  if (b.pages) return `${b.pages} ${unit}${b.pages === 1 ? "" : "s"}`;
  return b.kind === "epub" ? "EPUB" : "PDF";
}

function percent(b) {
  if (b.missing || !b.pages || !b.position?.pn) return "new";
  return `${Math.min(100, Math.round((b.position.pn / b.pages) * 100))}%`;
}

function card(b) {
  const wrap = document.createElement("div");
  wrap.className = `shelfCard${b.missing ? " gone" : ""}`;
  wrap.dataset.id = b.id;
  wrap.innerHTML = `
    <button class="cardOpen" style="--hue:${hueOf(b.id)}">
      <span class="cover">
        <span class="coverKind">${b.kind === "epub" ? "EPUB" : "PDF"}</span>
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
  wrap.querySelector(".cardOpen").onclick = () => handlers.open(b);
  wrap.querySelector(".cardForget").onclick = async (e) => {
    e.stopPropagation();
    await window.blitz.library.forget(b.id);
    refreshShelf();
  };
  return wrap;
}

export async function refreshShelf() {
  const books = await window.blitz.library.list().catch(() => []);
  const grid = $("shelfGrid");
  grid.replaceChildren(...books.map(card));
  $("shelf").hidden = books.length === 0;
}

export function initHome({ onOpen, onPick }) {
  handlers = { open: onOpen, pick: onPick };
  $("greeting").textContent = greeting();
  $("homePick").onclick = () => handlers.pick();
  refreshShelf();
}

/** "home" or "reader" -- CSS shows exactly one, keyed off the body. */
export function setView(view) {
  document.body.dataset.view = view;
  if (view === "home") refreshShelf();
}
