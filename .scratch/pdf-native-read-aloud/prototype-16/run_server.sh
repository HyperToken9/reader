#!/usr/bin/env bash
# TICKET 16 — one-command launcher for the Kokoro sidecar (server.py).
# Uses the venv built for tickets 11/14 in /tmp/claude-1000/tts, which already
# has kokoro-onnx, onnxruntime and the -timestamped model exported. Nothing
# in this repo installs it; if it's gone, see README.md "Rebuilding the venv".
set -euo pipefail
cd "$(dirname "$0")"
source /tmp/claude-1000/tts/venv/bin/activate
exec python server.py
