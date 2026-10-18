import { describe, expect, it } from 'vitest';
import { refineEdges } from './edgeMatte';
import { removeCharacterBackground } from './character';
import { transparentPalette } from './media';
import { analyzeRepair, smartRepair } from './smartRepair';

function mattedEdge(background = [255, 255, 255], foreground = [20, 20, 20]) {
  const width = 32; const height = 24;
  const original = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) original.set([...background, 255], i * 4);
  for (let y = 5; y <= 18; y++) for (let x = 8; x <= 22; x++) {
    const alpha = x === 8 ? .2 : x === 9 ? .6 : 1;
    original.set([...foreground.map((v, c) => Math.round(v * alpha + background[c] * (1 - alpha))), 255], (y * width + x) * 4);
  }
  return { original, width, height, mask: removeCharacterBackground(original, width, height) };
}
const rgba = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => [...pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];

describe('foreground color recovery at transparent edges', () => {
  it('removes the white matte around a black edge without changing its appearance over white', () => {
    const { original, mask, width, height } = mattedEdge();
    const result = refineEdges(original, mask, width, height);
    for (const [x, expectedAlpha] of [[8, 51], [9, 153]]) {
      const pixel = rgba(result, width, x, 12);
      expect(pixel.slice(0, 3)).toEqual([20, 20, 20]);
      expect(pixel[3]).toBe(expectedAlpha);
      const overBlack = pixel[0] * pixel[3] / 255;
      expect(overBlack).toBeLessThan(15);
      const overWhite = overBlack + 255 - pixel[3];
      expect(overWhite).toBeCloseTo(original[(12 * width + x) * 4], 0);
    }
    expect(rgba(result, width, 10, 12)).toEqual([20, 20, 20, 255]);
    expect(rgba(result, width, 1, 1)).toEqual([0, 0, 0, 0]);
    expect(rgba(mask, width, 8, 12)).toEqual([208, 208, 208, 255]); // no input mutation
  });
  it('also handles a known colored matte and a colored foreground without desaturating it', () => {
    const { original, mask, width, height } = mattedEdge([245, 235, 220], [30, 60, 90]);
    const result = refineEdges(original, mask, width, height);
    expect(rgba(result, width, 8, 12)).toEqual([30, 60, 90, 51]);
    expect(rgba(result, width, 9, 12)).toEqual([30, 60, 90, 153]);
  });
  it('keeps genuine white fur, eye whites, teeth, and pale colors including at the boundary', () => {
    const { original, mask, width, height } = mattedEdge();
    for (const [x, y, rgb] of [[12, 6, [255, 255, 255]], [15, 12, [255, 255, 255]], [19, 16, [202, 233, 244]], [17, 14, [255, 197, 206]]] as const) {
      original.set([...rgb, 255], (y * width + x) * 4); mask.set([...rgb, 255], (y * width + x) * 4);
    }
    const result = refineEdges(original, mask, width, height);
    for (const [x, y] of [[12, 6], [15, 12], [19, 16], [17, 14]]) expect(rgba(result, width, x, y)).toEqual(rgba(original, width, x, y));
  });
  it('does not multiply a photo AI soft alpha by the estimated coverage again', () => {
    const { original, mask, width, height } = mattedEdge();
    mask[(12 * width + 9) * 4 + 3] = 100;
    const result = refineEdges(original, mask, width, height);
    expect(rgba(result, width, 9, 12)).toEqual([20, 20, 20, 100]);
  });
  it('does not repeatedly darken or erode an edge when editing and reopening', () => {
    const { original, mask, width, height } = mattedEdge();
    const once = refineEdges(original, mask, width, height);
    expect(refineEdges(original, once, width, height)).toEqual(once);
    expect(refineEdges(original, refineEdges(original, once, width, height), width, height)).toEqual(once);
  });
  it('cleans white-matted colors restored by a correction stroke before they are exported', () => {
    const { original, mask, width, height } = mattedEdge();
    const damaged = mask.slice(); damaged[(12 * width + 8) * 4 + 3] = 0;
    const repaired = smartRepair(original, damaged, width, height, { points: [{ x: 8, y: 12 }], radius: 1, mode: 'restore' }, analyzeRepair(original, width, height));
    const result = refineEdges(original, repaired.pixels, width, height);
    expect(rgba(result, width, 8, 12)).toEqual([20, 20, 20, 51]);
  });
  it('keeps existing source transparency and clean soft edges without guessing a background', () => {
    const width = 16; const height = 16;
    const original = new Uint8ClampedArray(width * height * 4);
    original.set([20, 20, 20, 80], (8 * width + 8) * 4);
    original.set([255, 255, 255, 180], (8 * width + 9) * 4);
    expect(refineEdges(original, original, width, height)).toEqual(original);
  });
  it('does not apply matte removal to an unknown multicolor background', () => {
    const { original, mask, width, height } = mattedEdge();
    for (let y = 0; y < height; y++) for (let x = 0; x < width / 2; x++) if (!mask[(y * width + x) * 4 + 3]) original.set([150, 40, 30, 255], (y * width + x) * 4);
    const result = refineEdges(original, mask, width, height);
    expect(rgba(result, width, 8, 12)).toEqual([208, 208, 208, 255]);
  });
  it('gives GIF quantization dark foreground RGB rather than a white fringe', () => {
    const { original, mask, width, height } = mattedEdge();
    const { palette, indices } = transparentPalette(refineEdges(original, mask, width, height));
    expect(indices[12 * width + 8]).toBe(0);
    expect(palette[indices[12 * width + 9]]).toEqual([20, 20, 20]);
    expect(indices[12 * width + 10]).not.toBe(0);
  });
});
