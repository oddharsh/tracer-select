#!/bin/sh
# The control, end to end: trace the fixture suite on a good commit, break the
# data file one test reads with fs, then ask both selectors what to run.
# Usage (Linux, strace on PATH): sh scripts/control.sh [bun|node]
set -eu
runner=${1:-bun}
cli=$(cd "$(dirname "$0")/.." && pwd)/src/cli.ts
repo=$(mktemp -d)
cp -R "$(dirname "$cli")/../fixtures/suite/." "$repo"
cd "$repo"
if [ "$runner" = node ]; then
  printf '{ "command": ["node", "--test"], "tests": ["tests/**/*.test.mjs"] }\n' > tracer-select.json
fi
git init -q && git add -A && git commit -qm good
bun "$cli" trace --out /tmp/map.json
echo '--- plant: apple costs -1'
printf '{ "apple": -1, "pear": 2 }\n' > data/prices.json
git diff --stat
echo '--- tracer-select select --why'
bun "$cli" select --map /tmp/map.json --why
echo '--- bun test --changed'
bun test --changed 2>&1 || echo "(exit $?)"
echo '--- full suite, for the truth'
bun test 2>&1 | tail -4 || true
