import { test } from "node:test";
import assert from "node:assert/strict";
import { accumulate, depthAt } from "../dist/index.js";

test("accumulate runs bids from the best price down and asks from the best price up", () => {
  const bids = accumulate([[99, 1], [100, 2], [98, 3]], "bid");
  assert.deepEqual(bids.map((level) => level.price), [100, 99, 98]);
  assert.deepEqual(bids.map((level) => level.total), [2, 3, 6]);

  const asks = accumulate([[103, 1], [101, 2], [102, 3]], "ask");
  assert.deepEqual(asks.map((level) => level.price), [101, 102, 103]);
  assert.deepEqual(asks.map((level) => level.total), [2, 5, 6]);
});

test("accumulate adds up notional as price times size", () => {
  const [first, second] = accumulate([[10, 2], [9, 1]], "bid");
  assert.equal(first.notional, 20);
  assert.equal(second.notional, 29);
});

test("accumulate drops empty levels", () => {
  assert.deepEqual(accumulate([[10, 0], [9, 1]], "bid").map((level) => level.price), [9]);
});

test("depthAt returns the depth reached at a price, or nothing before the best level", () => {
  const bids = accumulate([[100, 2], [99, 1], [98, 3]], "bid");
  assert.equal(depthAt(bids, 99.5, "bid")?.total, 2);
  assert.equal(depthAt(bids, 98, "bid")?.total, 6);
  assert.equal(depthAt(bids, 101, "bid"), null);

  const asks = accumulate([[101, 2], [102, 3]], "ask");
  assert.equal(depthAt(asks, 101.5, "ask")?.total, 2);
  assert.equal(depthAt(asks, 100, "ask"), null);
});
