"""Build corpus/sentences.json: ~200 real sentences from 5 sample books,
biased toward the hard cases (numbers, abbreviations, hyphens, quotes, symbols,
maths-ish runs), plus 6 benchmark sentences (textbook-style, 26..~200 chars)."""
import json, random, re, html
from pathlib import Path

C = Path(__file__).parent / "corpus"
random.seed(17)


def clean(t):
    t = re.sub(r"-\n(?=[a-z])", "", t)          # de-hyphenate line breaks
    t = re.sub(r"\s*\n\s*", " ", t)
    t = re.sub(r"\s+", " ", t)
    return t


def epub_text():
    out = []
    for f in sorted((C / "epub/OEBPS").glob("ch0[1-4]*.xhtml")):
        s = f.read_text(encoding="utf-8", errors="ignore")
        s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.S)
        for p in re.findall(r"<p[^>]*>(.*?)</p>", s, flags=re.S):
            out.append(html.unescape(re.sub(r"<[^>]+>", "", p)))
    return " ".join(out)


SPLIT = re.compile(r"(?:(?<=[.!?])|(?<=[.!?][\"”’)]))\s+(?=[\"“‘(]?[A-Z0-9])")
HARD = {
    "digits": re.compile(r"\d"),
    "abbrev": re.compile(r"\b(e\.g\.|i\.e\.|etc\.|Fig\.|Dr\.|Mr\.|vs\.|et al\.|cf\.|No\.)"),
    "hyphen": re.compile(r"\w-\w|—|–"),
    "quote": re.compile(r"[\"“”‘’']"),
    "symbol": re.compile(r"[=+*/<>%&$#@^~|\\{}\[\]()°±×÷→←]"),
    "caps": re.compile(r"\b[A-Z]{2,}\b"),
}

books = {
    "ci": clean((C / "ci.txt").read_text()),
    "cb": clean((C / "cb.txt").read_text()),
    "bio": clean((C / "bio.txt").read_text()),
    "gp": clean((C / "gp.txt").read_text()),
    "drl": clean(epub_text()),
}
picked = []
for name, text in books.items():
    sents = [s.strip() for s in SPLIT.split(text)]
    sents = [s for s in sents if 25 <= len(s) <= 260 and re.search(r"[a-z]{3}", s)
             and len(re.findall(r"[A-Za-z]", s)) > 0.5 * len(s)]
    hard = [s for s in sents if any(r.search(s) for r in HARD.values())]
    plain = [s for s in sents if s not in hard]
    random.shuffle(hard); random.shuffle(plain)
    picked += [(name, s) for s in hard[:28] + plain[:12]]

BENCH = [
    "The parser reads one token at a time.",
    "Glucose is phosphorylated by hexokinase in the first step of glycolysis.",
    "A scanner, also called a lexer, takes in the linear stream of characters and chunks them together into a series of tokens.",
    "In 1586, Mary Queen of Scots was put on trial for treason, accused of plotting to assassinate Queen Elizabeth I of England.",
    "The force of gravity on an object near the Earth's surface is about 9.8 metres per second squared, which we usually write as g = 9.8 m/s².",
    "Reinforcement learning is concerned with solving sequential decision-making problems, in which an agent takes actions in an environment and receives rewards, and the goal is to maximise the cumulative reward over time.",
]
out = [{"id": f"bench{i}", "book": "bench", "text": s} for i, s in enumerate(BENCH)]
out += [{"id": f"{b}{i}", "book": b, "text": s} for i, (b, s) in enumerate(picked)]
(C / "sentences.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
tally = {k: sum(1 for o in out if r.search(o["text"])) for k, r in HARD.items()}
print(len(out), "sentences;", tally)
