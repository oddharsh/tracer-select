#!/bin/sh
# Runs a command in this repo inside a Linux VM (Apple's `container`), building
# the image once. Usage: sh scripts/linux.sh bun test
set -eu
image=scratch/tracer-select-strace:1
here=$(cd "$(dirname "$0")/.." && pwd)
container image inspect "$image" >/dev/null 2>&1 ||
  container build -t "$image" -l owner=tracer-select -f "$here/scripts/container/Containerfile" "$here/scripts/container"
exec container run --rm -l owner=tracer-select -v "$here:/work" -w /work "$image" "$@"
