import { describe, expect, it } from 'vitest';
import { tidyContour } from './contour';

function fixture() {
  const width = 24; const height = 24;
  const original = new Uint8ClampedArray(width * height * 4).fill(255);
  const mask = new Uint8ClampedArray(original.length);
  for (let y = 6; y <= 17; y++) for (let x = 6; x <= 17; x++) mask.set([255, 255, 255, 255], (y * width + x) * 4);
  return { width, height, original, mask };
}
const at = (pixels: Uint8ClampedArray, x: number, y: number) => [...pixels.slice((y * 24 + x) * 4, (y * 24 + x) * 4 + 4)];

describe('contour cleanup', () => {
  it('softens opaque staircase corners without shrinking straight edges or white interiors', () => {
    const { original, mask, width, height } = fixture();
    const cleaned = tidyContour(original, mask, width, height);
    expect(at(cleaned, 6, 6)[3]).toBeGreaterThanOrEqual(128); expect(at(cleaned, 6, 6)[3]).toBeLessThan(255);
    expect(at(cleaned, 6, 10)).toEqual([255, 255, 255, 255]);
    expect(at(cleaned, 12, 12)).toEqual([255, 255, 255, 255]);
    expect(at(cleaned, 5, 5)[3]).toBe(0);
    expect(tidyContour(original, cleaned, width, height)).toEqual(cleaned);
  });
  it('removes tiny detached backdrop speckles while preserving dark whiskers and colored details', () => {
    const { original, mask, width, height } = fixture();
    mask.set([255, 255, 255, 255], (3 * width + 3) * 4);
    for (const [x, rgb] of [[10, [20, 20, 20]], [18, [202, 233, 244]]] as const) {
      original.set([...rgb, 255], (3 * width + x) * 4); mask.set([...rgb, 255], (3 * width + x) * 4);
    }
    const cleaned = tidyContour(original, mask, width, height);
    expect(at(cleaned, 3, 3)).toEqual([0, 0, 0, 0]);
    expect(at(cleaned, 10, 3)).toEqual([20, 20, 20, 255]);
    expect(at(cleaned, 18, 3)).toEqual([202, 233, 244, 255]);
  });
  it('keeps a deliberately restored tiny white region and existing soft edges', () => {
    const { original, mask, width, height } = fixture(); const protect = new Int8Array(width * height);
    mask.set([255, 255, 255, 255], (3 * width + 3) * 4); protect[3 * width + 3] = 1;
    mask[(6 * width + 6) * 4 + 3] = 80;
    const cleaned = tidyContour(original, mask, width, height, protect);
    expect(at(cleaned, 3, 3)[3]).toBe(255); expect(at(cleaned, 6, 6)[3]).toBe(80);
  });
});
