/*
 * EPUB parsing: unzip -> OPF -> spine, resolving every resource a chapter
 * references (images, stylesheets, fonts, inline `url()`s) to blob: URLs so
 * a sandboxed iframe with no <base> and no network access still renders the
 * book's own markup and CSS as its author wrote them.
 *
 * Unlike the PDF path, there is no separate "extract the text" step to keep
 * faithful to a native render: an EPUB's native form already IS reflowable
 * HTML, so rendering its actual XHTML+CSS in an iframe *is* staying true to
 * the original, the same way rendering the PDF's own canvas is for PDF.js.
 * main.js reads sentences straight out of that live DOM (see epub-render.js
 * companion logic in main.js), not out of a second parallel extraction.
 */
import { unzipSync, strFromU8 } from "fflate";

const XLINK = "http://www.w3.org/1999/xlink";

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp",
  css: "text/css",
  otf: "font/otf", ttf: "font/ttf", woff: "font/woff", woff2: "font/woff2",
  xhtml: "application/xhtml+xml", html: "text/html", htm: "text/html",
};

function dirname(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

/** Resolve a relative href against a base directory, collapsing "." / "..". */
function resolvePath(baseDir, href) {
  if (!href) return null;
  href = href.split("#")[0].split("?")[0];
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null; // already absolute (data:, http:, ...)
  const parts = (baseDir + href).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop(); else out.push(p);
  }
  return out.join("/");
}

function readXml(zip, path) {
  const bytes = zip[path];
  if (!bytes) throw new Error(`EPUB is missing ${path}`);
  return new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
}

/** Rewrite every `url(...)` in a CSS text to a resolved blob: URL. */
function rewriteCssUrls(cssText, cssDir, urlFor) {
  return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref) => {
    const u = urlFor(resolvePath(cssDir, ref));
    return u ? `url(${u})` : m;
  });
}

/*
 * The book's own table of contents.
 *
 * EPUB 3 puts it in a nav document (a manifest item with properties="nav");
 * EPUB 2 puts it in an NCX. Plenty of books in the wild ship both, and
 * plenty of EPUB 3 files still carry only the NCX, so read whichever is
 * there and prefer the nav. Entries are resolved to spine positions, which
 * is the only coordinate the reader has: a TOC href pointing at a file that
 * is not in the spine (or at a fragment inside one) lands on the chapter
 * that contains it.
 */
function tocFromNav(zip, navPath, chapterIndex) {
  const bytes = zip[navPath];
  if (!bytes) return [];
  // text/html, not XML: same reasoning as buildChapter -- a nav document
  // that is not strictly well-formed should not cost the whole TOC.
  const doc = new DOMParser().parseFromString(strFromU8(bytes), "text/html");
  const nav = doc.querySelector('nav[epub\\:type~="toc"]') ?? doc.querySelector("nav");
  const baseDir = dirname(navPath);
  const out = [];
  const walk = (list, depth) => {
    for (const li of list.children) {
      if (li.tagName?.toLowerCase() !== "li") continue;
      const a = li.querySelector(":scope > a[href], :scope > span > a[href]");
      const title = a?.textContent?.trim();
      const pn = a ? chapterIndex(resolvePath(baseDir, a.getAttribute("href"))) : null;
      if (title) out.push({ title, pn, depth });
      const sub = li.querySelector(":scope > ol, :scope > ul");
      if (sub) walk(sub, depth + 1);
    }
  };
  const list = nav?.querySelector("ol, ul");
  if (list) walk(list, 0);
  return out;
}

function tocFromNcx(zip, ncxPath, chapterIndex) {
  const bytes = zip[ncxPath];
  if (!bytes) return [];
  const doc = new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
  const baseDir = dirname(ncxPath);
  const out = [];
  const walk = (parent, depth) => {
    for (const np of parent.children) {
      if (np.tagName?.toLowerCase() !== "navpoint") continue;
      const title = np.querySelector("navLabel > text")?.textContent?.trim();
      const src = np.querySelector("content")?.getAttribute("src");
      const pn = chapterIndex(resolvePath(baseDir, src));
      if (title) out.push({ title, pn, depth });
      walk(np, depth + 1);
    }
  };
  const map = doc.querySelector("navMap");
  if (map) walk(map, 0);
  return out;
}

/*
 * A book with no TOC of its own still gets one: a chapter's first heading is
 * what a reader would call it, and a spine of "Chapter 1, Chapter 2" is more
 * useful than an empty panel. Used only as a fallback.
 */
function tocFromHeadings(chapters) {
  return chapters.map((c, i) => {
    const doc = new DOMParser().parseFromString(c.bodyHtml, "text/html");
    const h = doc.querySelector("h1, h2, h3, title")?.textContent?.trim();
    return { title: h?.slice(0, 120) || `Chapter ${i + 1}`, pn: i + 1, depth: 0 };
  });
}

