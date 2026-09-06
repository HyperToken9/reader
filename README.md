# reader

Two reading tools, one repo. They share an idea — meet the reader where the text
already is, instead of moving the text somewhere else — and nothing else.

## Blitz — [`app/`](app/)

A desktop app that reads a textbook aloud **on the actual PDF page**. The page you
look at is the real render: figures, equations, columns, all of it, exactly as
authored. The reading experience is an overlay on top — a band over the sentence
being spoken, a cursor on the word.

That constraint is the whole point. Apps that read PDFs aloud generally extract the
text into their own reflowed environment first, which is exactly where diagrams and
equations fall apart. Nothing here reflows anything.

Electron, with local models and no network at read time: **Kokoro** for speech
(with phoneme-level timings, which is what makes the word cursor honest) and
**PP-DocLayoutV2** for reading order. Linux, packaged as an AppImage and a `.deb`.

```sh
cd app
npm install
npm run setup:speech    # one time, ~500 MB of model weights
npm run dev
```

[`app/README.md`](app/README.md) covers the architecture, the speech engine's two
sharp edges, and the branch model.

## Reading Lenses — [`src/`](src/)

An MV3 Chrome extension that applies eight evidence-based reading aids in place on
whatever web page you are already reading — crowding and spacing, typeface
switching, bionic-style fixation anchoring, a pacer, a reading mask, RSVP, and
read-aloud. It predates Blitz and is not part of it, though Blitz's read-aloud
began as a critique of this one's.

See [`README-reading-lenses.md`](README-reading-lenses.md).

## How this project is planned

Blitz is charted as a **Wayfinder map**: a destination, and a route of tickets that
each resolve one decision rather than slicing up a build. The map is the issue
labelled `wayfinder:map`; every ticket is an issue linked from it, and every ticket
that is closed carries the answer it reached and the evidence behind it.

Working copies live in [`.scratch/pdf-native-read-aloud/`](.scratch/pdf-native-read-aloud/),
along with the throwaway prototypes the answers were read off. Those prototypes are
kept deliberately: they are the primary sources, not clutter.

## A note on the test corpus

`sample_books/` holds real textbook PDFs and is gitignored — for size and because
they are licensed material. They were briefly committed early on and have since been
purged from history. Don't re-add them.
[Ticket 01](.scratch/pdf-native-read-aloud/issues/01-test-pdf-corpus.md) records what
the corpus needs to contain; OpenStax and arXiv are fine substitutes.
