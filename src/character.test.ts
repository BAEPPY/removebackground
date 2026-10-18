import { describe, expect, it } from 'vitest';
import { removeCharacterBackground } from './character';

function drawing() {
  const width = 64; const height = 64;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const pixel = (x: number, y: number, rgba: number[]) => pixels.set(rgba, (y * width + x) * 4);
  const box = (left: number, top: number, right: number, bottom: number, color = [20, 20, 20, 255]) => {
    for (let x = left; x <= right; x++) { pixel(x, top, color); pixel(x, bottom, color); }
    for (let y = top; y <= bottom; y++) { pixel(left, y, color); pixel(right, y, color); }
  };
  box(12, 12, 51, 51); // white fur inside a dark silhouette
  box(20, 21, 27, 28); // white eye
  box(35, 21, 42, 28); // white eye
  box(25, 35, 38, 44); // white mouth / teeth
  pixel(18, 34, [255, 197, 206, 255]); // pink skin
  pixel(44, 34, [202, 233, 244, 255]); // pale blue fur
  return { pixels, width, height, pixel, box };
}
const rgba = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => [...pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];

describe('outline-aware character protection', () => {
  it('removes exterior white while preserving white fur, eyes, mouth, teeth, and skin', () => {
    const image = drawing();
    const result = removeCharacterBackground(image.pixels, image.width, image.height);
    expect(rgba(result, 64, 1, 1)[3]).toBe(0);
    expect(rgba(result, 64, 10, 30)[3]).toBe(0);
    for (const [x, y] of [[15, 15], [23, 24], [38, 24], [30, 39]]) {
      expect(rgba(result, 64, x, y)).toEqual([255, 255, 255, 255]);
    }
    expect(rgba(result, 64, 18, 34)).toEqual([255, 197, 206, 255]);
    expect(rgba(result, 64, 44, 34)).toEqual([202, 233, 244, 255]);
    expect(image.pixels.every((value, index) => index % 4 !== 3 || value === 255)).toBe(true);
  });
  it('bridges a small break in the outer line without erasing the white body', () => {
    const image = drawing();
    image.pixel(31, 12, [255, 255, 255, 255]);
    image.pixel(32, 12, [255, 255, 255, 255]);
    const result = removeCharacterBackground(image.pixels, 64, 64);
    expect(rgba(result, 64, 31, 16)[3]).toBe(255);
    expect(rgba(result, 64, 1, 1)[3]).toBe(0);
  });
  it('keeps a wide exterior channel between separate body parts transparent', () => {
    const image = drawing();
    image.box(2, 20, 6, 45);
    const result = removeCharacterBackground(image.pixels, 64, 64);
    expect(rgba(result, 64, 9, 30)[3]).toBe(0);
    expect(rgba(result, 64, 4, 30)[3]).toBe(255);
  });
  it('trims background slivers along an outer curved outline', () => {
    const size = 128;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - 64, y - 64);
      if (distance >= 38 && distance <= 41) pixels.set([20, 20, 20, 255], (y * size + x) * 4);
    }
    const result = removeCharacterBackground(pixels, size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (Math.hypot(x - 64, y - 64) > 41) expect(result[(y * size + x) * 4 + 3]).toBe(0);
    }
    expect(rgba(result, size, 64, 64)).toEqual([255, 255, 255, 255]);
  });
  it('preserves original transparency, including holes inside the character', () => {
    const image = drawing();
    image.pixel(30, 30, [255, 255, 255, 0]);
    image.pixel(31, 30, [255, 255, 255, 90]);
    const result = removeCharacterBackground(image.pixels, 64, 64);
    expect(rgba(result, 64, 30, 30)[3]).toBe(0);
    expect(rgba(result, 64, 31, 30)[3]).toBe(90);
  });
  it('does not infer opaque background from an already transparent border', () => {
    const image = drawing();
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (x < 12 || x > 51 || y < 12 || y > 51) image.pixel(x, y, [0, 0, 0, 0]);
    expect(removeCharacterBackground(image.pixels, 64, 64)).toEqual(image.pixels);
  });
  it('handles JPEG-like near-white variations in an otherwise solid background', () => {
    const image = drawing();
    image.pixel(2, 2, [245, 247, 248, 255]);
    image.pixel(15, 15, [245, 247, 248, 255]);
    const result = removeCharacterBackground(image.pixels, 64, 64);
    expect(rgba(result, 64, 2, 2)[3]).toBe(0);
    expect(rgba(result, 64, 15, 15)).toEqual([245, 247, 248, 255]);
  });
  it('rejects a multicolor perimeter instead of silently stripping a guessed color', () => {
    const pixels = new Uint8ClampedArray(40 * 40 * 4);
    for (let i = 0; i < 1600; i++) pixels.set(i % 40 < 20 ? [220, 40, 40, 255] : [40, 100, 220, 255], i * 4);
    expect(() => removeCharacterBackground(pixels, 40, 40)).toThrow(/사진 AI/);
  });
});
