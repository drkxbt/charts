import { test } from "node:test";
import assert from "node:assert/strict";
import { squarify } from "../dist/index.js";

const area = ({ w, h }) => w * h;
const rect = { x: 0, y: 0, w: 600, h: 400 };

test("squarify gives every tile an area in proportion to its value", () => {
  const items = [{ value: 6 }, { value: 6 }, { value: 4 }, { value: 3 }, { value: 2 }, { value: 2 }, { value: 1 }];
  const total = items.reduce((sum, item) => sum + item.value, 0);
  for (const { item, rect: r } of squarify(items, rect)) {
    assert.ok(Math.abs(area(r) - (item.value / total) * area(rect)) < 1e-6);
  }
});

test("squarify fills the rectangle without gaps or overlap", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ value: 1000 / (i + 1) }));
  const placed = squarify(items, rect);
  const covered = placed.reduce((sum, { rect: r }) => sum + area(r), 0);
  assert.ok(Math.abs(covered - area(rect)) < 1e-6);
  for (const { rect: r } of placed) {
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= rect.w + 1e-6 && r.y + r.h <= rect.h + 1e-6);
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i].rect;
      const b = placed[j].rect;
      const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      assert.ok(overlap < 1e-6, `tiles ${i} and ${j} overlap`);
    }
  }
});

test("squarify keeps tiles close to square", () => {
  const items = Array.from({ length: 12 }, () => ({ value: 1 }));
  for (const { rect: r } of squarify(items, rect)) {
    assert.ok(Math.max(r.w / r.h, r.h / r.w) < 3);
  }
});

test("squarify skips empty values and empty rectangles", () => {
  assert.deepEqual(squarify([{ value: 0 }, { value: -2 }], rect), []);
  assert.deepEqual(squarify([{ value: 1 }], { x: 0, y: 0, w: 0, h: 100 }), []);
  assert.equal(squarify([{ value: 0 }, { value: 5 }], rect).length, 1);
});
