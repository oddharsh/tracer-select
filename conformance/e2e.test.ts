// The whole loop on a real runner: trace the fixture suite on a good commit,
// break the data file one test reads with fs, and select. Needs Linux with
// strace on PATH; `bun run test:linux` runs it in a container from macOS.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/cli.ts");
const hasStrace = spawnSync("strace", ["-V"]).status === 0;

function sh(cwd: string, command: string, ...args: string[]) {
  const r = spawnSync(command, args, { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A git repo holding the fixture suite, traced on its first commit, with prices.json then broken. */
function planted(command: string[]) {
  const repo = mkdtempSync(join(tmpdir(), "tracer-select-e2e-"));
  cpSync(join(import.meta.dir, "../fixtures/suite"), repo, { recursive: true });
  writeFileSync(join(repo, "tracer-select.json"), JSON.stringify({ command, tests: ["tests/**/*.test.mjs"] }));
  sh(repo, "git", "init", "-q");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "good");
  const traced = sh(repo, "bun", cli, "trace", "--out", join(repo, "../map.json"));
  expect(traced.out).toBe("traced 3 entries in " + /\d+\.\d s/.exec(traced.out)?.[0] + "; 0 always run\n");
  writeFileSync(join(repo, "data/prices.json"), '{ "apple": -1, "pear": 2 }\n');
  return repo;
}

describe.skipIf(!hasStrace)("on Linux", () => {
  for (const command of [
    ["bun", "test"],
    ["node", "--test"],
  ]) {
    test(`${command.join(" ")}: select picks the test that reads the broken file with fs`, () => {
      const repo = planted(command);
      const picked = sh(repo, "bun", cli, "select", "--map", join(repo, "../map.json"), "--why");
      expect(picked.out).toBe("tests/listing.test.mjs\ntests/prices.test.mjs\n");
      expect(picked.err).toContain("  tests/prices.test.mjs: reads data/prices.json\n");
      // The import-only test stays out, and the selection holds the real failure.
      const run = sh(repo, "bun", cli, "run", "--map", join(repo, "../map.json"));
      expect(run.code).toBe(1);
      expect(run.err).not.toContain("tests/total.test.mjs");
    }, 60_000);
  }

  test("control: bun test --changed runs nothing for the same change, and the full suite is red", () => {
    const repo = planted(["bun", "test"]);
    const changed = sh(repo, "bun", "test", "--changed");
    expect(changed.code).toBe(0);
    expect(changed.err).toContain("--changed: 1 changed file, but no test files are affected");
    expect(sh(repo, "bun", "test").code).toBe(1);
  }, 60_000);
});
