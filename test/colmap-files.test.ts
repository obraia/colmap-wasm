import assert from "node:assert/strict";
import { test } from "node:test";
import { quaternion, toColmapBinary } from "../src/colmap-files.ts";
import type { Features, Reconstruction } from "../src/types.ts";

function rotation(axis: [number, number, number], angle: number) {
  const n = Math.hypot(...axis), [x, y, z] = axis.map((v) => v / n), c = Math.cos(angle), s = Math.sin(angle), C = 1 - c;
  return Float64Array.from([c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C]);
}

test("quaternion of rotation matrices (all branches)", () => {
  for (const [axis, angle] of [[[0, 0, 1], 0.3], [[1, 0, 0], 3.0], [[0, 1, 0], 3.1], [[0, 0, 1], 3.1], [[1, 2, 3], 1.2]] as const) {
    const q = quaternion(rotation([...axis] as [number, number, number], angle));
    assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-12);
    assert.ok(q[0] >= 0);
    assert.ok(Math.abs(2 * Math.acos(Math.min(1, q[0])) - angle) < 1e-9);
  }
});

test("COLMAP binary files: counts and point links", () => {
  const f = (count: number): Features => ({ width: 100, height: 80, count, keypoints: new Float32Array(count * 6).map((_, i) => i), descriptors: new Uint8Array(count * 128), colors: new Uint8Array(count * 3) });
  const features = [f(3), f(2)];
  const rec: Reconstruction = {
    camera: { model: "SIMPLE_PINHOLE", width: 100, height: 80, focal: 120, cx: 50, cy: 40 },
    images: [
      { name: "a.jpg", registered: true, R: rotation([0, 1, 0], 0), t: [0, 0, 0] },
      { name: "b.jpg", registered: true, R: rotation([0, 1, 0], 0.2), t: [1, 0, 0] },
    ],
    points: [{ xyz: [0, 0, 5], color: [10, 20, 30], error: 0.5, track: [[0, 2], [1, 0]] }],
  };
  const files = toColmapBinary(rec, features);
  const cams = new DataView(files["cameras.bin"].buffer);
  assert.equal(cams.getBigUint64(0, true), 1n);
  assert.equal(cams.getFloat64(4 + 8 + 4 + 4 + 8 + 8 - 4, true) > 0, true);
  const im = new DataView(files["images.bin"].buffer);
  assert.equal(im.getBigUint64(0, true), 2n);
  // first image: id, quaternion, t, camera, "a.jpg\0", n points2D, then (x, y, id) × 3
  let o = 8 + 4 + 7 * 8 + 4 + 6;
  assert.equal(im.getBigUint64(o, true), 3n);
  o += 8;
  const ids = [0, 1, 2].map((k) => im.getBigInt64(o + k * 24 + 16, true));
  assert.deepEqual(ids, [-1n, -1n, 1n]);
  const pts = new DataView(files["points3D.bin"].buffer);
  assert.equal(pts.getBigUint64(0, true), 1n);
  const trackAt = 8 + 8 + 24 + 3 + 8;
  assert.equal(pts.getBigUint64(trackAt, true), 2n);
  assert.deepEqual([pts.getUint32(trackAt + 8, true), pts.getUint32(trackAt + 12, true)], [1, 2]);
});
