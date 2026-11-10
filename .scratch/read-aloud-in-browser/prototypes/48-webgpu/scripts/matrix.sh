#!/bin/sh
# PROTOTYPE 48 run matrix; each run takes the bench lock shared with prototype 47 on its own
cd "$(dirname "$0")/.."
L=/home/homefree/.claude/jobs/ec2bb647/tmp/bench.lock
run() { flock $L sh -c "echo; echo \"== $* | \$(uptime)\"; timeout 3000 node scripts/run.mjs $* 2>&1 | grep -v '^ *at ' | tail -4"; }
run bench --ep webgpu --pp high-performance --model fp32 --reps 3
run bench --ep wasm --threads 4 --reps 3
run bench --ep webgpu --pp low-power --reps 3 --tag webgpu-low-power-r2
run durations --ep webgpu --pp low-power
run ttfa --ep webgpu --pp low-power --profile ttfa
run drift --ep webgpu --pp low-power
run durations --ep wasm --threads 4
run phon
