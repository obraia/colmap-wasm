# Comparing colmap-wasm with native COLMAP

Two scripts check that colmap-wasm gives native COLMAP's results, one stage at
a time, on the same images:

- `compare_db.py A.db B.db`: two COLMAP databases. It compares keypoints,
  descriptors, raw matches and the geometric verification (configuration,
  inlier matches, F / E / H).
- `compare_models.py A/ B/`: two sparse models (`cameras.bin`, `images.bin`,
  `points3D.bin`). It compares the camera poses after aligning one
  reconstruction onto the other.

`A` is the reference (native COLMAP) and `B` is the one being checked
(colmap-wasm). `colmap_io.py` has the readers both scripts share.

## Requirements

- Python 3.9+ with `numpy`, `scipy` and `Pillow` (`pip install numpy scipy pillow`).
  Pillow is for `native/tools/raw.py`, which decodes the images for the wasm.
- Native COLMAP 4.2.1 on the `PATH` (`colmap -h`).
- The Node tools from `npm run build:wasm`:
  - `.colmap/build/colmap/colmap_sift.cjs` does SIFT extraction and matching.
  - `.colmap/build/colmap/colmap_gm.cjs` does verification, optional view-graph
    calibration and the global mapper.

  Run them with the Node that comes with emsdk
  (`.colmap/emsdk/node/*/bin/node`) or any Node ≥ 18.
- A folder of images that all have the same size. All images share one
  `SIMPLE_PINHOLE` camera, as in the browser. Use a dense sequence, such as
  consecutive video frames with plenty of overlap; a sparse set may not
  reconstruct, and then there are no poses to compare.

## Producing the two sides

Compare one stage at a time, and give both sides the same input at each stage.
That way, a difference points to the stage that produced it.

```bash
IMAGES=path/to/images            # 00000.jpg, 00001.jpg, …
NODE=$(ls -d .colmap/emsdk/node/*/bin/node | head -1)
TOOLS=.colmap/build/colmap
mkdir -p cmp && cd cmp
ls "$IMAGES" > list.txt
# pairs to match, one "name1 name2" per line (here: each image with its next 8)
awk '{n[NR]=$0} END {for (i=1;i<=NR;i++) for (j=i+1;j<=i+8&&j<=NR;j++) print n[i], n[j]}' list.txt > pairs.txt
```

**1. SIFT extraction and matching**

```bash
# native: same options as the wasm build (CPU SIFT, one camera, exact brute-force matching)
colmap feature_extractor --database_path native.db --image_path "$IMAGES" \
  --ImageReader.single_camera 1 --ImageReader.camera_model SIMPLE_PINHOLE \
  --FeatureExtraction.use_gpu 0
colmap matches_importer --database_path native.db --match_list_path pairs.txt --match_type pairs \
  --FeatureMatching.use_gpu 0 --SiftMatching.cpu_brute_force_matcher 1 --TwoViewGeometry.random_seed 0

# wasm: images decoded to raw RGB first (the wasm has no image codecs)
python3 ../native/tools/raw.py "$IMAGES" raw
"$NODE" ../$TOOLS/colmap_sift.cjs list.txt raw - pairs.txt wasm.db

python3 ../tools/compare/compare_db.py native.db wasm.db
```

`wasm.db` only holds raw matches, so this run compares keypoints, descriptors
and matches.

**2. Geometric verification on the same matches**

```bash
# the wasm verifies native's matches: a copy of native.db (colmap_gm clears and rewrites the verification)
cp native.db wasm-verified.db
sqlite3 wasm-verified.db "PRAGMA journal_mode=DELETE;"   # WAL needs shared memory the wasm doesn't have
mkdir -p wasm-model
"$NODE" ../$TOOLS/colmap_gm.cjs wasm-verified.db wasm-model 0   # seed 0, no calibration

python3 ../tools/compare/compare_db.py native.db wasm-verified.db
```

`native.db` already has native's verification, done by `matches_importer`
with seed 0.

**3. Global mapper on the same verified pairs**

