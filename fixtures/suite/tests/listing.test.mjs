import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

test("data/ holds only JSON", () => {
  assert.deepEqual(
    readdirSync("data").filter((f) => !f.endsWith(".json")),
    [],
  );
});
