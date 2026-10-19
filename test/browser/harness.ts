// Runs estimatePoses on images served by this dev server and leaves the result
// in `window.__result` (for automation). Query: ?dir=/@fs/<folder>&n=<count>
// [&ext=jpg] [&window=8] [&loop=1]: images <dir>/00000.<ext> … in name order.
import { estimatePoses, sequentialPairs, toColmapBinary } from "../../dist/index.js";

const q = new URLSearchParams(location.search);
const dir = q.get("dir")!, n = Number(q.get("n")), ext = q.get("ext") ?? "jpg";
const out = document.getElementById("log")!;
const log = (s: string) => (out.textContent += s + "\n");
const w = window as unknown as { __result?: unknown; __error?: string };

(async () => {
  try {
    const names = Array.from({ length: n }, (_, i) => `${String(i).padStart(5, "0")}.${ext}`);
    const images = await Promise.all(names.map(async (name) => ({ name, data: await (await fetch(`${dir}/${name}`)).blob() })));
    const pairs = sequentialPairs(n, { window: Number(q.get("window") ?? 8), loop: q.get("loop") === "1" });
    const r = await estimatePoses(images, { pairs, onLog: log });
    const files = toColmapBinary(r.reconstruction, r.features);
    w.__result = {
      registered: r.reconstruction.images.filter((i) => i.registered).length,
      points: r.reconstruction.points.length,
      focal: r.reconstruction.camera.focal,
      timings: r.timings,
      poses: r.reconstruction.images.map((i) => (i.R ? [...i.R, ...i.t!] : null)),
      bytes: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length])),
    };
    log("done");
  } catch (e) {
    w.__error = String(e);
    log(`error: ${e}`);
  }
})();
