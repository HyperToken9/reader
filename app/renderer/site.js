/*
 * Documentation sites, read as books.
 *
 * A docs site is already the shape of a book: an ordered table of contents in
 * a sidebar, and a page of real prose behind each entry. What it is not is a
 * file, so the two things this module does that the EPUB path does not are
 * (1) go and get it, page by page, over the bridge in electron/net.js, and
 * (2) leave behind something that can be read again offline next week.
 *
 * Everything after that is deliberately NOT new. A snapshot comes out in the
 * exact shape parseEpub returns -- ordered {headHtml, bodyHtml} chapters plus
 * a flat {title, pn, depth} table of contents -- so main.js opens it through
 * the same code that opens an EPUB, and the whole scroll, zoom, highlight,
 * notes and resume pipeline applies with no idea it is looking at a website.
 * A site's "chapter" is one of its pages; that is the only translation.
 *
 * Staying true to the original render, here, means what it meant for EPUB:
 * the site's own markup and the site's own stylesheet, laid out by the same
 * browser engine that would lay them out in a tab. What is dropped is the
 * chrome -- the sidebar, the header, the breadcrumbs, the search box -- which
 * is navigation around the document, not the document. The reader has a real
 * table of contents in the left rail for that.
 */

// --------------------------------------------------------------- limits
//
// A documentation site has an end; a website in general does not. Every one
// of these exists so that pointing this at the wrong URL wastes a minute
// rather than a morning and a gigabyte.
const MAX_PAGES = 200;
const MAX_SNAPSHOT_BYTES = 80 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024;

/* Sphinx and friends generate these next to the real pages; they are indexes
 * of a book rather than part of one, and they are enormous. */
const NOT_PROSE = /\/(genindex|py-modindex|modindex|search|searchindex)\.html?$/i;

/* Where a docs generator puts its sidebar. Checked in order, first one that
 * actually holds a few links wins; the last few are the generic shapes for a
 * site none of these recognise. */
const NAV_SELECTORS = [
  ".wy-menu-vertical",          // Sphinx, Read the Docs theme
  ".sphinxsidebarwrapper",      // Sphinx, classic themes
  ".md-nav--primary",           // MkDocs Material
  ".theme-doc-sidebar-menu",    // Docusaurus
  ".toctree-wrapper",           // an in-page Sphinx toctree (a contents page)
  "nav.menu",
  "[role=navigation]",
  "aside nav", "nav aside", ".sidebar", "#sidebar", ".toc", "#toc",
  "nav", "aside",
];

/* Where the same generators put the actual page. Same idea: first hit wins,
 * and the tail is the generic shape. */
const MAIN_SELECTORS = [
  "[role=main]", "main", ".md-content__inner", ".theme-doc-markdown",
  "article", ".document", ".rst-content", "#content", ".content", "#main-content", ".body",
];

/* Chrome that survives inside the main region on some themes. */
const CHROME_IN_MAIN =
  "script, noscript, nav, form, [role=search], iframe, object, embed, " +
  ".headerlink, .wy-breadcrumbs, .rst-footer-buttons, .related, .sphinxsidebar, " +
  ".md-sidebar, .md-source-file, .theme-doc-footer, .pagination-nav, footer";

const parser = new DOMParser();

// ------------------------------------------------------------- fetching

async function get(url) {
  const res = await window.blitz?.fetch?.(url);
  return res ?? { ok: false, reason: "no network bridge" };
}

async function getHtml(url) {
  const res = await get(url);
  if (!res.ok) return { ok: false, reason: res.reason };
  if (res.contentType && !/html|xml/.test(res.contentType)) {
    return { ok: false, reason: `${res.contentType} is not a page` };
  }
  return { ok: true, url: res.url, doc: parser.parseFromString(new TextDecoder().decode(res.bytes), "text/html") };
}

/*
 * An asset has to survive being written to disk and read back next week, so
 * it becomes a data: URL rather than the blob: URL an EPUB's resources get.
 * A blob URL dies with the session that made it, which is fine for a book
 * re-parsed from its zip on every open and useless for a snapshot.
 */
