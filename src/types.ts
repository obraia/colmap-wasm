/** An input image: a `File` (its name is used) or any `Blob` with a name. */
export type ImageInput = File | { name: string; data: Blob };

/** COLMAP SIFT features of one image. */
export interface Features {
  width: number;
  height: number;
  count: number;
  /** count × 6: x, y (pixels, COLMAP convention: pixel centres at +0.5) and the affine shape a11, a12, a21, a22. */
  keypoints: Float32Array;
  /** count × 128: COLMAP's uint8 SIFT descriptors. */
  descriptors: Uint8Array;
  /** count × 3: RGB at each keypoint. */
  colors: Uint8Array;
}

/** Raw (unverified) matches between images `a` and `b`. */
export interface PairMatches {
  a: number;
  b: number;
  /** Keypoint indices in A and B. */
  ia: Uint32Array;
  ib: Uint32Array;
}

/** One SIMPLE_PINHOLE camera shared by all images. */
export interface Camera {
  model: "SIMPLE_PINHOLE";
  width: number;
  height: number;
  focal: number;
  cx: number;
  cy: number;
}

export interface ImagePose {
  name: string;
  registered: boolean;
  /** World → camera rotation, row-major (null if not registered). */
  R: Float64Array | null;
  /** World → camera translation (null if not registered). */
  t: [number, number, number] | null;
}

export interface Point3D {
  xyz: [number, number, number];
  color: [number, number, number];
  /** Mean reprojection error (pixels). */
  error: number;
  /** Observations: [image index, keypoint index]. */
  track: [number, number][];
}

export interface Reconstruction {
  camera: Camera;
  images: ImagePose[];
  points: Point3D[];
}

export type Stage = "features" | "matching" | "mapping";

export interface Progress {
  stage: Stage;
  done: number;
  total: number;
}