export async function parseEpub(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));

  const container = readXml(zip, "META-INF/container.xml");
  const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("no <rootfile> in META-INF/container.xml");
  const opfDir = dirname(opfPath);
  const opf = readXml(zip, opfPath);

  const manifest = new Map(); // id -> { href: zip path, mediaType }
  for (const item of opf.querySelectorAll("manifest > item")) {
    const id = item.getAttribute("id");
    const href = resolvePath(opfDir, item.getAttribute("href"));
    if (id && href) manifest.set(id, { href, mediaType: item.getAttribute("media-type") || "" });
  }

  const spineIds = [...opf.querySelectorAll("spine > itemref")]
    .filter((n) => n.getAttribute("linear") !== "no")
    .map((n) => n.getAttribute("idref"));

  const title =
    opf.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", "title")[0]?.textContent?.trim() ||
    opf.querySelector("metadata title")?.textContent?.trim() ||
    "Untitled";

  // Resources are blob-ified lazily and cached by zip path, since the same
  // image or stylesheet is often shared across many chapters.
  const blobUrls = new Map();
  function urlFor(path) {
    if (!path) return null;
    const bytes = zip[path];
    if (!bytes) return null;
    if (blobUrls.has(path)) return blobUrls.get(path);
    const ext = path.split(".").pop().toLowerCase();
    const type = MIME_BY_EXT[ext] ?? "application/octet-stream";
    let blob;
    if (type === "text/css") {
      // CSS gets its own url()s rewritten before it's blobbed, or every font
      // and background image it references breaks once it's off the zip.
      blob = new Blob([rewriteCssUrls(strFromU8(bytes), dirname(path), urlFor)], { type });
    } else {
      blob = new Blob([bytes], { type });
    }
    const url = URL.createObjectURL(blob);
    blobUrls.set(path, url);
    return url;
  }

  function buildChapter(href) {
    const bytes = zip[href];
    if (!bytes) return null;
    const chapterDir = dirname(href);
    // text/html rather than application/xhtml+xml: EPUBs are nominally XHTML
    // but plenty ship well-formed-enough-for-a-browser markup that is not
    // strict XML (unescaped &, self-closed non-void elements), and a single
    // malformed chapter should not blank out the whole book.
    const parsed = new DOMParser().parseFromString(strFromU8(bytes), "text/html");

    for (const img of parsed.querySelectorAll("img[src]")) {
      const u = urlFor(resolvePath(chapterDir, img.getAttribute("src")));
      if (u) img.setAttribute("src", u); else img.remove();
    }
    for (const img of parsed.querySelectorAll("image")) { // SVG <image xlink:href="...">
      const ref = img.getAttributeNS(XLINK, "href") || img.getAttribute("href");
      const u = urlFor(resolvePath(chapterDir, ref));
      if (u) img.setAttributeNS(XLINK, "href", u);
    }
    for (const link of parsed.querySelectorAll('link[rel="stylesheet"]')) {
      const u = urlFor(resolvePath(chapterDir, link.getAttribute("href")));
      if (u) link.setAttribute("href", u); else link.remove();
    }
    for (const style of parsed.querySelectorAll("style")) {
      style.textContent = rewriteCssUrls(style.textContent, chapterDir, urlFor);
    }
    // Strip anything that could execute or navigate: the iframe sandbox
    // already blocks scripts, but belt-and-braces against a book with a
    // <script> tag or inline event handler wasting the parse.
    for (const s of parsed.querySelectorAll("script")) s.remove();
    for (const el of parsed.querySelectorAll("*")) {
      for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
    }
    for (const a of parsed.querySelectorAll("a[href]")) {
      // Internal chapter links (TOC, footnotes) go nowhere useful inside an
      // isolated srcdoc iframe; defang rather than leave a dead click target.
      a.removeAttribute("href");
    }

    return {
      headHtml: parsed.head?.innerHTML ?? "",
      bodyHtml: parsed.body?.innerHTML ?? "",
    };
  }

  const chapters = [];
  for (const id of spineIds) {
    const item = manifest.get(id);
    if (!item) continue;
    const built = buildChapter(item.href);
    if (built) chapters.push({ id, href: item.href, ...built });
  }

  // A TOC href can point at a fragment inside a chapter, or at a file that
  // is not itself in the spine; either way what the reader needs is the
  // spine position that contains it.
  const spinePos = new Map(chapters.map((c, i) => [c.href, i + 1]));
  const chapterIndex = (href) => (href ? spinePos.get(href) ?? null : null);

  const navItem = [...opf.querySelectorAll("manifest > item")]
    .find((n) => (n.getAttribute("properties") || "").split(/\s+/).includes("nav"));
  const ncxId = opf.querySelector("spine")?.getAttribute("toc");
  const ncxItem = (ncxId && manifest.get(ncxId))
    ?? [...manifest.values()].find((m) => m.mediaType === "application/x-dtbncx+xml");

  let toc = [];
  try {
    if (navItem) toc = tocFromNav(zip, resolvePath(opfDir, navItem.getAttribute("href")), chapterIndex);
    if (!toc.length && ncxItem) toc = tocFromNcx(zip, ncxItem.href, chapterIndex);
  } catch (e) {
    console.warn("[epub] could not read the table of contents", e);
  }
  if (!toc.length) toc = tocFromHeadings(chapters);

  return { title, numChapters: chapters.length, chapters, toc };
}
