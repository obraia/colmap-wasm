import { defineConfig } from "vite";

// Serves any folder via /@fs for the harness's ?dir=.
export default defineConfig({ server: { fs: { strict: false } } });
