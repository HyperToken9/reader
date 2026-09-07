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
import { basename, join, sep } from "node:path";
import { tmpdir } from "node:os";

const FILE = () => join(app.getPath("userData"), "library.json");
/*
 * A site is the one shelf entry that does NOT point at a file the reader
 * already had: there is nothing on disk to point at until we go and get it.
 * So a site's snapshot is written here, once, and the entry points at that --
 * which keeps every other part of the shelf (list, open, position, notes,
 * forget) working on the entry it already understands. It is also what makes
 * a site readable on a train: the pages are on disk, not re-fetched.
 */
const SITE_DIR = () => join(app.getPath("userData"), "sites");

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

/*
 * A site's identity is its address, not its bytes. Content-hashing a snapshot
 * would make every re-fetch a different book -- a doc site changes, that is
 * the point of re-fetching it -- and lose the notes and the reading position
 * attached to the old one. Normalised so the same site typed two ways is one
 * entry: the fragment and a default port are not part of which site this is,
 * and a trailing slash is the same page as none.
 */
export function canonicalSiteUrl(raw) {
  const u = new URL(raw);
  u.hash = "";
  u.username = "";
  u.password = "";
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname.endsWith("/index.html")) u.pathname = u.pathname.slice(0, -"index.html".length);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

function siteId(url) {
  return createHash("sha256").update(canonicalSiteUrl(url)).digest("hex").slice(0, 32);
}

/**
 * Shelve a freshly snapshotted site, writing the snapshot beside the library
 * and upserting on the address. Re-adding a site you already have is
 * therefore a *refresh*: same entry, same id, new pages -- so the notes and
 * the place you were keep pointing at the same book.
 */
export async function rememberSite({ url, title, pages, snapshot }) {
  const lib = await load();
  const id = siteId(url);
  await fs.mkdir(SITE_DIR(), { recursive: true });
  const file = join(SITE_DIR(), `${id}.json`);
  // Same write-then-rename as the library file itself: a snapshot interrupted
  // half-written is a book that will not open.
  await fs.writeFile(`${file}.tmp`, snapshot, "utf8");
  await fs.rename(`${file}.tmp`, file);

  let entry = lib.books.find((b) => b.id === id);
  if (!entry) {
    entry = { id, position: null, addedAt: Date.now() };
    lib.books.push(entry);
  }
  Object.assign(entry, {
    path: file,
    // The address as actually fetched, NOT the canonical form. Canonicalising
    // is for the *id* -- it decides whether two addresses are one site. It is
    // the wrong thing to fetch, because it strips a trailing slash, and a URL
    // without one names a file rather than a directory: every relative link
    // on the page then resolves one level up. That is not theoretical; it
    // turned a 26-page site into a 1-page one.
    url,
    title: title || canonicalSiteUrl(url),
    kind: "site",
    pages: pages ?? entry.pages ?? null,
    bytes: Buffer.byteLength(snapshot),
    openedAt: Date.now(),
    fetchedAt: Date.now(),
  });
  await save();
  return entry;
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
  // A document opened out of the OS temp directory is a scratch file -- the
  // smoke test's fixture, a mail attachment opened in place -- not something
  // to put on a shelf and offer to reopen next week.
  if (path.startsWith(tmpdir() + sep)) return null;
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
  if (i < 0) return true;
  const [gone] = lib.books.splice(i, 1);
  await save();
  // A PDF or an EPUB is the reader's own file and is never ours to delete.
  // A site's snapshot is a file this app wrote and nothing else refers to, so
  // forgetting the site has to take it with it or userData grows forever.
  if (gone.kind === "site" && gone.path) await fs.rm(gone.path, { force: true }).catch(() => {});
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
