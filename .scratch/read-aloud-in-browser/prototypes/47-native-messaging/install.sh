#!/bin/sh
# PROTOTYPE 47: install the Blitz speech native messaging host for one Linux user.
#
#   ./install.sh                         Google Chrome   (~/.config/google-chrome/NativeMessagingHosts)
#   ./install.sh --chromium              Chromium        (~/.config/chromium/NativeMessagingHosts)
#   ./install.sh --user-data-dir DIR     a Chrome started with --user-data-dir=DIR (DIR/NativeMessagingHosts)
#   ./install.sh --uninstall [same flag] remove it again
#
# Needs Node >= 20 on PATH, and the Kokoro weights in ~/.config/blitz/speech/
# (where Blitz downloads them on first play; BLITZ_SPEECH_DIR overrides).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
NAME=dev.blitz.speech
EXT_ID=agdejbojbbncecmipiedhfefmpkmcmba   # pinned by "key" in extension/manifest.json

dir="$HOME/.config/google-chrome/NativeMessagingHosts"
uninstall=0
while [ $# -gt 0 ]; do
  case "$1" in
    --chromium) dir="$HOME/.config/chromium/NativeMessagingHosts" ;;
    --user-data-dir) shift; dir="$1/NativeMessagingHosts" ;;
    --uninstall) uninstall=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$uninstall" = 1 ]; then
  rm -f "$dir/$NAME.json"
  echo "removed $dir/$NAME.json"
  exit 0
fi

node=$(command -v node) || { echo "Node is not on PATH" >&2; exit 1; }
[ -d "$here/node_modules/ort-speech" ] || (cd "$here" && npm install --no-audit --no-fund)
[ -f "$here/vendor/espeak-ng/libespeak-ng.so" ] || node "$here/fetch-espeak.mjs"
speech=${BLITZ_SPEECH_DIR:-$HOME/.config/blitz/speech}
[ -f "$speech/kokoro-v1.0.fp16.onnx" ] || echo "warning: no Kokoro model in $speech (open Blitz and press play once, or set BLITZ_SPEECH_DIR)" >&2

# libespeak-ng keeps its data path in a 160-byte buffer and silently falls
# back to its compiled-in path when ours is longer, so give it a short one.
espeak="$here/vendor/espeak-ng"
if [ ${#espeak} -gt 120 ]; then
  mkdir -p "$HOME/.cache"
  ln -sfn "$espeak" "$HOME/.cache/blitz-speech-espeak-ng"
  espeak="$HOME/.cache/blitz-speech-espeak-ng"
fi

# Chrome runs `path` directly with a minimal environment, so the launcher pins
# the absolute Node it was installed with.
launcher="$here/host/launcher.sh"
cat > "$launcher" <<EOF
#!/bin/sh
export BLITZ_ESPEAK_DIR="$espeak"
exec "$node" "$here/host/speech-host.mjs" "\$@" 2>>"$here/host/host.log"
EOF
chmod +x "$launcher"

mkdir -p "$dir"
cat > "$dir/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Blitz speech engine (prototype 47)",
  "path": "$launcher",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
echo "installed $dir/$NAME.json -> $launcher"
echo "now load $here/extension unpacked (chrome://extensions, Developer mode, Load unpacked); its ID is $EXT_ID"
