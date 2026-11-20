// Reading an `strace -f -y` log back into the repo paths a test touched.
//
// Ported from aadhar.sh's tools/test-inputs.ts (oddharsh/site#1515), where each
// rule below cost a retrace on 265 real test files: relative paths resolve
// against a per-process working directory carried through clone and chdir;
// threads cloned with CLONE_FS share one directory (libuv's pool threads open
// what the main thread's chdir pointed at); a child can chdir before strace
// prints its parent's clone returning; and git is judged by its subcommand and
// the repo it ran against, because a test's own temp-repo git says nothing
// about this one.

import { isAbsolute, join, relative, resolve } from "node:path";

/** A path a process touched, or (with `git`) a git call and the directory it ran against. */
export type Access = { path: string; listed: boolean; missing: boolean; byGit: boolean; git?: string };

/**
 * One test file's inputs. `packages`: what it loaded from node_modules, by
 * name. `uses`: producers whose outputs it read. `tree`: it lists tracked files
 * through git. `always`: why it can't be mapped and must always run.
 */
export type Entry = { reads: string[]; lists: string[]; uses: string[]; packages: string[]; tree?: true; always?: string };

export type InputMap = { commit: string; files: Record<string, Entry> };

/** What `entry` needs to know about the repo beyond git. */
export type Rules = {
  /** Generated outputs the suite reads and git doesn't hold, by producer name. */
  producers: Record<string, { paths: string[] }>;
  /** State a test writes for itself and reads back; ignored. */
  scratch: RegExp[];
  /** git calls that depend only on which files the tree holds. */
  treeOnlyGit: RegExp[];
};

export const DEFAULT_TREE_ONLY_GIT = [/^ls-files\b/, /^rev-parse --(show-toplevel|show-prefix|git-dir|git-path|is-inside-work-tree)\b/, /^check-ignore\b/];

const result = (args: string) => / = (-?\d+)(?:<[^>]*>)?(?: (E[A-Z]+))?(?: \(.*\))?$/.exec(args);

/** Every path an strace -f -y log touched, with relative paths resolved from `cwd`. */
export function accesses(log: string, cwd: string): Access[] {
  const out: Access[] = [];
  const cwds = new Map<string, { dir: string }>(),
    gits = new Set<string>(),
    pending = new Map<string, (ret: string, errno?: string) => void>();
  const cwdOf = (pid: string) => {
    let box = cwds.get(pid);
    if (!box) cwds.set(pid, (box = { dir: cwd }));
    return box;
  };
  const forked = (parent: string, child: string, sharesFs: boolean) => {
    if (!cwds.has(child)) cwds.set(child, sharesFs ? cwdOf(parent) : { dir: cwdOf(parent).dir });
    if (gits.has(parent)) gits.add(child);
  };
  for (const line of log.split("\n")) {
    const resumed = /^(\d+)\s+<\.\.\. \w+ resumed>(.*)$/.exec(line);
    if (resumed) {
      const done = result(resumed[2]);
      if (done) pending.get(resumed[1])?.(done[1], done[2]);
      pending.delete(resumed[1]);
      continue;
    }
    const call = /^(\d+)\s+(\w+)\((.*)$/.exec(line);
    if (!call) continue;
    const [, pid, name, args] = call;
    // Run now, or when the call resumes: strace -f splits a call another process interrupts.
    const finish = (fn: (ret: string, errno?: string) => void) => {
      if (args.endsWith("<unfinished ...>")) pending.set(pid, fn);
      else {
        const done = result(args);
        if (done) fn(done[1], done[2]);
      }
    };
    if (/^(clone3?|v?fork)$/.test(name)) {
      finish((ret) => Number(ret) > 0 && forked(pid, ret, args.includes("CLONE_FS")));
      continue;
    }
    if (name === "fchdir") {
      const dir = /^\d+<([^>]+)>/.exec(args);
      if (dir) finish((ret) => ret === "0" && (cwdOf(pid).dir = dir[1]));
      continue;
    }
    if (name === "getdents64") {
      const dir = /^\d+<([^>]+)>/.exec(args);
      if (dir) out.push({ path: dir[1], listed: true, missing: false, byGit: gits.has(pid) });
      continue;
    }
    const strings = [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
    const [raw] = strings;
    if (raw === undefined) continue;
    // -y prints AT_FDCWD's directory too, which beats the tracked cwd when a
    // child's call prints before its parent's clone returns.
    const dirfd = /^(?:\d+|AT_FDCWD)<([^>]+)>,/.exec(args);
    const path = isAbsolute(raw) ? raw : join(dirfd ? dirfd[1] : cwdOf(pid).dir, raw);
    if (name === "execve" && path.endsWith("/git")) {
      // argv after argv[0]; `-C dir` moves where it runs, `-c k=v` doesn't.
      const argv = strings.slice(2);
      let at = cwdOf(pid).dir;
      while (argv[0]?.startsWith("-")) {
        const flag = argv.shift();
        if (flag === "-C" && argv[0]) at = resolve(at, argv.shift() ?? "");
        else if (flag === "-c") argv.shift();
      }
      finish((ret) => {
        if (ret !== "0") return;
        gits.add(pid);
        out.push({ path: at, listed: false, missing: false, byGit: true, git: argv.join(" ") });
      });
      continue;
    }
    if (name === "chdir") {
      finish((ret) => ret === "0" && (cwdOf(pid).dir = path));
      continue;
    }
    const access: Access = { path, listed: false, missing: false, byGit: gits.has(pid) };
    out.push(access);
    finish((_, errno) => (access.missing = errno === "ENOENT"));
  }
  return out;
}

/** The package a node_modules path belongs to: the name after its last node_modules/. */
export function packageOf(rel: string): string | null {
  const names = [...rel.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/.][^/]*)/g)];
  return names.at(-1)?.[1] ?? null;
}

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel;
};

