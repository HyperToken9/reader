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
import { session } from "electron";

const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 20000;

// Identify honestly. A default Electron user-agent gets a fair number of
// sites' bot handling; this says what we are without pretending to be Chrome.
const UA = "Blitz/0.1 (+https://github.com/HyperToken9/reader) reader";

/*
 * Document fetching gets its own session, deliberately separate from the one
 * the app's own window uses.
 *
 * Not tidiness: the default session's HTTP cache and cookie jar are shared
 * state we do not control, and it bites. A burst of requests earned a 429
 * from a docs host's CDN, Chromium cached that response, and every later
 * request for that site came back 429 *from the cache* -- with the site
 * itself answering 200 to curl the whole time. A partition with no `persist:`
 * prefix is memory-only, so it starts empty every launch and carries nothing
 * between sites; `cache: "no-store"` on top keeps freshness where this module
 * can reason about it, in the ETag validators it sends by hand, rather than
 * in a browser cache it cannot see.
 *
 * Created lazily: sessions do not exist before the app is ready.
 */
let docSession = null;
function net() {
  if (!docSession) docSession = session.fromPartition("blitz-docs");
  return docSession;
}

/*
 * A site is re-checked every time it is opened, which is the point -- but
 * "re-checked" must not mean "re-downloaded". Handing back the validators a
 * server gave us last time turns the second open of a forty-page site into
 * forty empty 304s instead of forty page bodies: still genuinely current,
 * a fraction of the traffic, and not the sort of thing that gets an app
 * rate-limited (which is exactly what happened without it).
 */
function validators(headers, { etag, lastModified }) {
  if (etag) headers["If-None-Match"] = etag;
  else if (lastModified) headers["If-Modified-Since"] = lastModified;
  return headers;
}

/**
 * Fetch one http(s) resource. Never throws: a page that will not load is a
 * page the snapshot skips, not a crash in the middle of a 40-page site.
 *
 * Pass `etag` / `lastModified` from a previous fetch to make it conditional;
 * an unchanged resource then comes back as { ok, notModified: true } with no
 * body, and the caller reuses what it already has.
 *
 * Returns { ok, url (after redirects), status, contentType, bytes, etag,
 * lastModified, notModified }.
 */
export async function fetchResource(rawUrl, opts = {}) {
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

  const headers = validators({ "User-Agent": UA, Accept: "*/*" }, opts);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Electron's session.fetch does not always populate Response.url, so
      // the request URL stands in -- callers resolve relative links against
      // this and an empty string is not a base.
      const asked = url.toString();
      const res = await net().fetch(asked, {
        redirect: "follow",
        cache: "no-store",
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      // Unchanged since last time: no body, nothing to do.
      if (res.status === 304) {
        return { ok: true, notModified: true, status: 304, url: res.url || asked };
      }

      // Being told to slow down is worth honouring once rather than dropping
      // the page: a docs host will 429 a burst of forty requests.
      if (res.status === 429 && attempt === 0) {
        const after = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(after) ? after * 1000 : 1500, 5000)));
        continue;
      }

      if (!res.ok) {
        return {
          ok: false, status: res.status, url: res.url || asked,
          // 429 is the one status worth translating: it is temporary, it is
          // our fault, and "try again in a minute" is actionable where
          // "HTTP 429" is not.
          reason: res.status === 429 ? "the site is asking us to slow down — try again in a minute" : `HTTP ${res.status}`,
        };
      }

      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_BYTES) return { ok: false, status: res.status, url: res.url || asked, reason: "too large" };

      const buf = await res.arrayBuffer();
      // Content-Length is a hint, not a promise -- check what actually arrived.
      if (buf.byteLength > MAX_BYTES) return { ok: false, status: res.status, url: res.url || asked, reason: "too large" };

      return {
        ok: true,
        status: res.status,
        url: res.url || asked,
        contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(),
        etag: res.headers.get("etag") ?? null,
        lastModified: res.headers.get("last-modified") ?? null,
        bytes: buf,
      };
    } catch (e) {
      return { ok: false, status: 0, reason: e?.name === "TimeoutError" ? "timed out" : String(e?.message ?? e) };
    }
  }
  return { ok: false, status: 429, url: url.toString(), reason: "rate limited" };
}