```bash
mkdir -p native-model
colmap global_mapper --database_path native.db --image_path "$IMAGES" --output_path native-model \
  --GlobalMapper.random_seed 0 --GlobalMapper.num_threads 1

python3 ../tools/compare/compare_models.py native-model/0 wasm-model
```

`wasm-model` is what step 2's `colmap_gm` wrote.

To see how much native COLMAP itself varies, compare two native runs.
`view_graph_calibrator` is a good case: natively it runs unseeded and
multi-threaded, while the wasm build seeds it (`colmap_gm.cjs … 0 calibrate`).

```bash
for r in 1 2; do cp native.db rep$r.db; colmap view_graph_calibrator --database_path rep$r.db
  mkdir -p rep$r; colmap global_mapper --database_path rep$r.db --image_path "$IMAGES" --output_path rep$r \
    --GlobalMapper.random_seed 0 --GlobalMapper.num_threads 1; done
python3 ../tools/compare/compare_models.py rep1/0 rep2/0
```

## Reading the results

### `compare_db.py`

**keypoints**

- Keypoints are paired by position and affine shape, not by index. When one
  side detects a keypoint more or fewer, the indices shift, but the features
  are still the same.
- `B paired with A` is the share of B's keypoints that have a partner in A.
  It should be 99.5–100%. The rest are near-threshold detections that only
  one side keeps.
- `position error` should be about 1e-5 px (median), and every pair should be
  within 0.01 px. The wasm has no fused multiply-add, so it rounds slightly
  differently.
- `descriptors`: most are bit-identical and all should be within ±1, which is
  the rounding of the uint8 conversion.

**raw matches**

- These are compared through the keypoint pairing.
- On identical input, every pair is identical (100%).
- When both sides extracted their own keypoints (step 1), expect about 99%:
  a keypoint more or fewer can change a near tie in the ratio test.

**two-view geometries**

- Compare these when both sides verified the same matches with the same seed
  (step 2). Then:
  - `same configuration` should cover every pair;
  - `identical inlier sets` should cover nearly every pair, with 99.9% or
    more of the inliers shared. A match whose error sits right at the RANSAC
    threshold can fall on either side of it with different rounding, so a
    few pairs in a few hundred may differ by a handful of inliers;
  - the matrix that defines each pair's configuration (E and F for
    calibrated pairs, F for uncalibrated ones, H for planar and panoramic
    ones) should differ by about 1e-12 (floating point) in the median. The
    matrices are normalised and compared up to sign, since they are only
    defined up to scale. The maximum is larger, from ~1e-6 up to ~1e-2, on
    the pairs whose inliers differ or whose geometry is nearly degenerate.
- Pairs without matches only appear in native's table, because native also
  records them as degenerate.

### `compare_models.py`

- B is aligned to A with the similarity (rotation, translation, scale) that
  best maps B's camera centres onto A's (Umeyama). Each reconstruction comes
  out in an arbitrary frame and scale, so this step is needed before any
  comparison.
- `rotation difference` is the angle between each image's orientation in A
  and in B.
- `centre difference` is the distance between the camera centres, as a
  percentage of the "radius": the mean distance of A's cameras from their
  centroid.
- Use `--per-image` to list the images from worst to best.
- With identical inputs and seeds (step 3), expect the same registered
  images, a median below about 0.1° and a maximum below about 1° (often far
  less: around 0.01° on a dense sequence of 40 frames). The global mapper iterates (rotation
  averaging, global positioning, bundle adjustment), so the floating-point
  differences from steps 1–2 grow a little along the way: no FMA in wasm, and
  Eigen's `SimplicialLLT` instead of CHOLMOD. Comparing a model with itself
  gives exactly 0.
- Two native runs with `view_graph_calibrator` typically differ by 1–3°. A
  wasm-vs-native difference inside that range is as close as native is to
  itself.

### Red flags

Something is broken if you see any of these:

- under 95% of keypoints paired;
- descriptors off by more than 1;
- many pairs with a different verification configuration or different inliers
  on the same matches (more than about 1–2% of the pairs);
- poses several degrees apart while two native runs agree.
