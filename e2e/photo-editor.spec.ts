import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('photo AI result can be corrected with the real region worker and saved', async ({ page }) => {
  // Only model inference is substituted; decoding, editing, source view and export are real.
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    class PhotoFixture extends NativeWorker {
      processing: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); this.processing = /processor\.worker/.test(String(url));
      }
      postMessage(data: { file: Blob; mode: string }, options?: StructuredSerializeOptions) {
        if (!this.processing) { super.postMessage(data, options); return; }
        if (data.mode !== 'photo') throw new Error('Expected photo AI mode');
        void (async () => {
          const image = await createImageBitmap(data.file);
          const canvas = new OffscreenCanvas(64, 64); const ctx = canvas.getContext('2d')!;
          ctx.drawImage(image, 0, 0); image.close();
          ctx.clearRect(5, 20, 20, 20);
          const blob = await canvas.convertToBlob({ type: 'image/png' });
          this.dispatchEvent(new MessageEvent('message', { data: { type: 'done', blob, width: 64, height: 64, frames: 1 } }));
        })();
      }
    }
    Object.defineProperty(window, 'Worker', { value: PhotoFixture });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '사진 AI', exact: true }).click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#c83228'; ctx.fillRect(0, 0, 32, 64);
    ctx.fillStyle = '#2850c8'; ctx.fillRect(32, 0, 32, 64);
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  await page.getByRole('button', { name: '대략 표시해서 자동 보정' }).click();
  const dialog = page.getByRole('dialog'); const canvas = dialog.locator('canvas');
  const pixel = () => canvas.evaluate((c: HTMLCanvasElement) => [...c.getContext('2d')!.getImageData(15, 30, 1, 1).data]);
  await expect(dialog.getByRole('button', { name: '편집 적용' })).toBeEnabled();
  expect((await pixel())[3]).toBe(0);
  await dialog.getByRole('button', { name: '원본 보며 표시' }).click(); expect(await pixel()).toEqual([200, 50, 40, 255]);
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 15 / 64, y: box.height * 30 / 64 } });
  await expect(dialog.getByRole('button', { name: '되돌리기' })).toBeEnabled();
  expect(await pixel()).toEqual([200, 50, 40, 255]);
  await dialog.getByRole('button', { name: '편집 적용' }).click();
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: '투명 PNG 다운로드' }).click();
  await (await event).saveAs('artifacts/photo-region-restored.png');
  const saved = (await readFile('artifacts/photo-region-restored.png')).toString('base64');
  expect(await page.evaluate(async (base64) => {
    const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]);
    const image = await createImageBitmap(blob); const canvas = new OffscreenCanvas(64, 64); const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0); image.close(); return [...ctx.getImageData(15, 30, 1, 1).data];
  }, saved)).toEqual([200, 50, 40, 255]);
});
