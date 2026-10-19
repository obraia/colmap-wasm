import { estimatePoses, exhaustivePairs, sequentialPairs, toColmapBinary, type EstimateResult } from "../../dist/index.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = $<HTMLInputElement>("images"), run = $<HTMLButtonElement>("run"), download = $<HTMLButtonElement>("download");
const out = $<HTMLPreElement>("log");
const log = (s: string) => {
  out.textContent += s + "\n";
  out.scrollTop = out.scrollHeight;
};
let result: EstimateResult | null = null;

input.onchange = () => (run.disabled = !input.files?.length);

run.onclick = async () => {
  const files = [...(input.files ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const n = files.length;
  const pairs = $<HTMLInputElement>("sequential").checked
    ? sequentialPairs(n, { window: Number($<HTMLInputElement>("window").value), loop: $<HTMLInputElement>("loop").checked })
    : exhaustivePairs(n);
  run.disabled = download.disabled = true;
  out.textContent = "";
  log(`${n} images, ${pairs.length} pairs`);
  try {
    result = await estimatePoses(files, {
      pairs,
      onProgress: (p) => p.stage !== "mapping" && p.done % 10 === 0 && log(`${p.stage} ${p.done}/${p.total}`),
      onLog: log,
    });
    const r = result.reconstruction;
    const t = result.timings;
    log(`\n${r.images.filter((i) => i.registered).length}/${n} cameras, ${r.points.length} points, f = ${r.camera.focal.toFixed(1)} px`);
    log(`features ${(t.features / 1000).toFixed(1)} s, matching ${(t.matching / 1000).toFixed(1)} s, mapping ${(t.mapping / 1000).toFixed(1)} s`);
    download.disabled = false;
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : e}`);
  } finally {
    run.disabled = false;
  }
};

download.onclick = () => {
  if (!result) return;
  for (const [name, bytes] of Object.entries(toColmapBinary(result.reconstruction, result.features))) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes]));
    a.download = name;
    a.click();
  }
};
