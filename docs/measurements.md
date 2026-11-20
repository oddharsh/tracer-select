# Measurements

## The fs-read control (2026-11-20)

`sh scripts/control.sh bun` inside `scratch/tracer-select-strace:1` (Debian,
strace 6.1, bun 1.4.4, node 24.22.3, arm64 under Apple container 1.7.1). The
fixture suite is three files: `total.test.mjs` imports `lib/price.mjs`,
`prices.test.mjs` reads `data/prices.json` with `readFileSync`, and
`listing.test.mjs` lists `data/`. The plant sets apple's price to -1.

```
traced 3 entries in 0.0 s; 0 always run
--- plant: apple costs -1
 data/prices.json | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
--- tracer-select select --why
tracer-select: 1 changed path(s) since 2c4525bb; running 2 of 3 test files
  tests/listing.test.mjs: lists data
  tests/prices.test.mjs: reads data/prices.json
tests/listing.test.mjs
tests/prices.test.mjs
--- bun test --changed
bun test v1.4.4 (38afee6c8)
--changed: 1 changed file, but no test files are affected

 0 pass
 0 fail
Ran 0 tests across 0 files. [2.00ms]
--- full suite, for the truth

 2 pass
 1 fail
Ran 3 tests across 3 files. [11.00ms]
```

`sh scripts/control.sh node` (the fixture traced under `node --test`) selected
the same 2 files with the same reasons. The map it wrote:

```json
"tests/prices.test.mjs": { "reads": ["data/prices.json", "tests", "tests/prices.test.mjs"], "lists": [] },
"tests/total.test.mjs": { "reads": ["lib", "lib/price.mjs", "tests", "tests/total.test.mjs"], "lists": [] },
"tests/listing.test.mjs": { "reads": ["data", "tests", "tests/listing.test.mjs"], "lists": ["data"] }
```

## Stability (2026-11-20)

`bun test` in the container, 10 runs back to back: 15 pass, 0 fail on every run.

## AT_FDCWD resolution (2026-11-20)

With `-y`, strace prints a relative `openat`'s directory as
`AT_FDCWD</dir>`. The site's parser ignored it and used the cwd it tracked per
process, which is wrong when a child's call prints before its parent's `clone`
returns (the capture in `conformance/trace.test.ts` shows that ordering for
`execve`). Reverting the fix fails exactly one test, "a vfork child's relative
open resolves to the parent's chdir". I haven't measured whether any of the
site's 265 traced files hit this, so treat it as a latent bug there.
