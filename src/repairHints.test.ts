import { describe, expect, it } from 'vitest';
import { emptyRepairState, nextStroke, type RepairStroke } from './repairHints';
import { analyzeRepair, smartRepair } from './smartRepair';

function openDrawing(size = 96) {
  const source = new Uint8ClampedArray(size * size * 4).fill(255);
  // An L-shaped contour, open on two entire sides. No morphological closure
  // can infer a closed white body from this shape.
  for (let y = 20; y < 76; y++) for (let x = 20; x < 76; x++) {
    if (x < 23 || y > 72) source.set([25, 25, 25, 255], (y * size + x) * 4);
  }
  const cutout = source.slice();
  for (let i = 0; i < size * size; i++) if (cutout[i * 4] === 255) cutout[i * 4 + 3] = 0;
  const alpha = (pixels: Uint8ClampedArray, x: number, y: number) => pixels[(y * size + x) * 4 + 3];
  return { source, cutout, size, alpha, analysis: analyzeRepair(source, size, size) };
}
const keep = (x: number, y: number): RepairStroke => ({ points: [{ x, y }], radius: 3, mode: 'restore' });

describe('user corrections override automatic segmentation', () => {
  it('restores an explicitly marked open region instead of requiring a closed contour', () => {
    const { source, cutout, size, alpha, analysis } = openDrawing();
    expect(analysis?.foreground[45 * size + 50]).toBe(0);
    const result = smartRepair(source, cutout, size, size, keep(50, 45), analysis);
    expect(result.changed).toBeGreaterThan(50);
    expect(alpha(result.pixels, 50, 45)).toBe(255);
    expect(alpha(result.pixels, 53, 45)).toBe(255);
    expect(alpha(result.pixels, 92, 92)).toBe(0);
    expect(result.message).not.toMatch(/닫힌 윤곽|이미 선택/);
  });
  it('uses the middle and end of a stroke even when its first point is already opaque', () => {
    const { source, cutout, size, alpha, analysis } = openDrawing();
    cutout[(45 * size + 32) * 4 + 3] = 255;
    const result = smartRepair(source, cutout, size, size, { ...keep(32, 45), points: [{ x: 32, y: 45 }, { x: 68, y: 45 }] }, analysis);
    for (let x = 32; x <= 68; x++) expect(alpha(result.pixels, x, 45), `path ${x}`).toBe(255);
    expect(alpha(result.pixels, 92, 92)).toBe(0);
  });
  it('repeated overlapping hints change additional pixels each time, including across serialized sessions', () => {
    const { source, cutout, size, alpha, analysis } = openDrawing();
    let result = smartRepair(source, cutout, size, size, keep(50, 45), analysis);
    expect(alpha(result.pixels, 60, 45)).toBe(0);
    for (let attempt = 0; attempt < 3; attempt++) {
      const previousReach = result.state.strokes.at(-1)!.reach!;
      const previousAlpha = result.pixels.filter((_, index) => index % 4 === 3).reduce((total, alpha) => total + alpha, 0);
      // Worker -> App -> reopened Worker carries only cloneable memory.
      const state = structuredClone(result.state);
      result = smartRepair(source, result.pixels, size, size, keep(50, 45), result.regions, state);
      expect(result.changed).toBeGreaterThan(0);
      expect(result.state.strokes.at(-1)!.reach).toBeGreaterThan(previousReach);
      expect(result.pixels.filter((_, index) => index % 4 === 3).reduce((total, alpha) => total + alpha, 0)).toBeGreaterThan(previousAlpha);
    }
    expect(alpha(result.pixels, 60, 45)).toBe(255);
    expect(alpha(result.pixels, 92, 92)).toBe(0);
  });
  it('erase strokes also use their entire path and can override an earlier keep', () => {
    const { source, cutout, size, alpha, analysis } = openDrawing();
    const restored = smartRepair(source, cutout, size, size, { ...keep(35, 45), points: [{ x: 35, y: 45 }, { x: 65, y: 45 }] }, analysis);
    const erased = smartRepair(source, restored.pixels, size, size, { points: [{ x: 30, y: 35 }, { x: 65, y: 45 }], radius: 3, mode: 'erase' }, restored.regions, restored.state);
    expect(alpha(erased.pixels, 65, 45)).toBe(0);
    expect(alpha(erased.pixels, 40, 49)).toBe(255);
    const restoredAgain = smartRepair(source, erased.pixels, size, size, keep(65, 45), erased.regions, erased.state);
    expect(alpha(restoredAgain.pixels, 65, 45)).toBe(255);
  });
  it('automatic exterior cleanup respects a previously corrected open foreground area', () => {
    const { source, cutout, size, alpha, analysis } = openDrawing();
    const restored = smartRepair(source, cutout, size, size, keep(50, 45), analysis);
    const spilled = restored.pixels.slice(); spilled[(8 * size + 8) * 4 + 3] = 255;
    // Simulate applying and reopening, where source topology is recomputed.
    const erased = smartRepair(source, spilled, size, size, { ...keep(8, 8), mode: 'erase' }, analyzeRepair(source, size, size), restored.state);
    expect(alpha(erased.pixels, 8, 8)).toBe(0);
    expect(alpha(erased.pixels, 50, 45)).toBe(255);
    expect(alpha(erased.pixels, 53, 45)).toBe(255);
  });
  it('growth follows color edges rather than crossing an unmarked dark contour', () => {
    const { source, cutout, size, alpha, analysis } = openDrawing();
    const result = smartRepair(source, cutout, size, size, { ...keep(30, 45), radius: 10 }, analysis);
    expect(alpha(result.pixels, 25, 45)).toBe(255);
    expect(alpha(result.pixels, 16, 45)).toBe(0);
    expect(alpha(result.pixels, 21, 45)).toBe(255);
  });
  it('restores source colors and alpha rather than inventing colors in source-transparent pixels', () => {
    const { source, cutout, size, alpha, analysis } = openDrawing();
    source.set([250, 245, 230, 90], (45 * size + 50) * 4);
    source.set([0, 0, 0, 0], (45 * size + 52) * 4);
    const result = smartRepair(source, cutout, size, size, keep(50, 45), analysis);
    expect([...result.pixels.slice((45 * size + 50) * 4, (45 * size + 50) * 4 + 4)]).toEqual([250, 245, 230, 90]);
    expect(alpha(result.pixels, 52, 45)).toBe(0);
  });
  it('does not escalate unrelated strokes and rolls retry strength back with undo state', () => {
    const initial = emptyRepairState(96, 96);
    const first = nextStroke(keep(30, 30), initial, 96, 96);
    const afterFirst = { ...initial, strokes: [first] };
    const repeat = nextStroke(keep(30, 30), afterFirst, 96, 96);
    expect(repeat.reach).toBeGreaterThan(first.reach!);
    expect(nextStroke(keep(80, 80), afterFirst, 96, 96).reach).toBe(first.reach);
    expect(nextStroke(keep(30, 30), initial, 96, 96).reach).toBe(first.reach);
    const opposite = { ...repeat, mode: 'erase' as const };
    expect(nextStroke(keep(30, 30), { ...initial, strokes: [first, opposite] }, 96, 96).reach).toBe(first.reach);
  });
  it('keeps a long full-resolution stroke continuous through the bounded analysis grid', () => {
    const size = 1024;
    const source = new Uint8ClampedArray(size * size * 4).fill(255);
    const cutout = source.slice();
    for (let i = 3; i < cutout.length; i += 4) cutout[i] = 0;
    const result = smartRepair(source, cutout, size, size, { points: [{ x: 20, y: 20 }, { x: 1000, y: 1000 }], radius: 8, mode: 'restore' }, null);
    for (let i = 20; i <= 1000; i++) expect(result.pixels[(i * size + i) * 4 + 3], `${i}`).toBe(255);
    expect(result.pixels[(50 * size + 900) * 4 + 3]).toBe(0);
  });
  it('honors explicitly marked one-pixel features even when the analysis grid misses their source color', () => {
    const size = 1024;
    const source = new Uint8ClampedArray(size * size * 4);
    for (let x = 20; x <= 1000; x++) source.set([220, 150, 180, 255], (431 * size + x) * 4);
    const cutout = new Uint8ClampedArray(source.length);
    const result = smartRepair(source, cutout, size, size, { points: [{ x: 20, y: 431 }, { x: 1000, y: 431 }], radius: 8, mode: 'restore' }, null);
    for (let x = 20; x <= 1000; x++) expect([...result.pixels.slice((431 * size + x) * 4, (431 * size + x) * 4 + 4)]).toEqual([220, 150, 180, 255]);
    expect(result.pixels[(430 * size + 500) * 4 + 3]).toBe(0);
  });
});
