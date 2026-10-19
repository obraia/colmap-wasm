// Frames for the demo: evenly spaced frames sampled from a video, or images
// scaled to a common size (the pipeline uses one camera for all of them).

export interface Frame {
  name: string;
  data: Blob;
  thumb: string;
}

const pad = (i: number) => String(i).padStart(5, "0");

function canvasFor(w: number, h: number, maxSide: number) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const W = Math.round(w * s), H = Math.round(h * s);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  return { canvas, ctx: canvas.getContext("2d")!, W, H };
}

const toJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG encoding failed"))), "image/jpeg", 0.92));

function thumbnail(canvas: HTMLCanvasElement) {
  const t = document.createElement("canvas");
  t.width = 96;
  t.height = Math.round((96 * canvas.height) / canvas.width);
  t.getContext("2d")!.drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL("image/jpeg", 0.7);
}

/** `count` frames at evenly spaced times of the video (centres of equal intervals). */
export async function framesFromVideo(file: File, count: number, maxSide: number, progress: (done: number, total: number) => void): Promise<Frame[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(file);
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("This browser can't decode the video."));
    });
    const { canvas, ctx, W, H } = canvasFor(video.videoWidth, video.videoHeight, maxSide);
    const frames: Frame[] = [];
    for (let i = 0; i < count; i++) {
      const t = ((i + 0.5) / count) * video.duration;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = t;
      });
      ctx.drawImage(video, 0, 0, W, H);
      frames.push({ name: `${pad(i)}.jpg`, data: await toJpeg(canvas), thumb: thumbnail(canvas) });
      progress(i + 1, count);
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Images in name order, scaled to fit `maxSide`; all must share one size. */
export async function framesFromImages(files: File[], maxSide: number, progress: (done: number, total: number) => void): Promise<Frame[]> {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const frames: Frame[] = [];
  let size: string | null = null;
  for (const [i, f] of sorted.entries()) {
    const bmp = await createImageBitmap(f);
    const key = `${bmp.width}×${bmp.height}`;
    if (size && key !== size) {
      bmp.close();
      throw new Error(`All frames must have the same size (${f.name} is ${key}, the first is ${size}).`);
    }
    size = key;
    const scaled = Math.max(bmp.width, bmp.height) > maxSide;
    const { canvas, ctx, W, H } = canvasFor(bmp.width, bmp.height, maxSide);
    ctx.drawImage(bmp, 0, 0, W, H);
    bmp.close();
    // JPEGs that fit are passed as they are; anything else is re-encoded
    const data = !scaled && f.type === "image/jpeg" ? f : await toJpeg(canvas);
    frames.push({ name: `${pad(i)}.jpg`, data, thumb: thumbnail(canvas) });
    progress(i + 1, sorted.length);
  }
  return frames;
}
