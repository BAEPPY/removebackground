import { describe, expect, it } from 'vitest';
import { removeCharacterBackground } from './character';
import { analyzeRepair, smartRepair as repairStroke } from './smartRepair';
import type { BrushMode, CharacterRegions, Point } from './character';

const smartRepair = (original: Uint8ClampedArray, current: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, point: Point, mode: BrushMode, regions: CharacterRegions | null) => repairStroke(original, current, width, height, { points: [point], radius: 3, mode }, regions);

function brokenCharacter(scale = 1) {
  const width = 128 * scale; const height = width;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x / scale; const py = y / scale;
    const distance = Math.hypot(px - 64, py - 67);
    // Two 12–14px breaks in a rounded, 3px outline, unlike the old 2px box test.
    if (distance >= 41 && distance <= 44 && !(px < 30 && py > 59 && py < 73) && !(py < 30 && px > 55 && px < 67)) pixels.set([25, 25, 25, 255], (y * width + x) * 4);
    for (const cx of [48, 79]) {
      const eye = Math.hypot(px - cx, py - 55);
      if (eye >= 5 && eye <= 8) pixels.set([25, 25, 25, 255], (y * width + x) * 4);
    }
    if (px >= 56 && px <= 73 && py >= 79 && py <= 91) pixels.set([25, 25, 25, 255], (y * width + x) * 4);
    if (px >= 60 && px <= 68 && py >= 80 && py <= 85) pixels.set([255, 255, 255, 255], (y * width + x) * 4);
    if (Math.hypot(px - 38, py - 73) < 5) pixels.set([255, 197, 206, 255], (y * width + x) * 4);
  }
  const alpha = (data: Uint8ClampedArray, x: number, y: number) => data[((y * scale) * width + x * scale) * 4 + 3];
  return { pixels, width, height, alpha };
}

describe('broken character contours', () => {
  for (const scale of [1, 2, 4]) it(`recovers a white face with two large breaks at ${128 * scale}px`, () => {
    const { pixels, width, height, alpha } = brokenCharacter(scale);
    const cutout = removeCharacterBackground(pixels, width, height);
    for (const [x, y] of [[64, 67], [35, 67], [48, 55], [64, 82], [38, 73]]) expect(alpha(cutout, x, y), `${x},${y}`).toBe(255);
    for (const [x, y] of [[2, 2], [12, 67], [64, 14], [112, 67], [64, 117]]) expect(alpha(cutout, x, y), `${x},${y}`).toBe(0);
  });
});

