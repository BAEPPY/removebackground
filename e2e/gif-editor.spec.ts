import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import gifenc from 'gifenc';
import gifuct from 'gifuct-js';
const { GIFEncoder, quantize, applyPalette } = gifenc;
const { parseGIF, decompressFrames } = gifuct;

async function downloadFrames(page: Page, name: string) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '투명 GIF 다운로드' }).click();
  const downloaded = await event; expect(downloaded.suggestedFilename()).toBe('moving-off.gif');
  const path = `artifacts/${name}.gif`; await downloaded.saveAs(path);
  const gif = parseGIF(Uint8Array.from(await readFile(path)).buffer);
  const loop = gif.frames.find((f) => 'application' in f && /NETSCAPE/.test(f.application.id));
  expect(loop && 'application' in loop ? [...loop.application.blocks.slice(0, 3)] : []).toEqual([1, 2, 0]);
  const frames = decompressFrames(gif, true);
  expect(frames.map((f) => f.delay)).toEqual([40, 120]);
  return frames.map((f) => [...f.patch.slice((30 * 64 + 30) * 4, (30 * 64 + 30) * 4 + 4)]);
}

test('GIF editor handles individual and all-frame marks, original view, preview, undo, cancel and actual downloads', async ({ page }) => {
  test.setTimeout(60_000);
  const encoder = GIFEncoder();
  for (const shift of [0, 8]) {
    const rgba = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    for (let y = 15; y <= 48; y++) for (let x = 16 + shift; x <= 44 + shift; x++) {
      if (y === 15 || y === 48 || x === 16 + shift || x === 44 + shift) rgba.set([10, 10, 10, 255], (y * 64 + x) * 4);
    }
    const palette = quantize(rgba, 256);
    encoder.writeFrame(applyPalette(rgba, palette), 64, 64, { palette, delay: shift ? 120 : 40, repeat: 2 });
  }
  encoder.finish();
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'moving.gif', mimeType: 'image/gif', buffer: Buffer.from(encoder.bytes()) });
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  const open = page.getByRole('button', { name: '대략 표시해서 자동 보정' });
  await open.click();
  const editor = page.getByRole('dialog'); const canvas = editor.locator('canvas');
  const apply = editor.getByRole('button', { name: '편집 적용' });
  const alpha = () => canvas.evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(30, 30, 1, 1).data[3]);
  const mark = async () => { const box = (await canvas.boundingBox())!; await canvas.click({ position: { x: box.width * 30 / 64, y: box.height * 30 / 64 } }); await expect(apply).toBeEnabled(); };
  const seek = async (index: number) => {
    await editor.getByRole('slider', { name: 'GIF 편집 프레임' }).fill(String(index));
    await expect(editor.getByRole('slider', { name: 'GIF 편집 프레임' })).toHaveValue(String(index));
    await expect(apply).toBeEnabled();
  };
  await expect(apply).toBeEnabled();
  await expect(editor.getByRole('combobox', { name: 'GIF 보정 적용 범위' })).toHaveValue('frame');
  await editor.getByRole('button', { name: '남은 배경 지우기' }).click(); await mark();
  await expect.poll(alpha).toBe(0);
  await seek(1); expect(await alpha()).toBe(255);
  await editor.getByRole('button', { name: '되돌리기' }).click(); await expect(apply).toBeEnabled();
  await seek(0); expect(await alpha()).toBe(255);
  await mark(); await expect.poll(alpha).toBe(0); await apply.click(); await expect(editor).toHaveCount(0);
  expect((await downloadFrames(page, 'gif-single-frame')).map((p) => p[3])).toEqual([0, 255]);

  await open.click(); await expect(apply).toBeEnabled();
  await editor.getByRole('button', { name: '남은 배경 지우기' }).click();
  await editor.getByRole('combobox', { name: 'GIF 보정 적용 범위' }).selectOption('all');
  await mark(); await seek(1); expect(await alpha()).toBe(0);
  await editor.getByRole('button', { name: '움직임 미리보기' }).click();
  await expect(editor.getByRole('img', { name: '영역 보정한 GIF 움직임 미리보기' })).toBeVisible();
  await expect(editor.getByRole('button', { name: '남길 부분 복원' })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await editor.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/gif-editor-mobile.png', fullPage: true });
  await editor.getByRole('button', { name: '편집으로 돌아가기' }).click();
  await editor.getByRole('button', { name: '되돌리기' }).click(); await expect.poll(alpha).toBe(255);
  await mark(); await expect.poll(alpha).toBe(0);
  await editor.getByRole('button', { name: '취소', exact: true }).click();
  expect((await downloadFrames(page, 'gif-cancelled')).map((p) => p[3])).toEqual([0, 255]);

  await open.click(); await expect(apply).toBeEnabled();
  await expect.poll(alpha).toBe(0);
  await editor.getByRole('button', { name: '원본 보며 표시' }).click(); await expect.poll(alpha).toBe(255);
  await mark(); await expect.poll(alpha).toBe(255);
  await expect(editor.getByRole('button', { name: '원본 보며 표시' })).toHaveAttribute('aria-pressed', 'false');
  await apply.click(); await expect(editor).toHaveCount(0);
  expect(await downloadFrames(page, 'gif-restored')).toEqual([[255, 255, 255, 255], [255, 255, 255, 255]]);

  await open.click(); await expect(apply).toBeEnabled();
  await editor.getByRole('button', { name: '남은 배경 지우기' }).click();
  await editor.getByRole('combobox', { name: 'GIF 보정 적용 범위' }).selectOption('all');
  await mark(); await expect.poll(alpha).toBe(0); await apply.click(); await expect(editor).toHaveCount(0);
  expect((await downloadFrames(page, 'gif-all-frames')).map((p) => p[3])).toEqual([0, 0]);
});
