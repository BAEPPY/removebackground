import { expect, test, type Page } from '@playwright/test';
import gifenc from 'gifenc';
import gifuct from 'gifuct-js';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const { decompressFrames, parseGIF } = gifuct;

async function uploadCharacter(page: Page) {
  const png = await page.evaluate(() => {
    const surface = document.createElement('canvas'); surface.width = 128; surface.height = 128;
    const ctx = surface.getContext('2d')!;
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = '#202020'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(64, 68, 44, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    for (const x of [49, 79]) { ctx.beginPath(); ctx.arc(x, 59, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = '#202020'; ctx.fillRect(55, 80, 18, 10);
    ctx.fillStyle = 'white'; ctx.fillRect(60, 81, 7, 5);
    ctx.fillStyle = '#ffc5ce'; ctx.beginPath(); ctx.arc(36, 74, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#cae9f4'; ctx.beginPath(); ctx.arc(64, 23, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    return surface.toDataURL('image/png').split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'white-character.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  await expect(page.getByRole('button', { name: '투명 PNG 다운로드' })).toBeVisible();
}

async function resultPixel(page: Page, x: number, y: number) {
  return page.evaluate(async ({ x, y }) => {
    const image = document.querySelector<HTMLImageElement>('img[alt="배경을 제거한 결과"]')!;
    await image.decode();
    const surface = document.createElement('canvas'); surface.width = image.naturalWidth; surface.height = image.naturalHeight;
    const context = surface.getContext('2d')!; context.drawImage(image, 0, 0);
    return [...context.getImageData(x, y, 1, 1).data];
  }, { x, y });
}

test('real worker preserves white character features and removes only the exterior', async ({ page }) => {
  const modelRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('staticimgly.com')) modelRequests.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '캐릭터 보호', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await uploadCharacter(page);
  expect(await resultPixel(page, 5, 5)).toEqual([0, 0, 0, 0]);
  expect(await resultPixel(page, 64, 68)).toEqual([255, 255, 255, 255]);
  expect(await resultPixel(page, 49, 59)).toEqual([255, 255, 255, 255]);
  expect(await resultPixel(page, 63, 83)).toEqual([255, 255, 255, 255]);
  expect(await resultPixel(page, 36, 74)).toEqual([255, 197, 206, 255]);
  expect(await resultPixel(page, 64, 23)).toEqual([202, 233, 244, 255]);
  expect(modelRequests).toEqual([]);
  await page.getByRole('button', { name: '다크 배경으로 미리보기' }).click();
  await page.screenshot({ path: 'artifacts/character-protection.png', fullPage: true });
});

test('real PNG editor erases, undoes, restores source pixels, cancels and downloads edits', async ({ page }) => {
  await page.goto('/'); await uploadCharacter(page);
  const open = page.getByRole('button', { name: '지워진 부분 복원 / 직접 지우기' });
  await open.click();
  const editor = page.getByRole('dialog');
  const canvas = editor.locator('canvas');
  await expect(editor.getByRole('button', { name: '편집 적용' })).toBeEnabled();
  await editor.getByRole('slider', { name: '브러시 크기' }).fill('8');
  await editor.getByRole('button', { name: '지우기', exact: true }).click();
  await canvas.click({ position: { x: 64, y: 68 } });
  const alpha = () => canvas.evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(64, 68, 1, 1).data[3]);
  expect(await alpha()).toBe(0);
  await editor.getByRole('button', { name: '되돌리기' }).click();
  expect(await alpha()).toBe(255);
  await canvas.click({ position: { x: 64, y: 68 } });
  await editor.getByRole('button', { name: '편집 적용' }).click();
  await expect(editor).toHaveCount(0);
  expect((await resultPixel(page, 64, 68))[3]).toBe(0);
  await open.click();
  await expect(editor.getByRole('button', { name: '편집 적용' })).toBeEnabled();
  await canvas.click({ position: { x: 64, y: 68 } });
  await editor.getByRole('button', { name: '편집 적용' }).click();
  await expect(editor).toHaveCount(0);
  expect(await resultPixel(page, 64, 68)).toEqual([255, 255, 255, 255]);
  await open.click();
  await expect(editor.getByRole('button', { name: '편집 적용' })).toBeEnabled();
  await editor.getByRole('button', { name: '지우기', exact: true }).click();
  await canvas.click({ position: { x: 64, y: 68 } });
  await editor.getByRole('button', { name: '취소', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await resultPixel(page, 64, 68)).toEqual([255, 255, 255, 255]);
  const promise = page.waitForEvent('download');
  await page.getByRole('button', { name: '투명 PNG 다운로드' }).click();
  expect((await promise).suggestedFilename()).toBe('white-character-off.png');
});

test('real GIF processing protects moving white interiors in every frame', async ({ page }) => {
  const encoder = GIFEncoder();
  for (const shift of [0, 4]) {
    const pixels = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    for (let y = 15; y <= 48; y++) for (let x = 16 + shift; x <= 44 + shift; x++) {
      if (y === 15 || y === 48 || x === 16 + shift || x === 44 + shift) pixels.set([10, 10, 10, 255], (y * 64 + x) * 4);
    }
    const palette = quantize(pixels, 256);
    encoder.writeFrame(applyPalette(pixels, palette), 64, 64, { palette, delay: shift ? 120 : 40, repeat: 2 });
  }
  encoder.finish();
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'white-character.gif', mimeType: 'image/gif', buffer: Buffer.from(encoder.bytes()) });
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  await expect(page.getByRole('button', { name: '투명 GIF 다운로드' })).toBeVisible();
  const bytes = await page.evaluate(async () => {
    const url = document.querySelector<HTMLImageElement>('img[alt="배경을 제거한 결과"]')!.src;
    return [...new Uint8Array(await (await fetch(url)).arrayBuffer())];
  });
  const gif = parseGIF(new Uint8Array(bytes).buffer);
  const frames = decompressFrames(gif, true);
  expect(frames).toHaveLength(2);
  expect(frames.map((frame) => frame.delay)).toEqual([40, 120]);
  frames.forEach((frame, index) => {
    expect(frame.patch[3]).toBe(0);
    const position = (30 * 64 + 30 + index * 4) * 4;
    expect([...frame.patch.slice(position, position + 4)]).toEqual([255, 255, 255, 255]);
  });
  await expect(page.getByRole('button', { name: '지워진 부분 복원 / 직접 지우기' })).toHaveCount(0);
});
