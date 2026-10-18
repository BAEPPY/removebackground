import { describe, expect, it } from 'vitest';
import { decompressFrames, parseGIF, type ParsedFrame, type ParsedGif } from 'gifuct-js';
import { GIFEncoder } from 'gifenc';
import { createCompositor, downloadName, fitSize, MAX_BYTES, preserveAlpha, readRepeat, transparentPalette, validateFile } from './media';

const frame = (pixels: number[], left = 0, disposalType = 1, transparentIndex?: number): ParsedFrame => ({
  dims: { left, top: 0, width: pixels.length / 4, height: 1 }, patch: new Uint8ClampedArray(pixels),
  delay: 40, disposalType, colorTable: [], pixels: [], transparentIndex: transparentIndex as number,
});
const red = [255, 0, 0, 255];
const blue = [0, 0, 255, 255];
const empty = [0, 0, 0, 0];

describe('GIF frame reconstruction', () => {
  it('retains previous pixels under transparent pixels and honors frame offsets', () => {
    const composite = createCompositor(3, 1, empty);
    composite(frame([...red, ...red, ...red]));
    expect([...composite(frame([...empty, ...blue], 1))]).toEqual([...red, ...red, ...blue]);
  });
  it('clears the previous frame rectangle for disposal 2', () => {
    const composite = createCompositor(3, 1, empty);
    composite(frame([...red, ...red, ...red]));
    composite(frame(blue, 1, 2, 0));
    expect([...composite(frame(blue, 2))]).toEqual([...red, ...empty, ...blue]);
  });
  it('restores the logical background for opaque disposal 2', () => {
    const white = [255, 255, 255, 255];
    const composite = createCompositor(2, 1, white);
    composite(frame(red, 0, 2));
    expect([...composite(frame(blue, 1))]).toEqual([...white, ...blue]);
  });
  it('restores the canvas before a disposal 3 frame', () => {
    const composite = createCompositor(3, 1, empty);
    composite(frame([...red, ...red, ...red]));
    composite(frame(blue, 1, 3));
    expect([...composite(frame(blue, 2))]).toEqual([...red, ...red, ...blue]);
  });
  it('round-trips alpha, opaque black, delay, frame count, and finite repeats', () => {
    const encoder = GIFEncoder();
    for (const delay of [30, 170]) {
      const { palette, indices } = transparentPalette(new Uint8ClampedArray([...empty, 0, 0, 0, 255, ...red]));
      encoder.writeFrame(indices, 3, 1, { palette, transparent: true, transparentIndex: 0, delay, repeat: 3, dispose: 2 });
    }
    encoder.finish();
    const gif = parseGIF(encoder.bytes().buffer as ArrayBuffer);
    const decoded = decompressFrames(gif, true);
    expect(decoded).toHaveLength(2);
    expect(decoded.map((f) => f.delay)).toEqual([30, 170]);
    expect(decoded.map((f) => f.disposalType)).toEqual([2, 2]);
    expect(decoded[0].patch[3]).toBe(0);
    expect([...decoded[0].patch.slice(4, 8)]).toEqual([0, 0, 0, 255]);
    expect(readRepeat(gif)).toBe(3);
  });
  it('keeps a non-looping GIF non-looping', () => {
    expect(readRepeat({ frames: [] } as unknown as ParsedGif)).toBe(-1);
  });
});

describe('input and output constraints', () => {
  it('never restores pixels that were already transparent', () => {
    const output = new Uint8ClampedArray([...red, ...blue, 0, 0, 0, 80]);
    const original = new Uint8ClampedArray([...empty, 0, 0, 255, 128, ...red]);
    expect([...preserveAlpha(output, original)]).toEqual([255, 0, 0, 0, 0, 0, 255, 128, 0, 0, 0, 80]);
  });
  it('rejects unsupported, empty and oversized uploads', () => {
    expect(validateFile({ name: 'a.svg', type: 'image/svg+xml', size: 10 })).toBeTruthy();
    expect(validateFile({ name: 'a.png', type: 'image/png', size: MAX_BYTES + 1 })).toBeTruthy();
    expect(validateFile({ name: 'a.jpg', type: 'image/jpeg', size: 0 })).toBeTruthy();
    expect(validateFile({ name: 'a.GIF', type: '', size: 42 })).toBeNull();
  });
  it('downscales proportionally without upscaling', () => {
    expect(fitSize(4000, 2000, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(fitSize(640, 480, 768)).toEqual({ width: 640, height: 480 });
    expect(() => fitSize(10_000, 10_000, 2048)).toThrow();
  });
  it('preserves Korean names and sets the correct output extension', () => {
    expect(downloadName('나의.사진.JPG', false)).toBe('나의.사진-off.png');
    expect(downloadName('고양이.gif', true)).toBe('고양이-off.gif');
  });
});
