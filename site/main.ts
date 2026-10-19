import { zipSync } from "fflate";
import { estimatePoses, exhaustivePairs, sequentialPairs, toColmapBinary, type EstimateResult } from "../dist/index.js";
import { type Frame, framesFromImages, framesFromVideo } from "./frames.ts";
import { sampleOrbit } from "./sample.ts";
import { Viewer } from "./viewer.ts";
import "./style.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = $<HTMLLabelElement>("drop"), fileInput = $<HTMLInputElement>("files");
const info = $("input-info"), thumbs = $("thumbs"), options = $<HTMLFieldSetElement>("options");
const runBtn = $<HTMLButtonElement>("run"), sampleBtn = $<HTMLButtonElement>("sample"), downloadBtn = $<HTMLButtonElement>("download");
const logEl = $("log"), stats = $("stats"), empty = $("view-empty");
const num = (id: string) => Number($<HTMLInputElement>(id).value);
const checked = (id: string) => $<HTMLInputElement>(id).checked;

const viewer = new Viewer($<HTMLCanvasElement>("view"));
const hasGpu = "gpu" in navigator;
if (!hasGpu) $("gpu-warning").hidden = false;

/** What the user gave: a video (sampled when running) or frames. */
let source: { kind: "video"; file: File } | { kind: "frames"; frames: Frame[]; label: string } | null = null;
let result: EstimateResult | null = null;
let busy = false;

const log = (s: string) => {
  logEl.textContent += s + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};

const ORDER = ["frames", "features", "matching", "mapping", "done"];

/** Progress of `stage` (0–1); the mapper reports no steps, so it shows as busy. */
function setStage(stage: string, frac: number) {
  for (const el of document.querySelectorAll<HTMLElement>(".stage")) {
    const i = ORDER.indexOf(el.dataset.stage!), j = ORDER.indexOf(stage);
    el.classList.toggle("done", i < j);
    el.classList.toggle("active", i === j);
    el.classList.toggle("busy", i === j && stage === "mapping" && frac < 1);
    el.querySelector<HTMLElement>(".bar i")!.style.width = i < j ? "100%" : i === j ? `${Math.round(frac * 100)}%` : "0";
  }
}

function showThumbs(frames: Frame[]) {
  thumbs.replaceChildren(
    ...frames.filter((_, i) => frames.length <= 16 || i % Math.ceil(frames.length / 16) === 0).slice(0, 16).map((f) => {
      const img = new Image();
      img.src = f.thumb;
      img.alt = f.name;
      return img;
    }),
  );
}

function refresh() {
  runBtn.disabled = busy || !source || !hasGpu;
  sampleBtn.disabled = busy;
  options.disabled = busy;
  $("frames-row").hidden = source?.kind !== "video";
  downloadBtn.disabled = busy || !result;
}

async function take(files: File[]) {
  if (busy || !files.length) return;
  result = null;
  const video = files.find((f) => f.type.startsWith("video/"));
  if (video) {
    source = { kind: "video", file: video };
    $<HTMLInputElement>("ordered").checked = true;
    info.textContent = `${video.name} · ${(video.size / 1e6).toFixed(1)} MB · frames are sampled when you run`;
    thumbs.replaceChildren();
  } else {
    const images = files.filter((f) => f.type.startsWith("image/"));
    try {
      info.textContent = "Reading frames…";
      const frames = await framesFromImages(images, num("maxside"), () => {});
      source = { kind: "frames", frames, label: `${frames.length} frames` };
      info.textContent = `${frames.length} frames`;
      showThumbs(frames);
    } catch (e) {
      source = null;
      info.textContent = e instanceof Error ? e.message : String(e);
    }
  }
  refresh();
}

fileInput.onchange = () => take([...(fileInput.files ?? [])]);
drop.ondragover = (e) => {
  e.preventDefault();
  drop.classList.add("over");
};
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  take([...(e.dataTransfer?.files ?? [])]);
};

sampleBtn.onclick = async () => {
  busy = true;
  result = null;
  refresh();
  info.textContent = "Rendering a synthetic orbit…";
  try {
    const frames = await sampleOrbit(48, 960, 720, (d, n) => setStage("frames", d / n));
    source = { kind: "frames", frames, label: "48 synthetic frames" };
    $<HTMLInputElement>("ordered").checked = true;
    $<HTMLInputElement>("loop").checked = true;
    info.textContent = "48 synthetic frames of a closed orbit, 960×720";
    showThumbs(frames);
  } finally {
    busy = false;
    refresh();
  }
};

runBtn.onclick = async () => {
  if (!source) return;
  busy = true;
  result = null;
  refresh();
  logEl.textContent = "";
  stats.hidden = true;
  const t0 = performance.now();
  try {
    let frames: Frame[];
    if (source.kind === "video") {
      setStage("frames", 0);
      frames = await framesFromVideo(source.file, Math.min(200, Math.max(12, num("frames"))), num("maxside"), (d, n) => setStage("frames", d / n));
      showThumbs(frames);
    } else frames = source.frames;
    const n = frames.length;
    const pairs = checked("ordered") ? sequentialPairs(n, { window: num("window"), loop: checked("loop") }) : exhaustivePairs(n);
    log(`${n} frames, ${pairs.length} pairs`);
    result = await estimatePoses(frames, {
      pairs,
      onProgress: (p) => setStage(p.stage, p.done / p.total),
      onLog: log,
    });
    setStage("done", 1);
    const r = result.reconstruction, t = result.timings;
    const registered = r.images.filter((im) => im.registered).length;
    stats.replaceChildren(
      ...[
        `${registered}/${n} cameras`,
        `${r.points.length.toLocaleString("en-US")} points`,
        `f = ${r.camera.focal.toFixed(0)} px`,
        `SIFT ${(t.features / 1000).toFixed(1)} s`,
        `matching ${(t.matching / 1000).toFixed(1)} s`,
        `mapping ${(t.mapping / 1000).toFixed(1)} s`,
        `total ${((performance.now() - t0) / 1000).toFixed(1)} s`,
      ].map((s) => Object.assign(document.createElement("span"), { textContent: s })),
    );
    stats.hidden = false;
    empty.hidden = true;
    viewer.show(r);
    if (!registered) log("No cameras could be registered: try more frames or more overlap between them.");
  } catch (e) {
    log(`Error: ${e instanceof Error ? e.message : e}`);
    (document.querySelector(".log") as HTMLDetailsElement).open = true;
  } finally {
    busy = false;
    refresh();
  }
};

downloadBtn.onclick = () => {
  if (!result) return;
  const files = toColmapBinary(result.reconstruction, result.features);
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [`sparse/0/${k}`, v])), { level: 6 });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }));
  a.download = "colmap-sparse.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

refresh();
