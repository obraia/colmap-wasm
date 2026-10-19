/** Every pair of `n` images (n·(n−1)/2 pairs). */
export function exhaustivePairs(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) out.push([a, b]);
  return out;
}

/**
 * Pairs for an ordered sequence (video frames): each image with the next
 * `window` ones, plus longer jumps (`jumps`, default 16, 32, 64) that tie
 * distant parts together. `loop`: the sequence is a closed orbit, so the end
 * is matched with the start (offsets up to n/2 in both directions).
 */
export function sequentialPairs(
  n: number,
  { window = 8, jumps = [16, 32, 64], loop = false }: { window?: number; jumps?: number[]; loop?: boolean } = {},
): [number, number][] {
  const offsets = [...Array(window).keys()].map((k) => k + 1);
  for (const o of jumps) if (o > window) offsets.push(o);
  const limit = loop ? Math.floor(n / 2) : n - 1;
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++)
    for (const o of offsets) {
      if (o > limit) continue;
      const j = i + o;
      if (j >= n && !loop) continue;
      const a = Math.min(i, j % n), b = Math.max(i, j % n);
      const key = `${a},${b}`;
      if (a !== b && !seen.has(key)) {
        seen.add(key);
        out.push([a, b]);
      }
    }
  return out;
}
