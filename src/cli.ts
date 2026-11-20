#!/usr/bin/env bun
// tracer-select: run only the test files a change can reach, judged by the
// files each one opened, stat'ed or listed under strace.
//
//   tracer-select trace --out map.json [--jobs 4]   Linux, strace on PATH
//   tracer-select select --map map.json [--why]     any OS: files to run, one a line
//   tracer-select run --map map.json                the suite, narrowed
//
// A trace shows the paths that commit's code took. A read behind a branch the
// trace never took is invisible, so the default branch must still run
// everything. With no map, an unfetchable map commit, or a global change,
// `run` runs the whole suite.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { type Change, lockPackages, select } from "./select.ts";
import { accesses, entry, type Entry, type InputMap, parseMap, straceArgs } from "./trace.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

/** Test files on disk, tracked or not, that match the config's globs. */
function testFiles(config: Config): string[] {
  const globs = config.tests.map((g) => new Bun.Glob(g));
  const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
  return [...new Set(files)].filter((f) => existsSync(join(root, f)) && globs.some((g) => g.match(f))).sort();
}

function trackedSet(): Set<string> {
  const set = new Set<string>();
  for (const file of git("ls-files", "-z").split("\0").filter(Boolean)) {
    set.add(file);
    for (let d = dirname(file); d !== "."; d = dirname(d)) set.add(d);
  }
  return set;
}

function traced(command: string[], dir: string, name: string): Promise<{ code: number; log: string }> {
  const out = join(dir, name.replace(/\W/g, "_"));
  return new Promise((done) => {
    const child = spawn("strace", [...straceArgs(out), ...command], { cwd: root, stdio: "ignore" });
    child.on("error", () => done({ code: 127, log: "" }));
    child.on("close", (code) => done({ code: code ?? 1, log: existsSync(out) ? readFileSync(out, "utf8") : "" }));
  });
}

/** The map at `path` and what changed since its commit, working tree included. */
function sinceMap(path: string | undefined, lockfile: string | undefined): { map: InputMap; change: Change } | { map: null; reason: string } {
  if (!path || !existsSync(path)) return { map: null, reason: "no input map" };
  const map = parseMap(JSON.parse(readFileSync(path, "utf8")) as unknown);
  try {
    git("cat-file", "-e", `${map.commit}^{commit}`);
  } catch {
    // A shallow CI checkout lacks the map's commit; it's a fetch away.
    try {
      git("fetch", "--quiet", "--depth=1", "--no-tags", "origin", map.commit);
    } catch {
      return { map: null, reason: `the map's commit ${map.commit.slice(0, 8)} can't be fetched` };
    }
  }
  const status = git("diff", "--name-status", map.commit).split("\n").filter(Boolean);
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
  return {
    map,
    change: {
      paths: [...status.flatMap((line) => line.split("\t").slice(1)), ...untracked],
      filesMoved: untracked.length > 0 || status.some((line) => /^[ADRC]/.test(line)),
      packages: lockfile === "bun.lock" ? lockPackages(git("diff", map.commit, "--", lockfile)) : undefined,
    },
  };
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: n }, worker));
}

const unmapped = (always: string): Entry => ({ reads: [], lists: [], uses: [], packages: [], always });

async function trace(config: Config, out: string, jobs: number) {
  const dir = mkdtempSync(join(tmpdir(), "tracer-select-"));
  const tracked = trackedSet();
  const files: Record<string, Entry> = {};
  const started = Date.now();
  // Producers first and alone: they rewrite what the tests then read.
  for (const [name, { command }] of Object.entries(config.producers)) {
    const { code, log } = await traced(command, dir, name);
    files[name] = code === 0 ? entry(accesses(log, root), tracked, root, config) : unmapped(`${command.join(" ")} exited ${code} under strace`);
    files[name].uses = files[name].uses.filter((u) => u !== name);
  }
  await pool(testFiles(config), jobs, async (test) => {
    const { code, log } = await traced([...config.command, `./${test}`], dir, test);
    files[test] = code === 0 ? entry(accesses(log, root), tracked, root, config) : unmapped(`failed under strace (exit ${code})`);
  });
  rmSync(dir, { recursive: true, force: true });
  const map: InputMap = { commit: git("rev-parse", "HEAD").trim(), files };
  writeFileSync(out, `${JSON.stringify(map, null, 1)}\n`);
  const always = Object.entries(files).filter(([, e]) => e.always);
  console.log(`traced ${Object.keys(files).length} entries in ${((Date.now() - started) / 1000).toFixed(1)} s; ${always.length} always run`);
  for (const [name, e] of always) console.log(`  ${name}: ${e.always}`);
}

if (import.meta.main) {
  const [mode] = process.argv.slice(2);
  const arg = (flag: string) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
  const config = loadConfig(root);
  if (mode === "trace") {
    await trace(config, arg("--out") ?? "tracer-select.map.json", Number(arg("--jobs") ?? 4));
  } else if (mode === "select" || mode === "run") {
    const since = sinceMap(arg("--map"), config.lockfile);
    const tests = testFiles(config);
    const { run, skip, why } = select(since.map, tests, since.map ? since.change : { paths: [] }, config);
    const reason = since.map ? `${since.change.paths.length} changed path(s) since ${since.map.commit.slice(0, 8)}` : since.reason;
    console.error(`tracer-select: ${reason}; running ${run.length} of ${tests.length} test files`);
    if (mode === "select") {
      if (process.argv.includes("--why")) for (const t of run) console.error(`  ${t}: ${why[t]}`);
      if (run.length) console.log(run.join("\n"));
    } else {
      for (const t of run) console.error(`  ${t}: ${why[t]}`);
      if (!run.length) process.exit(0);
      const [command, ...args] = [...config.command, ...(skip.length ? run.map((f) => `./${f}`) : [])];
      process.exit(spawnSync(command, args, { cwd: root, stdio: "inherit" }).status ?? 1);
    }
  } else {
    console.error("usage: tracer-select trace --out FILE [--jobs N] | select --map FILE [--why] | run --map FILE");
    process.exit(2);
  }
}
