"""Run-to-run determinism of the python path (same process, and raw model)."""
import sys, json, numpy as np
sys.path.insert(0, "/home/homefree/Development/blitz/app/electron")
import tts_server as S
sents = json.load(open("corpus/sentences.json"))
from collections import Counter
print("random ops:", Counter(n.op_type for n in __import__("onnx").load(S.MODEL).graph.node if "Random" in n.op_type) if __import__("importlib").util.find_spec("onnx") else "onnx not installed")
for s in sents[:6]:
    r = []
    for _ in range(2):
        a, sr, t = S.kokoro.create_timed(s["text"], voice="bf_emma", speed=1.0, continuous=True)
        r.append((a, [(x.start, x.end) for x in t]))
    (a1, t1), (a2, t2) = r
    m = min(len(a1), len(a2)); d = a1[:m] - a2[:m]
    snr = 10*np.log10((a1[:m]**2).sum() / max((d**2).sum(), 1e-30))
    print(s["id"], "len", len(a1), len(a2), "timings same", t1 == t2, "snr dB %.1f" % snr)
# raw model: same input twice -> durations equal? waveform equal?
toks = S.kokoro.tokenizer.tokenize(S.kokoro.tokenizer.phonemize(sents[2]["text"]))
st = S.kokoro.voices["bf_emma"][len(toks)-1]
o1 = S.sess.run(None, {"input_ids": np.array([[0,*toks,0]]), "style": st, "speed": np.array([1.0], np.float32)})
o2 = S.sess.run(None, {"input_ids": np.array([[0,*toks,0]]), "style": st, "speed": np.array([1.0], np.float32)})
print("raw: durations equal", np.array_equal(o1[1], o2[1]), "waveform equal", np.array_equal(o1[0], o2[0]))
np.save("out/dur_py.npy", o1[1]); json.dump(toks, open("out/toks.json", "w"))
