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

CFG_DIR=/repo
if [ "$MODE" = "--stock" ]; then
  # stock build: drop the project block (it references code that only exists with the patch)
  CFG_DIR=/tmp/cfg
  mkdir -p "$CFG_DIR/configs/$CONFIG"
  sed '/---- Shramko Motor Autostart/,$d' "/repo/configs/$CONFIG/config.h" > "$CFG_DIR/configs/$CONFIG/config.h"
fi

# firmware `version` shows which commit of this repo was built (stock: plain upstream revision)
REV="$(git -C /repo rev-parse --short=7 HEAD 2>/dev/null || echo local)"
EXTRA=()
[ "$MODE" != "--stock" ] && EXTRA=(REVISION="as-$REV")

make CONFIG="$CONFIG" CONFIG_DIR="$CFG_DIR" "${EXTRA[@]}" -j"$(nproc)" hex

mkdir -p /repo/out
suffix="autostart"
[ "$MODE" = "--stock" ] && suffix="stock"
for f in obj/betaflight_*_"$CONFIG".hex; do
  out="/repo/out/$(basename "${f%.hex}")_${suffix}.hex"
  cp "$f" "$out"
  echo ">> built $out"
done
