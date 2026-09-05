# Reading Lenses

A Chrome/Edge (MV3) extension that applies eight evidence-based reading aids **in place**, on
whatever page you are already reading — no reader view, no copy-paste, no separate app.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open any article. `Alt+R` opens the panel.

Shortcuts are editable at `chrome://extensions/shortcuts`.

| Key | Action |
| --- | --- |
| `Alt+R` | Show/hide the in-page panel |
| `Alt+M` | Toggle the reading mask |
| `Alt+S` | RSVP the selection, or the whole article |
| `Alt+click` a word | Start the pacer / read-aloud / RSVP from that word |
| `Esc` | Leave RSVP |

The toolbar popup carries the four most-used toggles, the typeface picker, and a
**Pause on this site** switch. Right-click gives the same actions from the page context menu.

## The eight techniques, and where each one lives

| Technique | Control | How it works here |
| --- | --- | --- |
| Visual crowding reduction | *Crowding & spacing* sliders | Tracking, word gap, leading, size and measure are written as custom properties on the detected article element; a manifest stylesheet applies them to prose descendants only, so headings and code keep their own scale. |
| Typographic switching | *Typeface* | Atkinson Hyperlegible, Lexend and OpenDyslexic ship as latin-subset `woff2` inside the extension. Nothing is fetched at runtime. |
| Bionic / fixation anchoring | *Fixation anchoring* | Word openings wrapped in `<rl-b>`, strength 25–62%. The bolded slice is measured over the word's leading *letters*, so punctuation doesn't eat the anchor. |
| Chromatic line guidance | *Chromatic line guidance* | Word boxes are measured to find real rendered lines, then each line gets a hue ramp whose end colour opens the next line. Page background luminance picks the lightness, so it stays legible on dark sites. Links keep their own colour. |
| Screen masking / reading ruler | *Reading mask* | A fixed band with a `100vmax` box-shadow follows the cursor; aperture is 1–4 lines, sized from the article's computed `line-height`. |
| Digital meta-guiding | *Pacer* | A `requestAnimationFrame` highlight walks the wrapped words at 150–700 wpm, holding 1.55× on commas and 2.1× on sentence ends, and scrolling to keep itself on screen. |
| Bimodal audio-visual | *Read aloud* | `speechSynthesis` with `onboundary` → word mapping. Long pages are split into 220-word utterances (Chrome silently drops long ones). If a voice emits no boundary events, it says so and falls back to estimated cadence. |
| RSVP | *RSVP* | Full-screen single-word reader, ORP character held on a fixed centre line. Takes your selection if you have one, otherwise the detected article. |

## How it stays out of the page's way

- **No `<style>` injection.** Page rules come from a manifest content-script stylesheet (exempt
  from the page's CSP); the panel's own CSS is a constructed `CSSStyleSheet` on a shadow root.
  Dynamic values are set through CSSOM, which CSP does not restrict.
- **The panel is a shadow root** on a `<reading-lenses>` host with `all: initial`, so no page
  selector reaches in and no page `*` rule reaches out.
- **Word wrappers are custom elements** (`<rl-t>`, `<rl-w>`, `<rl-b>`) — nothing a site writes for
  `div` or `span` can hit them by accident.
- **Reversible.** Each wrapped text node keeps its original string; *Reset* restores the DOM,
  drops the classes and clears the custom properties.
- **No network, no telemetry, no remote code.** Fonts are bundled. Settings live in
  `chrome.storage.local`.

## Known limits

- The article detector scores paragraph density and picks the most specific element holding the
  prose. On unusual layouts, hit **↻** in the panel header to re-scan.
- SPA route changes don't re-scan automatically — same **↻** button.
- Wrapping every word costs a layout pass; on a very long page the first toggle takes a beat.
- Chrome blocks all extensions on `chrome://` pages, the Web Store and the built-in PDF viewer.
  The popup says so rather than failing silently.
