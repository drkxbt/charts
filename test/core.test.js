import { test } from "node:test";
import assert from "node:assert/strict";
import { changeSign, formatChange, formatPrice, niceStep, resample, ticks, withAlpha } from "../dist/index.js";

test("niceStep picks 1, 2, 2.5 or 5 times a power of ten", () => {
  assert.equal(niceStep(100, 5), 20);
  assert.equal(niceStep(12, 5), 2.5);
  assert.equal(niceStep(0.9, 5), 0.2);
  assert.equal(niceStep(0), 1);
});

test("ticks land on the step and never print float noise", () => {
  assert.deepEqual(ticks(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(ticks(0.1, 0.35, 5), [0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
  assert.deepEqual(ticks(63_812, 64_190, 5), [63_900, 64_000, 64_100]);
  assert.deepEqual(ticks(63_812, 64_190, 10), [63_850, 63_900, 63_950, 64_000, 64_050, 64_100, 64_150]);
});

test("resample keeps the ends and interpolates between them", () => {
  assert.deepEqual(resample([0, 10], 5), [0, 2.5, 5, 7.5, 10]);
  const long = resample([1, 4, 2, 8, 3, 9, 5], 3);
  assert.equal(long[0], 1);
  assert.equal(long[2], 5);
  assert.deepEqual(resample([7], 3), [7, 7, 7]);
  assert.deepEqual(resample([], 2), [0, 0]);
});

test("formatChange uses a true minus sign and changeSign ignores rounding noise", () => {
  assert.equal(formatChange(0.0123), "+1.23%");
  assert.equal(formatChange(-0.05), "−5.00%");
  assert.equal(changeSign(0.00001), 0);
  assert.equal(changeSign(-0.002), -1);
});

test("formatPrice keeps small prices readable", () => {
  assert.equal(formatPrice(64012.5), "64,012.50");
  assert.equal(formatPrice(0.0006396), "0.0006396");
});

test("withAlpha reads hex and rgb", () => {
  assert.equal(withAlpha("#0ecb81", 0.5), "rgba(14, 203, 129, 0.5)");
  assert.equal(withAlpha("#fff", 1), "rgba(255, 255, 255, 1)");
  assert.equal(withAlpha("rgb(1, 2, 3)", 0.2), "rgba(1, 2, 3, 0.2)");
});
