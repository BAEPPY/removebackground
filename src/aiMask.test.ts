import { describe, expect, it } from 'vitest';
import { applyAIMask, rememberAIMask } from './aiMask';

describe('AI alpha with original subject pixels', () => {
  it('remembers AI changes on every targeted frame without mutating undo history', () => {
    const before = new Uint8ClampedArray([255, 255, 255, 0, 20, 20, 20, 255]);
    const after = before.slice(); after[3] = 255;
    const state = { labels: new Int8Array([0, -1]), strokes: [] };
    const hint = { points: [{ x: 0, y: 0 }], radius: 1, mode: 'restore' as const };
    const remembered = rememberAIMask(before, after, state, hint);
    expect([...remembered.labels]).toEqual([1, -1]); expect(remembered.strokes).toEqual([hint]);
    expect([...state.labels]).toEqual([0, -1]); expect(state.strokes).toEqual([]);
  });
  const width = 40; const height = 32;
  function fixture() {
    const source = new Uint8ClampedArray(width * height * 4); const mask = source.slice();
    for (let i = 0; i < width * height; i++) { source.set([202, 233, 244, 255], i * 4); mask.set([255, 0, 0, i % width < 20 ? 255 : 0], i * 4); }
    return { source, mask };
  }
  it('ignores generated colors and preserves original alpha', () => {
    const { source, mask } = fixture(); source[3] = 90;
    const output = applyAIMask(source, mask, width, height);
    expect([...output.slice(0, 4)]).toEqual([202, 233, 244, 90]);
    expect([...output.slice(4, 8)]).toEqual([202, 233, 244, 255]);
    expect([...output.slice(25 * 4, 26 * 4)]).toEqual([0, 0, 0, 0]);
  });
  it('rejects missing transparency and fully empty masks instead of silently returning an unchanged image', () => {
    const { source, mask } = fixture();
    expect(() => applyAIMask(source, source, width, height)).toThrow(/유효한/);
    mask.fill(0); expect(() => applyAIMask(source, mask, width, height)).toThrow(/유효한/);
  });
  it('limits region corrections, honors rough marks and supports opposite-direction updates', () => {
    const { source, mask } = fixture(); const current = new Uint8ClampedArray(source.length);
    const hint = { points: [{ x: 25, y: 16 }], radius: 2, mode: 'restore' as const };
    const restored = applyAIMask(source, mask, width, height, current, hint);
    const marked = (16 * width + 25) * 4;
    expect([...restored.slice(marked, marked + 4)]).toEqual([202, 233, 244, 255]);
    expect(restored[3]).toBe(0); // unmarked, distant foreground from AI is ignored
    const erased = applyAIMask(source, mask, width, height, restored, { ...hint, mode: 'erase' });
    expect(erased[marked + 3]).toBe(0);
  });
});
