// Character mode uses connectivity and outlines, not a global color replacement.
// Only background-colored pixels reachable from the canvas edge are removed.
// Enclosed regions keep their original RGB and alpha, even when they are white.
function borderIndices(width: number, height: number) {
  const indices: number[] = [];
  for (let x = 0; x < width; x++) { indices.push(x); if (height > 1) indices.push((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { indices.push(y * width); if (width > 1) indices.push(y * width + width - 1); }
  return indices;
}

function backdrop(pixels: Uint8ClampedArray, border: number[]) {
  const opaque = border.filter((i) => pixels[i * 4 + 3] > 240);
  if (border.filter((i) => pixels[i * 4 + 3] < 16).length > border.length * .6) return null;
  if (opaque.length < border.length * .6) throw new Error('캐릭터 보호는 단색 배경에 알맞아요. 복잡한 배경은 사진 AI 모드를 선택해 주세요.');
  const color = [0, 1, 2].map((channel) => {
    const values = opaque.map((i) => pixels[i * 4 + channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
  const matching = opaque.filter((i) => color.every((value, channel) => Math.abs(pixels[i * 4 + channel] - value) <= 24));
  if (matching.length < opaque.length * .75) throw new Error('배경 색이 고르지 않아요. 사진 AI 모드로 처리한 뒤 필요한 부분을 복원해 주세요.');
  return color;
}

// Separable sliding-window morphology keeps processing O(width * height).
function filterMask(input: Uint8Array, width: number, height: number, radius: number, dilate: boolean, horizontal: boolean) {
  const output = new Uint8Array(input.length);
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const stride = horizontal ? 1 : width;
  for (let line = 0; line < lines; line++) {
    const start = horizontal ? line * width : line;
    let sum = 0;
    for (let p = 0; p <= Math.min(radius, length - 1); p++) sum += input[start + p * stride];
    for (let p = 0; p < length; p++) {
      const count = Math.min(length - 1, p + radius) - Math.max(0, p - radius) + 1;
      output[start + p * stride] = Number(dilate ? sum > 0 : sum === count);
      if (p - radius >= 0) sum -= input[start + (p - radius) * stride];
      if (p + radius + 1 < length) sum += input[start + (p + radius + 1) * stride];
    }
  }
  return output;
}

export function removeCharacterBackground(pixels: Uint8ClampedArray, width: number, height: number) {
  if (pixels.length !== width * height * 4 || width < 1 || height < 1) throw new Error('이미지 크기를 확인할 수 없어요.');
  const border = borderIndices(width, height);
  const background = backdrop(pixels, border);
  const output = pixels.slice();
  // An already-transparent illustration keeps its existing holes and soft alpha.
  if (!background) return output;

  const count = width * height;
  const edges = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const offset = i * 4;
    edges[i] = Number(pixels[offset + 3] > 15 && background.some((value, channel) => Math.abs(pixels[offset + channel] - value) > 24));
  }
  // Close short breaks in line art, without expanding the entire silhouette.
  const radius = Math.min(5, Math.max(1, Math.round(Math.min(width, height) / 150)));
  let closed = filterMask(edges, width, height, radius, true, true);
  closed = filterMask(closed, width, height, radius, true, false);
  closed = filterMask(closed, width, height, radius, false, true);
  closed = filterMask(closed, width, height, radius, false, false);

  const exterior = new Uint8Array(count);
  const queue = new Uint32Array(count);
  let tail = 0;
  const visit = (i: number) => {
    if (!exterior[i] && !closed[i]) { exterior[i] = 1; queue[tail++] = i; }
  };
  for (const i of border) visit(i);
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i + width < count) visit(i + width);
  }
  // Closing can add tiny background-colored slivers on the outer side of a
  // curved outline. Trim those from the exterior, without traversing into the
  // enclosed interior (which would reopen the repaired contour gaps).
  const trim = (i: number) => {
    if (!exterior[i] && closed[i] && !edges[i]) { exterior[i] = 1; queue[tail++] = i; }
  };
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const x = i % width;
    if (x > 0) trim(i - 1);
    if (x < width - 1) trim(i + 1);
    if (i >= width) trim(i - width);
    if (i + width < count) trim(i + width);
  }
  for (let i = 0; i < count; i++) {
    if (exterior[i] && !edges[i]) output[i * 4 + 3] = 0;
  }
  return output;
}

export type BrushMode = 'restore' | 'erase';
export type Point = { x: number; y: number };

// Restore samples the original RGBA; it never substitutes a guessed fill color.
export function paintMask(pixels: Uint8ClampedArray, original: Uint8ClampedArray, width: number, height: number, from: Point, to: Point, radius: number, mode: BrushMode) {
  const left = Math.max(0, Math.floor(Math.min(from.x, to.x) - radius));
  const top = Math.max(0, Math.floor(Math.min(from.y, to.y) - radius));
  const right = Math.min(width - 1, Math.ceil(Math.max(from.x, to.x) + radius));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(from.y, to.y) + radius));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const projection = lengthSquared ? Math.max(0, Math.min(1, ((x - from.x) * dx + (y - from.y) * dy) / lengthSquared)) : 0;
      if ((x - from.x - projection * dx) ** 2 + (y - from.y - projection * dy) ** 2 > radius * radius) continue;
      const i = (y * width + x) * 4;
      if (mode === 'erase') pixels[i + 3] = 0;
      else pixels.set(original.subarray(i, i + 4), i);
    }
  }
}
