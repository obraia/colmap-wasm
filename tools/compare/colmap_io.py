"""Minimal readers for COLMAP sparse models (cameras.bin, images.bin,
points3D.bin) and COLMAP databases (SQLite), for the comparison tools.

Only what the comparisons need; formats as written by COLMAP 4.x."""

import sqlite3
import struct
from pathlib import Path

import numpy as np

# Number of parameters per COLMAP camera model id.
CAMERA_PARAMS = {0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12, 7: 5, 8: 4, 9: 5, 10: 12, 11: 15}

# Pair id = image_id1 * 2147483647 + image_id2, with image_id1 < image_id2.
MAX_IMAGE_ID = 2147483647


def quat_to_rot(qw, qx, qy, qz):
    return np.array([
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy)],
        [2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx)],
        [2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)],
    ])


def read_cameras(model_dir):
    """{camera_id: (model_id, width, height, params)}"""
    cams = {}
    with open(Path(model_dir) / "cameras.bin", "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        for _ in range(n):
            cam_id, model, w, h = struct.unpack("<IiQQ", f.read(24))
            k = CAMERA_PARAMS[model]
            cams[cam_id] = (model, w, h, np.array(struct.unpack(f"<{k}d", f.read(8 * k))))
    return cams


def read_images(model_dir):
    """{name: {id, camera_id, R (world→camera), t, C (centre), xy (n×2), point3D_ids (n)}}"""
    images = {}
    with open(Path(model_dir) / "images.bin", "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        for _ in range(n):
            image_id, qw, qx, qy, qz, tx, ty, tz, cam_id = struct.unpack("<I4d3dI", f.read(64))
            name = b""
            while (c := f.read(1)) != b"\0":
                name += c
            (n2,) = struct.unpack("<Q", f.read(8))
            pts = np.frombuffer(f.read(24 * n2), dtype=[("x", "<f8"), ("y", "<f8"), ("id", "<i8")])
            R = quat_to_rot(qw, qx, qy, qz)
            t = np.array([tx, ty, tz])
            images[name.decode()] = dict(
                id=image_id, camera_id=cam_id, R=R, t=t, C=-R.T @ t,
                xy=np.stack([pts["x"], pts["y"]], 1), point3D_ids=pts["id"],
            )
    return images


def read_points(model_dir):
    """{point_id: {xyz, rgb, error, track (n×2: image_id, point2D_idx)}}"""
    points = {}
    with open(Path(model_dir) / "points3D.bin", "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        for _ in range(n):
            pid, x, y, z, r, g, b, err = struct.unpack("<Q3d3Bd", f.read(43))
            (tl,) = struct.unpack("<Q", f.read(8))
            track = np.frombuffer(f.read(8 * tl), dtype="<u4").reshape(-1, 2)
            points[pid] = dict(xyz=np.array([x, y, z]), rgb=(r, g, b), error=err, track=track)
    return points


class Database:
    """Read-only view of a COLMAP database, keyed by image name."""

    def __init__(self, path):
        # A plain connection: read-only mode can't open a database left in WAL mode
        # without its -shm file. Nothing is written.
        self.db = sqlite3.connect(path)
        self.names = {i: n for i, n in self.db.execute("SELECT image_id, name FROM images")}

    def keypoints(self):
        """{name: (n×cols float32)}; cols is 6 (x, y, a11, a12, a21, a22) for SIFT."""
        return {self.names[i]: np.frombuffer(d, np.float32).reshape(r, c)
                for i, r, c, d in self.db.execute("SELECT image_id, rows, cols, data FROM keypoints")}

    def descriptors(self):
        """{name: (n×128 uint8)}"""
        return {self.names[i]: np.frombuffer(d, np.uint8).reshape(r, c)
                for i, r, c, d in self.db.execute("SELECT image_id, rows, cols, data FROM descriptors")}

    def _pair(self, pair_id):
        id2 = pair_id % MAX_IMAGE_ID
        id1 = (pair_id - id2) // MAX_IMAGE_ID
        return self.names[id1], self.names[id2]

    def matches(self):
        """{(name1, name2): (n×2 uint32)}, raw matches; only pairs with matches."""
        return {self._pair(p): np.frombuffer(d, np.uint32).reshape(r, 2)
                for p, r, d in self.db.execute("SELECT pair_id, rows, data FROM matches WHERE rows > 0")}

    def two_view_geometries(self):
        """{(name1, name2): {config, inliers (n×2), F, E, H (3×3 or None)}}"""
        out = {}
        for p, r, d, config, F, E, H in self.db.execute(
                "SELECT pair_id, rows, data, config, F, E, H FROM two_view_geometries"):
            mat = lambda b: np.frombuffer(b, np.float64).reshape(3, 3) if b else None
            out[self._pair(p)] = dict(
                config=config,
                inliers=np.frombuffer(d, np.uint32).reshape(r, 2) if r else np.zeros((0, 2), np.uint32),
                F=mat(F), E=mat(E), H=mat(H),
            )
        return out
