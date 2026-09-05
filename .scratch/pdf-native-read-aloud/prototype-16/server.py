#!/usr/bin/env python3
"""
TICKET 16 — Kokoro synthesis sidecar. THROWAWAY PROTOTYPE, not production code.

Stdlib http.server only (no Flask in the tts venv, and this is one route).
Run with the venv built for ticket 11/14: see README.

POST /synthesize {text, voice, speed} -> {sr, audio_b64 (wav pcm16), words, spans}
  spans: phoneme-groups aligned to word indices, so the browser binary-searches
  audio.currentTime against span.start/.end and lights up every word index the
  span covers (almost always one, sometimes two — see align_groups_to_words).
GET /voices -> list of voice names baked into voices-v1.0.bin
"""
import base64
import difflib
import io
import json
import re
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from kokoro_onnx import Kokoro

MODEL = "/tmp/claude-1000/tts/kokoro/kokoro-timestamped-fp16.onnx"
VOICES = "/tmp/claude-1000/tts/kokoro/voices-v1.0.bin"
PORT = 5177

so = ort.SessionOptions()
so.intra_op_num_threads = 16
so.inter_op_num_threads = 1
sess = ort.InferenceSession(MODEL, so, providers=["CPUExecutionProvider"])
kokoro = Kokoro.from_session(sess, VOICES)
# kokoro-onnx's Kokoro.__init__ checks for an ONNX output literally named
# "duration"; the -timestamped export names it "durations" (plural), so
# has_timings is False and create_timed() silently returns zero timings.
# Confirmed on this export (ticket 16 progress notes) — force it true.
kokoro.has_timings = True
print(f"[server] loaded {MODEL}, has_timings={kokoro.has_timings}")

WORD_RE = re.compile(r"\S+")


def word_list(text):
    return [m.group() for m in WORD_RE.finditer(text)]


def phoneme_groups(timings):
    """
    Split the phoneme timeline into groups on the literal ' ' phoneme. Each
    group keeps its own phoneme text (stress/diacritics included) so it can
    later be *content*-matched against per-word phonemization, not just
    counted — see align_groups_to_words.
    """
    groups, cur = [], None
    for t in timings:
        if t.phoneme == " ":
            if cur:
                groups.append(cur)
            cur = None
            continue
        if cur is None:
            cur = [t.start, t.end, t.phoneme]
        else:
            cur[1] = t.end
            cur[2] += t.phoneme
    if cur:
        groups.append(cur)
    return groups


def align_groups_to_words(words, groups, tokenizer):
    """
    Map each phoneme group to the word(s) it spoke, by *content*, not by
    counting. Counting fails in both directions on real text: espeak
    cliticises function words ("on the" -> one group covering two words) and
    expands numbers ("55" -> "fifty five", one word spread over two groups) —
    and textbooks carry both in the same sentence, so a running tally drifts
    as soon as either fires (measured: it front-loads every deficit onto the
    first words in the sentence, misassigning nearly everything).

    Instead, phonemize every word alone (no neighbour to clitisice onto, but
    number expansion still fires — it needs no context) and diff the
    concatenation of those against the concatenation of the real per-group
    phonemes with difflib. Matching blocks recover, per group, which word(s)
    contributed characters to it: a cliticised group naturally matches two
    words' worth of expected characters, and a number's two groups each
    independently match the same one word. Approximate — stress marks shift
    at word boundaries (ˈ -> ˌ) so matches are fuzzy, not exact — but errors
    only ever land on a *neighbouring* word, never a distant one.
    """
    expected_word_of_pos = []
    expected_parts = []
    for wi, w in enumerate(words):
        ph = tokenizer.phonemize(w).replace(" ", "")
        expected_parts.append(ph)
        expected_word_of_pos += [wi] * len(ph)
    expected_str = "".join(expected_parts)

    actual_group_of_pos = []
    actual_parts = []
    for gi, g in enumerate(groups):
        actual_parts.append(g[2])
        actual_group_of_pos += [gi] * len(g[2])
    actual_str = "".join(actual_parts)

    group_words = [set() for _ in groups]
    sm = difflib.SequenceMatcher(None, actual_str, expected_str, autojunk=False)
    for a0, b0, size in sm.get_matching_blocks():
        for k in range(size):
            ai, bi = a0 + k, b0 + k
            if ai < len(actual_group_of_pos) and bi < len(expected_word_of_pos):
                group_words[actual_group_of_pos[ai]].add(expected_word_of_pos[bi])

    result = []
    for gi, g in enumerate(groups):
        ws = sorted(group_words[gi]) or ([gi] if gi < len(words) else [])
        result.append((ws, g[0], g[1]))
    return result


def to_wav_b64(audio, sr):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
        w.writeframes(pcm.tobytes())
    return base64.b64encode(buf.getvalue()).decode("ascii")


def voice_names():
    files = getattr(kokoro.voices, "files", None)
    return sorted(files) if files is not None else []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[server] {self.address_string()} {fmt % args}")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/voices":
            return self._json(200, {"voices": voice_names()})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/synthesize":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            text = body["text"]
            voice = body.get("voice", "bf_emma")
            speed = float(body.get("speed", 1.0))

            # continuous=True: kokoro-onnx's default batched path
            # (_create_batches -> _split_phonemes) can return a completely
            # empty audio array for some ordinary sentences with no warning
            # (reproduced on "more powerful methods for attacking them." --
            # nothing unusual about it), which then crashes pauses.py's
            # _quiet_frames on an empty reduction. The sliding-window path
            # here doesn't batch-split at all, costs ~1.4x the synth time
            # per kokoro-onnx's own docstring, and has not reproduced the
            # bug in any case tried. Correctness over the constant factor.
            audio, sr, timings = kokoro.create_timed(
                text, voice=voice, speed=speed, lang="en-us", continuous=True
            )
            if len(audio) == 0:
                raise ValueError(f"synthesis produced zero-length audio for {text!r}")
            groups = phoneme_groups(timings)
            words = word_list(text)
            aligned = align_groups_to_words(words, groups, kokoro.tokenizer)

            self._json(200, {
                "sr": sr,
                "audio_b64": to_wav_b64(audio, sr),
                "words": words,
                "spans": [
                    {"start": s, "end": e, "words": wi} for wi, s, e in aligned
                ],
            })
        except Exception as e:  # prototype: surface the error, don't hide it
            import traceback
            traceback.print_exc()
            self._json(500, {"error": str(e)})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[server] Kokoro sidecar on http://127.0.0.1:{PORT}")
    server.serve_forever()
