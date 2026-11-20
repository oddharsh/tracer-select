import { expect, test } from "bun:test";
import { accesses, DEFAULT_TREE_ONLY_GIT, entry, packageOf } from "../src/trace.ts";

// Lines in strace 6.1's -f -y format, captured in a Debian container on
// 2026-11-20 and trimmed to what each case needs.

test("a vfork child's relative open resolves to the parent's chdir, even when it prints before the clone returns", () => {
  const log = [
    `6     chdir("/r/data") = 0`,
    `6     clone(child_stack=0xffffe51a6030, flags=CLONE_VM|CLONE_VFORK|SIGCHLD <unfinished ...>`,
    `7     openat(AT_FDCWD</r/data>, "prices.json", O_RDONLY) = 3</r/data/prices.json>`,
    `6     <... clone resumed>)              = 7`,
    `7     openat(AT_FDCWD</r/data>, "missing.json", O_RDONLY) = -1 ENOENT (No such file or directory)`,
  ].join("\n");
  expect(accesses(log, "/r")).toEqual([
    { path: "/r/data/prices.json", listed: false, missing: false, byGit: false },
    { path: "/r/data/missing.json", listed: false, missing: true, byGit: false },
  ]);
});

test("a stat with no dirfd follows chdir per process, and CLONE_FS threads share it", () => {
  const log = [
    `1 clone3({flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD, child_tid=0x1}, 88) = 2`,
    `1 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 3`,
    `1 chdir("lib") = 0`,
    `2 stat("price.mjs", {st_mode=S_IFREG|0644, st_size=10, ...}) = 0`,
    `3 stat("price.mjs", 0xffff) = -1 ENOENT (No such file or directory)`,
  ].join("\n");
  expect(accesses(log, "/r")).toEqual([
    { path: "/r/lib/price.mjs", listed: false, missing: false, byGit: false },
    { path: "/r/price.mjs", listed: false, missing: true, byGit: false },
  ]);
});

test("getdents64 is a listing, and git -C names the repo git ran against", () => {
  const log = [
    `8     getdents64(3</r/data>, 0xaaaad5b26600 /* 3 entries */, 32768) = 80`,
    `9     execve("/usr/bin/git", ["git", "-C", "..", "ls-files"], 0xaaaae058f7d8 /* 6 vars */ <unfinished ...>`,
    `9     <... execve resumed>)             = 0`,
    `9     chdir("..")                       = 0`,
    `9     openat(AT_FDCWD</r>, ".git/index", O_RDONLY) = 3</r/.git/index>`,
  ].join("\n");
  expect(accesses(log, "/r/data")).toEqual([
    { path: "/r/data", listed: true, missing: false, byGit: false },
    { path: "/r", listed: false, missing: false, byGit: true, git: "ls-files" },
    { path: "/r/.git/index", listed: false, missing: false, byGit: true },
  ]);
});

const rules = { producers: { "@build": { paths: [".build"] } }, scratch: [/(^|\/)\.cache(\/|$)/], treeOnlyGit: DEFAULT_TREE_ONLY_GIT };
const tracked = new Set(["data", "data/prices.json", "lib", "lib/price.mjs"]);
const at = (path: string, more: Partial<{ listed: boolean; missing: boolean; byGit: boolean; git: string }> = {}) => ({
  path,
  listed: false,
  missing: false,
  byGit: false,
  ...more,
});

test("entry sorts accesses into reads, listings, producers and packages, and drops scratch and git's own reads", () => {
  const found = [
    at("/r/lib/price.mjs"),
    at("/r/data", { listed: true }),
    at("/r/bunfig.toml", { missing: true }),
    at("/r/.build/index.html"),
    at("/r/node_modules/.bun/@types+bun@1.4.5/node_modules/@types/bun/index.d.ts"),
    at("/r/.cache/x"),
    at("/r", { byGit: true, git: "ls-files -z" }),
    at("/r/.git/index", { byGit: true }),
    at("/elsewhere/file"),
  ];
  expect(entry(found, tracked, "/r", rules)).toEqual({
    reads: ["bunfig.toml", "lib/price.mjs"],
    lists: ["data"],
    uses: ["@build"],
    packages: ["@types/bun"],
    tree: true,
  });
});

test("entry marks a test always-run when it reads an untracked file or runs history-dependent git", () => {
  expect(entry([at("/r/notes.txt")], tracked, "/r", rules).always).toBe("reads untracked notes.txt");
  expect(entry([at("/r", { byGit: true, git: "log --oneline" })], tracked, "/r", rules).always).toBe("runs git log --oneline");
  expect(entry([at("/r/lib/price.mjs")], tracked, "/r", rules).always).toBe(undefined);
});

test("packageOf names the innermost package, scoped or not", () => {
  expect(packageOf("node_modules/.bun/a@1/node_modules/@s/b/x.js")).toBe("@s/b");
  expect(packageOf("node_modules/left-pad/index.js")).toBe("left-pad");
  expect(packageOf("src/index.ts")).toBe(null);
});
