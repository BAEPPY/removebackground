import { expect, test } from '@playwright/test';

test('GPT mode gates setup, preserves source colors and only calls API on explicit region requests', async ({ page }) => {
  const calls: { action: string; images: string[] }[] = [];
  let fail = false;
  await page.goto('/');
  const fixture = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 64, 48);
    ctx.fillStyle = '#cae9f4'; ctx.fillRect(16, 12, 32, 24);
    const original = canvas.toDataURL().split(',')[1];
    canvas.width = canvas.height = 1024;
    ctx.fillStyle = '#ff0000'; ctx.fillRect(256, 320, 512, 384); // AI RGB differs deliberately
    return { original, cutout: canvas.toDataURL().split(',')[1] };
  });
  await page.route('**/api/background', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: { configured: true } }); return; }
    expect(route.request().headers().authorization).toBe('Bearer personal-password-123');
    const body = route.request().postDataJSON(); calls.push(body);
    if (fail) await route.fulfill({ status: 429, json: { error: 'OpenAI 사용 한도나 잔액을 확인한 뒤 다시 시도해 주세요.' } });
    else await route.fulfill({ contentType: 'image/png', body: Buffer.from(fixture.cutout, 'base64') });
  });
  await page.getByRole('button', { name: 'GPT AI', exact: true }).click();
  await expect(page.getByText(/서버 API 설정 완료/)).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'api-source.png', mimeType: 'image/png', buffer: Buffer.from(fixture.original, 'base64') });
  const run = page.getByRole('button', { name: '배경 지우기', exact: true });
  await expect(run).toBeDisabled(); await page.getByLabel('개인용 비밀번호', { exact: true }).fill('personal-password-123');
  await expect(page.getByText('이번 배경 제거: API 최대 1회')).toBeVisible();
  await run.click(); await expect(page.getByRole('button', { name: '투명 PNG 다운로드' })).toBeVisible();
  expect(calls).toHaveLength(1); expect(calls[0].images).toHaveLength(1); expect(calls[0].action).toBe('remove');
  const pixel = () => page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('img[alt="배경을 제거한 결과"]')!; await img.decode();
    const c = document.createElement('canvas'); c.width = 64; c.height = 48; const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(32, 24, 1, 1).data];
  });
  expect(await pixel()).toEqual([202, 233, 244, 255]);
  await page.getByRole('button', { name: '대략 표시해서 자동 보정' }).click();
  const editor = page.getByRole('dialog'); const apply = editor.getByRole('button', { name: '편집 적용' });
  await expect(apply).toBeEnabled();
  await editor.getByRole('button', { name: '남은 배경 지우기' }).click();
  const canvas = editor.locator('canvas'); const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(editor.getByRole('button', { name: '되돌리기' })).toBeEnabled(); expect(calls).toHaveLength(1);
  await editor.getByRole('button', { name: '남길 부분 복원' }).click();
  await canvas.click({ position: { x: box.width / 4, y: box.height / 2 } });
  await expect(editor.getByText(/GPT 보정 대상 표시 2개/)).toBeVisible();
  expect(calls).toHaveLength(1);
  await editor.getByRole('button', { name: '표시한 곳 GPT로 보정' }).click();
  await expect(editor.getByRole('status')).toContainText('GPT 영역 보정을 적용');
  expect(calls).toHaveLength(2); expect(calls[1].images).toHaveLength(2); expect(calls[1].action).toBe('correct');
  const before = await canvas.evaluate((c: HTMLCanvasElement) => [...c.getContext('2d')!.getImageData(0, 0, 64, 48).data]);
  await editor.getByRole('button', { name: '표시한 곳 GPT로 보정' }).click();
  await expect(editor.getByRole('status')).toContainText('새 API 0회'); expect(calls).toHaveLength(2);
  fail = true; await editor.getByRole('checkbox', { name: '결과가 부족하면 새로 분석 (추가 과금)' }).check();
  await editor.getByRole('button', { name: '표시한 곳 GPT로 보정' }).click();
  await expect(editor.getByRole('alert')).toContainText('사용 한도');
  expect(calls).toHaveLength(3); expect(await canvas.evaluate((c: HTMLCanvasElement) => [...c.getContext('2d')!.getImageData(0, 0, 64, 48).data])).toEqual(before);
  await editor.getByRole('button', { name: '취소', exact: true }).click(); expect(await pixel()).toEqual([202, 233, 244, 255]);
  await page.reload(); await page.getByRole('button', { name: 'GPT AI', exact: true }).click();
  await expect(page.getByLabel('개인용 비밀번호', { exact: true })).toHaveValue('');
});

