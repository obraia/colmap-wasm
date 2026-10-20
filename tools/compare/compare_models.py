#!/usr/bin/env python3
"""Compare the camera poses of two COLMAP sparse models of the same images,
e.g. native COLMAP (A) against colmap-wasm (B).

Each reconstruction has its own arbitrary position, orientation and scale, so B
is first aligned to A with the similarity (rotation, translation, scale) that
best maps B's camera centres onto A's (Umeyama). Then, per image:
  - rotation difference: angle between A's and B's camera orientation, in degrees;
  - centre difference: distance between the camera centres, as a percentage of
    the mean distance of A's cameras from their centroid (the "radius").

    python3 compare_models.py native/sparse/0 wasm/sparse/0 [--per-image]
"""

import argparse

import numpy as np

from colmap_io import read_cameras, read_images, read_points


def umeyama(src, dst):
    """Scale s, rotation Q, translation t with dst ≈ s Q src + t (least squares)."""
    ms, md = src.mean(0), dst.mean(0)
    xs, xd = src - ms, dst - md
    U, S, Vt = np.linalg.svd(xd.T @ xs)
    D = np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))])
    Q = U @ D @ Vt
    s = (S * np.diag(D)).sum() / (xs ** 2).sum()
    return s, Q, md - s * Q @ ms


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("a", help="reference model directory (cameras.bin, images.bin, points3D.bin)")
    ap.add_argument("b", help="model directory to check")
    ap.add_argument("--per-image", action="store_true", help="print every image, worst first")
    args = ap.parse_args()

    A, B = read_images(args.a), read_images(args.b)
    common = sorted(set(A) & set(B))
    print(f"registered images: A {len(A)}, B {len(B)}, both {len(common)}")
    only = sorted(set(A) ^ set(B))
    if only:
        print(f"  registered in only one model: {', '.join(only[:10])}{' …' if len(only) > 10 else ''}")
    if len(common) < 3:
        print("too few common images to align")
        return

    ca = np.array([A[n]["C"] for n in common])
    cb = np.array([B[n]["C"] for n in common])
    s, Q, t = umeyama(cb, ca)
    radius = np.linalg.norm(ca - ca.mean(0), axis=1).mean()
    centre = np.linalg.norm((s * (Q @ cb.T)).T + t - ca, axis=1) / radius * 100
    # camera-from-world rotations: B's world is rotated by Q into A's world
    rot = np.array([
        np.degrees(np.arccos(np.clip((np.trace(A[n]["R"] @ (B[n]["R"] @ Q.T).T) - 1) / 2, -1, 1)))
        for n in common
    ])

    fa = [c[3][0] for c in read_cameras(args.a).values()]
    fb = [c[3][0] for c in read_cameras(args.b).values()]
    print(f"focal length: A {', '.join(f'{f:.2f}' for f in fa)}, B {', '.join(f'{f:.2f}' for f in fb)}")
    print(f"3D points: A {len(read_points(args.a))}, B {len(read_points(args.b))}")
    print(f"rotation difference: median {np.median(rot):.4f}°, max {rot.max():.4f}°")
    print(f"centre difference: median {np.median(centre):.4f}%, max {centre.max():.4f}% of the radius")
    if args.per_image:
        for i in np.argsort(-rot):
            print(f"  {common[i]}: {rot[i]:.4f}°, {centre[i]:.4f}%")


if __name__ == "__main__":
    main()
