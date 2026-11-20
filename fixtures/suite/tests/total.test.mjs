import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../lib/price.mjs";

test("total multiplies price by quantity", () => {
  assert.equal(
    total([
      { price: 3, qty: 2 },
      { price: 2, qty: 1 },
    ]),
    8,
  );
});
