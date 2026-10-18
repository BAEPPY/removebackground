import { expect, test } from '@playwright/test';

test('desktop comparison, background previews, result view, and sample input', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto('/');
  await expect(page).toHaveTitle(/off\./);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const slider = page.getByRole('slider', { name: '배경 제거 전후 비교 위치' });
  await slider.fill('73');
  await expect(slider).toHaveValue('73');
  await page.getByRole('button', { name: '라벤더 배경으로 미리보기' }).click();
  await expect(page.getByRole('button', { name: '라벤더 배경으로 미리보기' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '결과만 보기' }).click();
  await expect(slider).toHaveCount(0);
  await page.getByRole('button', { name: '전후 비교', exact: true }).click();
  await slider.fill('48');
  await page.getByRole('button', { name: '투명 배경으로 미리보기' }).click();
  await page.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
  await page.getByRole('button', { name: '예시로 시작하기' }).click();
  await expect(page.getByText('sunflower.png', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '배경 지우기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '선택한 파일 삭제' }).click();
  await expect(page.getByRole('button', { name: '이미지 선택', exact: true })).toBeVisible();
});

test('mobile has no horizontal overflow and FAQ works', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByText('움짤도 움직인 채로 저장되나요?').click();
  await expect(page.getByText(/최대 120프레임·20MB/)).toBeVisible();
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
});

test('rejects unsupported and corrupt files without a download', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(page.getByRole('alert')).toContainText('JPG, JFIF, PNG, WebP');
  await page.locator('input[type=file]').setInputFiles({ name: 'broken.gif', mimeType: 'image/gif', buffer: Buffer.from('not a gif') });
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('올바른 GIF');
  await expect(page.getByRole('button', { name: /다운로드/ })).toHaveCount(0);
});

test('JFIF decoding, processing controls and PNG download with a worker fixture', async ({ page }) => {
  // This fixture covers the UI lifecycle only. It does not claim to test AI inference.
  await page.addInitScript(() => {
    class FixtureWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror = null;
      timer?: ReturnType<typeof setTimeout>;
      async postMessage({ file }: { file: File }) {
        if (file.type !== 'image/jpeg') throw new Error('JFIF MIME type was not normalized');
        const bitmap = await createImageBitmap(file);
        if (bitmap.width !== 32 || bitmap.height !== 24) throw new Error('JFIF did not decode correctly');
        bitmap.close();
        this.onmessage?.({ data: { type: 'progress', value: 50, message: '테스트 처리 중' } });
        this.timer = setTimeout(() => {
          const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
          this.onmessage?.({ data: { type: 'done', blob: new Blob([bytes], { type: 'image/png' }), width: 1, height: 1, frames: 1 } });
        }, 1800);
      }
      terminate() { clearTimeout(this.timer); }
    }
    Object.defineProperty(window, 'Worker', { value: FixtureWorker });
  });
  await page.goto('/');
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#b8ec7d'; context.fillRect(0, 0, 32, 24);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  });
  const bytes = Buffer.from(jpeg, 'base64');
  expect(bytes.subarray(6, 10).toString()).toBe('JFIF');
  const input = page.locator('input[type=file]');
  await expect(input).toHaveAttribute('accept', /\.jfif/);
  await input.setInputFiles({ name: '사진.JFIF', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page.getByText('사진.JFIF', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '선택한 원본 이미지' })).toHaveJSProperty('naturalWidth', 32);
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('테스트 처리 중');
  await page.getByRole('button', { name: '처리 취소' }).click();
  await expect(page.getByRole('button', { name: '배경 지우기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  const downloadButton = page.getByRole('button', { name: '투명 PNG 다운로드' });
  await expect(downloadButton).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toBe('사진-off.png');
  await expect(page.getByRole('slider')).toBeVisible();
});
