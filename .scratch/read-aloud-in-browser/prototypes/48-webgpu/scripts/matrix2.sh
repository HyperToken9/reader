#!/bin/sh
# PROTOTYPE 48 second pass (after the offscreen-ready fix); each run takes the shared bench lock
cd "$(dirname "$0")/.."
L=/home/homefree/.claude/jobs/ec2bb647/tmp/bench.lock
run() { flock $L sh -c "echo; echo \"== $* | \$(uptime)\"; timeout 3000 node scripts/run.mjs $* 2>&1 | grep -v '^ *at ' | tail -8 | cut -c1-1500"; }
run ttfa --ep webgpu --pp low-power --profile ttfa
run drift --ep webgpu --pp low-power --profile drift
