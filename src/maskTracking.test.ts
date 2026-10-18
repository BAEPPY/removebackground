import { describe, expect, it } from 'vitest';
import { KEYFRAME_INTERVAL, trackMask } from './maskTracking';

const width = 128; const height = 72;
function fixture(dx = 0, dy = 0) {
  const source = new Uint8ClampedArray(width * height * 4).fill(255);
  const mask = new Uint8ClampedArray(source.length);
  for (let y = 20; y <= 44; y++) for (let x = 30; x <= 54; x++) {
    const i = ((y + dy) * width + x + dx) * 4;
    const rgb = x === 30 || x === 54 || y === 20 || y === 44 ? [12, 12, 12] : x < 42 ? [255, 255, 255] : [202, 233, 244];
    source.set([...rgb, 255], i); mask.set([...rgb, x === 30 ? 150 : 255], i);
  }
  return { source, mask };
}

describe('conservative GIF mask tracking', () => {
  it('moves white interiors and antialiased outlines with the actual subject', () => {
    const key = fixture(); const next = fixture(5, -3);
    const tracked = trackMask(key.source, key.mask, next.source, width, height)!;
    expect(tracked).not.toBeNull(); expect([tracked.dx, tracked.dy]).toEqual([5, -3]);
    expect(tracked.pixels).toEqual(next.mask);
    expect(tracked.pixels[((25 - 3) * width + 35 + 5) * 4 + 3]).toBe(255);
  });
  it('requests new analysis for a one-pixel new feature, deformations or a scene cut', () => {
    const key = fixture(); const next = fixture(3);
    next.source.set([0, 0, 0, 255], (30 * width + 42) * 4);
    expect(trackMask(key.source, key.mask, next.source, width, height)).toBeNull();
    next.source.fill(0);
    expect(trackMask(key.source, key.mask, next.source, width, height)).toBeNull();
  });
  it('does not shift masks through a changing or textured background', () => {
    const key = fixture(); const next = fixture(4);
    key.source.set([0, 0, 0, 255], (6 * width + 6) * 4);
    next.source.set([0, 0, 0, 255], (6 * width + 6) * 4);
    expect(trackMask(key.source, key.mask, next.source, width, height)).toBeNull();
  });
  it('uses three keyframes for thirty simple translations without compounding alpha', () => {
    let key = fixture(); let index = 0; let calls = 0;
    for (let frame = 0; frame < 30; frame++) {
      const next = fixture(frame);
      const tracked = frame && frame - index < KEYFRAME_INTERVAL ? trackMask(key.source, key.mask, next.source, width, height) : null;
      if (!tracked) { key = next; index = frame; calls++; }
      else expect(tracked.pixels).toEqual(next.mask);
    }
    expect(calls).toBe(3);
  });
});
