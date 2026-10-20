#!/usr/bin/env python3
"""Compare two COLMAP databases built from the same images, e.g. native COLMAP
(A) against colmap-wasm (B): keypoints, descriptors, raw matches and the
two-view geometries (configuration, inlier matches, F / E / H).

Keypoints are paired by position and affine shape, not by index: when one side
detects a keypoint more or less, indices shift but the features are the same.
Matches and inliers are compared through that pairing.

    python3 compare_db.py native.db wasm.db [--verbose]

See README.md for how to produce both databases and how to read the output.
"""

import argparse

import numpy as np
from scipy.spatial import cKDTree

from colmap_io import Database

# COLMAP's TwoViewGeometry::ConfigurationType, and the matrix each one is defined by.
CONFIGS = {0: "undefined", 1: "degenerate", 2: "calibrated", 3: "uncalibrated", 4: "planar",
           5: "panoramic", 6: "planar or panoramic", 7: "watermark", 8: "multiple"}
CONFIG_MATRICES = {2: ("E", "F"), 3: ("F",), 4: ("H",), 5: ("H",), 6: ("H",), 7: ("H",)}

# Keypoint pairing: (x, y) in pixels and the affine shape scaled by SHAPE_SCALE,
# matched within PAIR_TOL in that space (≈ 0.05 px with the shape agreeing too).
SHAPE_SCALE = 100.0
PAIR_TOL = 0.05


def pair_keypoints(ka, kb):
    """Index in A of each keypoint of B (−1 if none), and the position error (px) of each pair."""
    if ka.shape == kb.shape and np.array_equal(ka, kb):
        n = len(kb)
        return np.arange(n), np.zeros(n)
    fa = np.c_[ka[:, :2], SHAPE_SCALE * ka[:, 2:]] if ka.shape[1] > 2 else ka[:, :2]
    fb = np.c_[kb[:, :2], SHAPE_SCALE * kb[:, 2:]] if kb.shape[1] > 2 else kb[:, :2]
    d, j = cKDTree(fa).query(fb)
    j = np.where(d <= PAIR_TOL, j, -1)
    err = np.where(j >= 0, np.linalg.norm(kb[:, :2] - ka[np.maximum(j, 0), :2], axis=1), np.nan)
    return j, err


def canonical(pairs):
    """{(name1, name2) sorted: (n×2) with columns in that order} — the databases may number images differently."""
    out = {}
    for (a, b), m in pairs.items():
        out[(a, b) if a <= b else (b, a)] = m if a <= b else m[:, ::-1]
    return out


def as_set(m, map1=None, map2=None):
    if map1 is not None:
        m = np.c_[map1[m[:, 0]], map2[m[:, 1]]]
        m = m[(m[:, 0] >= 0) & (m[:, 1] >= 0)]
    return set(map(tuple, m.tolist()))


def matrix_diff(a, b):
    """Difference of two matrices defined up to scale and sign (F, E, H): Frobenius norm after normalising."""
    if a is None or b is None or not np.any(a) or not np.any(b):
        return None
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    return min(np.linalg.norm(a - b), np.linalg.norm(a + b))