/**
 * One test's entry from its accesses. `tracked` holds every path git tracks and
 * every directory above one. A read of an untracked, existing file makes the
 * test always run, since no diff would ever name it.
 */
export function entry(found: Access[], tracked: Set<string>, root: string, rules: Rules): Entry {
  const reads = new Set<string>(),
    lists = new Set<string>(),
    uses = new Set<string>(),
    packages = new Set<string>();
  let tree = false;
  let always: string | undefined;
  for (const { path, listed, missing, byGit, git } of found) {
    const rel = within(root, path);
    if (git !== undefined) {
      if (rel === null) continue;
      if (rules.treeOnlyGit.some((t) => t.test(git))) tree = true;
      else always ??= `runs git ${git.split(" ").slice(0, 2).join(" ")}`;
      continue;
    }
    if (byGit || !rel || rel === ".git" || rules.scratch.some((s) => s.test(rel))) continue;
    if (/(^|\/)node_modules(\/|$)/.test(rel)) {
      const name = packageOf(rel);
      if (name) packages.add(name);
      continue;
    }
    if (rel.startsWith(".git/")) {
      always ??= "reads .git";
      continue;
    }
    const producer = Object.entries(rules.producers).find(([, p]) => p.paths.some((d) => rel === d || rel.startsWith(`${d}/`)));
    if (producer) {
      uses.add(producer[0]);
      continue;
    }
    if (listed) lists.add(rel);
    else if (tracked.has(rel) || missing) reads.add(rel);
    else always ??= `reads untracked ${rel}`;
  }
  const out: Entry = { reads: [...reads].sort(), lists: [...lists].sort(), uses: [...uses].sort(), packages: [...packages].sort() };
  if (tree) out.tree = true;
  if (always) out.always = always;
  return out;
}

/** The strace invocation `trace` wraps each command in. */
export const straceArgs = (log: string) => ["-f", "-qq", "-y", "-s", "4096", "-e", "trace=%file,%process,getdents64", "-o", log];

const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** A map read back from disk, checked once so selection can trust it. */
export function parseMap(raw: unknown): InputMap {
  if (typeof raw !== "object" || raw === null) throw new Error("input map: expected an object");
  const { commit, files } = raw as Record<string, unknown>;
  if (typeof commit !== "string" || typeof files !== "object" || files === null) throw new Error("input map: needs commit and files");
  for (const [name, e] of Object.entries(files)) {
    const { reads, lists, uses, packages } = (e ?? {}) as Record<string, unknown>;
    if (![reads, lists, uses, packages].every(isList)) throw new Error(`input map: ${name} needs reads, lists, uses and packages`);
  }
  return { commit, files: files as Record<string, Entry> };
}
