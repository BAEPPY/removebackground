import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import gifenc from 'gifenc';
import gifuct from 'gifuct-js';
const { GIFEncoder, quantize, applyPalette } = gifenc;
const { parseGIF, decompressFrames } = gifuct;

function mattedPixels() {
  const pixels = new Uint8ClampedArray(32 * 24 * 4).fill(255);
  for (let y = 5; y <= 18; y++) for (let x = 8; x <= 22; x++) {
    const c = x === 8 ? 208 : x === 9 ? 114 : 20;
    pixels.set([c, c, c, 255], (y * 32 + x) * 4);
  }
  // Genuine white and pale features inside the dark outline must survive.
  pixels.set([255, 255, 255, 255], (12 * 32 + 15) * 4);
  pixels.set([202, 233, 244, 255], (12 * 32 + 18) * 4);
  return pixels;
}
async function download(page: Page, path: string) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: /투명 (PNG|GIF) 다운로드/ }).click();
  await (await event).saveAs(path);
  return readFile(path);
}
async function pngRow(page: Page, bytes: Buffer) {
  return page.evaluate(async (base64) => {
    const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' });
    const image = await createImageBitmap(blob);
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); image.close();
    return [1, 8, 9, 10, 15, 18].map((x) => [...ctx.getImageData(x, 12, 1, 1).data]);
  }, bytes.toString('base64'));
}

test('downloaded PNG has clean dark edge RGB and retains white anatomy after editing', async ({ page }) => {
  await page.goto('/');
  const png = await page.evaluate((rgba) => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), 32, 24), 0, 0);
    return canvas.toDataURL().split(',')[1];
  }, [...mattedPixels()]);
  await page.locator('input[type=file]').setInputFiles({ name: 'matted.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  await expect(page.getByRole('button', { name: '투명 PNG 다운로드' })).toBeVisible();
  const bytes = await download(page, 'artifacts/edge-cleaned.png');
  const row = await pngRow(page, bytes);
  expect(row).toEqual([[0, 0, 0, 0], [20, 20, 20, 51], [20, 20, 20, 153], [20, 20, 20, 255], [255, 255, 255, 255], [202, 233, 244, 255]]);
  await page.getByRole('button', { name: '대략 표시해서 자동 보정' }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByRole('button', { name: '편집 적용' })).toBeEnabled();
  // A real restore stroke writes original matted colors back; the export must clean them again.
  const canvas = editor.locator('canvas'); const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 9 / 32, y: box.height * 12 / 24 } });
  await expect(editor.getByRole('button', { name: '되돌리기' })).toBeEnabled();
  await editor.getByRole('button', { name: '편집 적용' }).click();
  const after = await pngRow(page, await download(page, 'artifacts/edge-cleaned-edited.png'));
  // The interior second antialias pixel remains dark and semi-transparent after restoration.
  expect(after[2]).toEqual([20, 20, 20, 153]);
  expect(after[4]).toEqual([255, 255, 255, 255]);
  await page.getByRole('button', { name: '다크 배경으로 미리보기' }).click();
  await page.screenshot({ path: 'artifacts/edge-cleaned-download.png', fullPage: true });
});

test('downloaded GIF quantizes cleaned RGB, keeps opaque black and preserves timing', async ({ page }) => {
  const encoder = GIFEncoder();
  const pixels = mattedPixels(); const palette = quantize(pixels, 256);
  for (const delay of [50, 170]) encoder.writeFrame(applyPalette(pixels, palette), 32, 24, { palette, delay, repeat: 2 });
  encoder.finish();
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'matted.gif', mimeType: 'image/gif', buffer: Buffer.from(encoder.bytes()) });
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  await expect(page.getByRole('button', { name: '투명 GIF 다운로드' })).toBeVisible();
  const bytes = await download(page, 'artifacts/edge-cleaned.gif');
  const frames = decompressFrames(parseGIF(Uint8Array.from(bytes).buffer), true);
  expect(frames.map((f) => f.delay)).toEqual([50, 170]);
  for (const frame of frames) {
    const pixel = (x: number) => [...frame.patch.slice((12 * 32 + x) * 4, (12 * 32 + x) * 4 + 4)];
    expect(pixel(8)[3]).toBe(0); expect(pixel(9)).toEqual([20, 20, 20, 255]);
    expect(pixel(10)).toEqual([20, 20, 20, 255]); expect(pixel(15)).toEqual([255, 255, 255, 255]);
  }
});
