// Which test files a change can reach, given a traced input map. Pure: no git,
// no filesystem, so selection runs on any OS.

import { dirname } from "node:path";
import type { InputMap } from "./trace.ts";

export type Selection = { run: string[]; skip: string[]; why: Record<string, string> };

/**
 * `paths`: every path the change touches (a rename names both). `filesMoved`:
 * it adds, removes or renames one. `packages`: the packages its lockfile diff
 * names; without it, a lockfile change runs everything.
 */
export type Change = { paths: string[]; filesMoved?: boolean; packages?: string[] };

/** Package names on the added and removed lines of a bun.lock diff. */
export function lockPackages(diff: string): string[] {
  const names = new Set<string>();
  for (const [, name] of diff.matchAll(/^[+-]\s+"((?:@[^"/]+\/)?[^"/@][^"]*)":/gm)) names.add(name);
  return [...names].sort();
}

/**
 * The test files a change can reach. A test file missing from the map runs.
 * `global` paths move every test through how the suite runs; `lockfile` is the
 * one lockfile whose diff `packages` came from.
 */
export function select(
  map: InputMap | null,
  tests: string[],
  { paths: changed, filesMoved = false, packages }: Change,
  { global, lockfile }: { global: RegExp[]; lockfile?: string },
): Selection {
  const why: Record<string, string> = {};
  const all = (reason: string) => ({ run: tests, skip: [], why: Object.fromEntries(tests.map((t) => [t, reason])) });
  if (!map) return all("no input map");
  const hit = changed.find((c) => global.some((g) => g.test(c)) || (c === lockfile && !packages));
  if (hit) return all(`${hit} changed`);
  const moved = new Set(packages ?? []);
  const touched = new Set(changed),
    dirs = new Set(changed.map(dirname));
  for (const test of tests) {
    const e = map.files[test];
    if (!e) why[test] = "not in the map";
    else if (e.always) why[test] = e.always;
    else if (e.tree && filesMoved) why[test] = "lists tracked files, and the change adds or removes one";
    else {
      const used = e.uses.map((u) => map.files[u]);
      if (used.some((u) => !u || u.always)) why[test] = `uses ${e.uses.join(", ")}, which can't be mapped`;
      else {
        const all = [e, ...used.filter((u) => u !== undefined)];
        const read = all.flatMap((x) => x.reads).find((r) => touched.has(r)),
          listed = all.flatMap((x) => x.lists).find((l) => dirs.has(l)),
          pkg = all.flatMap((x) => x.packages).find((name) => moved.has(name));
        if (read) why[test] = `reads ${read}`;
        else if (listed) why[test] = `lists ${listed}`;
        else if (pkg) why[test] = `loads ${pkg}, which the lockfile moved`;
      }
    }
  }
  return { run: tests.filter((t) => why[t]), skip: tests.filter((t) => !why[t]), why };
}
