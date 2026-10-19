import assert from "node:assert/strict";
import { test } from "node:test";
import { exhaustivePairs, sequentialPairs } from "../src/pairs.ts";

test("exhaustive pairs", () => {
  assert.deepEqual(exhaustivePairs(4), [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]);
});

test("sequential pairs: window and jumps, open sequence", () => {
  const p = sequentialPairs(40, { window: 2 });
  assert.ok(p.every(([a, b]) => a < b));
  const offsets = new Set(p.map(([a, b]) => b - a));
  assert.deepEqual([...offsets].sort((x, y) => x - y), [1, 2, 16, 32]);
  assert.equal(new Set(p.map(String)).size, p.length);
});

test("sequential pairs: a closed loop matches the end with the start", () => {
  const p = sequentialPairs(10, { window: 2, loop: true });
  assert.ok(p.some(([a, b]) => a === 0 && b === 9));
  assert.ok(p.some(([a, b]) => a === 1 && b === 9));
  assert.equal(new Set(p.map(String)).size, p.length);
});
