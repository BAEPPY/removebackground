import { characterRegions, type BrushMode, type CharacterRegions, type Point } from './character';

function component(seed: number, width: number, height: number, accepts: (index: number) => boolean) {
  const selected = new Uint8Array(width * height);
  const queue = new Uint32Array(selected.length);
  let tail = 0;
  const visit = (i: number) => { if (!selected[i] && accepts(i)) { selected[i] = 1; queue[tail++] = i; } };
  visit(seed);
  for (let head = 0; head < tail; head++) {
    const i = queue[head]; const x = i % width;
    if (x > 0) visit(i - 1);
    if (x + 1 < width) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i + width < selected.length) visit(i + width);
  }
  return selected;
}

export function analyzeRepair(original: Uint8ClampedArray, width: number, height: number) {
  try { return characterRegions(original, width, height); }
  catch { return null; } // Photos use a local color/edge region instead of a guessed backdrop.
}

// A stroke is a region hint. Its first point anchors the selection; later mouse
// movement and the visible stroke width cannot paint across the source contour.
export function smartRepair(original: Uint8ClampedArray, current: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, point: Point, mode: BrushMode, analysis: CharacterRegions | null) {
  if (original.length !== width * height * 4 || current.length !== original.length) throw new Error('이미지 크기가 맞지 않아요.');
  const x = Math.max(0, Math.min(width - 1, Math.floor(point.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(point.y)));
  const seed = y * width + x;
  let regions = analysis;
  if (mode === 'restore' && original[seed * 4 + 3] === 0) {
    return { pixels: current, changed: 0, regions, message: '이 부분은 원본에서도 투명해요. 원래 색이 남아 있는 부분을 표시해 주세요.' };
  }
  if (mode === 'restore' && regions && !regions.foreground[seed]) {
    // A keep hint permits bridging a larger gap, but only when it actually
    // encloses the indicated point. It never restores the exterior wholesale.
    const hinted = characterRegions(original, width, height, { x, y });
    if (hinted?.foreground[seed]) regions = hinted;
    else return { pixels: current, changed: 0, regions, message: '이곳에서는 닫힌 윤곽을 찾지 못했어요. 남길 부분의 안쪽을 한 번 눌러 주세요.' };
  }
  let selected: Uint8Array;
  let message: string;
  if (regions && mode === 'restore') {
    const foreground = regions.foreground;
    selected = component(seed, width, height, (i) => !!foreground[i]);
    message = '같은 윤곽 안의 털·눈·입을 원본으로 복원했어요.';
  } else if (regions && !regions.foreground[seed]) {
    const foreground = regions.foreground;
    selected = component(seed, width, height, (i) => !foreground[i]);
    message = '윤곽 밖에 남은 배경을 정리했어요.';
  } else {
    const offset = seed * 4;
    const barriers = regions?.barriers;
    const inOpenRegion = barriers && !barriers[seed];
    selected = component(seed, width, height, (i) => {
      if (inOpenRegion && barriers[i]) return false;
      if (original[i * 4 + 3] === 0) return false;
      return [0, 1, 2].every((c) => Math.abs(original[i * 4 + c] - original[offset + c]) <= 36);
    });
    message = mode === 'restore' ? '비슷한 색이 이어진 영역을 원본으로 복원했어요.' : '표시한 곳과 색이 이어진 영역을 지웠어요.';
  }
  const pixels = current.slice();
  let changed = 0;
  for (let i = 0; i < selected.length; i++) {
    if (!selected[i]) continue;
    const offset = i * 4;
    const alpha = mode === 'restore' ? original[offset + 3] : 0;
    if (pixels[offset + 3] !== alpha) changed++;
    if (mode === 'restore') pixels.set(original.subarray(offset, offset + 4), offset);
    else pixels[offset + 3] = 0;
  }
  return { pixels, changed, regions, message: changed ? message : '이 영역은 이미 선택한 상태예요. 다른 부분도 눌러 확인할 수 있어요.' };
}
