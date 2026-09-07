/*
 * The library: which books this reader has opened, and where they were left.
 *
 * Deliberately NOT in the renderer's localStorage, which is where the
 * appearance prefs live (20). Those are per-viewer, cheap and disposable;
 * losing your place in an 800-page textbook because site data got cleared is
 * a different class of failure. This is a JSON file under userData, owned by
 * the main process and reached over the existing IPC bridge -- the same
 * choice the speech weights already make by living under $BLITZ_TTS_HOME
 * rather than in browser storage.
 *
 * The library POINTS at books, it never copies them: a shelf of 25 MB EPUBs
 * and 30 MB textbooks would duplicate gigabytes to no end. The cost is that a
 * book can move out from under an entry, so every entry is keyed on a content
 * hash with its last-known path alongside: a book that moved is recognised
 * and re-bound rather than duplicated, and a book that is gone can say so
 * instead of silently vanishing.
 */
import { app } from "electron";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { basename, join } from "node:path";

const FILE = () => join(app.getPath("userData"), "library.json");

let cache = null;    // {version, books: []}
let writing = null;  // in-flight write, so concurrent saves serialise

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE(), "utf8"));
    if (!Array.isArray(cache?.books)) throw new Error("shape");
  } catch {
    // A missing file is the normal first-run case; a corrupt one is not worth
    // taking the app down for either -- start empty and overwrite on the next
    // save rather than refusing to open anything.
    cache = { version: 1, books: [] };
  }
  return cache;
}

async function save() {
  const data = JSON.stringify(cache, null, 2);
  // Write-then-rename, so a crash mid-write can't leave a truncated library.
  writing = (writing ?? Promise.resolve()).then(async () => {
    const tmp = `${FILE()}.tmp`;
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, FILE());
  }).catch((e) => console.error("[library] save failed", e.message));
  return writing;
}

/** sha256 of the file's bytes: identity that survives a move or a rename. */
function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex").slice(0, 32)));
  });
}

/** Newest-first, each entry told whether its file is still where we left it. */
export async function list() {
  const { books } = await load();
  const withState = await Promise.all(books.map(async (b) => ({
    ...b,
    missing: !(await fs.stat(b.path).then(() => true).catch(() => false)),
  })));
  return withState.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
}

/**
 * Record that this file was just opened, returning the entry -- including any
 * position saved for it, which is what "continue where you left off" reads.
 * Upserting on the hash is what re-binds a book that moved: same bytes, new
 * path, one entry.
 */
export async function remember({ path, title, kind, pages }) {
  const lib = await load();
  const [id, stat] = await Promise.all([hashFile(path), fs.stat(path)]);
  let entry = lib.books.find((b) => b.id === id);
  if (!entry) {
    entry = { id, position: null, addedAt: Date.now() };
    lib.books.push(entry);
  }
  Object.assign(entry, {
    path,
    title: title || basename(path).replace(/\.(pdf|epub)$/i, ""),
    kind,
    pages: pages ?? entry.pages ?? null,
    bytes: stat.size,
    openedAt: Date.now(),
  });
  await save();
  return entry;
}

/**
 * Where the reader is in a book: the same {pn, si} cursor the reading loop
 * already passes around (16). Not a scroll offset -- that does not survive a
 * zoom, and after the EPUB zoom rework a chapter's height changes with text
 * size while its sentence indices do not.
 */
export async function savePosition({ id, pn, si, pages }) {
  const lib = await load();
  const entry = lib.books.find((b) => b.id === id);
  if (!entry) return null;
  entry.position = { pn, si: si ?? null, at: Date.now() };
  if (pages) entry.pages = pages;
  await save();
  return entry.position;
}

/*
 * Notes are stored with the book rather than in their own file: they are
 * meaningless without the entry that says which book and where in it, and a
 * library of a few dozen books' notes is kilobytes.
 */
export async function saveNotes({ id, notes }) {
  const lib = await load();
  const entry = lib.books.find((b) => b.id === id);
  if (!entry) return null;
  entry.notes = notes ?? [];
  await save();
  return entry.notes;
}

export async function forget(id) {
  const lib = await load();
  const i = lib.books.findIndex((b) => b.id === id);
  if (i >= 0) { lib.books.splice(i, 1); await save(); }
  return true;
}

/** Read a shelved book's bytes back, or say why it can't be opened. */
export async function open(id) {
  const lib = await load();
  const entry = lib.books.find((b) => b.id === id);
  if (!entry) return { ok: false, reason: "unknown" };
  try {
    const buf = await fs.readFile(entry.path);
    entry.openedAt = Date.now();
    await save();
    // A Buffer crosses IPC as a Uint8Array; the renderer wants its bytes.
    return { ok: true, entry, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch {
    return { ok: false, reason: "missing", entry };
  }
}
