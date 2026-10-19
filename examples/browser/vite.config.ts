import { defineConfig } from "vite";

// The example imports the built package (npm run build); apps importing it should
// keep it out of dependency pre-bundling, so the worker and .wasm URLs resolve:
//   optimizeDeps: { exclude: ["colmap-wasm"] }
export default defineConfig({ server: { fs: { allow: ["../.."] } } });
