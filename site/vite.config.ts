import { defineConfig } from "vite";

// The site imports the built package (../dist, `npm run build`), like an app
// importing colmap-wasm would; its worker and .wasm resolve via import.meta.url.
export default defineConfig({
  root: import.meta.dirname,
  build: { outDir: "../site-dist", emptyOutDir: true, target: "es2022" },
  server: { port: 5180, fs: { allow: [".."] } },
});
