// Conservative translation tracking for sticker-like GIFs. We reuse a mask
// only when the full-resolution source also matches, including its background.
// Deformation, cuts, rotation, occlusion and uncertain matches request new AI.
export const KEYFRAME_INTERVAL = 10;
type Pixels = Uint8ClampedArray;

function difference(a: Pixels, i: number, b: Pixels, j: number) {
  let diff = Math.abs(a[i + 3] - b[j + 3]);
  for (let c = 0; c < 3; c++) diff = Math.max(diff, Math.abs(a[i + c] * a[i + 3] / 255 - b[j + c] * b[j + 3] / 255));
  return diff;
}

export function trackMask(source: Pixels, mask: Pixels, next: Pixels, width: number, height: number) {
  if (source.length !== width * height * 4 || mask.length !== source.length || next.length !== source.length) return null;
  function validate(dx: number, dy: number) {
    let error = 0; let changed = 0;
    let uniformBorder: boolean | undefined;
    function borderMatches() {
      if (uniformBorder !== undefined) return uniformBorder;
      uniformBorder = true;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (x && y && x < width - 1 && y < height - 1) continue;
        const i = (y * width + x) * 4;
        if (mask[i + 3] || difference(source, i, source, 0) > 4) return uniformBorder = false;
      }
      return uniformBorder;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const rx = x - dx; const ry = y - dy; const i = (y * width + x) * 4;
      const inside = rx >= 0 && ry >= 0 && rx < width && ry < height;
      if (!inside && !borderMatches()) return null;
      const delta = difference(next, i, source, inside ? (ry * width + rx) * 4 : 0);
      // A single newly appearing dark stroke/eye must trigger fresh inference.
      if (delta > 20) return null;
      error += delta; if (delta > 8) changed++;
    }
    if (error / (width * height) > 2 || changed > width * height * .0005) return null;
    const pixels = new Uint8ClampedArray(next);
    let foreground = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const rx = x - dx; const ry = y - dy; const i = (y * width + x) * 4;
      pixels[i + 3] = rx >= 0 && ry >= 0 && rx < width && ry < height ? Math.min(next[i + 3], mask[(ry * width + rx) * 4 + 3]) : 0;
      if (!pixels[i + 3]) pixels.fill(0, i, i + 4); else foreground++;
    }
    return foreground ? { pixels, dx, dy } : null;
  }
  const unchanged = validate(0, 0);
  if (unchanged) return unchanged;

  const step = Math.max(1, Math.ceil(Math.max(width, height) / 80));
  const range = Math.min(64, Math.max(4, Math.ceil(Math.max(width, height) * .12)));
  const samples: { x: number; y: number; i: number; weight: number }[] = [];
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const i = (y * width + x) * 4;
    samples.push({ x, y, i, weight: mask[i + 3] > 16 ? 4 : 1 });
  }
  let best = Infinity; let bestX = 0; let bestY = 0;
  function score(dx: number, dy: number) {
    let sum = 0;
    for (const p of samples) {
      const x = p.x + dx; const y = p.y + dy;
      sum += (x < 0 || y < 0 || x >= width || y >= height ? (mask[p.i + 3] ? 255 : 0) : difference(source, p.i, next, (y * width + x) * 4)) * p.weight;
      if (sum >= best) return;
    }
    if (sum < best) { best = sum; bestX = dx; bestY = dy; }
  }
  for (let dy = -range; dy <= range; dy += step) for (let dx = -range; dx <= range; dx += step) score(dx, dy);
  const cx = bestX; const cy = bestY;
  for (let dy = cy - step; dy <= cy + step; dy++) for (let dx = cx - step; dx <= cx + step; dx++) score(dx, dy);
  return validate(bestX, bestY);
}
