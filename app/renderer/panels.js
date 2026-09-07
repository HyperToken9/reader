/*
 * The left rail: the book's table of contents, and your notes on it.
 *
 * Both are about the book you are reading, which is why they sit on the left
 * against the page, while everything about the *app* -- voice, appearance,
 * layout, diagnostics -- moved to the right. Two tabs rather than two
 * stacked lists: a textbook's TOC is long enough to want the whole rail.
 *
 * This module owns the DOM of those two panels and nothing else. Everything
 * that needs the document itself (what page is showing, what sentence is
 * being spoken, where to save) is passed in from main.js as callbacks, so
 * the panels stay a view over state they do not own.
 */

const $ = (id) => document.getElementById(id);

let hooks = { goTo: () => {}, openNote: () => {}, context: () => null, save: () => {} };
let notes = [];
let notesEnabled = false;

// ---------------------------------------------------------------- tabs

export function initPanels({ onGoTo, onOpenNote, getContext, onSaveNotes }) {
  hooks = { goTo: onGoTo, openNote: onOpenNote, context: getContext, save: onSaveNotes };

  for (const btn of $("leftTabs").children) {
    btn.onclick = () => selectTab(btn.dataset.tab);
  }
  $("addNote").onclick = addNote;
  $("collapseLeft").onclick = () => document.getElementById("app").classList.toggle("noleft");
  selectTab("contents");
}

function selectTab(name) {
  for (const btn of $("leftTabs").children) btn.classList.toggle("active", btn.dataset.tab === name);
  $("tabContents").hidden = name !== "contents";
  $("tabNotes").hidden = name !== "notes";
}

// ---------------------------------------------------------------- contents

/**
 * `entries` is [{title, pn, depth}] -- the same shape whichever format it
 * came from, so a PDF outline and an EPUB nav document render identically.
 */
export function setToc(entries, hint) {
  const list = $("toc");
  list.replaceChildren();
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = `tocItem depth${Math.min(e.depth ?? 0, 3)}`;
    li.dataset.page = e.pn ?? "";
    const btn = document.createElement("button");
    btn.textContent = e.title;
    btn.title = e.title;
    // An entry whose destination could not be resolved is still worth
    // showing -- it is part of the book's structure -- but it cannot be
    // clicked anywhere useful.
    if (e.pn) btn.onclick = () => hooks.goTo(e.pn);
    else btn.disabled = true;
    li.append(btn);
    list.append(li);
  }
  $("tocHint").textContent = entries.length ? "" : hint;
  $("tocHint").hidden = entries.length > 0;
}

/*
 * Mark the entry the reader is currently inside: the one with the highest
 * page at or before this one.
 *
 * Highest page, NOT last in the list. Real outlines are not reliably
 * monotonic -- the biochemistry textbook has one stray bookmark 400 entries
 * deep that points back at page 13 -- and "last one seen" lets a single bad
 * entry like that claim the whole rest of the book.
 */
export function markToc(pn) {
  const items = [...$("toc").children];
  let active = null;
  let best = 0;
  for (const li of items) {
    const at = Number(li.dataset.page);
    // Strictly greater, so when several entries start on the same page the
    // first of them wins -- "you are in this section", not the last heading
    // that happens to share the page.
    if (at && at <= pn && at > best) { best = at; active = li; }
  }
  let changed = false;
  for (const li of items) {
    const on = li === active;
    if (on !== li.classList.contains("current")) changed = true;
    li.classList.toggle("current", on);
  }
  // Follow along, but only when the mark actually moves, and only within the
  // panel's own scroller -- reading should never yank the rail underneath a
  // finger that is scrolling it.
  if (changed && active) keepVisible(active);
}

function keepVisible(li) {
  const panel = $("tabContents");
  if (panel.hidden) return;
  const top = li.offsetTop;
  const bottom = top + li.offsetHeight;
  if (top < panel.scrollTop) panel.scrollTop = top - 8;
  else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight + 8;
}

// ---------------------------------------------------------------- notes

/**
 * Notes live with the book on the shelf, so they need a shelved book to live
 * with. A document opened from a path the app can't recover (dragged out of
 * a web page) reads fine but cannot be noted on -- say so rather than
 * silently dropping what someone typed.
 */
export function setNotes(list, { enabled, reason }) {
  notes = list ?? [];
  notesEnabled = enabled;
  $("addNote").disabled = !enabled;
  $("notesHint").textContent = enabled
    ? (notes.length ? "" : "Select any text on the page and add a note to quote it -- or add one for the page you are on. A note follows its quote, so it survives the page moving.")
    : reason;
  renderNotes();
}

function renderNotes() {
  const list = $("notesList");
  list.replaceChildren();
  for (const n of notes) {
    const li = document.createElement("li");
    li.className = "note";
    li.innerHTML = `<div class="noteHead"><button class="noteWhere"></button><button class="noteDrop" title="Delete this note">×</button></div>` +
      `<blockquote class="noteQuote"></blockquote>` +
      `<textarea class="noteText" rows="2" placeholder="…"></textarea>`;
    const quote = li.querySelector(".noteQuote");
    quote.textContent = n.quote ?? "";
    quote.hidden = !n.quote;
    // A note is opened by its quote, not by the page it was written on:
    // main.js's goToNote finds that text wherever it lives in the document
    // today. The label is the page's name for the same reason -- a number
    // stops meaning anything the moment a site is re-fetched and repaginated.
    li.querySelector(".noteWhere").textContent = n.label ?? n.title ?? `page ${n.pn}`;
    li.querySelector(".noteWhere").onclick = () => hooks.openNote(n);
    li.querySelector(".noteDrop").onclick = () => {
      notes = notes.filter((x) => x.id !== n.id);
      renderNotes();
      hooks.save(notes);
    };
    const text = li.querySelector(".noteText");
    text.value = n.text ?? "";
    // Save on blur, not on every keystroke: the store is a file on disk and
    // a note is a paragraph, not a live document.
    text.onblur = () => {
      if (text.value === n.text) return;
      n.text = text.value;
      hooks.save(notes);
    };
    list.append(li);
  }
}

function addNote() {
  if (!notesEnabled) return;
  const ctx = hooks.context();
  if (!ctx) return;
  const note = { id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, at: Date.now(), text: "", ...ctx };
  notes = [note, ...notes];
  renderNotes();
  hooks.save(notes);
  // Straight into typing: the reason anyone pressed the button.
  $("notesList").querySelector(".noteText")?.focus();
  $("notesHint").textContent = "";
}
