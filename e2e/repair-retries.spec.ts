import { expect, test } from '@playwright/test';

test('open contours honor entire strokes, repeated corrections survive apply/reopen, and undo/cancel restore history', async ({ page }) => {
  await page.goto('/');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff'; context.fillRect(0, 0, 96, 96);
    context.fillStyle = '#191919'; context.fillRect(20, 20, 3, 56); context.fillRect(20, 73, 56, 3);
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'open-contour.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  const open = page.getByRole('button', { name: '대략 표시해서 자동 보정' });
  await open.click();
  const editor = page.getByRole('dialog'); const canvas = editor.locator('canvas');
  const apply = editor.getByRole('button', { name: '편집 적용' });
  const ready = () => expect(apply).toBeEnabled();
  const alpha = (x: number, y: number) => canvas.evaluate((element: HTMLCanvasElement, { x, y }) => element.getContext('2d')!.getImageData(x, y, 1, 1).data[3], { x, y });
  const click = async (x: number, y: number) => {
    const box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: x / 96 * box.width, y: y / 96 * box.height } });
    await ready();
  };
  const stroke = async (from: [number, number], to: [number, number]) => {
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + from[0] / 96 * box.width, box.y + from[1] / 96 * box.height);
    await page.mouse.down();
    await page.mouse.move(box.x + to[0] / 96 * box.width, box.y + to[1] / 96 * box.height, { steps: 12 });
    await page.mouse.up(); await ready();
  };
  await ready();
  expect(await alpha(50, 45)).toBe(0);
  await click(50, 45);
  expect(await alpha(50, 45)).toBe(255);
  expect(await alpha(58, 45)).toBe(0);
  await expect(editor.getByRole('status')).not.toContainText(/닫힌 윤곽|이미 선택/);
  await apply.click(); await expect(editor).toHaveCount(0);

  await open.click(); await ready();
  await click(50, 45); // prior anchor is already opaque; retry must still expand
  expect(await alpha(58, 45)).toBe(255);
  await editor.getByRole('button', { name: '되돌리기' }).click(); await ready();
  expect(await alpha(58, 45)).toBe(0);
  await click(50, 45);
  expect(await alpha(58, 45)).toBe(255);
  await stroke([50, 45], [75, 45]); // the entire stroke, not just its first point
  expect(await alpha(65, 45)).toBe(255);
  expect(await alpha(75, 45)).toBe(255);
  expect(await alpha(92, 92)).toBe(0);
  await editor.getByRole('button', { name: '남은 배경 지우기' }).click();
  await stroke([50, 65], [75, 45]);
  expect(await alpha(75, 45)).toBe(0);
  expect(await alpha(50, 45)).toBe(255);
  await editor.getByRole('button', { name: '취소', exact: true }).click();
  await expect(editor).toHaveCount(0);

  await open.click(); await ready();
  expect(await alpha(58, 45)).toBe(0); // cancelled masks and retry history are discarded
  await click(50, 45);
  expect(await alpha(58, 45)).toBe(255);
  expect(await alpha(66, 45)).toBe(0); // cancelled escalation did not leak back
  await page.screenshot({ path: 'artifacts/open-contour-retry.png' });
  await apply.click(); await expect(editor).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '투명 PNG 다운로드' }).click();
  expect((await pending).suggestedFilename()).toBe('open-contour-off.png');
});
