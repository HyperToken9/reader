"""Reference synthesis through the REAL tts_server.py functions (imported, not copied).
  BLITZ_TTS_THREADS=8 ~/.local/share/blitz-tts/venv/bin/python -B py_synth.py [--bench]
Writes out/py/<id>.f32 (raw float32 audio) and out/py_synth.json.
--bench: only the 6 bench sentences, 3 warm runs each, + cold start, -> out/py_bench.json
"""
import json, os, sys, time
T0 = time.perf_counter()
sys.path.insert(0, "/home/homefree/Development/blitz/app/electron")
import numpy as np
import tts_server as S  # builds the session exactly as the app does (8 intra / 1 inter)
T_LOADED = time.perf_counter()

from pathlib import Path
HERE = Path(__file__).parent
OUT = HERE / "out"; PYDIR = os.environ.get("PYDIR", "py"); (OUT / PYDIR).mkdir(parents=True, exist_ok=True)
sents = json.loads((HERE / "corpus/sentences.json").read_text())
bench = "--bench" in sys.argv

# Instrument the model call so we can split ONNX time from everything else
_infer = S.kokoro._infer
calls = []
def timed_infer(*a, **k):
    t = time.perf_counter(); r = _infer(*a, **k); calls.append(time.perf_counter() - t); return r
S.kokoro._infer = timed_infer


def one(text):
    calls.clear()
    t = time.perf_counter()
    audio, sr, timings = S.kokoro.create_timed(text, voice="bf_emma", speed=1.0, lang="en-us", continuous=True)
    groups = S.phoneme_groups(timings)
    words = S.word_list(text)
    aligned = S.align_groups_to_words(words, groups, S.kokoro.tokenizer)
    wav = S.to_wav_b64(audio, sr)
    dt = time.perf_counter() - t
    return audio, timings, words, aligned, dt, list(calls), wav


if bench:
    first = None
    res = {"import_and_load_s": T_LOADED - T0, "runs": []}
    for rep in range(4):  # rep 0 = first synthesis after load (cold-ish)
        for s in sents[:6]:
            audio, *_ , dt, c, _w = one(s["text"])
            res["runs"].append({"rep": rep, "id": s["id"], "chars": len(s["text"]), "s": dt,
                                "onnx_s": sum(c), "audio_s": len(audio) / 24000})
    (OUT / "py_bench.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res["import_and_load_s"]))
    sys.exit()

out = []
for i, s in enumerate(sents):
    audio, timings, words, aligned, dt, c, wav = one(s["text"])
    audio.astype("<f4").tofile(OUT / PYDIR / f"{s['id']}.f32")
    out.append({"id": s["id"], "text": s["text"], "n": len(audio), "s": dt, "onnx_s": sum(c), "windows": len(c),
                "timings": [[t.phoneme, t.start, t.end] for t in timings],
                "words": words, "spans": [{"start": a, "end": b, "words": w} for w, a, b in aligned],
                "wav_len": len(wav)})
    if i % 20 == 0:
        print(i, s["id"], f"{dt:.2f}s", flush=True)
(OUT / f"{PYDIR}_synth.json").write_text(json.dumps(out, ensure_ascii=False))
print("done", len(out))
