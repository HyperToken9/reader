# PROTOTYPE 46 — the two layers on real web pages (throwaway)

Ticket: [#46](https://github.com/HyperToken9/reader/issues/46). Map: [#43](https://github.com/HyperToken9/reader/issues/43). Built on [#45](https://github.com/HyperToken9/reader/issues/45)'s approach.
Vocabulary: `extension/GLOSSARY.md` (sentence spotlight, word cursor, Read from here, Read this, reading pill).

**This is throwaway code.** It answers "what should the two layers look and feel like on real pages, and do they hold up?". Nothing here is meant to be built on; the `build:` tickets start fresh in `extension/`.

What it does:
- Finds the main content (Readability on a clone, mapped back to the live page; fallback `<article>/<main>` scorer from Reading Lenses).
- Paints the **sentence spotlight** (the rest of the main content fades), the **nested dim** (the rest of the lit sentence fades a little) and the **word cursor** in place, with the CSS Custom Highlight API and one highlight per text colour (#45's per-colour fade). The page's DOM is never changed.
- **The voice is fake.** Words advance at about 180 wpm, longer words a bit longer, with a short pause between sentences. There is no sound.

## Load it

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Turn on **Developer mode** (top right).
3. **Load unpacked**, then choose the `extension/` folder next to this README. The files are only on branch `prototype/46-two-layers`. Either:
   - use the worktree it was built in: `/home/homefree/Development/blitz/.claude/worktrees/agent-ace1ddc0da724ec90/.scratch/read-aloud-in-browser/prototypes/46-two-layers/extension`; or
   - check the branch out yourself: `git fetch origin && git worktree add /tmp/p46 origin/prototype/46-two-layers`, then load `/tmp/p46/.scratch/read-aloud-in-browser/prototypes/46-two-layers/extension`.
4. Reload any tab that was already open (or just use it: the first menu click injects the script).

Remove it from `chrome://extensions` when you are done.

## Use it

- **Read from here:** right-click a sentence → *Read from here (P46)*.
- **Read this:** select some text, right-click → *Read this (P46)*. It reads the whole sentences the selection touches, then stops.
- **Toolbar button:** reads the selection if there is one, else from the top of the main content.
- **Click a sentence while reading** to jump the voice there. Links still work as links; clicks while text is selected are ignored.
- **The pill:** ⏮ sentence back · play/pause · ⏭ sentence forward · speed (0.75–2×) · ✕ close. **Esc** also closes.
- **Look toggles** on the pill's second row:
  - **dim** `L` / `M` / `S` — light, medium, strong (the rest of the main content keeps 55% / 40% / 25% of its colour).
  - **cursor** `nested dim` (Blitz's shipped default from #16: the spoken word stays full strength, the rest of the sentence at 72%) / `tint` (the sentence stays full strength, the word gets a soft amber background).
  - **pill** `bottom` (floating, bottom centre) / `near` (just under the lit sentence, follows it) / `top-right`.
  - **i** shows the state: which main-content route was used, sentence count, colour buckets, which CSS route worked, and the per-word paint cost.

Nothing is remembered between pages; every page starts at medium / nested dim / bottom.

## What to try, page by page

| Page | Try |
|---|---|
| [MDN `Range`](https://developer.mozilla.org/en-US/docs/Web/API/Range) | Read from here in the description; jump into the method lists. Watch `<code>` names fade with the text and the sidebar stay untouched. Code blocks are skipped. |
| A BBC News article (any `bbc.com/news/articles/…`) | Read from here on the second paragraph. Does the dim look right next to photos that don't dim? |
| [Wikipedia "Speech synthesis"](https://en.wikipedia.org/wiki/Speech_synthesis) | Long page: does the cursor keep up? Footnote markers `[1]` dim with the text. |
| [Rust Book, ownership](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html) in **Coal** or **Ayu** (paintbrush icon, top left) | The dark-theme case: does dimmed text fade toward the background properly, and is the cursor readable? |
| [paulgraham.com/greatwork.html](https://paulgraham.com/greatwork.html) | Table layout, no `<article>`, paragraphs made of `<br><br>`. Read from here mid-essay; click ahead to jump. |
| [GitHub README](https://github.com/mozilla/readability) (or any issue) | Strict CSP. Try light and dark mode. |
| `check/edge-cases.html` (open it via a local server, e.g. `python3 -m http.server` in `check/`) | Shadow DOM (open and closed), `-webkit-text-fill-color`, gradient text. Select text inside the blue-bordered card and use Read this. |

## Questions for you

1. **Dim strength:** light, medium or strong? Does the answer change between light and dark pages?
2. **Word cursor:** nested dim (Blitz's default) or tint? Is nested dim still readable on the web, where the dimmed text is only colour, not a veil?
3. **Pill placement:** bottom, near the sentence, or top-right? (Near tends to cover the next lines.)
4. **Text-only dim:** only text fades; images, code-block backgrounds, borders and video stay at full strength. Acceptable, or does it need an overlay like Blitz's veil?
5. **Landing:** do Read from here, Read this and click-to-jump land on the sentence you meant?
6. **Anything broken** on any page you tried? Note the URL.

## Findings from the automated run

The full write-up is the comment on #46. In short:
- **It paints everywhere tried**, including GitHub's strict CSP. An adopted stylesheet from the content script worked on every page, so the fallbacks were never needed.
- **Two bugs found and fixed:**
  - MDN's `<main>` is `display: contents`, and `checkVisibility()` returns false for it, so the whole page was dropped.
  - `Intl.Segmenter` always breaks a sentence at a newline. Hand-wrapped HTML (PG, mdBook, GitHub) had its sentences cut at every source line, so the model segments a copy with the newlines blanked.
- **Gradient text** (transparent `-webkit-text-fill-color`) can't dim. Other `-webkit-text-fill-color` pages dim fine when the fill is set too.
- **Per-word cost** is about 0.1 ms. Re-registering everything on every word costs about 5–8 ms on Wikipedia and under 1 ms elsewhere.

Screenshots are in `screenshots/`, as JPEGs converted from the PNGs `check/run.mjs` writes: `<page>-1-read-from-here`, `-2-jump-near-tint-strong`, `-3-light-bottom` and `-4-read-this`. The raw numbers are in `check/results.json`. Headless Chrome reported a dark colour scheme, so MDN and GitHub are shown in dark mode.

To re-run the check (own Chrome for Testing, throwaway profile, never the real browser profile):
`node check/run.mjs /tmp/p46-profile [pageId]`. It needs puppeteer and Chrome for Testing 151 in `~/.cache/puppeteer` (paths at the top of `check/run.mjs`). Branded Google Chrome ignores `--load-extension` since v137, so the check uses Chrome for Testing. The context-menu click itself can't be automated; the check right-clicks the sentence for real (so the coordinates are captured) and then sends the same message the menu sends.