def pct(x, n):
    return f"{100 * x / n:.2f}%" if n else "n/a"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("a", help="reference database (e.g. native COLMAP)")
    ap.add_argument("b", help="database to check (e.g. colmap-wasm)")
    ap.add_argument("--verbose", action="store_true", help="list the images and pairs that differ most")
    args = ap.parse_args()
    A, B = Database(args.a), Database(args.b)

    # --- keypoints and descriptors
    ka, kb = A.keypoints(), B.keypoints()
    names = sorted(set(ka) & set(kb))
    print(f"images: {len(ka)} in A, {len(kb)} in B, {len(names)} in both")
    da, db = A.descriptors(), B.descriptors()
    maps = {}
    n_a = n_b = paired = within = same_desc = close_desc = 0
    errs, worst = [], []
    for n in names:
        j, err = pair_keypoints(ka[n], kb[n])
        maps[n] = j
        ok = j >= 0
        n_a += len(ka[n])
        n_b += len(kb[n])
        paired += ok.sum()
        within += (err[ok] <= 0.01).sum()
        errs.append(err[ok])
        worst.append((len(kb[n]) - ok.sum(), n))
        if n in da and n in db and ok.any():
            diff = np.abs(da[n][j[ok]].astype(int) - db[n][ok].astype(int)).max(1)
            same_desc += (diff == 0).sum()
            close_desc += (diff <= 1).sum()
    errs = np.concatenate(errs) if errs else np.zeros(0)
    print("\nkeypoints")
    print(f"  A {n_a}, B {n_b}; B paired with A: {paired} ({pct(paired, n_b)})")
    if paired:
        print(f"  position error of paired keypoints: median {np.median(errs):.2e} px, max {errs.max():.2e} px; within 0.01 px: {pct(within, paired)}")
        print(f"  descriptors of paired keypoints: identical {pct(same_desc, paired)}, within ±1 {pct(close_desc, paired)}")
    if args.verbose:
        for miss, n in sorted(worst, reverse=True)[:5]:
            if miss:
                print(f"    {n}: {miss} keypoints of B without a partner in A")

    # --- raw matches
    ma, mb = canonical(A.matches()), canonical(B.matches())
    print("\nraw matches")
    common = [p for p in sorted(set(ma) & set(mb)) if p[0] in maps and p[1] in maps]
    print(f"  pairs with matches: A {len(ma)}, B {len(mb)}, both {len(common)}")
    if common:
        tot_a = shared = identical = 0
        worst = []
        for p in common:
            sa = as_set(ma[p])
            sb = as_set(mb[p], maps[p[0]], maps[p[1]])
            tot_a += len(sa)
            shared += len(sa & sb)
            identical += sa == sb
            worst.append((len(sa ^ sb), p))
        print(f"  identical pairs: {identical}/{len(common)}; matches of A also in B: {shared}/{tot_a} ({pct(shared, tot_a)})")
        if args.verbose:
            for d, p in sorted(worst, reverse=True)[:5]:
                if d:
                    print(f"    {p[0]} – {p[1]}: {d} matches differ")

    # --- two-view geometries (geometric verification)
    ga, gb = canonical_geometries(A.two_view_geometries()), canonical_geometries(B.two_view_geometries())
    print("\ntwo-view geometries (verification)")
    common = [p for p in sorted(set(ga) & set(gb)) if p[0] in maps and p[1] in maps]
    print(f"  pairs: A {len(ga)}, B {len(gb)}, both {len(common)}")
    if common:
        same_config = identical = tot_a = shared = 0
        mdiff = {"F": [], "E": [], "H": []}
        worst = []
        for p in common:
            a, b = ga[p], gb[p]
            same_config += a["config"] == b["config"]
            sa = as_set(a["inliers"])
            sb = as_set(b["inliers"], maps[p[0]], maps[p[1]])
            tot_a += len(sa)
            shared += len(sa & sb)
            identical += sa == sb
            worst.append((len(sa ^ sb), p))
            # only the matrix the configuration is defined by: the others can be
            # ill-conditioned estimates the pair doesn't use
            if a["config"] == b["config"]:
                for k in CONFIG_MATRICES.get(a["config"], ()):
                    d = matrix_diff(a[k], b[k])
                    if d is not None:
                        mdiff[k].append(d)
        print(f"  same configuration: {same_config}/{len(common)}")
        counts = {}
        for p in common:
            counts[ga[p]["config"]] = counts.get(ga[p]["config"], 0) + 1
        print("    A's configurations: " + ", ".join(f"{CONFIGS.get(c, c)} {n}" for c, n in sorted(counts.items())))
        print(f"  identical inlier sets: {identical}/{len(common)}; inliers of A also in B: {shared}/{tot_a} ({pct(shared, tot_a)})")
        for k, v in mdiff.items():
            if v:
                v = np.array(v)
                print(f"  {k} of the pairs it defines (normalised, up to sign): median diff {np.median(v):.1e}, max {v.max():.1e} over {len(v)} pairs")
        if args.verbose:
            for d, p in sorted(worst, reverse=True)[:5]:
                if d:
                    print(f"    {p[0]} – {p[1]}: {d} inliers differ")


def canonical_geometries(g):
    out = {}
    for (a, b), v in g.items():
        if a <= b:
            out[(a, b)] = v
        else:  # swapping the images transposes F and E and inverts H
            out[(b, a)] = dict(
                config=v["config"], inliers=v["inliers"][:, ::-1],
                F=None if v["F"] is None else v["F"].T, E=None if v["E"] is None else v["E"].T,
                H=None if v["H"] is None or not np.any(v["H"]) else np.linalg.inv(v["H"]),
            )
    return out


if __name__ == "__main__":
    main()
