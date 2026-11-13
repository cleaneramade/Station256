#!/bin/bash
# Puts llama.cpp's llama-server in the house for Station's Local AI tab (panel/lib/llama.js finds
# it in ~/.local/bin). Uses a pinned official build: the NVIDIA (CUDA) one when the computer's
# graphics card can run it, otherwise the plain one. Safe to run again; no admin password needed.
#   system/install-llama.sh          install, or check what's installed
#   LLAMA_FLAVOR=cpu system/install-llama.sh   the plain build, even with a graphics card
set -euo pipefail
TAG=b12283 # shortcut: pinned by hand; move it up when a newer release is wanted
CUDA=13.5  # the CUDA build for this TAG; the card's driver must support at least this version
BASE="$HOME/.local/share/llama.cpp"
RELEASES="https://github.com/ggml-org/llama.cpp/releases/download/$TAG"

# The program has to start from a bare environment, the way Station starts it.
works() { env -i HOME="$HOME" PATH=/usr/bin:/bin "$1/llama-server" --version >/dev/null 2>&1; }

# The card can run CUDA builds up to the version its driver reports.
card_ok() {
  local have
  have="$(nvidia-smi 2>/dev/null | grep -o 'CUDA[A-Z ]* Version: *[0-9.]*' | grep -o '[0-9.]*$' || true)"
  [ -n "$have" ] && [ "$(printf '%s\n%s\n' "$CUDA" "$have" | sort -V | head -1)" = "$CUDA" ]
}

# Downloads each archive and unpacks everything into one folder (llama-server needs the .so files
# beside it), then moves that folder into place whole.
fetch() {
  local dest="$1"; shift
  local tmp; tmp="$(mktemp -d "$HOME/.cache/llama-install.XXXXXX")" # not /tmp: that's memory in the house
  local status=0
  unpack "$tmp" "$dest" "$@" || status=$?
  rm -rf "$tmp"
  return "$status"
}

# Every step is checked by hand (set -e doesn't hold inside a function called with ||), so a broken
# download never gets moved into place.
unpack() {
  local tmp="$1" dest="$2"; shift 2
  mkdir -p "$tmp/out" || return 1
  for asset in "$@"; do
    echo "Downloading $asset"
    curl -L --fail --progress-bar -o "$tmp/$asset" "$RELEASES/$asset" || return 1
    tar -tzf "$tmp/$asset" >/dev/null || return 1
    tar -xzf "$tmp/$asset" -C "$tmp/out" || return 1
  done
  local program from
  program="$(find "$tmp/out" -name llama-server -type f | head -1)"
  [ -n "$program" ] || { echo "No llama-server in the download."; return 1; }
  from="$(dirname "$program")"
  # Extra archives (the CUDA libraries) may unpack beside the folder rather than in it.
  find "$tmp/out" -maxdepth 2 -name '*.so*' ! -path "$from/*" -exec mv -t "$from" {} + || return 1
  rm -rf "$dest" && mkdir -p "$BASE" && mv "$from" "$dest"
}

mkdir -p "$HOME/.cache" "$HOME/.local/bin"
flavor="${LLAMA_FLAVOR:-}"
[ -n "$flavor" ] || { if card_ok; then flavor=cuda; else flavor=cpu; fi; }
dest="$BASE/$TAG-$flavor"
if ! works "$dest"; then
  if [ "$flavor" = cuda ]; then
    fetch "$dest" "llama-$TAG-bin-ubuntu-cuda-$CUDA-x64.tar.gz" "cudart-llama-$TAG-bin-ubuntu-cuda-$CUDA-x64.tar.gz" || true
    if ! works "$dest"; then echo "The NVIDIA build didn't start here, so using the plain one."; flavor=cpu; dest="$BASE/$TAG-cpu"; fi
  fi
  works "$dest" || fetch "$dest" "llama-$TAG-bin-ubuntu-x64.tar.gz"
  works "$dest" || { echo "llama-server didn't start after installing."; exit 1; }
fi
ln -sfn "$dest" "$BASE/current"
ln -sfn "$BASE/current/llama-server" "$HOME/.local/bin/llama-server"
echo "llama.cpp $TAG ($flavor) is ready: $(env -i HOME="$HOME" PATH=/usr/bin:/bin "$HOME/.local/bin/llama-server" --version 2>&1 | head -1)"

# No model is downloaded unless you ask: you bring your own .gguf file. LLAMA_MODEL=starter downloads one
# small example (2.5 GB, Apache-2.0) when ~/models has none.
# shortcut: fetched from the repo's newest copy, not a pinned revision; pin it if the file ever changes.
MODEL_REPO=unsloth/Qwen3-4B-Instruct-2507-GGUF
MODEL=Qwen3-4B-Instruct-2507-Q4_K_M.gguf
if [ "${LLAMA_MODEL:-}" = starter ] && ! compgen -G "$HOME/models/*.gguf" >/dev/null; then
  mkdir -p "$HOME/models"
  echo "Downloading the model $MODEL (2.5 GB)"
  curl -L --fail --progress-bar -o "$HOME/models/$MODEL.part" "https://huggingface.co/$MODEL_REPO/resolve/main/$MODEL"
  mv "$HOME/models/$MODEL.part" "$HOME/models/$MODEL" # only a whole download gets the real name
fi
echo "Local AI is ready. Put a .gguf model in ~/models, then open it in Station: the New menu, then Local AI."
