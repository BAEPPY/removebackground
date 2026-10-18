import { characterRegions, type CharacterRegions } from './character';
import { emptyRepairState, growStroke, nextStroke, type RepairState, type RepairStroke } from './repairHints';

function component(seeds: number[], width: number, height: number, accepts: (index: number) => boolean) {
  const selected = new Uint8Array(width * height);
  const queue = new Uint32Array(selected.length);
  let tail = 0;
  const visit = (i: number) => { if (!selected[i] && accepts(i)) { selected[i] = 1; queue[tail++] = i; } };
  for (const seed of seeds) visit(seed);
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
  catch { return null; }
}

// The topology is a proposal, never a veto on user corrections. Keep the full
// path, use bounded edge-aware growth on open regions, and remember corrections
// so a later automatic selection cannot silently undo an earlier keep/erase.
export function smartRepair(original: Uint8ClampedArray, current: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, input: RepairStroke, analysis: CharacterRegions | null, state: RepairState = emptyRepairState(width, height)) {
  if (original.length !== width * height * 4 || current.length !== original.length || state.labels.length !== width * height) throw new Error('이미지 크기가 맞지 않아요.');
  let stroke = nextStroke(input, state, width, height);
  const seeds = stroke.points.map((p) => Math.floor(p.y) * width + Math.floor(p.x));
  let regions = analysis;
  if (stroke.mode === 'restore' && regions && !regions.foreground[seeds[0]]) {
    const hinted = characterRegions(original, width, height, stroke.points[0]);
    if (hinted?.foreground[seeds[0]]) regions = hinted;
  }
  let automatic = new Uint8Array(width * height);
  if (regions && stroke.mode === 'restore') {
    const foreground = regions.foreground;
    automatic = component(seeds, width, height, (i) => !!foreground[i]);
  } else if (regions) {
    const foreground = regions.foreground;
    const outside = seeds.filter((i) => !foreground[i]);
    if (outside.length) automatic = component(outside, width, height, (i) => !foreground[i]);
    else {
      const seed = seeds[0];
      const barriers = regions.barriers;
      // An enclosed white hole can still be cleared in one click. A mark on
      // the outline itself is handled locally rather than erasing all ink.
      if (!barriers[seed]) automatic = component([seed], width, height, (i) => !barriers[i] && original[i * 4 + 3] > 0 && [0, 1, 2].every((c) => Math.abs(original[i * 4 + c] - original[seed * 4 + c]) <= 36));
    }
  }
  const sign = stroke.mode === 'restore' ? 1 : -1;
  const pixels = current.slice();
  const labels = state.labels.slice();
  let changed = 0;
  function apply(i: number, remember = true) {
    const offset = i * 4;
    const alpha = sign === 1 ? original[offset + 3] : 0;
    if (pixels[offset + 3] !== alpha) changed++;
    if (sign === 1) {
      pixels[offset] = original[offset]; pixels[offset + 1] = original[offset + 1]; pixels[offset + 2] = original[offset + 2];
    }
    pixels[offset + 3] = alpha;
    if (remember) labels[i] = sign;
  }
  for (let i = 0; i < automatic.length; i++) if (automatic[i] && state.labels[i] !== -sign) apply(i, false);
  // The analysis grid is only a boundary suggestion. Enforce the indicated
  // path at original resolution too, so thin features cannot disappear during
  // downsampling and a prior mask can never veto an explicit correction.
  for (let p = 0; p < stroke.points.length; p++) {
    const a = stroke.points[Math.max(0, p - 1)]; const b = stroke.points[p];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
    for (let step = 0; step <= steps; step++) {
      const x = Math.floor(a.x + (b.x - a.x) * step / steps);
      const y = Math.floor(a.y + (b.y - a.y) * step / steps);
      const i = y * width + x;
      if (original[i * 4 + 3]) apply(i);
    }
  }
  // If the first proposal changed nothing, try wider local neighborhoods in
  // this same request. Subsequent overlapping strokes continue from that reach.
  for (let attempt = 0; attempt < 3; attempt++) {
    const grown = growStroke(original, width, height, stroke);
    for (let y = grown.top; y <= grown.bottom; y++) for (let x = grown.left; x <= grown.right; x++) {
      const i = y * width + x;
      const cell = Math.min(Math.ceil((grown.bottom - grown.top + 1) / grown.scale) - 1, Math.floor((y - grown.top) / grown.scale)) * grown.columns + Math.min(grown.columns - 1, Math.floor((x - grown.left) / grown.scale));
      if (grown.distance[cell] > grown.budget || !original[i * 4 + 3]) continue;
      // The latest local correction wins, even over an earlier opposite hint.
      // Only the broader automatic proposal is constrained by old decisions.
      apply(i);
    }
    if (changed || attempt === 2 || stroke.reach! >= Math.hypot(width, height)) break;
    stroke = { ...stroke, reach: Math.min(Math.hypot(width, height), stroke.reach! + stroke.radius * 2) };
  }
  const sourceExists = seeds.some((i) => original[i * 4 + 3] > 0);
  const message = changed
    ? `${stroke.mode === 'restore' ? '복원' : '지우기'} 표시 전체와 주변을 ${state.strokes.length ? '다시 ' : ''}보정했어요. 더 표시하면 이어서 반영해요.`
    : !sourceExists && sign === 1 ? '표시한 곳은 원본부터 투명해서 복원할 색이 없어요. 원본 색이 있는 부분까지 이어서 표시해 주세요.'
    : '주변까지 다시 계산했지만 바뀐 투명도는 없어요. 표시는 기억하고 다음 보정에서 범위를 더 넓혀요.';
  return { pixels, changed, regions, state: { ...state, labels, strokes: [...state.strokes, stroke] }, message };
}
