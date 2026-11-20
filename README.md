# tracer-select

`tracer-select` runs only the test files a change can reach. It decides by
watching what each test file actually opened, stat'ed and listed while it ran,
so it works for any runner that takes test files as arguments: `bun test`,
`node --test`, `vitest`, `pytest`.

Import-graph selection misses tests that read their inputs from disk. Bun's own
`bun test --changed` follows imports only. On the fixture suite here, a change
that breaks `data/prices.json` (read with `readFileSync`) gets this:

```
$ bun test --changed
--changed: 1 changed file, but no test files are affected
Ran 0 tests across 0 files.
```

The full suite is red on that change. `tracer-select` picks the failing test:

```
$ tracer-select select --map map.json --why
tracer-select: 1 changed path(s) since 2c4525bb; running 2 of 3 test files
  tests/listing.test.mjs: lists data
  tests/prices.test.mjs: reads data/prices.json
```

That run is pinned as a test (`conformance/e2e.test.ts`), under both `bun test`
and `node --test`. [docs/measurements.md](docs/measurements.md) has the full
output.

## Limits

**Tracing is Linux-only.** `trace` runs each test file under `strace -f`, which
needs ptrace. macOS has no equivalent without turning off System Integrity
Protection (dtruss and dtrace are blocked under SIP). Trace on Linux CI, for
example nightly on the default branch, and select anywhere: `select` and `run`
need only the map and `git diff`.

**A trace sees only the branches a test took on that commit.** A read behind a
condition the traced run never hit is invisible to selection. So the default
branch must still run the whole suite, and the map is a guess about pull
requests, refreshed by each trace. A test that fails under strace, reads an
untracked file, reads `.git` directly, or runs history-dependent git
(`git log`, `git diff`) always runs.

**Runners must take test files as arguments.** `cargo test` selects by target
and test name, so it doesn't fit the one-file-per-trace model yet. Packages are
recognized under `node_modules/` only; a Python `.venv` inside the repo reads as
untracked files, which makes those tests always run (safe, just unnarrowed).

## Use

```bash
tracer-select trace --out map.json [--jobs 4]   # Linux with strace on PATH
tracer-select select --map map.json [--why]     # files to run, one a line
tracer-select run --map map.json                # the narrowed suite
```

`run` falls back to the whole suite when there's no map, when the map's commit
can't be fetched, or when a global path changed.

A file reruns when the change touches a path it read (a missing path it probed
counts, so creating it reruns the test), adds or edits a file in a directory it
listed, or moves a package (from a `bun.lock` diff) it loaded.

## Config

`tracer-select.json` at the repo root:

```json
{
  "command": ["node", "--test"],
  "tests": ["tests/**/*.test.mjs"],
  "global": ["^\\.github/workflows/ci\\.yml$", "^\\.node-version$"],
  "lockfile": "bun.lock",
  "producers": {
    "@build": { "paths": [".build"], "command": ["bun", "run", "build"] }
  },
  "scratch": ["(^|/)\\.wrangler(/|$)"]
}
```

- `command`: the runner. `trace` appends one `./file`; `run` appends the selected ones.
- `global`: regexes for paths that move every test (CI config, toolchain pins). The config file itself is always global.
- `lockfile`: the one lockfile whose diff names packages. Only `bun.lock` is parsed today; put any other lockfile in `global`.
- `producers`: untracked outputs the suite reads, such as a build directory. Each producer is traced as its own entry, and a test that reads its paths inherits its inputs.
- `scratch`: state a test writes for itself and reads back, ignored.

## Tests

```bash
bun run check:fast      # lint, typecheck, tests, format on any OS (Linux tests skip)
bun run test:linux      # the whole suite in a Linux VM through Apple's container
```

`test:linux` builds `scratch/tracer-select-strace:1` once (Debian, strace,
node 24, bun 1.4.4) and runs with `--rm`. Delete it with
`container image delete scratch/tracer-select-strace:1`.

## Origin

Extracted from aadhar.sh's `tools/test-inputs.ts` (oddharsh/site PR 1515).
There, a replay over 40 merged PRs ran 7,383 of 10,600 file-runs (70%), and
docs-only PRs selected 14 to 52 of 265 files.