function dataUrl(bytes, contentType) {
  const view = new Uint8Array(bytes);
  // btoa on a 4 MB string built with spread would blow the argument limit;
  // chunk it.
  let bin = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  }
  return `data:${contentType || "application/octet-stream"};base64,${btoa(bin)}`;
}

// ----------------------------------------------------------- discovery

function sameSite(a, b) {
  return a.origin === b.origin;
}

/** Strip the fragment: two links to the same page are one page. */
function pageKey(u) {
  const c = new URL(u);
  c.hash = "";
  return c.toString();
}

function absolute(base, href) {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/*
 * The site's own table of contents, which is also its page list.
 *
 * This is the whole reason a docs site can be read as a book rather than
 * crawled as a website: the author already decided what the pages are and
 * what order they go in, and wrote it down in the sidebar. Following that is
 * both cheaper and more faithful than discovering pages by following every
 * link on every page -- which on a docs site walks straight into the API
 * reference, the changelog and every version of the site ever published.
 *
 * Depth comes from list nesting, counted rather than pattern-matched, so a
 * theme that uses <ul> and one that uses <div> both give a sane rail as long
 * as they nest at all.
 */
function discoverPages(doc, entryUrl) {
  const entry = new URL(entryUrl);
  // Only pages under the entry's own directory. A docs site is versioned and
  // sectioned by path ("/en/latest/"), and this is what keeps a link to the
  // project's blog, or to /en/stable/, out of the book.
  const prefix = entry.pathname.replace(/[^/]*$/, "");

  const eligible = (a) => {
    const u = absolute(entryUrl, a.getAttribute("href"));
    if (!u || !sameSite(u, entry)) return null;
    if (!u.pathname.startsWith(prefix)) return null;
    if (NOT_PROSE.test(u.pathname)) return null;
    return u;
  };

  let nav = null;
  for (const sel of NAV_SELECTORS) {
    for (const cand of doc.querySelectorAll(sel)) {
      const n = [...cand.querySelectorAll("a[href]")].filter(eligible).length;
      if (n >= 3) { nav = cand; break; }
    }
    if (nav) break;
  }
  // No recognisable sidebar: read the entry page's own links instead. A
  // hand-written index page is a perfectly good table of contents.
  const scope = nav ?? doc.body;

  const seen = new Map(); // pageKey -> { url, title, depth }
  for (const a of scope.querySelectorAll("a[href]")) {
    const u = eligible(a);
    if (!u) continue;
    const key = pageKey(u);
    if (seen.has(key)) continue;
    // Nesting depth *within the nav*, so an entry's rank in the rail matches
    // its rank in the site's own contents.
    let depth = -1;
    for (let el = a.parentElement; el && el !== scope; el = el.parentElement) {
      if (el.tagName === "UL" || el.tagName === "OL") depth++;
    }
    seen.set(key, {
      url: key,
      title: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      depth: Math.max(0, Math.min(depth, 3)),
    });
    if (seen.size >= MAX_PAGES) break;
  }

  const list = [...seen.values()];
  // The page you asked for is page one, whether or not its own sidebar links
  // to it. Every docs site's landing page is part of the book.
  const entryKey = pageKey(entry);
  const at = list.findIndex((p) => p.url === entryKey);
  if (at > 0) list.unshift(...list.splice(at, 1));
  else if (at < 0) list.unshift({ url: entryKey, title: "", depth: 0 });
  return list;
}

// ---------------------------------------------------------- extraction

/** The page itself, with the site's navigation chrome taken off it. */
function extractMain(doc) {
  let root = null;
  for (const sel of MAIN_SELECTORS) {
    const found = doc.querySelector(sel);
    // A main region with almost nothing in it is a theme's empty wrapper, not
    // the page; keep looking.
    if (found && (found.textContent ?? "").trim().length > 40) { root = found; break; }
  }
  root = root ?? doc.body;
  if (!root) return null;
  const clone = root.cloneNode(true);
  for (const el of clone.querySelectorAll(CHROME_IN_MAIN)) el.remove();
  // Same defusing an EPUB chapter gets: the iframe sandbox already blocks
  // scripts, but a page is easier to reason about with none in it.
  for (const el of clone.querySelectorAll("*")) {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  }
  return clone;
}

function pageTitle(doc, root, fallback) {
  const h = root?.querySelector("h1, h2");
  const fromBody = (h?.textContent ?? "").replace(/¶|/g, "").replace(/\s+/g, " ").trim();
  if (fromBody) return fromBody.slice(0, 160);
  const t = (doc.querySelector("title")?.textContent ?? "").replace(/\s+/g, " ").trim();
  // "Page name — Project documentation" -- the half before the dash is the page.
  const cut = t.split(/\s+[—–|]\s+/)[0].trim();
  return (cut || t || fallback || "Untitled").slice(0, 160);
}

/** The site's own name, for the shelf. */
function siteTitle(doc, entryUrl) {
  const cands = [
    doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content"),
    doc.querySelector(".wy-side-nav-search > a")?.textContent,
    doc.querySelector(".md-header__topic .md-ellipsis")?.textContent,
    doc.querySelector(".navbar__title, .navbar__brand")?.textContent,
    (doc.querySelector("title")?.textContent ?? "").split(/\s+[—–|]\s+/).pop(),
  ];
  for (const c of cands) {
    const t = (c ?? "").replace(/\s+/g, " ").trim();
    // Two characters is a real project name ("uv", "Go"), so this is not the
    // place to demand more; the fallbacks below it are what catch nothing.
    if (t.length >= 2) return t.slice(0, 160);
  }
  return new URL(entryUrl).hostname;
}

// ------------------------------------------------------------- the run

/**
 * Fetch a documentation site and return it in parseEpub's shape:
 * `{ url, title, css, chapters: [{headHtml, bodyHtml}], toc: [{title, pn, depth}] }`.
 *
 * `onProgress({ phase, done, total, title })` is called as it goes; a 40-page
 * site is tens of seconds of network, which is far too long to show nothing.
 */
export async function snapshotSite(rawUrl, onProgress = () => {}) {
  const typed = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;

  onProgress({ phase: "index", done: 0, total: 0 });
  const first = await getHtml(typed);
  if (!first.ok) throw new Error(`Could not open ${typed} — ${first.reason}`);

  const entryUrl = first.url;
  const list = discoverPages(first.doc, entryUrl);
  if (!list.length) throw new Error("Found no pages to read at that address");

  // url -> data: URL (or null for one that would not load). Shared across
  // every page, because a docs site's logo, its diagrams and above all its
  // stylesheet's webfonts are the same bytes on all of them.
  const assets = new Map();
  let budget = MAX_SNAPSHOT_BYTES;

  async function inline(url, { max = MAX_ASSET_BYTES } = {}) {
    const key = pageKey(url);
    if (assets.has(key)) return assets.get(key);
    let out = null;
    const res = await get(key);
    if (res.ok && res.bytes.byteLength <= max && res.bytes.byteLength * 1.4 < budget) {
      out = dataUrl(res.bytes, res.contentType);
      budget -= out.length;
    }
    assets.set(key, out);
    return out;
  }

  /* A stylesheet's own url()s -- its webfonts, its icons -- have to be
   * resolved against the stylesheet, not against the page that links it. */
  async function inlineCss(cssText, cssUrl) {
    const refs = [...cssText.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
    const map = new Map();
    for (const [, , ref] of refs) {
      if (/^(data:|https?:\/\/fonts\.gstatic|#)/.test(ref) || map.has(ref)) continue;
      const u = absolute(cssUrl, ref);
      map.set(ref, u ? await inline(u.toString()) : null);
    }
    return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref) => {
      const u = map.get(ref);
      return u ? `url(${u})` : (/^data:/.test(ref) ? m : "url(about:blank)");
    });
  }

  // The site's stylesheet, gathered once for the whole book rather than per
  // page: it is the same file on every page, and duplicating a theme's fonts
  // across forty chapters is tens of megabytes of identical base64.
  const cssSeen = new Set();
  const cssParts = [];
  async function collectCss(doc, pageUrl) {
    for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
      const u = absolute(pageUrl, link.getAttribute("href"));
      if (!u || cssSeen.has(u.toString())) continue;
      cssSeen.add(u.toString());
      const res = await get(u.toString());
      if (!res.ok || res.bytes.byteLength > MAX_STYLESHEET_BYTES) continue;
      cssParts.push(await inlineCss(new TextDecoder().decode(res.bytes), res.url));
    }
    for (const style of doc.querySelectorAll("head style")) {
      const text = style.textContent ?? "";
      if (!text.trim() || cssSeen.has(text)) continue;
      cssSeen.add(text);
      cssParts.push(await inlineCss(text, pageUrl));
    }
  }

  // ---- pass one: fetch every page, keep its main region as a live DOM ----
  const fetched = []; // { url, title, root }
  for (let i = 0; i < list.length; i++) {
    const want = list[i];
    onProgress({ phase: "pages", done: i, total: list.length, title: want.title });
    const page = i === 0 && pageKey(first.url) === want.url
      ? { ok: true, url: first.url, doc: first.doc }
      : await getHtml(want.url);
    if (!page.ok) {
      console.warn("[site] skipping", want.url, page.reason);
      continue;
    }
    const root = extractMain(page.doc);
    if (!root || (root.textContent ?? "").trim().length < 40) continue;
    await collectCss(page.doc, page.url);
    fetched.push({ url: want.url, title: want.title || pageTitle(page.doc, root, want.title), root });
  }
  if (!fetched.length) throw new Error("None of that site's pages had anything to read");

  // ---- pass two: rewrite links and inline images, now the page set is known ----
  //
  // Links can only be resolved once every page is known, which is why this is
  // a second pass: a cross-reference to another page of the same site should
  // jump the reader there rather than die, and that means knowing its number.
  const index = new Map(fetched.map((p, i) => [p.url, i + 1]));
  for (let i = 0; i < fetched.length; i++) {
    const p = fetched[i];
    onProgress({ phase: "assets", done: i, total: fetched.length, title: p.title });

    for (const img of p.root.querySelectorAll("img[src]")) {
      // A responsive source set points at files we have not fetched and
      // cannot resolve inside a srcdoc; the plain src is the one we inline.
      img.removeAttribute("srcset");
      img.removeAttribute("loading");
      const u = absolute(p.url, img.getAttribute("src"));
      const data = u ? await inline(u.toString()) : null;
      if (data) img.setAttribute("src", data);
      else img.remove();
    }
    // A docs page's demo clips are tens of megabytes of MP4 and there is
    // nothing in them to read; left in place they render as a dead player,
    // because their <source> cannot resolve inside a srcdoc iframe. Say what
    // was there instead -- which the voice then reads as "video", the same
    // brief placeholder a figure gets.
    for (const m of p.root.querySelectorAll("video, audio")) {
      const note = m.ownerDocument.createElement("p");
      note.className = "blitzMedia";
      note.textContent = `[${m.tagName.toLowerCase()}]`;
      m.replaceWith(note);
    }
    for (const src of p.root.querySelectorAll("source[srcset], source[src]")) src.remove();

    for (const a of p.root.querySelectorAll("a[href]")) {
      const u = absolute(p.url, a.getAttribute("href"));
      const href = a.getAttribute("href");
      a.removeAttribute("href"); // nothing navigates inside the reader's iframe
      if (!u) {
        // A bare "#anchor" within this page: harmless, and worth keeping as
        // text rather than as a dead control.
        if (href?.startsWith("#")) a.setAttribute("data-anchor", href.slice(1));
        continue;
      }
      const to = index.get(pageKey(u));
      // A link into the book jumps; a link out of it opens in the browser.
      // Both are handled by main.js, which sees the click forwarded out of
      // the iframe (wireEpubInput).
      if (to) a.setAttribute("data-page", String(to));
      else a.setAttribute("data-external", u.toString());
    }
  }

  const chapters = fetched.map((p) => ({
    href: p.url,
    headHtml: "", // the whole site shares one stylesheet; see `css` below
    bodyHtml: p.root.outerHTML,
  }));
  const toc = fetched.map((p, i) => ({
    title: p.title,
    pn: i + 1,
    depth: list.find((l) => l.url === p.url)?.depth ?? 0,
  }));

  onProgress({ phase: "done", done: fetched.length, total: fetched.length });
  return {
    url: entryUrl,
    title: siteTitle(first.doc, entryUrl),
    fetchedAt: Date.now(),
    css: cssParts.join("\n"),
    chapters,
    toc,
  };
}
