#!/bin/sh
# PROTOTYPE 47: every measurement, each under the shared bench lock (so it never
# overlaps the #48 agent's runs), with the load average logged alongside.
# Results land in out/results.jsonl and out/bench.log.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
LOCK=/home/homefree/.claude/jobs/ec2bb647/tmp/bench.lock
export BLITZ_ESPEAK_DIR=${BLITZ_ESPEAK_DIR:-$HOME/.cache/blitz-speech-espeak-ng}
mkdir -p out
run() {
  echo "=== $* | before: $(uptime)" | tee -a out/bench.log
  timeout "${STEP_TIMEOUT:-900}" flock "$LOCK" sh -c "echo \"  locked: \$(uptime)\"; $*" 2>&1 | tee -a out/bench.log
  echo "  after: $(uptime)" | tee -a out/bench.log
}
steps=${*:-"rtf exact ttfa passage survival idle ids"}
for s in $steps; do
  case $s in
    rtf)
      for t in 4 8; do for i in 1 2 3; do run "BLITZ_TTS_THREADS=$t node bench/host-direct.mjs rtf"; done; done ;;
    exact)
      run "BLITZ_TTS_THREADS=4 node bench/reference.mjs out/ref-t4.json && BLITZ_TTS_THREADS=4 node bench/host-direct.mjs exact out/ref-t4.json"
      run "BLITZ_TTS_THREADS=4 node bench/reference.mjs out/ref-t4b.json 30"
      run "BLITZ_TTS_THREADS=1 node bench/reference.mjs out/ref-t1.json 30 && BLITZ_TTS_THREADS=1 node bench/reference.mjs out/ref-t1b.json 30 && BLITZ_TTS_THREADS=1 node bench/host-direct.mjs exact out/ref-t1.json" ;;
    ttfa) run "BLITZ_TTS_THREADS=4 node bench/browser.mjs ttfa" ;;
    passage) run "BLITZ_TTS_THREADS=4 node bench/browser.mjs passage" ;;
    survival) run "BLITZ_TTS_THREADS=4 node bench/browser.mjs survival" ;;
    idle) run "BLITZ_TTS_THREADS=4 node bench/browser.mjs idle" && run "BLITZ_TTS_THREADS=4 node bench/host-direct.mjs idle" ;;
    transport) run "BLITZ_TTS_THREADS=4 node bench/host-direct.mjs exact out/ref-t4b.json" ;;
    ids) run "node bench/browser.mjs ids" ;;
  esac
done
