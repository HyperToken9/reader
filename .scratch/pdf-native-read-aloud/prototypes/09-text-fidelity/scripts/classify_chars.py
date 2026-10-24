"""For every non-ASCII char that reaches a TTS string, what does Kokoro's
phonemizer turn it into? Context 'a C b' so we can see what C contributes."""
import json, sys, unicodedata
from kokoro_onnx.tokenizer import Tokenizer
t = Tokenizer()
chars = json.load(open("out/chars.json"))
base = t.phonemize("a b", "en-us")
out = {}
for c, counts in chars.items():
    ph = t.phonemize(f"a {c} b", "en-us")
    alone = t.phonemize(c, "en-us")
    name = unicodedata.name(c, f"U+{ord(c):04X}")
    if "lˌɛɾɚ" in alone or "lˈɛɾɚ" in alone:
        cls = "codepoint gibberish"
    elif not alone.strip() or ph.replace(" ", "") == base.replace(" ", ""):
        cls = "silent"
    elif alone.strip() in "…—–‘’“”«»•·":
        cls = "punctuation passthrough"
    else:
        cls = "spoken"
    out[c] = {"name": name, "cp": f"U+{ord(c):04X}", "class": cls, "alone": alone, "counts": counts}
json.dump(out, open("out/chars_classified.json", "w"), ensure_ascii=False, indent=1)
agg = {}
for c, r in out.items():
    a = agg.setdefault(r["class"], {"distinct": 0, "occurrences": 0})
    a["distinct"] += 1; a["occurrences"] += r["counts"]["total"]
print(json.dumps(agg, indent=1))
for c, r in sorted(out.items(), key=lambda kv: -kv[1]["counts"]["total"])[:90]:
    print(r["cp"], c, r["class"], r["counts"]["total"], r["name"][:34], "->", r["alone"][:40])
