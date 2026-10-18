import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import gifenc from 'gifenc';
import gifuct from 'gifuct-js';
const { GIFEncoder, quantize, applyPalette } = gifenc;
const { parseGIF, decompressFrames } = gifuct;

function movingGif() {
  const encoder = GIFEncoder();
  for (let frame = 0; frame < 30; frame++) {
    const pixels = new Uint8ClampedArray(128 * 72 * 4).fill(255);
    for (let y = 20; y <= 44; y++) for (let x = 30; x <= 54; x++) {
      const rgb = x === 30 || x === 54 || y === 20 || y === 44 ? [12, 12, 12] : x < 42 ? [255, 255, 255] : [202, 233, 244];
      pixels.set([...rgb, 255], (y * 128 + x + frame) * 4);
    }
    const palette = quantize(pixels, 256);
    encoder.writeFrame(applyPalette(pixels, palette), 128, 72, { palette, delay: frame % 2 ? 120 : 40, repeat: 2 });
  }
  encoder.finish(); return Buffer.from(encoder.bytes());
}

test('GIF savings reduces 30 calls to 3, preserves every moving white interior, and reuses successful requests across workers', async ({ page }) => {
  test.setTimeout(90_000);
  let calls = 0;
  await page.goto('/');
  await page.route('**/api/background', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: { configured: true } }); return; }
    calls++;
    const body = route.request().postDataJSON();
    // A deterministic AI stand-in returning a correct mask, with deliberately
    // wrong RGB. The real workers, tracker, cache and encoders are exercised.
    const output = await page.evaluate(async (source: string) => {
      const img = new Image(); img.src = source; await img.decode();
      const c = document.createElement('canvas'); c.width = c.height = 1024;
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, 1024, 1024).data;
      let left = 1024; let right = 0; let top = 1024; let bottom = 0;
      for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
        const i = (y * 1024 + x) * 4;
        if (pixels[i + 3] && pixels[i] < 50) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
      }
      ctx.clearRect(0, 0, 1024, 1024); ctx.fillStyle = 'red'; ctx.fillRect(left, top, right - left + 1, bottom - top + 1);
      return c.toDataURL().split(',')[1];
    }, body.images[0]);
    await route.fulfill({ contentType: 'image/png', body: Buffer.from(output, 'base64') });
  });
  await page.getByRole('button', { name: 'GPT AI', exact: true }).click();
  await page.getByLabel('개인용 비밀번호', { exact: true }).fill('personal-password-123');
  const file = { name: 'moving.gif', mimeType: 'image/gif', buffer: movingGif() };
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByRole('checkbox', { name: /GIF 절약 처리/ })).toBeChecked();
  await expect(page.getByText(/이번 배경 제거: API 최대 30회/)).toBeVisible();
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  await expect(page.locator('.api-summary')).toContainText('새 API 3회');
  await expect(page.locator('.api-summary')).toContainText('움직임 추적 27프레임');
  expect(calls).toBe(3);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '투명 GIF 다운로드' }).click();
  const fileResult = await download; await fileResult.saveAs('artifacts/savings-moving.gif');
  const gif = parseGIF(Uint8Array.from(await readFile('artifacts/savings-moving.gif')).buffer);
  const frames = decompressFrames(gif, true); expect(frames).toHaveLength(30);
  for (let f = 0; f < frames.length; f++) {
    expect(frames[f].delay).toBe(f % 2 ? 120 : 40);
    const inside = (30 * 128 + 35 + f) * 4;
    expect([...frames[f].patch.slice(inside, inside + 4)]).toEqual([255, 255, 255, 255]);
    expect(frames[f].patch[(30 * 128 + 26 + f) * 4 + 3]).toBe(0);
  }
  await page.getByRole('button', { name: '대략 표시해서 자동 보정' }).click();
  const editor = page.getByRole('dialog'); await expect(editor.getByRole('button', { name: '편집 적용' })).toBeEnabled();
  await editor.getByRole('slider', { name: 'GIF 편집 프레임' }).fill('29');
  await expect(editor.getByRole('slider', { name: 'GIF 편집 프레임' })).toHaveValue('29');
  await expect(editor.getByRole('button', { name: '편집 적용' })).toBeEnabled();
  await page.screenshot({ path: 'artifacts/savings-gif-editor.png', fullPage: true });
  await editor.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '사진 AI', exact: true }).click();
  await page.getByRole('button', { name: 'GPT AI', exact: true }).click();
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  await expect(page.locator('.api-summary')).toContainText('새 API 0회');
  await expect(page.locator('.api-summary')).toContainText('저장된 결과 3회');
  expect(calls).toBe(3);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/savings-mobile.png', fullPage: true });
});
