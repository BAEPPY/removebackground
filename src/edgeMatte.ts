import { solidBackdrop } from './character';
import { tidyContour } from './contour';

// Recover foreground color from C = alpha * F + (1 - alpha) * background.
// Only a narrow band bordering transparent pixels is eligible. In particular,
// white fur and other pixels indistinguishable from the backdrop are NOT erased.
export function refineEdges(original: Uint8ClampedArray, mask: Uint8ClampedArray, width: number, height: number, protectedPixels?: Int8Array) {
  if (width < 1 || height < 1 || original.length !== width * height * 4 || mask.length !== original.length) throw new Error('이미지 크기가 맞지 않아요.');
  const output = mask.slice();
  const background = solidBackdrop(original, width, height);
  for (let i = 0; i < width * height; i++) if (!output[i * 4 + 3]) output.fill(0, i * 4, i * 4 + 4);
  // Existing transparent artwork has no known baked-in matte to remove.
  if (!background) return tidyContour(original, output, width, height, protectedPixels);

  const band = 3;
  const count = width * height;
  const distance = new Uint8Array(count).fill(255);
  const queue = new Uint32Array(count);
  let tail = 0;
  for (let i = 0; i < count; i++) if (mask[i * 4 + 3] === 0) { distance[i] = 0; queue[tail++] = i; }
  function visit(i: number, depth: number) {
    if (depth < distance[i]) { distance[i] = depth; queue[tail++] = i; }
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head]; const depth = distance[i] + 1;
    if (depth > band + 2) continue;
    const x = i % width;
    if (x > 0) visit(i - 1, depth);
    if (x + 1 < width) visit(i + 1, depth);
    if (i >= width) visit(i - width, depth);
    if (i + width < count) visit(i + width, depth);
  }
  const contrast = (i: number) => Math.max(Math.abs(original[i * 4] - background[0]), Math.abs(original[i * 4 + 1] - background[1]), Math.abs(original[i * 4 + 2] - background[2]));
  const offsets: { dx: number; dy: number; squared: number }[] = [];
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const squared = dx * dx + dy * dy;
    if (squared > 0 && squared <= 16) offsets.push({ dx, dy, squared });
  }
  offsets.sort((a, b) => a.squared - b.squared);
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    if (!mask[p + 3] || distance[i] > band || original[p + 3] < 250) continue;
    const pixelContrast = contrast(i);
    // Near-white source pixels may be genuine white anatomy. No color keying.
    if (pixelContrast < 8) continue;
    const x = i % width; const y = Math.floor(i / width);
    let best = Infinity; let foreground = -1; let coverage = 1;
    for (const { dx, dy, squared } of offsets) {
      const nx = x + dx; const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const j = ny * width + nx; const q = j * 4;
      // Estimate from a more solid, deeper neighbor, not a removed pixel or
      // another light antialias pixel on the outer side of the contour.
      if (mask[q + 3] < 240 || original[q + 3] < 250 || distance[j] < distance[i] || contrast(j) < Math.max(80, pixelContrast + 24)) continue;
      let stable = false;
      for (const k of [nx > 0 ? j - 1 : -1, nx + 1 < width ? j + 1 : -1, ny > 0 ? j - width : -1, ny + 1 < height ? j + width : -1]) {
        if (k >= 0 && k !== i && mask[k * 4 + 3] >= 240 && [0, 1, 2].every((c) => Math.abs(original[k * 4 + c] - original[q + c]) <= 12)) { stable = true; break; }
      }
      if (!stable) continue;
      let dot = 0; let norm = 0;
      for (let c = 0; c < 3; c++) { const v = background[c] - original[q + c]; dot += (background[c] - original[p + c]) * v; norm += v * v; }
      const alpha = Math.max(0, Math.min(1, dot / norm));
      if (alpha < .025 || alpha > .98) continue;
      let residual = 0;
      for (let c = 0; c < 3; c++) residual = Math.max(residual, Math.abs(original[p + c] - (alpha * original[q + c] + (1 - alpha) * background[c])));
      if (residual > 8) continue;
      const score = residual * 2 + squared * .15 + (255 - contrast(j)) * .08;
      if (score < best) { best = score; foreground = j; coverage = alpha; }
    }
    if (foreground < 0) continue;
    // Read the original composite every time, never un-matte an already
    // corrected RGB value. Use min, not multiplication, with an AI soft mask.
    output[p + 3] = Math.min(mask[p + 3], Math.round(coverage * original[p + 3]));
    for (let c = 0; c < 3; c++) output[p + c] = Math.max(0, Math.min(255, Math.round(background[c] + (original[p + c] - background[c]) / coverage)));
  }
  return tidyContour(original, output, width, height, protectedPixels);
}
