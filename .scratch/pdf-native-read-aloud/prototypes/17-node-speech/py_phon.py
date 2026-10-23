"""Reference phonemes from the Python path, exactly as tts_server.py gets them.
Run with the blitz-tts venv:  ~/.local/share/blitz-tts/venv/bin/python -B py_phon.py
Writes out/py_phon.json: [{id, text, sent: <phonemes fed to tokenizer>, words: [[w, phonemize(w)]]}]
"""
import json, re, sys
from pathlib import Path
from kokoro_onnx.tokenizer import Tokenizer

HERE = Path(__file__).parent
tok = Tokenizer()  # same defaults Kokoro._setup gets (embedded vocab == package vocab, checked in B)
sents = json.loads((HERE / "corpus/sentences.json").read_text())
out = []
for s in sents:
    ph = tok.phonemize(s["text"], "en-us")
    fed = " ".join(ph.split())  # Kokoro._prepare
    words = [m.group() for m in re.finditer(r"\S+", s["text"])]
    out.append({"id": s["id"], "text": s["text"], "raw": ph, "sent": fed,
                "words": [[w, tok.phonemize(w)] for w in words]})
(HERE / "out").mkdir(exist_ok=True)
(HERE / "out/py_phon.json").write_text(json.dumps(out, ensure_ascii=False))
print(len(out), "sentences,", sum(len(o["words"]) for o in out), "words")
