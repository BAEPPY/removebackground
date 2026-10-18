import type { RepairState, RepairStroke } from './repairHints';
import { strokeDistance } from './repairHints';

export function correctionBounds(stroke: RepairStroke, width: number, height: number) {
  const margin = Math.max(stroke.radius * 4, stroke.reach ?? 0, Math.min(width, height) * .08);
  return { left: Math.max(0, Math.floor(Math.min(...stroke.points.map(p => p.x)) - margin)), top: Math.max(0, Math.floor(Math.min(...stroke.points.map(p => p.y)) - margin)), right: Math.min(width - 1, Math.ceil(Math.max(...stroke.points.map(p => p.x)) + margin)), bottom: Math.min(height - 1, Math.ceil(Math.max(...stroke.points.map(p => p.y)) + margin)) };
}

// Use AI only to estimate alpha: generated RGB must never replace real facial
// features, colors or lettering. Local changes cannot affect unrelated areas.
export function applyAIMask(original: Uint8ClampedArray, mask: Uint8ClampedArray, width: number, height: number, current?: Uint8ClampedArray, stroke?: RepairStroke) {
  if (original.length !== width * height * 4 || mask.length !== original.length || (current && current.length !== original.length)) throw new Error('AI 결과 크기가 맞지 않아요.');
  let transparent = 0; let solid = 0;
  for (let p = 3; p < mask.length; p += 4) { if (mask[p] < 128) transparent++; else solid++; }
  if (!transparent || !solid) throw new Error('AI가 유효한 투명 윤곽을 반환하지 않았어요. 결과를 적용하지 않았습니다.');
  const output = current ? current.slice() : original.slice();
  const bounds = stroke ? correctionBounds(stroke, width, height) : { left: 0, top: 0, right: width - 1, bottom: height - 1 };
  for (let y = bounds.top; y <= bounds.bottom; y++) for (let x = bounds.left; x <= bounds.right; x++) {
    const i = (y * width + x) * 4;
    let alpha = Math.min(original[i + 3], mask[i + 3]);
    if (current && stroke) {
      alpha = stroke.mode === 'restore' ? Math.max(current[i + 3], alpha) : Math.min(current[i + 3], alpha);
      const blend = Math.min(1, (Math.min(x - bounds.left, bounds.right - x, y - bounds.top, bounds.bottom - y) + 1) / 3);
      alpha = Math.round(current[i + 3] + (alpha - current[i + 3]) * blend);
      if (strokeDistance({ x, y }, stroke.points) <= stroke.radius) alpha = stroke.mode === 'restore' ? original[i + 3] : 0;
    }
    output.set(original.subarray(i, i + 3), i); output[i + 3] = alpha;
    if (!alpha) output.fill(0, i, i + 4);
  }
  return output;
}

export function rememberAIMask(before: Uint8ClampedArray, after: Uint8ClampedArray, state: RepairState, stroke: RepairStroke): RepairState {
  const labels = state.labels.slice();
  for (let i = 0; i < labels.length; i++) if (before[i * 4 + 3] !== after[i * 4 + 3]) labels[i] = stroke.mode === 'restore' ? 1 : -1;
  return { labels, strokes: state.strokes.at(-1) === stroke ? state.strokes : [...state.strokes, stroke] };
}
