#!/usr/bin/env node
// Builds COLMAP 4.2.1 (SIFT extraction, geometric verification, view-graph
// calibration, global mapper) as WebAssembly for src/worker.ts.
//
//   npm run build:wasm
//
// - Sources, toolchain and patches: native/ (fetch.sh, build.sh, entry/, patches/).
// - Work directory: .colmap/ (emsdk, sources, build; COLMAP_WASM_DIR overrides).
// - Output: wasm/colmap.{mjs,wasm} and its types (ES module for a Web Worker).
// - Requires git, curl, Python >= 3.10 (PYTHON overrides) and Boost headers
//   (BOOST_INC overrides; Homebrew `boost` or Debian `libboost-dev`).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const here = join(root, "native");
const work = process.env.COLMAP_WASM_DIR || join(root, ".colmap");
const out = join(root, "wasm");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** First Python >= 3.10 found (emsdk needs it). */
function python() {
  if (process.env.PYTHON) return process.env.PYTHON;
  for (const p of ["python3.13", "python3.12", "python3.11", "python3.10", "/opt/homebrew/bin/python3", "python3"]) {
    const r = spawnSync(p, ["-c", "import sys; print(sys.version_info >= (3, 10))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "True") return p;
  }
  throw new Error("Python >= 3.10 not found (set PYTHON).");
}

function boost() {
  if (process.env.BOOST_INC) return process.env.BOOST_INC;
  const dir = ["/opt/homebrew/include", "/usr/local/include", "/usr/include"].find((d) => existsSync(join(d, "boost", "version.hpp")));
  if (!dir) throw new Error("Boost headers not found (brew install boost / apt install libboost-dev, or set BOOST_INC).");
  return dir;
}

mkdirSync(work, { recursive: true });
const env = { ...process.env, COLMAP_WASM_DIR: work, PYTHON: python(), BOOST_INC: boost() };
run("bash", [join(here, "fetch.sh")], { env });
run("bash", [join(here, "build.sh")], { env });
mkdirSync(out, { recursive: true });
for (const f of ["colmap.mjs", "colmap.wasm"]) copyFileSync(join(work, "build", "colmap", f), join(out, f));
// Types for the Emscripten module (native/entry/web.cc's C API).
writeFileSync(
  join(out, "colmap.d.mts"),
  `export interface ColmapModule {
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _cw_error(): number;
  _cw_extract(rgb: number, width: number, height: number): number;
  _cw_keypoints(): number;
  _cw_descriptors(): number;
  _cw_map_begin(width: number, height: number): number;
  _cw_map_image(name: number, keypoints: number, n: number): number;
  _cw_map_matches(a: number, b: number, matches: number, n: number): number;
  _cw_map_run(seed: number): number;
  _cw_res_camera(): number;
  _cw_res_poses(): number;
  _cw_res_num_points(): number;
  _cw_res_points(): number;
  _cw_res_tracks_size(): number;
  _cw_res_tracks(): number;
  _cw_map_end(): void;
  UTF8ToString(ptr: number): string;
  stringToNewUTF8(s: string): number;
}
export default function createModule(options?: {
  print?: (s: string) => void;
  printErr?: (s: string) => void;
  onAbort?: (what: unknown) => void;
  locateFile?: (path: string, prefix: string) => string;
}): Promise<ColmapModule>;
`,
);
console.log(`COLMAP wasm → ${out}`);
