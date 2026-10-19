// SIFT matching on the GPU (WebGPU compute shader) with COLMAP's brute-force
// rule (`SiftMatchingOptions` defaults with `cpu_brute_force_matcher`):
// integer dot products, strictly larger wins in index order, angle and ratio
// tests in float32, cross-check. The matches equal COLMAP's.

import type { PairMatches } from "./types.ts";

// Same loop as COLMAP's FindBestMatchesOneWayBruteForce: strictly larger dot
// products win, in index order, starting from 0 (no match if all are 0).
const shader = (packedDot: boolean) => /* wgsl */ `
struct Job { offA: u32, nA: u32, offB: u32, nB: u32, out: u32, _p0: u32, _p1: u32, _p2: u32 }
@group(0) @binding(0) var<storage, read> desc: array<u32>;
@group(0) @binding(1) var<storage, read> jobs: array<Job>;
@group(0) @binding(2) var<storage, read_write> result: array<u32>;
var<workgroup> tile: array<u32, 2048>;

fn dot4(a: u32, b: u32) -> u32 {
  ${packedDot ? "return dot4U8Packed(a, b);" : `var s = 0u;
  for (var k = 0u; k < 32u; k += 8u) { s += extractBits(a, k, 8u) * extractBits(b, k, 8u); }
  return s;`}
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let job = jobs[wg.y];
  let q = wg.x * 64u + lid.x;
  let valid = q < job.nA;
  var qd: array<u32, 32>;
  if (valid) {
    for (var k = 0u; k < 32u; k++) { qd[k] = desc[(job.offA + q) * 32u + k]; }
  }
  var best = 0u;
  var second = 0u;
  var bi = 0xffffffffu;
  for (var base = 0u; base < job.nB; base += 64u) {
    let j = base + lid.x;
    for (var k = 0u; k < 32u; k++) {
      tile[lid.x * 32u + k] = select(0u, desc[(job.offB + j) * 32u + k], j < job.nB);
    }
    workgroupBarrier();
    let cnt = min(64u, job.nB - base);
    if (valid) {
      for (var t = 0u; t < cnt; t++) {
        var d = 0u;
        for (var k = 0u; k < 32u; k++) { d += dot4(qd[k], tile[t * 32u + k]); }
        if (d > best) { second = best; best = d; bi = base + t; }
        else if (d > second) { second = d; }
      }
    }
    workgroupBarrier();
  }
  if (valid) {
    result[job.out + q * 3u] = bi;
    result[job.out + q * 3u + 1u] = best;
    result[job.out + q * 3u + 2u] = second;
  }
}`;

const NONE = 0xffffffff;
/** Squared norm of COLMAP's uint8 SIFT descriptors. */
const SQ_NORM = 512 * 512;

export interface SiftMatchOptions {
  /** Lowe's ratio test (COLMAP default 0.8). */
  maxRatio?: number;
  /** Maximum angle between descriptors, in radians (COLMAP default 0.7). */
  maxDistance?: number;
  /** Keep only mutual best matches (COLMAP default true). */
  crossCheck?: boolean;
  /** Pairs per GPU dispatch. */
  batch?: number;
  onProgress?: (done: number, total: number) => void;
}

export class SiftMatcher {
  private constructor(
    private device: GPUDevice,
    private pipeline: GPUComputePipeline,
    private ownsDevice: boolean,
  ) {}

