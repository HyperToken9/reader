"""Assemble real-excerpts.pdf from single pages of the sample books + manifest.
  venv/bin/python build_real.py OUTDIR
"""
import json, sys
from pathlib import Path
from pypdf import PdfReader, PdfWriter

OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
D = Path("/home/homefree/Development/blitz/sample_books")
FILES = {}
for f in D.glob("*.pdf"):
    n = f.name
    FILES["millington" if n.startswith("Game") else "biochem" if n.startswith("Textbook") else "crafting" if n.startswith("crafting") else "lejepa" if n.startswith("lejepa") else "codebook"] = f
cases = json.loads(Path("real_cases.json").read_text())
w = PdfWriter()
readers = {}
manifest = []
order = []  # unique (book, pn) in case order
for c in cases:
    k = (c["book"], c["pn"])
    if k not in order:
        order.append(k)
for i, (book, pn) in enumerate(order, 1):
    r = readers.setdefault(book, PdfReader(str(FILES[book])))
    w.add_page(r.pages[pn - 1])
    manifest.append({"excerpt_page": i, "book": book, "file": FILES[book].name, "source_page": pn,
                     "cases": [c["id"] for c in cases if (c["book"], c["pn"]) == (book, pn)]})
w.write(str(OUT / "real-excerpts.pdf"))
(OUT / "real-excerpts-manifest.json").write_text(json.dumps(manifest, indent=1))
print(len(manifest), "pages")