describe('region hints', () => {
  it('a keep hint repairs a larger opening and stays protected during subsequent exterior cleanup', () => {
    const width = 80; const height = 80;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 15; y <= 64; y++) for (let x = 15; x <= 64; x++) {
      if ((x === 15 || x === 64 || y === 15 || y === 64) && !(x === 15 && y >= 34 && y <= 47)) pixels.set([20, 20, 20, 255], (y * width + x) * 4);
    }
    const cutout = removeCharacterBackground(pixels, width, height);
    expect(cutout[(40 * width + 40) * 4 + 3]).toBe(0);
    const kept = smartRepair(pixels, cutout, width, height, { x: 40, y: 40 }, 'restore', analyzeRepair(pixels, width, height));
    expect(kept.pixels[(40 * width + 40) * 4 + 3]).toBe(255);
    const spilled = kept.pixels.slice();
    for (let y = 30; y < 50; y++) for (let x = 0; x < 30; x++) spilled[(y * width + x) * 4 + 3] = 255;
    const cleaned = smartRepair(pixels, spilled, width, height, { x: 4, y: 40 }, 'erase', kept.regions);
    expect(cleaned.pixels[(40 * width + 40) * 4 + 3]).toBe(255);
    expect(cleaned.pixels[(40 * width + 4) * 4 + 3]).toBe(0);
  });
  it('one keep hint restores the entire face, eyes and teeth without restoring external white', () => {
    const { pixels, width, height, alpha } = brokenCharacter();
    const damaged = pixels.slice();
    for (let i = 0; i < damaged.length; i += 4) if (damaged[i] > 240) damaged[i + 3] = 0;
    const repaired = smartRepair(pixels, damaged, width, height, { x: 64, y: 67 }, 'restore', analyzeRepair(pixels, width, height));
    expect(repaired.changed).toBeGreaterThan(3000);
    for (const [x, y] of [[64, 67], [35, 67], [48, 55], [79, 55], [64, 82], [38, 73]]) expect(alpha(repaired.pixels, x, y)).toBe(255);
    for (const [x, y] of [[2, 2], [12, 67], [112, 67], [64, 117]]) expect(alpha(repaired.pixels, x, y)).toBe(0);
  });
  it('one exterior erase hint removes a broad white spill without touching the white body', () => {
    const { pixels, width, height } = brokenCharacter();
    const cutout = removeCharacterBackground(pixels, width, height);
    const spilled = cutout.slice();
    for (let y = 50; y < 120; y++) for (let x = 5; x < 75; x++) spilled.set(pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (y * width + x) * 4);
    const repaired = smartRepair(pixels, spilled, width, height, { x: 12, y: 80 }, 'erase', analyzeRepair(pixels, width, height));
    expect(repaired.changed).toBeGreaterThan(1000);
    expect(repaired.pixels).toEqual(cutout);
    expect(spilled).not.toEqual(cutout); // no mutation; undo retains the previous mask
  });
  it('a keep hint outside the automatic silhouette is honored locally without filling the whole canvas', () => {
    const { pixels, width, height } = brokenCharacter();
    const cutout = removeCharacterBackground(pixels, width, height);
    const repaired = smartRepair(pixels, cutout, width, height, { x: 2, y: 2 }, 'restore', analyzeRepair(pixels, width, height));
    expect(repaired.changed).toBeGreaterThan(0);
    expect(repaired.changed).toBeLessThan(200);
    expect(repaired.pixels[(2 * width + 2) * 4 + 3]).toBe(255);
    expect(repaired.pixels[(2 * width + 120) * 4 + 3]).toBe(0);
  });
  it('erasing an enclosed white region leaves other enclosed regions and the outline intact', () => {
    const { pixels, width, height, alpha } = brokenCharacter();
    const cutout = removeCharacterBackground(pixels, width, height);
    const repaired = smartRepair(pixels, cutout, width, height, { x: 48, y: 55 }, 'erase', analyzeRepair(pixels, width, height));
    expect(alpha(repaired.pixels, 48, 55)).toBe(0);
    expect(alpha(repaired.pixels, 79, 55)).toBe(255);
    expect(alpha(repaired.pixels, 64, 67)).toBe(255);
    expect(alpha(repaired.pixels, 41, 55)).toBe(255);
  });
  it('restores original RGB and soft alpha and never fills original transparent holes', () => {
    const { pixels, width, height, alpha } = brokenCharacter();
    pixels.set([245, 250, 255, 90], (67 * width + 64) * 4);
    pixels.set([0, 0, 0, 0], (68 * width + 64) * 4);
    const damaged = pixels.slice();
    for (let i = 3; i < damaged.length; i += 4) damaged[i] = 0;
    const repaired = smartRepair(pixels, damaged, width, height, { x: 60, y: 67 }, 'restore', analyzeRepair(pixels, width, height));
    expect([...repaired.pixels.slice((67 * width + 64) * 4, (67 * width + 64) * 4 + 4)]).toEqual([245, 250, 255, 90]);
    expect(alpha(repaired.pixels, 64, 68)).toBe(0);
  });
  it('on multicolor photos, color-connected repair stops at a contrasting source boundary', () => {
    const width = 40; const height = 40;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) pixels.set(i % width < 20 ? [220, 40, 40, 255] : [40, 100, 220, 255], i * 4);
    const damaged = pixels.slice();
    for (let i = 3; i < damaged.length; i += 4) damaged[i] = 0;
    const analysis = analyzeRepair(pixels, width, height);
    expect(analysis).toBeNull();
    const repaired = smartRepair(pixels, damaged, width, height, { x: 10, y: 20 }, 'restore', analysis);
    expect(repaired.changed).toBeGreaterThan(50);
    expect(repaired.pixels[(20 * width + 10) * 4 + 3]).toBe(255);
    expect(repaired.pixels[(20 * width + 30) * 4 + 3]).toBe(0);
  });
});
