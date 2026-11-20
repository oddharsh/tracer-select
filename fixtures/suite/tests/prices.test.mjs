import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("every price is a positive whole number of cents", () => {
  const prices = JSON.parse(readFileSync("data/prices.json", "utf8"));
  assert.deepEqual(
    Object.entries(prices).filter(([, p]) => !(Number.isInteger(p) && p > 0)),
    [],
  );
});
