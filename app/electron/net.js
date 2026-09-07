/*
 * The one place Blitz reaches the network for a *document*.
 *
 * A documentation site is a book whose pages happen to live on a web server,
 * so reading one means fetching it. That fetch has to happen here rather than
 * in the renderer for the plain reason that the renderer is a file:// page:
 * every cross-origin request it makes is blocked, and no amount of markup
 * rewriting fixes that. The main process has no such origin, the same way it
 * is already the only place that touches the filesystem.
 *
 * What crosses back is *bytes*, never a parsed page and never anything that
 * runs. Everything downstream -- picking the table of contents out of the
 * markup, extracting the prose, inlining images -- happens in the renderer
 * with the DOMParser it already uses for EPUB chapters, and lands in the same
 * sandboxed no-scripts iframe an EPUB chapter does (renderer/site.js).
 */

// A doc site's stylesheet or a full-page diagram is measured in hundreds of
// kilobytes; anything past this is not something we are going to read.
const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 20000;

// Identify honestly. A default Electron user-agent gets a fair number of
// sites' bot handling; this says what we are without pretending to be Chrome.
const UA = "Blitz/0.1 (+https://github.com/HyperToken9/reader) reader";

/**
 * Fetch one http(s) resource. Never throws: a page that will not load is a
 * page the snapshot skips, not a crash in the middle of a 40-page site.
 *
 * Returns { ok, url (after redirects), status, contentType, bytes }.
 */
export async function fetchResource(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 0, reason: "that is not a URL" };
  }
  // http(s) only. file: would hand a web page the filesystem, and the other
  // schemes have no meaning here.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, status: 0, reason: `${url.protocol} is not a web address` };
  }

  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "*/*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, url: res.url, reason: `HTTP ${res.status}` };

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return { ok: false, status: res.status, url: res.url, reason: "too large" };

    const buf = await res.arrayBuffer();
    // Content-Length is a hint, not a promise -- check what actually arrived.
    if (buf.byteLength > MAX_BYTES) return { ok: false, status: res.status, url: res.url, reason: "too large" };

    return {
      ok: true,
      status: res.status,
      url: res.url,
      contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(),
      bytes: buf,
    };
  } catch (e) {
    return { ok: false, status: 0, reason: e?.name === "TimeoutError" ? "timed out" : String(e?.message ?? e) };
  }
}
