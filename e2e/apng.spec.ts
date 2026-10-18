import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

function chunks(bytes: Buffer) {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const result: { type: string; data: Buffer }[] = [];
  for (let i = 8; i + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(i); result.push({ type: bytes.toString('ascii', i + 4, i + 8), data: bytes.subarray(i + 8, i + 8 + size) });
    // Validate each CRC, including the animation control and sequence fields.
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(i + 4, i + 8 + size)) {
      crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    expect((crc ^ 0xffffffff) >>> 0).toBe(bytes.readUInt32BE(i + size + 8)); i += size + 12;
  }
  return result;
}

test('animated PNG keeps soft alpha, frame timing and loop count before and after GIF edits', async ({ page }) => {
  const encoder = GIFEncoder();
  for (const shift of [0, 3]) {
    const pixels = new Uint8ClampedArray(32 * 24 * 4).fill(255);
    for (let y = 5; y <= 18; y++) for (let x = 8 + shift; x <= 22 + shift; x++) {
      const c = x === 8 + shift ? 208 : x === 9 + shift ? 114 : 20; pixels.set([c, c, c, 255], (y * 32 + x) * 4);
    }
    const palette = quantize(pixels, 256); encoder.writeFrame(applyPalette(pixels, palette), 32, 24, { palette, delay: shift ? 170 : 50, repeat: 2 });
  }
  encoder.finish();
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'smooth.gif', mimeType: 'image/gif', buffer: Buffer.from(encoder.bytes()) });
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  const save = async (name: string) => {
    const event = page.waitForEvent('download'); await page.getByRole('link', { name: '부드러운 APNG 다운로드' }).click();
    const download = await event; expect(download.suggestedFilename()).toBe('smooth-off-smooth.png');
    await download.saveAs(`artifacts/${name}.png`); return readFile(`artifacts/${name}.png`);
  };
  const validate = (bytes: Buffer) => {
    const parts = chunks(bytes); const control = parts.find(c => c.type === 'acTL')!.data;
    expect(control.readUInt32BE(0)).toBe(2); expect(control.readUInt32BE(4)).toBe(3); // initial play + 2 repeats
    const frames = parts.filter(c => c.type === 'fcTL');
    expect(frames.map(f => f.data.readUInt16BE(20) / f.data.readUInt16BE(22))).toEqual([.05, .17]);
    const sequence = parts.filter(c => c.type === 'fdAT' || c.type === 'fcTL').map(c => c.data.readUInt32BE(0));
    expect(sequence).toEqual(sequence.map((_, i) => i));
    expect(frames.every(f => f.data[25] === 0)).toBe(true);
  };
  const bytes = await save('smooth-animation'); validate(bytes);
  const edge = async (data: Buffer) => page.evaluate(async base64 => {
    const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' });
    const image = await createImageBitmap(blob); const c = new OffscreenCanvas(32, 24); const ctx = c.getContext('2d')!;
    ctx.drawImage(image, 0, 0); image.close(); return [...ctx.getImageData(8, 12, 2, 1).data];
  }, data.toString('base64'));
  expect(await edge(bytes)).toEqual([20, 20, 20, 51, 20, 20, 20, 153]); // GIF stores this same pixel as fully opaque
  await page.getByRole('button', { name: '대략 표시해서 자동 보정' }).click();
  await expect(page.getByRole('button', { name: '편집 적용' })).toBeEnabled();
  await page.getByRole('button', { name: '편집 적용' }).click();
  const edited = await save('smooth-animation-edited'); validate(edited);
  expect(await edge(edited)).toEqual(await edge(bytes));
});
