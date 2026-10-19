// COLMAP (WebAssembly) in a Web Worker: SIFT extraction of one image at a
// time, or the mapping of a whole set (geometric verification, view-graph
// calibration, global mapper). One request at a time per worker.

import createModule from "../wasm/colmap.mjs";
import type { ColmapModule } from "../wasm/colmap.mjs";
import type { FeaturesMessage, MapMessage, WorkerMessage, WorkerRequest } from "./protocol.ts";

/** COLMAP's default SIFT max image size (`FeatureExtractionOptions::EffMaxImageSize`). */
const MAX_IMAGE_SIZE = 3200;

const post = (m: WorkerMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// Errors outside a request (or thrown asynchronously) would otherwise reach the
// page as an error event without a message.
self.addEventListener("error", (e) => {
  post({ kind: "error", text: describe(e.error ?? e.message) });
  e.preventDefault();
});
self.addEventListener("unhandledrejection", (e) => {
  post({ kind: "error", text: describe(e.reason) });
  e.preventDefault();
});

// Mapping logs are useful (stage timings, camera counts); extraction logs are noise.
let forwardLogs = false;
const module: Promise<ColmapModule> = createModule({
  print: (s) => forwardLogs && post({ kind: "log", text: s }),
  // glog lines: "I20261019 07:45:00.123 1 file.cc:123] text"
  printErr: (s) => forwardLogs && post({ kind: "log", text: s.replace(/^[IWEF]\d{8} [\d:.]+\s+\d+ [^\]]+\] /, "") }),
  // COLMAP CHECK failures and wasm traps end here (the call then throws).
  onAbort: (what) => post({ kind: "log", text: `COLMAP aborted: ${what}` }),
});

function check(m: ColmapModule, r: number) {
  if (r < 0) throw new Error(m.UTF8ToString(m._cw_error()));
  return r;
}

async function pixels(data: Blob, width?: number, height?: number) {
  const bmp = await createImageBitmap(data, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const W = width ?? bmp.width, H = height ?? bmp.height;
  const ctx = new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  return { data: ctx.getImageData(0, 0, W, H).data, W, H };
}

async function extract(m: ColmapModule, data: Blob, maskData: Blob | undefined, id: number): Promise<FeaturesMessage> {
  const full = await pixels(data);
  const { W, H } = full;
  // Large images are reduced to COLMAP's max size, and the keypoints scaled back (ScaleKeypoints).
  const s = Math.min(1, MAX_IMAGE_SIZE / Math.max(W, H));
  const img = s < 1 ? await pixels(data, Math.round(W * s), Math.round(H * s)) : full;
  const rgb = new Uint8Array(img.W * img.H * 3);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgb[i] = img.data[j];
    rgb[i + 1] = img.data[j + 1];
    rgb[i + 2] = img.data[j + 2];
  }
  const ptr = m._malloc(rgb.length);
  m.HEAPU8.set(rgb, ptr);
  let n: number;
  try {
    n = check(m, m._cw_extract(ptr, img.W, img.H));
  } finally {
    m._free(ptr);
  }
  const kp = m.HEAPF32.slice(m._cw_keypoints() / 4, m._cw_keypoints() / 4 + n * 6);
  const desc = m.HEAPU8.slice(m._cw_descriptors(), m._cw_descriptors() + n * 128);
  if (s < 1) {
    const sx = W / img.W, sy = H / img.H;
    for (let i = 0; i < n; i++) {
      const k = 6 * i;
      kp[k] *= sx;
      kp[k + 1] *= sy;
      kp[k + 2] *= sx;
      kp[k + 3] *= sy;
      kp[k + 4] *= sx;
      kp[k + 5] *= sy;
    }
  }
  // Masks as in COLMAP's MaskFeatures: drop keypoints on 0 pixels.
  const mask = maskData ? (await pixels(maskData, W, H)).data : null;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = Math.trunc(kp[6 * i]), y = Math.trunc(kp[6 * i + 1]);
    if (mask && (x < 0 || y < 0 || x >= W || y >= H || mask[(y * W + x) * 4] === 0)) continue;
    keep.push(i);
  }
  const out = { keypoints: new Float32Array(keep.length * 6), descriptors: new Uint8Array(keep.length * 128), colors: new Uint8Array(keep.length * 3) };
  keep.forEach((i, k) => {
    out.keypoints.set(kp.subarray(6 * i, 6 * i + 6), 6 * k);
    out.descriptors.set(desc.subarray(128 * i, 128 * i + 128), 128 * k);
    const x = Math.min(W - 1, Math.max(0, Math.floor(kp[6 * i]))), y = Math.min(H - 1, Math.max(0, Math.floor(kp[6 * i + 1])));
    const p = (y * W + x) * 4;
    out.colors.set([full.data[p], full.data[p + 1], full.data[p + 2]], 3 * k);
  });
  return { kind: "features", id, width: W, height: H, count: keep.length, ...out };
}

function map(m: ColmapModule, req: Extract<WorkerRequest, { kind: "map" }>): MapMessage {
  forwardLogs = true;
  check(m, m._cw_map_begin(req.width, req.height));
  try {
    req.names.forEach((name, i) => {
      const kp = req.keypoints[i];
      const namePtr = m.stringToNewUTF8(name);
      const kpPtr = m._malloc(Math.max(4, kp.byteLength));
      m.HEAPF32.set(kp, kpPtr / 4);
      try {
        check(m, m._cw_map_image(namePtr, kpPtr, kp.length / 6));
      } finally {
        m._free(kpPtr);
        m._free(namePtr);
      }
    });
    for (const pm of req.matches) {
      const n = pm.ia.length;
      const ab = new Uint32Array(2 * n);
      for (let k = 0; k < n; k++) {
        ab[2 * k] = pm.ia[k];
        ab[2 * k + 1] = pm.ib[k];
      }
      const ptr = m._malloc(Math.max(4, ab.byteLength));
      m.HEAPU32.set(ab, ptr / 4);
      try {
        check(m, m._cw_map_matches(pm.a, pm.b, ptr, n));
      } finally {
        m._free(ptr);
      }
    }
    const registered = check(m, m._cw_map_run(req.seed));
    post({ kind: "log", text: `wasm memory: ${(m.HEAPU8.length / 2 ** 20).toFixed(0)} MB` });
    const nPts = m._cw_res_num_points();
    return {
      kind: "model",
      registered,
      camera: m.HEAPF64.slice(m._cw_res_camera() / 8, m._cw_res_camera() / 8 + 3),
      poses: m.HEAPF64.slice(m._cw_res_poses() / 8, m._cw_res_poses() / 8 + 13 * req.names.length),
      points: m.HEAPF64.slice(m._cw_res_points() / 8, m._cw_res_points() / 8 + 4 * nPts),
      tracks: m.HEAP32.slice(m._cw_res_tracks() / 4, m._cw_res_tracks() / 4 + m._cw_res_tracks_size()),
    };
  } finally {
    m._cw_map_end();
    forwardLogs = false;
  }
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  try {
    const m = await module;
    const req = ev.data;
    if (req.kind === "extract") {
      const r = await extract(m, req.data, req.mask, req.id);
      post(r, [r.keypoints.buffer, r.descriptors.buffer, r.colors.buffer]);
    } else {
      const r = map(m, req);
      post(r, [r.camera.buffer, r.poses.buffer, r.points.buffer, r.tracks.buffer]);
    }
  } catch (e) {
    post({ kind: "error", text: describe(e) });
  }
};
