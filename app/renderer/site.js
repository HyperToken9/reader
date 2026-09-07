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
// A demo clip is bigger than a diagram and worth more room, since the
// alternative is not showing it at all.
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
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

/*
 * What comes OUT of the main region, and it is deliberately almost nothing.
 *
 * The rule is that a snapshot shows what the site shows. Anything visible on
 * the real page has to survive into the book, so this list is scripts (which
 * cannot run in the iframe anyway) and the theme's own sidebar if a theme
 * nests one inside its content region. Not footers, not in-page navs, not
 * breadcrumbs, not the ¶ anchors -- those are on the page, so they are in
 * the book. Embedded frames are the one thing that cannot come across, and
 * they are replaced by a visible marker rather than deleted (below), because
 * a silently missing element is exactly the failure this list guards.
 */
const CHROME_IN_MAIN = "script, noscript, .sphinxsidebar, .md-sidebar, .wy-nav-side";

/*
 * Shown, not spoken. A heading's permalink anchor renders as "¶" and belongs
 * on the page -- the site's own CSS keeps it hidden until you hover -- but
 * reading it aloud after every heading is nonsense. main.js's sentence
 * walker skips anything under this attribute.
 */
const QUIET_IN_MAIN = ".headerlink, .md-source-file, .wy-breadcrumbs";

/*
 * Only when the whole body is used as a last resort (no recognisable content
 * region at all). A theme's page shell is laid out for a browser window --
 * a fixed 300px sidebar with the content margin-shifted past it -- which
 * inside a page sized to its own content is not chrome the reader loses, it
 * is a broken layout. The site's contents are in the left rail either way.
 */
const SHELL_IN_BODY =
  ".wy-nav-side, .wy-nav-top, .sphinxsidebar, .sphinxsidebarwrapper, " +
  ".md-header, .md-sidebar, .md-tabs, .theme-doc-sidebar-container, .navbar";

const parser = new DOMParser();

/** What the most recent snapshot cost, for the diagnostics panel and tests. */
export let lastTally = null;

// ------------------------------------------------------------- fetching

async function get(url, opts) {
  const res = await window.blitz?.fetch?.(url, opts);
  return res ?? { ok: false, reason: "no network bridge" };
}

async function getHtml(url, opts) {
  const res = await get(url, opts);
  if (!res.ok) return { ok: false, reason: res.reason };
  if (res.notModified) return { ok: true, notModified: true, url: res.url };
  if (res.contentType && !/html|xml/.test(res.contentType)) {
    return { ok: false, reason: `${res.contentType} is not a page` };
  }
  return {
    ok: true,
    url: res.url,
    etag: res.etag ?? null,
    lastModified: res.lastModified ?? null,
    doc: parser.parseFromString(new TextDecoder().decode(res.bytes), "text/html"),
  };
}

/*
 * Fetching is almost all of the wall clock, and the pages are independent, so
 * a few at a time. Deliberately a *few*: a docs host will rate-limit a burst
 * of forty, and being throttled costs more than the parallelism saves.
 */
const FETCH_LANES = 4;

