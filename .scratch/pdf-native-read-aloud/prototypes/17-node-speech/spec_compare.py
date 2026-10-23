"""Phase-insensitive audio comparison: log-magnitude STFT distance (dB) between runs.
venv/bin/python spec_compare.py py py2 node node-ort123 ...   (first name is the reference)
Only sentences whose audio lengths match are compared (otherwise frames misalign)."""
import json, sys
import numpy as np
from pathlib import Path
O = Path(__file__).parent / "out"
ref, others = sys.argv[1], sys.argv[2:]
ids = [r["id"] for r in json.loads((O / f"{ref}_synth.json").read_text())]

def logmag(x, n=1024, hop=256):
    w = np.hanning(n).astype(np.float32)
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::hop] * w
    return 20 * np.log10(np.abs(np.fft.rfft(frames, axis=1)) + 1e-5)

for o in others:
    d, wd, k = [], [], 0
    for i in ids:
        a = np.fromfile(O / ref / f"{i}.f32", "<f4"); b = np.fromfile(O / o / f"{i}.f32", "<f4")
        if len(a) != len(b):
            continue
        k += 1
        A, B = logmag(a), logmag(b)
        loud = A > A.max() - 60  # ignore near-silent bins
        d.append(np.mean(np.abs(A - B)[loud]))
        e = a - b
        wd.append(10 * np.log10((a ** 2).sum() / max((e ** 2).sum(), 1e-30)))
    print(f"{ref} vs {o}: n={k}  log-spectral |dB| median {np.median(d):.2f} p95 {np.percentile(d,95):.2f} max {np.max(d):.2f}"
          f" | waveform SNR median {np.median(wd):.1f} dB")
