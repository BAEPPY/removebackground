import { solidBackdrop } from './character';

// Preserve the silhouette and thin strands. Only opaque stair-step corners
// are softened; existing soft alpha is never blurred again on editor reopen.
export function tidyContour(original: Uint8ClampedArray, input: Uint8ClampedArray, width: number, height: number, protectedPixels?: Int8Array) {
  const output = input.slice(); const count = width * height;
  const background = solidBackdrop(original, width, height);
  const visited = new Uint8Array(count); const queue = new Uint32Array(count);
  for (let seed = 0; seed < count; seed++) {
    if (visited[seed] || !input[seed * 4 + 3]) continue;
    let head = 0; let tail = 1; queue[0] = seed; visited[seed] = 1;
    let hasDetail = false;
    while (head < tail) {
      const i = queue[head++]; const x = i % width; const y = Math.floor(i / width);
      if (!hasDetail && (tail > 4 || protectedPixels?.[i] === 1 || !background || Math.max(...background.map((c, k) => Math.abs(original[i * 4 + k] - c))) > 24)) hasDetail = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const j = (y + dy) * width + x + dx;
        if (!visited[j] && input[j * 4 + 3]) { visited[j] = 1; queue[tail++] = j; }
      }
    }
    // Tiny detached remnants in the known backdrop color, never dark whiskers
    // or colored details. Large white subject components stay intact.
    if (tail <= 4 && !hasDetail) for (let n = 0; n < tail; n++) output.fill(0, queue[n] * 4, queue[n] * 4 + 4);
  }
  const alpha = (x: number, y: number) => x < 0 || x >= width || y < 0 || y >= height ? 0 : output[(y * width + x) * 4 + 3];
  const softened = output.slice();
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    if (output[i * 4 + 3] !== 255 || original[i * 4 + 3] !== 255 || protectedPixels?.[i] === 1) continue;
    let support = 0; let weight = 0; let softNeighbor = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = alpha(x + dx, y + dy);
      if (a >= 128) support++;
      if (a > 0 && a < 255) softNeighbor = true;
      weight += (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1) * a;
    }
    // Do not alter thin lines, internal whites, or already antialiased edges.
    if (support < 4 || support === 9 || softNeighbor) continue;
    softened[i * 4 + 3] = Math.max(128, Math.min(255, Math.round((weight / 16 - 63.75) * 2)));
  }
  return softened;
}
