// Messages between the main thread and src/worker.ts.

import type { Features, PairMatches } from "./types.ts";

export type WorkerRequest =
  | { kind: "extract"; id: number; data: Blob; mask?: Blob }
  | { kind: "map"; width: number; height: number; names: string[]; keypoints: Float32Array[]; matches: PairMatches[]; seed: number };

export interface FeaturesMessage extends Features {
  kind: "features";
  id: number;
}

export interface MapMessage {
  kind: "model";
  registered: number;
  /** focal, cx, cy */
  camera: Float64Array;
  /** Per input image: registered (0/1), R (row-major, world → camera), t. */
  poses: Float64Array;
  /** Per point: x, y, z, mean reprojection error. */
  points: Float64Array;
  /** Per point: track length, then (image, keypoint) pairs. */
  tracks: Int32Array;
}

export type WorkerMessage = FeaturesMessage | MapMessage | { kind: "log"; text: string } | { kind: "error"; text: string };
