# colmap-wasm

**Unofficial** WebAssembly build of [COLMAP](https://github.com/colmap/colmap)
4.2.1 for the browser: COLMAP's own SIFT extraction, geometric verification,
view-graph calibration and global mapper (GLOMAP), plus exact SIFT matching on
WebGPU. Give it images, get cameras and a sparse point cloud, without a server.

Not affiliated with or endorsed by the COLMAP authors. The goal is to offer
this upstream; until then, issues go here.

## What runs where

| Stage | Where | Same result as native COLMAP? |
| --- | --- | --- |
| SIFT extraction (`feature_extractor`, CPU defaults) | Web Workers, one wasm instance each | Keypoints to ~1e-5 px, identical descriptors |
| SIFT matching | WebGPU compute shader | Identical matches to `cpu_brute_force_matcher` |
| Geometric verification (`geometric_verifier`) | one worker | Identical with the same seed |
| View-graph calibration (`view_graph_calibrator`) | same worker | Seeded here; natively it runs unseeded |
| Global mapper (`global_mapper`) | same worker | Same intermediate counts; poses equal up to floating point |

Everything is seeded (default 0), so the same images give the same cameras.

On 90 images of 1024×1280 on an Apple M4 (Chrome): features 21 s (5 workers),
matching 4.7 s, mapping 45 s. The `.wasm` is 7 MB (2.1 MB gzipped).

## Install

```bash
npm install colmap-wasm
```

Requires a browser with WebGPU (for matching) and module Web Workers. No
`SharedArrayBuffer` or cross-origin isolation is needed.

With Vite, keep the package out of dependency pre-bundling so the worker and
`.wasm` URLs resolve:

```ts
// vite.config.ts
export default defineConfig({ optimizeDeps: { exclude: ["colmap-wasm"] } });
```

## Usage

```ts
import { estimatePoses, sequentialPairs, toColmapBinary } from "colmap-wasm";

const files: File[] = [...input.files!]; // same size; one shared SIMPLE_PINHOLE camera
const { reconstruction, features, timings } = await estimatePoses(files, {
  pairs: sequentialPairs(files.length, { window: 8, loop: true }), // default: all pairs
  onProgress: ({ stage, done, total }) => console.log(stage, done, total),
  onLog: (line) => console.log(line), // COLMAP's mapper log
});

for (const im of reconstruction.images) {
  if (im.registered) console.log(im.name, im.R, im.t); // world → camera, R row-major
}

// COLMAP sparse model (cameras.bin, images.bin, points3D.bin), e.g. for 3D Gaussian Splatting trainers
const sparse = toColmapBinary(reconstruction, features);
```

### API

- `estimatePoses(images, options)`: the whole pipeline. `images`: `File`s or
  `{ name, data: Blob }`. Options: `pairs`, `masks` (aligned with the images;
  0 = ignore, as COLMAP's `--ImageReader.mask_path`), `workers`, `seed`,
  `onProgress`, `onLog`, `signal`.
- `extractFeatures(images, options)`: COLMAP SIFT only (`Features`: keypoints
  `n×6`, descriptors `n×128`, colors `n×3`).
- `SiftMatcher.create({ device? })`, then
  `.match(descriptors, pairs, options)`: GPU matching with COLMAP's rule
  (`maxRatio` 0.8, `maxDistance` 0.7, `crossCheck`).
- `reconstruct(names, features, matches, options)`: verification,
  calibration and global mapper on your own features and matches.
- `exhaustivePairs(n)`, `sequentialPairs(n, { window, jumps, loop })`.
- `toColmapBinary(reconstruction, features)`: COLMAP binary model files.

All images share one `SIMPLE_PINHOLE` camera (focal estimated, principal
point at the centre), which suits video frames.

## Building from source

```bash
npm install
npm run build:wasm   # emsdk, Eigen, Ceres, glog, PoseLib, SQLite, COLMAP subset → wasm/ (~5 min clean)
npm run build        # TypeScript → dist/
npm test
npm run example      # examples/browser (pick images, download sparse/0)
```

`build:wasm` needs git, curl, Python ≥ 3.10 and the Boost headers
(`brew install boost` or `apt install libboost-dev`). Everything it downloads
is pinned (git commits, SHA-256 for archives) and goes to `.colmap/`.

### What is changed or left out

- [`native/patches/colmap-no-cholmod.patch`](native/patches/colmap-no-cholmod.patch):
  Eigen's `SimplicialLLT` instead of SuiteSparse's CHOLMOD (no SuiteSparse in
  the build; Ceres uses Eigen's sparse Cholesky too).
- [`native/patches/colmap-inline-thread-pool.patch`](native/patches/colmap-inline-thread-pool.patch):
  `ThreadPool` runs each task when it is added if emscripten has no pthreads.
- No OpenMP (a single-thread `omp.h`), no OpenImageIO (images are decoded by
  the browser; a minimal `Bitmap`), no faiss (matching is brute force on the
  GPU), no METIS, CUDA, GUI, MVS or ONNX features.
- [`native/entry/web.cc`](native/entry/web.cc) is the C API the worker calls;
  `main.cc` and `sift_main.cc` build Node tools for comparisons with a native
  COLMAP.

## License

BSD-3-Clause for this repository, like COLMAP. The compiled module includes
COLMAP, VLFeat, Ceres, Eigen, glog, PoseLib, SQLite and the Emscripten runtime:
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Built for [Gausify Orbit](https://github.com/obraia/gausify-orbit), an
in-browser orbit-video-to-Gaussian-Splatting app.
