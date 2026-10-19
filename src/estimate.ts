// Camera estimation in the browser: COLMAP SIFT in Web Workers, SIFT matching
// on the GPU and COLMAP's geometric verification, view-graph calibration and
// global mapper in a worker.

import { exhaustivePairs } from "./pairs.ts";
import type { FeaturesMessage, MapMessage, WorkerMessage, WorkerRequest } from "./protocol.ts";
import { SiftMatcher } from "./sift-matcher.ts";
import type { Features, ImageInput, PairMatches, Progress, Reconstruction } from "./types.ts";

const newWorker = () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

const aborted = () => new DOMException("cancelled", "AbortError");

/** One request on a worker; rejects on its errors and on `signal`. */
function request<T extends WorkerMessage>(w: Worker, req: WorkerRequest, log?: (s: string) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const abort = () => reject(aborted());
    signal?.addEventListener("abort", abort, { once: true });
    w.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      const m = ev.data;
      if (m.kind === "log") return log?.(m.text);
      signal?.removeEventListener("abort", abort);
      if (m.kind === "error") reject(new Error(`COLMAP: ${m.text}`));
      else resolve(m as T);
    };
    // A worker the browser stops (often for lack of memory) gets no message.
    w.onerror = (e) => {
      e.preventDefault();
      const where = e.filename ? ` (${e.filename}:${e.lineno})` : "";
      reject(new Error(`COLMAP worker stopped: ${e.message || "no message from the browser; it may have run out of memory"}${where}`));
    };
    w.onmessageerror = () => reject(new Error("COLMAP worker: a message could not be read"));
    w.postMessage(req);
  });
}

const imageName = (im: ImageInput) => (im instanceof File ? im.name : im.name);
const imageData = (im: ImageInput) => (im instanceof File ? im : im.data);

/**
 * Default worker count: one per core but one, at most 6, and fewer on devices
 * with little memory (each SIFT worker holds a few hundred MB on large images).
 */
export function defaultWorkers(): number {
  const memGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  return Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 1, 6, Math.floor(memGB / 1.5)));
}

export interface ExtractOptions {
  /** Masks aligned with the images (0 = ignore), as COLMAP's `--ImageReader.mask_path`. */
  masks?: (Blob | null | undefined)[];
  /** Parallel workers (default: `defaultWorkers()`). */
  workers?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** COLMAP SIFT (CPU defaults, as `colmap feature_extractor`) on every image. */
export async function extractFeatures(images: ImageInput[], options: ExtractOptions = {}): Promise<Features[]> {
  const { masks, onProgress, signal } = options;
  const n = Math.max(1, Math.min(images.length, options.workers ?? defaultWorkers()));
  const workers = Array.from({ length: n }, newWorker);
  const results: Features[] = new Array(images.length);
  let next = 0, done = 0;
  try {
    await Promise.all(
      workers.map(async (w) => {
        while (next < images.length) {
          const id = next++;
          const m = await request<FeaturesMessage>(w, { kind: "extract", id, data: imageData(images[id]), mask: masks?.[id] ?? undefined }, undefined, signal);
          const { kind: _k, id: _i, ...features } = m;
          results[id] = features;
          onProgress?.(++done, images.length);
        }
      }),
    );
  } finally {
    workers.forEach((w) => w.terminate());
  }
  return results;
}

export interface MapOptions {
  /** Seed for every RANSAC and the mapper (default 0): the same input gives the same cameras. */
  seed?: number;
  /** COLMAP's log lines (verification, calibration and mapper stages). */
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * Geometric verification of the raw matches, view-graph calibration and the
 * global mapper (`colmap geometric_verifier` + `view_graph_calibrator` +
 * `global_mapper`). All images share one SIMPLE_PINHOLE camera, so they must
 * have the same size.
 */
export async function reconstruct(
  names: string[],
  features: Features[],
  matches: PairMatches[],
  options: MapOptions = {},
): Promise<Reconstruction> {
  const { width, height } = features[0];
  if (features.some((f) => f.width !== width || f.height !== height)) throw new Error("All images must have the same size (one shared camera).");
  const w = newWorker();
  let r: MapMessage;
  try {
    r = await request<MapMessage>(
      w,
      { kind: "map", width, height, names, keypoints: features.map((f) => f.keypoints), matches, seed: options.seed ?? 0 },
      options.onLog,
      options.signal,
    );
  } finally {
    w.terminate();
  }
  const images = names.map((name, i) => {
    const p = r.poses.subarray(13 * i, 13 * i + 13);
    return p[0]
      ? { name, registered: true, R: Float64Array.from(p.subarray(1, 10)), t: [p[10], p[11], p[12]] as [number, number, number] }
      : { name, registered: false, R: null, t: null };
  });
  const points: Reconstruction["points"] = [];
  for (let j = 0, at = 0; j < r.points.length / 4; j++) {
    const len = r.tracks[at++];
    const track: [number, number][] = [];
    for (let k = 0; k < len; k++, at += 2) track.push([r.tracks[at], r.tracks[at + 1]]);
    const [i0, k0] = track[0];
    const c = features[i0].colors.subarray(3 * k0, 3 * k0 + 3);
    points.push({ xyz: [r.points[4 * j], r.points[4 * j + 1], r.points[4 * j + 2]], color: [c[0], c[1], c[2]], error: r.points[4 * j + 3], track });
  }
  const [focal, cx, cy] = r.camera;
  return { camera: { model: "SIMPLE_PINHOLE", width, height, focal, cx, cy }, images, points };
}

export interface EstimateOptions {
  /** Image pairs to match (default: all pairs; see `sequentialPairs` for video frames). */
  pairs?: [number, number][];
  masks?: (Blob | null | undefined)[];
  workers?: number;
  seed?: number;
  onProgress?: (p: Progress) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export interface EstimateResult {
  reconstruction: Reconstruction;
  features: Features[];
  /** Raw matches (before geometric verification). */
  matches: PairMatches[];
  /** Milliseconds per stage. */
  timings: { features: number; matching: number; mapping: number };
}

/** Cameras and sparse points of a set of images, COLMAP-style, in the browser. */
export async function estimatePoses(images: ImageInput[], options: EstimateOptions = {}): Promise<EstimateResult> {
  const { onProgress, signal } = options;
  const names = images.map(imageName);
  const t0 = performance.now();
  const features = await extractFeatures(images, {
    masks: options.masks,
    workers: options.workers,
    signal,
    onProgress: (done, total) => onProgress?.({ stage: "features", done, total }),
  });
  const t1 = performance.now();
  const pairs = options.pairs ?? exhaustivePairs(images.length);
  const matcher = await SiftMatcher.create();
  let matches: PairMatches[];
  try {
    matches = await matcher.match(
      features.map((f) => f.descriptors),
      pairs,
      { onProgress: (done, total) => onProgress?.({ stage: "matching", done, total }) },
    );
  } finally {
    matcher.destroy();
  }
  if (signal?.aborted) throw aborted();
  const t2 = performance.now();
  onProgress?.({ stage: "mapping", done: 0, total: 1 });
  const reconstruction = await reconstruct(names, features, matches, { seed: options.seed, onLog: options.onLog, signal });
  onProgress?.({ stage: "mapping", done: 1, total: 1 });
  return { reconstruction, features, matches, timings: { features: t1 - t0, matching: t2 - t1, mapping: performance.now() - t2 } };
}