async function pooled(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FETCH_LANES, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
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

/**
 * The page itself.
 *
 * Picking a main region is a bet, and a bad bet loses content silently --
 * a theme whose real page sits outside whatever `[role=main]` it happens to
 * carry. So the bet is checked: whatever region wins has to account for most
 * of the page's prose, and if it does not, the whole body is used instead.
 * Losing some chrome is a much smaller failure than losing the page.
 */
function extractMain(doc) {
  const textOf = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim().length;
  const bodyLen = textOf(doc.body);

  // The richest candidate wins, not the first one that clears a bar set
  // against the whole body. A short page is allowed to be short: "About the
  // author" is four hundred characters next to a sidebar of two thousand,
  // and a body-relative test threw exactly that page away and pulled the
  // sidebar in with it.
  let root = null;
  let best = 0;
  for (const sel of MAIN_SELECTORS) {
    for (const found of doc.querySelectorAll(sel)) {
      const len = textOf(found);
      if (len > best) { best = len; root = found; }
    }
  }
  // Falling back to the body means no candidate held anything at all -- a
  // theme none of the selectors know. Then, and only then, the page shell
  // comes off, because it cannot lay out inside a self-sized page.
  const fellBack = best < 40 || best < bodyLen * 0.08;
  if (fellBack) root = doc.body;
  if (!root) return null;

  const clone = root.cloneNode(true);
  for (const el of clone.querySelectorAll(CHROME_IN_MAIN)) el.remove();
  if (fellBack) for (const el of clone.querySelectorAll(SHELL_IN_BODY)) el.remove();
  for (const el of clone.querySelectorAll(QUIET_IN_MAIN)) el.setAttribute("data-blitz-quiet", "");
  // Same defusing an EPUB chapter gets: the iframe sandbox already blocks
  // scripts, but a page is easier to reason about with none in it.
  for (const el of clone.querySelectorAll("*")) {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  }
  return clone;
}

/** A visible stand-in for something that could not come across. Never nothing. */
function marker(doc, label, detail) {
  const el = doc.createElement("p");
  el.className = "blitzMissing";
  el.setAttribute("data-blitz-quiet", "");
  el.textContent = detail ? `[${label} — ${detail}]` : `[${label}]`;
  return el;
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
export async function snapshotSite(rawUrl, onProgress = () => {}, previous = null) {
  const typed = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;

  // What we already hold for this site, by page address. Every request below
  // carries the validators that came with it, so an unchanged page costs a
  // 304 and no body -- which is what makes "check it every time" affordable.
  const held = new Map((previous?.chapters ?? []).map((c) => [c.href, c]));

  onProgress({ phase: "index", done: 0, total: 0 });
  const first = await getHtml(typed, previous?.index ?? undefined);
  if (!first.ok) throw new Error(`Could not open ${typed} — ${first.reason}`);

  let entryUrl = first.url;
  let list;
  if (first.notModified && previous?.pageList?.length) {
    // The contents page has not changed, so neither has the page list.
    entryUrl = previous.url;
    list = previous.pageList;
  } else if (first.notModified) {
    // Told "unchanged" with nothing held to reuse: ask again unconditionally.
    const again = await getHtml(typed);
    if (!again.ok || !again.doc) throw new Error(`Could not open ${typed} — ${again.reason ?? "no page"}`);
    Object.assign(first, again);
    entryUrl = again.url;
    list = discoverPages(again.doc, entryUrl);
  } else {
    list = discoverPages(first.doc, entryUrl);
  }
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
  // Reusable wholesale when the contents page came back 304: a theme's
  // stylesheet and its webfonts are the same bytes, and they are most of the
  // traffic. `null` means "not settled yet, go and collect it".
  let reusedCss = first.notModified && previous?.css ? previous.css : null;
  const cssSeen = new Set();
  const cssParts = [];
  async function collectCss(doc, pageUrl) {
    if (reusedCss !== null) return;
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
  //
  // A page that comes back 304 is reused from the copy we hold -- its markup
  // with its images already inlined -- so the common case of reopening an
  // unchanged site does no downloading at all while still having *checked*
  // every page. Its cross-page links are re-resolved in pass two either way,
  // because the page list around it may have moved even if it did not.
  let done = 0;
  const tally = { pages: list.length, unchanged: 0, fetched: 0, failed: 0 };
  const results = await pooled(list, async (want, i) => {
    const known = held.get(want.url);
    const page = i === 0 && !first.notModified && pageKey(first.url) === want.url
      ? { ok: true, url: first.url, doc: first.doc, etag: first.etag, lastModified: first.lastModified }
      : await getHtml(want.url, known ? { etag: known.etag, lastModified: known.lastModified } : undefined);
    onProgress({ phase: "pages", done: done++, total: list.length, title: want.title });
    if (!page.ok) {
      tally.failed++;
      console.warn("[site] skipping", want.url, page.reason);
      return null;
    }
    if (page.notModified && known) {
      tally.unchanged++;
      const box = document.createElement("div");
      box.innerHTML = known.bodyHtml;
      return { url: want.url, title: known.title ?? want.title, root: box.firstElementChild ?? box,
               etag: known.etag, lastModified: known.lastModified, reused: true };
    }
    if (!page.doc) { tally.failed++; return null; }
    tally.fetched++;
    const root = extractMain(page.doc);
    if (!root || (root.textContent ?? "").trim().length < 40) return null;
    return { url: want.url, title: want.title || pageTitle(page.doc, root, want.title), root,
             doc: page.doc, etag: page.etag, lastModified: page.lastModified, reused: false };
  });

  const fetched = results.filter(Boolean);
  if (!fetched.length) throw new Error("None of that site's pages had anything to read");
  // Worth saying out loud: this is the difference between "checked every page"
  // and "downloaded every page", and it is the whole reason re-checking a site
  // on every open is affordable.
  console.info(`[site] ${tally.pages} pages — ${tally.unchanged} unchanged, ${tally.fetched} downloaded, ${tally.failed} unreadable`);
  lastTally = tally;
  for (const p of fetched) if (p.doc) await collectCss(p.doc, p.url);

  // ---- pass two: rewrite links and inline images, now the page set is known ----
  //
  // Links can only be resolved once every page is known, which is why this is
  // a second pass: a cross-reference to another page of the same site should
  // jump the reader there rather than die, and that means knowing its number.
  const index = new Map(fetched.map((p, i) => [p.url, i + 1]));
  for (let i = 0; i < fetched.length; i++) {
    const p = fetched[i];
    onProgress({ phase: "assets", done: i, total: fetched.length, title: p.title });

    if (p.reused) {
      // Its assets are already inline; only the page numbers behind its
      // cross-references can have moved.
      for (const a of p.root.querySelectorAll("a[data-href]")) {
        const to = index.get(pageKey(a.getAttribute("data-href")));
        if (to) a.setAttribute("data-page", String(to));
        else a.removeAttribute("data-page");
      }
      continue;
    }

    const odoc = p.root.ownerDocument;

    /* The first real URL behind an image, whether it arrived as src or as a
     * <picture>'s candidate list. A responsive srcset points at files we have
     * not fetched and cannot resolve inside a srcdoc, so the candidate has to
     * be picked here rather than left to the browser. */
    const pickSrc = (img) => {
      const own = img.getAttribute("src");
      if (own) return own;
      const sets = [img, ...(img.closest("picture")?.querySelectorAll("source") ?? [])]
        .map((el) => el.getAttribute("srcset"))
        .filter(Boolean);
      return sets[0]?.split(",")[0]?.trim().split(/\s+/)[0] ?? null;
    };

    for (const img of p.root.querySelectorAll("img")) {
      const ref = pickSrc(img);
      img.removeAttribute("srcset");
      img.removeAttribute("loading");
      const u = ref ? absolute(p.url, ref) : null;
      const data = u ? await inline(u.toString()) : null;
      if (data) { img.setAttribute("src", data); continue; }
      // An image that would not come across is replaced by something you can
      // see -- its own alt text where it has one. A page that quietly loses a
      // figure is worse than a page that says it lost one.
      img.replaceWith(marker(odoc, "image", img.getAttribute("alt")?.trim() || null));
    }
    for (const el of p.root.querySelectorAll("picture > source")) el.remove();

    // An inline background-image is a figure too on plenty of themes.
    for (const el of p.root.querySelectorAll('[style*="url("]')) {
      const css = el.getAttribute("style");
      const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(css);
      const u = m ? absolute(p.url, m[2]) : null;
      const data = u ? await inline(u.toString()) : null;
      if (data) el.setAttribute("style", css.replace(m[0], `url(${data})`));
    }

    /* A demo clip is part of the page, so it comes across when it fits.
     * When it does not, what is left behind is its own poster frame and a
     * marker -- never an empty player, and never silence. */
    for (const m of p.root.querySelectorAll("video, audio")) {
      const refs = [m.getAttribute("src"), ...[...m.querySelectorAll("source")].map((el) => el.getAttribute("src"))]
        .filter(Boolean);
      let inlined = null;
      for (const ref of refs) {
        const u = absolute(p.url, ref);
        inlined = u ? await inline(u.toString(), { max: MAX_MEDIA_BYTES }) : null;
        if (inlined) break;
      }
      if (inlined) {
        for (const src of m.querySelectorAll("source")) src.remove();
        m.setAttribute("src", inlined);
        m.setAttribute("controls", "");
        m.removeAttribute("autoplay");
        const poster = m.getAttribute("poster");
        const pu = poster ? absolute(p.url, poster) : null;
        const pd = pu ? await inline(pu.toString()) : null;
        if (pd) m.setAttribute("poster", pd); else m.removeAttribute("poster");
        m.setAttribute("data-blitz-quiet", "");
        continue;
      }
      const poster = m.getAttribute("poster");
      const pu = poster ? absolute(p.url, poster) : null;
      const pd = pu ? await inline(pu.toString()) : null;
      const stand = marker(odoc, m.tagName.toLowerCase(), refs[0] ? "too large to save" : null);
      if (pd) {
        const still = odoc.createElement("img");
        still.setAttribute("src", pd);
        m.replaceWith(still, stand);
      } else {
        m.replaceWith(stand);
      }
    }

    // An embedded frame (a YouTube player, a live demo) cannot come across at
    // all -- but it is on the page, so it leaves its address behind.
    for (const f of p.root.querySelectorAll("iframe, object, embed")) {
      const ref = f.getAttribute("src") ?? f.getAttribute("data");
      const u = ref ? absolute(p.url, ref) : null;
      const stand = marker(odoc, "embedded " + f.tagName.toLowerCase(), u ? u.hostname : null);
      if (u) stand.setAttribute("data-external", u.toString());
      f.replaceWith(stand);
    }

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
      const key = pageKey(u);
      const to = index.get(key);
      // A link into the book jumps; a link out of it opens in the browser.
      // Both are handled by main.js, which sees the click forwarded out of
      // the iframe (wireEpubInput). The address is kept alongside the page
      // number so a reused page can have its number recomputed next time
      // without being fetched again.
      if (to) { a.setAttribute("data-href", key); a.setAttribute("data-page", String(to)); }
      else a.setAttribute("data-external", u.toString());
    }
  }

  const chapters = fetched.map((p) => ({
    href: p.url,
    title: p.title,
    // Kept so the next open can ask "has this changed?" instead of "give me
    // this again" -- see the top of this function.
    etag: p.etag ?? null,
    lastModified: p.lastModified ?? null,
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
    title: first.doc ? siteTitle(first.doc, entryUrl) : (previous?.title ?? new URL(entryUrl).hostname),
    fetchedAt: Date.now(),
    // The contents page's own validators, and the page list it produced, so
    // the next open can skip rediscovery when it has not changed.
    index: { etag: first.etag ?? previous?.index?.etag ?? null,
             lastModified: first.lastModified ?? previous?.index?.lastModified ?? null },
    pageList: list,
    css: reusedCss ?? cssParts.join("\n"),
    chapters,
    toc,
  };
}
