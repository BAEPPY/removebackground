import type { BrushMode, Point } from './character';

export type RepairStroke = { points: Point[]; radius: number; mode: BrushMode; reach?: number };
export type RepairState = { labels: Int8Array<ArrayBuffer>; strokes: RepairStroke[] };
export type RepairMemory = { labels: Blob; strokes: RepairStroke[] };

export function emptyRepairState(width: number, height: number): RepairState {
  return { labels: new Int8Array(width * height), strokes: [] };
}

export function strokeDistance(point: Point, points: Point[]) {
  let distance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)]; const b = points[i];
    const dx = b.x - a.x; const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
    distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  }
  return distance;
}

export function nextStroke(stroke: RepairStroke, state: RepairState, width: number, height: number): RepairStroke {
  const points = stroke.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => ({ x: Math.max(0, Math.min(width - 1, p.x)), y: Math.max(0, Math.min(height - 1, p.y)) }));
  if (!points.length) throw new Error('표시한 위치를 확인할 수 없어요.');
  const radius = Math.max(1, Math.min(Math.max(width, height), stroke.radius || 1));
  let reach = radius * 2;
  // The most recent nearby opposite hint resets escalation. Distant work must
  // not make an unrelated click more aggressive.
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const prior = state.strokes[i];
    if (!points.some((point) => strokeDistance(point, prior.points) <= Math.max(radius, prior.radius) * 2)) continue;
    if (prior.mode === stroke.mode) reach = Math.max(reach, (prior.reach ?? prior.radius * 2) + radius * 2);
    break;
  }
  return { points, radius, mode: stroke.mode, reach: Math.min(Math.hypot(width, height), reach) };
}

// A bounded geodesic brush: the whole path supplies seeds, color edges slow
// expansion, and an open contour cannot flood an entire same-colored canvas.
// Analyze at <=512px per side; final pixels always come from the full source.
export function growStroke(original: Uint8ClampedArray, width: number, height: number, stroke: RepairStroke) {
  const reach = stroke.reach ?? stroke.radius * 2;
  let left = width; let top = height; let right = 0; let bottom = 0;
  for (const p of stroke.points) { left = Math.min(left, p.x); right = Math.max(right, p.x); top = Math.min(top, p.y); bottom = Math.max(bottom, p.y); }
  left = Math.max(0, Math.floor(left - reach - 1)); top = Math.max(0, Math.floor(top - reach - 1));
  right = Math.min(width - 1, Math.ceil(right + reach + 1)); bottom = Math.min(height - 1, Math.ceil(bottom + reach + 1));
  const scale = Math.max(1, Math.max(right - left + 1, bottom - top + 1) / 512);
  const columns = Math.ceil((right - left + 1) / scale); const rows = Math.ceil((bottom - top + 1) / scale);
  const count = columns * rows;
  const distance = new Float32Array(count).fill(Infinity);
  const seeds = new Uint8Array(count);
  const colors = new Uint8Array(count * 4);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const source = (Math.min(height - 1, top + Math.floor((y + .5) * scale)) * width + Math.min(width - 1, left + Math.floor((x + .5) * scale))) * 4;
    colors.set(original.subarray(source, source + 4), (y * columns + x) * 4);
  }
  const heap: { index: number; cost: number }[] = [];
  function push(index: number, cost: number) {
    if (cost >= distance[index]) return;
    distance[index] = cost; cost = distance[index];
    const entry = { index, cost }; let i = heap.length; heap.push(entry);
    while (i > 0) { const parent = (i - 1) >> 1; if (heap[parent].cost <= cost) break; heap[i] = heap[parent]; i = parent; }
    heap[i] = entry;
  }
  function pop() {
    const first = heap[0]; const last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].cost < heap[child].cost) child++;
        if (heap[child].cost >= last.cost) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return first;
  }
  function seedPoint(p: Point) {
    const x = Math.max(0, Math.min(columns - 1, Math.floor((p.x - left) / scale)));
    const y = Math.max(0, Math.min(rows - 1, Math.floor((p.y - top) / scale)));
    const i = y * columns + x;
    // Source-transparent pixels cannot be reconstructed by changing a mask.
    if (colors[i * 4 + 3]) { seeds[i] = 1; push(i, 0); }
  }
  for (let i = 0; i < stroke.points.length; i++) {
    const a = stroke.points[Math.max(0, i - 1)]; const b = stroke.points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(.5, scale / 2)));
    for (let step = 0; step <= steps; step++) seedPoint({ x: a.x + (b.x - a.x) * step / steps, y: a.y + (b.y - a.y) * step / steps });
  }
  const budget = reach / scale;
  const visit = (from: number, to: number, step: number, cost: number) => {
    if (!colors[to * 4 + 3]) return;
    const contrast = Math.max(Math.abs(colors[from * 4] - colors[to * 4]), Math.abs(colors[from * 4 + 1] - colors[to * 4 + 1]), Math.abs(colors[from * 4 + 2] - colors[to * 4 + 2]));
    const next = cost + step * (1 + contrast / 20) + (contrast > 55 ? budget : 0);
    if (next <= budget) push(to, next);
  };
  while (heap.length) {
    const { index: i, cost } = pop();
    if (cost > distance[i]) continue;
    const x = i % columns; const y = Math.floor(i / columns);
    if (x) visit(i, i - 1, 1, cost);
    if (x + 1 < columns) visit(i, i + 1, 1, cost);
    if (y) visit(i, i - columns, 1, cost);
    if (y + 1 < rows) visit(i, i + columns, 1, cost);
    if (x && y) visit(i, i - columns - 1, Math.SQRT2, cost);
    if (x + 1 < columns && y) visit(i, i - columns + 1, Math.SQRT2, cost);
    if (x && y + 1 < rows) visit(i, i + columns - 1, Math.SQRT2, cost);
    if (x + 1 < columns && y + 1 < rows) visit(i, i + columns + 1, Math.SQRT2, cost);
  }
  return { left, top, right, bottom, columns, scale, distance, seeds, budget };
}
