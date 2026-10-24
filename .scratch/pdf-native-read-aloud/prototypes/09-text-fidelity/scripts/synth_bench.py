"""Synthesise every case's exact TTS strings with the app's own engine code.
Imports app/electron/tts_server.py (read-only) exactly as proto17/py_synth.py did,
and calls kokoro.create_timed with the same arguments the server uses
(voice bf_emma, speed 1.0, lang en-us, continuous=True).
  BLITZ_TTS_THREADS=6 ~/.local/share/blitz-tts/venv/bin/python -B synth_bench.py bench OUTAUDIO
Writes OUTAUDIO/<id>.mp3 and bench/synth.json (phonemes, durations, errors).
"""
import json, os, subprocess, sys, wave, io
from pathlib import Path
sys.path.insert(0, "/home/homefree/Development/blitz/app/electron")
import numpy as np
import tts_server as S

B = Path(sys.argv[1]); AUD = Path(sys.argv[2]); AUD.mkdir(parents=True, exist_ok=True)
res = json.loads((B / "results.json").read_text())
only = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else None
out_path = B / "synth.json"
out = json.loads(out_path.read_text()) if out_path.exists() else {}
SR = 24000
gap = np.zeros(int(0.35 * SR), dtype=np.float32)
import re
for c in res["synthetic"] + res["real"]:
    cid = c["id"]
    if only and cid not in only:
        continue
    texts = [s["speech"] for s in c["sentences"] if s.get("speech") and not s.get("scaffold")]
    rec = {"strings": []}
    chunks = []
    for t in texts:
        r = {"text": t, "phonemes": S.kokoro.tokenizer.phonemize(t, "en-us")}
        if not re.search(r"[A-Za-z]", t):  # main.js:2990 -- app never sends it
            r["skipped_by_app"] = True
        else:
            try:
                audio, sr, timings = S.kokoro.create_timed(t, voice="bf_emma", speed=1.0, lang="en-us", continuous=True)
                if len(audio) == 0:
                    raise ValueError("zero-length audio")
                r["seconds"] = round(len(audio) / sr, 2)
                chunks += [audio.astype(np.float32), gap]
            except Exception as e:  # the server would 500 and the client skip the sentence
                r["error"] = str(e)
        rec["strings"].append(r)
    if chunks:
        a = np.concatenate(chunks)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
            w.writeframes((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes())
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "wav", "-i", "-", "-ac", "1", "-b:a", "48k", str(AUD / f"{cid}.mp3")],
                       input=buf.getvalue(), check=True)
        rec["clip"] = f"audio/{cid}.mp3"
    out[cid] = rec
    print(cid, len(texts), "strings", flush=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=1))
print("done", len(out))
