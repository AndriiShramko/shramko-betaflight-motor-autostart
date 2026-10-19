#!/usr/bin/env bash
# Runs inside the build container. Usage: build.sh <CONFIG> [--stock]
#   <CONFIG>  board config folder under /repo/configs (e.g. HGLRC_F405_S8)
#   --stock   build without the autostart patch (for comparison / restoring stock behaviour)
# Output: /repo/out/<name>.hex
set -euo pipefail

CONFIG="${1:?config name required}"
MODE="${2:-patched}"

# every `docker run --rm` starts from the pristine image, so patch the tree in place
cd /bf

if [ "$MODE" != "--stock" ]; then
  for p in /repo/patches/*.patch; do
    echo ">> applying $(basename "$p")"
    git apply --whitespace=nowarn "$p"
  done
fi

make CONFIG="$CONFIG" CONFIG_DIR=/repo -j"$(nproc)" hex

mkdir -p /repo/out
suffix="autostart"
[ "$MODE" = "--stock" ] && suffix="stock"
for f in obj/betaflight_*_"$CONFIG".hex; do
  out="/repo/out/$(basename "${f%.hex}")_${suffix}.hex"
  cp "$f" "$out"
  echo ">> built $out"
done
