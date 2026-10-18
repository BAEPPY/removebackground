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

export type CharacterRegions = { foreground: Uint8Array; barriers: Uint8Array };

function floodExterior(barriers: Uint8Array, width: number, height: number, border: number[]) {
  const exterior = new Uint8Array(barriers.length);
  const queue = new Uint32Array(barriers.length);
  let tail = 0;
  const visit = (i: number) => {
    if (!exterior[i] && !barriers[i]) { exterior[i] = 1; queue[tail++] = i; }
  };
  for (const i of border) visit(i);
  for (let head = 0; head < tail; head++) {
    const i = queue[head]; const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i + width < width * height) visit(i + width);
  }
  return { exterior, queue, tail };
}

// Try the smallest repair first. Eye/mouth holes alone must not count as a
// recovered body: the old fixed 1px radius left larger broken contours open.
export function characterRegions(pixels: Uint8ClampedArray, width: number, height: number, hint?: Point): CharacterRegions | null {
  if (pixels.length !== width * height * 4 || width < 1 || height < 1) throw new Error('이미지 크기를 확인할 수 없어요.');
  const border = borderIndices(width, height);
  const background = backdrop(pixels, border);
  // An already-transparent illustration keeps its existing holes and soft alpha.
  if (!background) return null;

  const count = width * height;
  const edges = new Uint8Array(count);
  let left = width; let right = -1; let top = height; let bottom = -1;
  for (let i = 0; i < count; i++) {
    const offset = i * 4;
    edges[i] = Number(pixels[offset + 3] > 15 && background.some((value, channel) => Math.abs(pixels[offset + channel] - value) > 24));
    if (edges[i]) { const x = i % width; const y = Math.floor(i / width); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  const shortSide = Math.max(1, Math.min(right - left + 1, bottom - top + 1));
  const limit = Math.min(64, Math.max(1, Math.ceil(shortSide * (hint ? .16 : .09))));
  let closed = edges;
  let flooded: ReturnType<typeof floodExterior>;
  const seed = hint ? Math.max(0, Math.min(height - 1, Math.floor(hint.y))) * width + Math.max(0, Math.min(width - 1, Math.floor(hint.x))) : -1;
  for (let radius = 1; ; radius = hint ? Math.min(limit, Math.ceil(radius * 1.6)) : limit) {
    closed = filterMask(edges, width, height, radius, true, true);
    closed = filterMask(closed, width, height, radius, true, false);
    closed = filterMask(closed, width, height, radius, false, true);
    closed = filterMask(closed, width, height, radius, false, false);
    flooded = floodExterior(closed, width, height, border);
    let enclosed = 0;
    for (let i = 0; i < count; i++) if (!closed[i] && !flooded.exterior[i]) enclosed++;
    // Once a larger repair is necessary, use the drawing-relative limit.
    // Stopping at the first small enclosure can mistake cheek/eye marks for
    // the outer contour and leave one side of a broken face transparent.
    const recovered = hint ? !closed[seed] && !flooded.exterior[seed] : radius === 1 && enclosed >= (right - left + 1) * (bottom - top + 1) * .2;
    if (recovered || radius === limit) break;
  }
  const { exterior, queue } = flooded;
  // Divide newly bridged pixels between the nearest interior and exterior.
  // Flooding them only from outside used to cut deep into white fur whenever
  // a wider gap repair also joined nearby cheek/eye marks to the outline.
  const ownership = new Uint8Array(count);
  let tail = 0;
  for (let i = 0; i < count; i++) {
    if (!closed[i]) { ownership[i] = exterior[i] ? 1 : 2; queue[tail++] = i; }
  }
  const extend = (i: number, owner: number) => {
    if (!ownership[i] && !edges[i]) { ownership[i] = owner; queue[tail++] = i; }
  };
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const x = i % width;
    if (x > 0) extend(i - 1, ownership[i]);
    if (x < width - 1) extend(i + 1, ownership[i]);
    if (i >= width) extend(i - width, ownership[i]);
    if (i + width < count) extend(i + width, ownership[i]);
  }
  const foreground = new Uint8Array(count);
  for (let i = 0; i < count; i++) foreground[i] = Number(ownership[i] !== 1);
  return { foreground, barriers: closed };
}

export function removeCharacterBackground(pixels: Uint8ClampedArray, width: number, height: number) {
  const regions = characterRegions(pixels, width, height);
  const output = pixels.slice();
  if (regions) for (let i = 0; i < regions.foreground.length; i++) if (!regions.foreground[i]) output[i * 4 + 3] = 0;
  return output;
}

export type BrushMode = 'restore' | 'erase';
export type Point = { x: number; y: number };