  /**
   * `device`: an existing WebGPU device to share (otherwise one is requested).
   * `packedDot: false` forces the shader path for GPUs without dot4U8Packed.
   */
  static async create({
    device,
    packedDot = navigator.gpu.wgslLanguageFeatures?.has("packed_4x8_integer_dot_product") ?? false,
  }: { device?: GPUDevice; packedDot?: boolean } = {}): Promise<SiftMatcher> {
    const owns = !device;
    if (!device) {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("WebGPU is not available.");
      device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxBufferSize: adapter.limits.maxBufferSize,
        },
      });
    }
    const module = device.createShaderModule({ code: shader(packedDot) });
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    return new SiftMatcher(device, pipeline, owns);
  }

  /** Matches the requested pairs of images. `descriptors`: 128 bytes per keypoint, per image. */
  async match(descriptors: Uint8Array[], pairs: [number, number][], options: SiftMatchOptions = {}): Promise<PairMatches[]> {
    const { maxRatio = 0.8, maxDistance = 0.7, crossCheck = true, batch = 48, onProgress } = options;
    const f = Math.fround;
    const inv = f(1 / SQ_NORM), ratio = f(maxRatio), maxDist = f(maxDistance);
    const angle = (dot: number) => f(Math.acos(Math.min(f(inv * dot), 1)));
    const oneWay = (res: Uint32Array, off: number, i: number) => {
      const j = res[off + 3 * i];
      if (j === NONE) return -1;
      const best = angle(res[off + 3 * i + 1]);
      if (best > maxDist) return -1;
      if (best >= f(ratio * angle(res[off + 3 * i + 2]))) return -1;
      return j;
    };

    const dev = this.device;
    const words = descriptors.map((d) =>
      d.byteOffset % 4 ? new Uint32Array(d.slice().buffer) : new Uint32Array(d.buffer, d.byteOffset, d.byteLength / 4),
    );
    const counts = words.map((d) => d.length / 32);
    const offsets: number[] = [];
    let total = 0;
    for (const c of counts) {
      offsets.push(total);
      total += c;
    }
    const all = new Uint32Array(total * 32);
    words.forEach((d, i) => all.set(d, offsets[i] * 32));
    const descBuf = dev.createBuffer({ size: Math.max(4, all.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(descBuf, 0, all);
    const maxN = Math.max(1, ...counts);

    const out: PairMatches[] = [];
    try {
      for (let s = 0; s < pairs.length; s += batch) {
        const chunk = pairs.slice(s, s + batch);
        // two jobs per pair: A→B and B→A
        const jobs = new Uint32Array(chunk.length * 2 * 8);
        let outLen = 0;
        const outOff: number[] = [];
        chunk.forEach(([a, b], k) => {
          for (const [x, y, slot] of [
            [a, b, 2 * k],
            [b, a, 2 * k + 1],
          ]) {
            jobs.set([offsets[x], counts[x], offsets[y], counts[y], outLen], slot * 8);
            outOff[slot] = outLen;
            outLen += counts[x] * 3;
          }
        });
        const size = Math.max(4, outLen * 4);
        const jobBuf = dev.createBuffer({ size: jobs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        dev.queue.writeBuffer(jobBuf, 0, jobs);
        const resBuf = dev.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const readBuf = dev.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const bind = dev.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: descBuf } },
            { binding: 1, resource: { buffer: jobBuf } },
            { binding: 2, resource: { buffer: resBuf } },
          ],
        });
        const enc = dev.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(Math.ceil(maxN / 64), chunk.length * 2);
        pass.end();
        enc.copyBufferToBuffer(resBuf, 0, readBuf, 0, size);
        dev.queue.submit([enc.finish()]);
        await readBuf.mapAsync(GPUMapMode.READ);
        const res = new Uint32Array(readBuf.getMappedRange().slice(0));
        readBuf.unmap();
        [jobBuf, resBuf, readBuf].forEach((b) => b.destroy());

        chunk.forEach(([a, b], k) => {
          const ab = outOff[2 * k], ba = outOff[2 * k + 1];
          const ia: number[] = [], ib: number[] = [];
          for (let i = 0; i < counts[a]; i++) {
            const j = oneWay(res, ab, i);
            if (j < 0 || (crossCheck && oneWay(res, ba, j) !== i)) continue;
            ia.push(i);
            ib.push(j);
          }
          out.push({ a, b, ia: Uint32Array.from(ia), ib: Uint32Array.from(ib) });
        });
        onProgress?.(Math.min(s + batch, pairs.length), pairs.length);
      }
    } finally {
      descBuf.destroy();
    }
    return out;
  }

  /** Releases the GPU device, unless it was passed to `create`. */
  destroy() {
    if (this.ownsDevice) this.device.destroy();
  }
}
