"""
Write the Python engine's answer for every corpus sentence, so the Node engine
has something to be compared against after the Python engine is gone.

This is how python-reference.json (and python-reference-2.json, the second run
that measures the noise floor) were made, against tts_server.py as it stood
at commit 1cbac26, the last one that had it:

  git show 1cbac26:app/electron/tts_server.py > /tmp/tts_server.py
  BLITZ_TTS_THREADS=8 ~/.local/share/blitz-tts/venv/bin/python -B \
      python_reference.py /tmp python-reference.json

It imports the real module rather than copying it, so the reference is exactly
what the app used to serve. Audio is left out: the model graph has random ops,
so audio is never bit-identical, not even Python against Python.
"""
import json
import sys
from pathlib import Path

server_dir, out_name = sys.argv[1], sys.argv[2]
sys.path.insert(0, server_dir)
import tts_server as S  # noqa: E402  (builds the session exactly as the app did)

HERE = Path(__file__).parent
sentences = json.loads((HERE / "sentences.json").read_text())

out = []
for i, s in enumerate(sentences):
    text = s["text"]
    audio, sr, timings = S.kokoro.create_timed(text, voice="bf_emma", speed=1.0, lang="en-us", continuous=True)
    groups = S.phoneme_groups(timings)
    words = S.word_list(text)
    aligned = S.align_groups_to_words(words, groups, S.kokoro.tokenizer)
    out.append({
        "id": s["id"],
        "phonemes": S.kokoro.tokenizer.phonemize(text, "en-us"),
        "samples": len(audio),
        "words": words,
        "spans": [{"start": a, "end": b, "words": w} for w, a, b in aligned],
    })
    if i % 20 == 0:
        print(i, s["id"], flush=True)

(HERE / out_name).write_text(json.dumps(out, ensure_ascii=False, indent=0))
print("done", len(out))
