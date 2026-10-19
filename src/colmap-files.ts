// COLMAP sparse model files (cameras.bin, images.bin, points3D.bin), as
// written by `colmap model_converter --output_type BIN`. Every keypoint
// becomes a POINTS2D entry, linked to its 3D point or −1.

import type { Features, Reconstruction } from "./types.ts";

class Writer {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  private o = 0;
  private grow(n: number) {
    if (this.o + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.o + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) {
    this.grow(1);
    this.view.setUint8(this.o, v);
    this.o += 1;
  }
  i32(v: number) {
    this.grow(4);
    this.view.setInt32(this.o, v, true);
    this.o += 4;
  }
  u32(v: number) {
    this.grow(4);
    this.view.setUint32(this.o, v, true);
    this.o += 4;
  }
  u64(v: number) {
    this.grow(8);
    this.view.setBigUint64(this.o, BigInt(v), true);
    this.o += 8;
  }
  i64(v: number) {
    this.grow(8);
    this.view.setBigInt64(this.o, BigInt(v), true);
    this.o += 8;
  }
  f64(v: number) {
    this.grow(8);
    this.view.setFloat64(this.o, v, true);
    this.o += 8;
  }
  str(s: string) {
    const b = new TextEncoder().encode(s);
    this.grow(b.length + 1);
    this.buf.set(b, this.o);
    this.o += b.length;
    this.u8(0);
  }
  bytes() {
    return this.buf.slice(0, this.o);
  }
}

/** Unit quaternion (w, x, y, z) of a row-major rotation matrix. */
export function quaternion(R: ArrayLike<number>): [number, number, number, number] {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = Array.from(R);
  const tr = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (tr > 0) {
    const s = 2 * Math.sqrt(1 + tr);
    q = [s / 4, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [(m21 - m12) / s, s / 4, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m02 - m20) / s, (m01 + m10) / s, s / 4, (m12 + m21) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, s / 4];
  }
  const n = Math.hypot(...q) * (q[0] < 0 ? -1 : 1);
  return q.map((v) => v / n) as [number, number, number, number];
}

/** The reconstruction as COLMAP binary files (`features`: those it was built from). */
export function toColmapBinary(rec: Reconstruction, features: Features[]): Record<"cameras.bin" | "images.bin" | "points3D.bin", Uint8Array> {
  const cams = new Writer();
  cams.u64(1);
  cams.u32(1);
  cams.i32(0); // SIMPLE_PINHOLE
  cams.u64(rec.camera.width);
  cams.u64(rec.camera.height);
  cams.f64(rec.camera.focal);
  cams.f64(rec.camera.cx);
  cams.f64(rec.camera.cy);

  // 3D point id (1-based) of each observed keypoint
  const pointOf = rec.images.map((_, i) => new Int32Array(features[i].count).fill(-1));
  rec.points.forEach((p, j) => {
    for (const [i, k] of p.track) pointOf[i][k] = j + 1;
  });

  const images = new Writer();
  images.u64(rec.images.filter((im) => im.registered).length);
  rec.images.forEach((im, i) => {
    if (!im.registered || !im.R || !im.t) return;
    images.u32(i + 1);
    quaternion(im.R).forEach((v) => images.f64(v));
    im.t.forEach((v) => images.f64(v));
    images.u32(1);
    images.str(im.name);
    const f = features[i];
    images.u64(f.count);
    for (let k = 0; k < f.count; k++) {
      images.f64(f.keypoints[6 * k]);
      images.f64(f.keypoints[6 * k + 1]);
      images.i64(pointOf[i][k]);
    }
  });

  const pts = new Writer();
  pts.u64(rec.points.length);
  rec.points.forEach((p, j) => {
    pts.u64(j + 1);
    p.xyz.forEach((v) => pts.f64(v));
    p.color.forEach((v) => pts.u8(v));
    pts.f64(p.error);
    pts.u64(p.track.length);
    for (const [i, k] of p.track) {
      pts.u32(i + 1);
      pts.u32(k);
    }
  });
  return { "cameras.bin": cams.bytes(), "images.bin": images.bytes(), "points3D.bin": pts.bytes() };
}