test('unconfigured GPT API gives setup instructions without sending any images', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/background', async route => { if (route.request().method() === 'POST') calls++; await route.fulfill({ json: { configured: false } }); });
  await page.goto('/'); await page.getByRole('button', { name: 'GPT AI', exact: true }).click();
  await expect(page.getByText('서버 API 설정이 필요해요')).toBeVisible();
  await expect(page.getByText(/Vercel 환경변수에/)).toBeVisible();
  expect(calls).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/api-setup-mobile.png', fullPage: true });
});

test('GPT handles GIF frames, reports call count and applies all-frame AI corrections atomically', async ({ page }) => {
  const { default: gifenc } = await import('gifenc');
  const { GIFEncoder, quantize, applyPalette } = gifenc;
  const encoder = GIFEncoder();
  for (const rgb of [[202, 233, 244], [255, 197, 206]]) {
    const pixels = new Uint8ClampedArray(32 * 24 * 4).fill(255);
    for (let y = 6; y < 18; y++) for (let x = 8; x < 24; x++) pixels.set([...rgb, 255], (y * 32 + x) * 4);
    const palette = quantize(pixels, 256); encoder.writeFrame(applyPalette(pixels, palette), 32, 24, { palette, delay: 80 });
  }
  encoder.finish(); let calls = 0; let failAt = 4;
  await page.goto('/');
  const mask = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = c.height = 1024; const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'red'; ctx.fillRect(256, 320, 512, 384); return c.toDataURL().split(',')[1];
  });
  await page.route('**/api/background', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: { configured: true } }); return; }
    calls++;
    if (calls === failAt) await route.fulfill({ status: 502, json: { error: 'AI 결과를 받지 못했어요.' } });
    else await route.fulfill({ contentType: 'image/png', body: Buffer.from(mask, 'base64') });
  });
  await page.getByRole('button', { name: 'GPT AI', exact: true }).click();
  await page.getByLabel('개인용 비밀번호', { exact: true }).fill('personal-password-123');
  await page.locator('input[type=file]').setInputFiles({ name: 'api.gif', mimeType: 'image/gif', buffer: Buffer.from(encoder.bytes()) });
  await expect(page.getByText(/API 최대 2회/)).toBeVisible();
  await page.getByRole('button', { name: '배경 지우기', exact: true }).click();
  await expect(page.getByRole('link', { name: '부드러운 APNG 다운로드' })).toBeVisible(); expect(calls).toBe(2);
  await page.getByRole('button', { name: '대략 표시해서 자동 보정' }).click();
  const editor = page.getByRole('dialog'); const canvas = editor.locator('canvas'); const apply = editor.getByRole('button', { name: '편집 적용' });
  const pixel = () => canvas.evaluate((c: HTMLCanvasElement) => [...c.getContext('2d')!.getImageData(16, 12, 1, 1).data]);
  await expect(apply).toBeEnabled(); expect(await pixel()).toEqual([202, 233, 244, 255]);
  await editor.getByRole('slider', { name: 'GIF 편집 프레임' }).fill('1'); await expect(apply).toBeEnabled();
  await expect.poll(pixel).toEqual([255, 197, 206, 255]);
  await editor.getByRole('combobox', { name: 'GIF 보정 적용 범위' }).selectOption('all');
  await editor.getByRole('button', { name: '남은 배경 지우기' }).click();
  const box = (await canvas.boundingBox())!; await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(editor.getByRole('button', { name: '되돌리기' })).toBeEnabled();
  const before = await canvas.evaluate((c: HTMLCanvasElement) => [...c.getContext('2d')!.getImageData(0, 0, 32, 24).data]);
  await editor.getByRole('button', { name: '표시한 곳 GPT로 보정' }).click();
  await expect(editor.getByRole('alert')).toContainText('AI 결과를 받지 못했어요'); expect(calls).toBe(4);
  expect(await canvas.evaluate((c: HTMLCanvasElement) => [...c.getContext('2d')!.getImageData(0, 0, 32, 24).data])).toEqual(before);
  failAt = 0; await editor.getByRole('button', { name: '표시한 곳 GPT로 보정' }).click();
  await expect(editor.getByRole('status')).toContainText('모든 2프레임'); expect(calls).toBe(5); // the successful frame from the failed batch is reused
  await apply.click(); await expect(editor).toHaveCount(0);
  await expect(page.getByRole('link', { name: '부드러운 APNG 다운로드' })).toBeVisible();
});
