// tracer-select.json: the part of selection that depends on the repo.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TREE_ONLY_GIT, type Rules } from "./trace.ts";

/** The file as written. Regexes are strings so the file stays JSON. */
export type ConfigFile = {
  /** The runner. `trace` appends one test file; `run` appends the selected ones. */
  command: string[];
  /** Globs over the repo's files that name the test files. */
  tests: string[];
  /** Paths that move every test: the runner's own config, CI, toolchain pins. */
  global?: string[];
  /** The lockfile whose diff names packages (bun.lock only for now). Any other lockfile belongs in `global`. */
  lockfile?: string;
  /** Untracked outputs the suite reads, by producer: traced as their own entry. */
  producers?: Record<string, { paths: string[]; command: string[] }>;
  /** State a test writes for itself and reads back. */
  scratch?: string[];
  /** Extra git subcommands that depend only on which files the tree holds. */
  treeOnlyGit?: string[];
};

export type Config = Rules & {
  command: string[];
  tests: string[];
  global: RegExp[];
  lockfile?: string;
  producers: Record<string, { paths: string[]; command: string[] }>;
};

const regexes = (list: unknown, field: string): RegExp[] => {
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) throw new Error(`tracer-select.json: ${field} must be an array of strings`);
  return list.map((s) => new RegExp(s));
};

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string");

/** Parses the config once at the boundary; everything past here trusts the type. */
export function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) throw new Error("tracer-select.json: expected an object");
  const c = raw as Record<string, unknown>;
  if (!strings(c.command)) throw new Error("tracer-select.json: command must be a non-empty array of strings");
  if (!strings(c.tests)) throw new Error("tracer-select.json: tests must be a non-empty array of globs");
  if (c.lockfile !== undefined && typeof c.lockfile !== "string") throw new Error("tracer-select.json: lockfile must be a string");
  const producers: Config["producers"] = {};
  if (c.producers !== undefined) {
    if (typeof c.producers !== "object" || c.producers === null) throw new Error("tracer-select.json: producers must be an object");
    for (const [name, p] of Object.entries(c.producers)) {
      const { paths, command } = (p ?? {}) as Record<string, unknown>;
      if (!strings(paths) || !strings(command)) throw new Error(`tracer-select.json: producers.${name} needs paths and command`);
      producers[name] = { paths, command };
    }
  }
  return {
    command: c.command,
    tests: c.tests,
    global: [...regexes(c.global, "global"), /^tracer-select\.json$/],
    lockfile: c.lockfile,
    producers,
    scratch: regexes(c.scratch, "scratch"),
    treeOnlyGit: [...DEFAULT_TREE_ONLY_GIT, ...regexes(c.treeOnlyGit, "treeOnlyGit")],
  };
}

export function loadConfig(root: string): Config {
  const path = join(root, "tracer-select.json");
  if (!existsSync(path)) throw new Error(`no tracer-select.json in ${root}`);
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}
