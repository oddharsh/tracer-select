import { expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { lockPackages, select } from "../src/select.ts";
import type { Entry, InputMap } from "../src/trace.ts";

const e = (over: Partial<Entry>): Entry => ({ reads: [], lists: [], uses: [], packages: [], ...over });
const map: InputMap = {
  commit: "c0ffee",
  files: {
    "tests/prices.test.mjs": e({ reads: ["data/prices.json", "tests/prices.test.mjs"] }),
    "tests/listing.test.mjs": e({ reads: ["tests/listing.test.mjs"], lists: ["data"] }),
    "tests/total.test.mjs": e({ reads: ["lib/price.mjs", "tests/total.test.mjs"], packages: ["left-pad"] }),
    "tests/page.test.mjs": e({ uses: ["@build"] }),
    "tests/files.test.mjs": e({ tree: true }),
    "@build": e({ reads: ["src/page.html"] }),
  },
};
const tests = ["tests/files.test.mjs", "tests/listing.test.mjs", "tests/new.test.mjs", "tests/page.test.mjs", "tests/prices.test.mjs", "tests/total.test.mjs"];
const opts = { global: [/^ci\.yml$/], lockfile: "bun.lock" };

test("a data file change runs the test that read it and the one that listed its directory", () => {
  expect(select(map, tests, { paths: ["data/prices.json"] }, opts)).toEqual({
    run: ["tests/listing.test.mjs", "tests/new.test.mjs", "tests/prices.test.mjs"],
    skip: ["tests/files.test.mjs", "tests/page.test.mjs", "tests/total.test.mjs"],
    why: { "tests/listing.test.mjs": "lists data", "tests/new.test.mjs": "not in the map", "tests/prices.test.mjs": "reads data/prices.json" },
  });
});

test("a producer's input runs the test that read its output", () => {
  expect(select(map, tests, { paths: ["src/page.html"] }, opts).why["tests/page.test.mjs"]).toBe("reads src/page.html");
});

test("adding a file runs tree listers; a lockfile diff runs only tests that loaded a moved package", () => {
  expect(select(map, tests, { paths: ["x/y.txt"], filesMoved: true }, opts).run).toEqual(["tests/files.test.mjs", "tests/new.test.mjs"]);
  expect(select(map, tests, { paths: ["bun.lock"], packages: ["left-pad"] }, opts).run).toEqual(["tests/new.test.mjs", "tests/total.test.mjs"]);
});

test("a global path, a lockfile without packages, or no map runs everything", () => {
  expect(select(map, tests, { paths: ["ci.yml"] }, opts).run).toEqual(tests);
  expect(select(map, tests, { paths: ["bun.lock"] }, opts).why["tests/total.test.mjs"]).toBe("bun.lock changed");
  expect(select(null, tests, { paths: [] }, opts).why["tests/prices.test.mjs"]).toBe("no input map");
});

test("lockPackages reads names off a bun.lock diff's changed lines", () => {
  const diff = [
    '-    "left-pad": ["left-pad@1.0.0", "", {}, "sha512-a"],',
    '+    "left-pad": ["left-pad@1.1.0", "", {}, "sha512-b"],',
    '     "@s/b": ["@s/b@2.0.0"],',
  ].join("\n");
  expect(lockPackages(diff)).toEqual(["left-pad"]);
});

test("parseConfig makes the config itself a global input and rejects a missing command", () => {
  const config = parseConfig({ command: ["node", "--test"], tests: ["**/*.test.mjs"], global: ["^ci\\.yml$"] });
  expect(config.global.map(String)).toEqual(["/^ci\\.yml$/", "/^tracer-select\\.json$/"]);
  expect(() => parseConfig({ tests: ["x"] })).toThrow("tracer-select.json: command must be a non-empty array of strings");
});
