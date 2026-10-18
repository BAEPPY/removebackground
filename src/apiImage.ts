import { applyAIMask } from './aiMask';
import type { RepairStroke } from './repairHints';

async function dataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return `data:image/png;base64,${btoa(binary)}`;
}

export async function openAICutout(original: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, access: string, current?: Uint8ClampedArray<ArrayBuffer>, stroke?: RepairStroke) {
  if (!access) throw new Error('GPT AI의 개인용 비밀번호를 입력해 주세요.');
  const source = new OffscreenCanvas(width, height); const context = source.getContext('2d')!;
  context.putImageData(new ImageData(original, width, height), 0, 0);
  let size = 1024; let blobs: Blob[] = [];
  while (size >= 256) {
    const scale = Math.min(size / width, size / height);
    const w = width * scale; const h = height * scale; const x = (size - w) / 2; const y = (size - h) / 2;
    const square = new OffscreenCanvas(size, size); const ctx = square.getContext('2d')!;
    ctx.drawImage(source, x, y, w, h); blobs = [await square.convertToBlob({ type: 'image/png' })];
    if (current && stroke) {
      const edited = new OffscreenCanvas(width, height); edited.getContext('2d')!.putImageData(new ImageData(current, width, height), 0, 0);
      ctx.clearRect(0, 0, size, size); ctx.drawImage(edited, x, y, w, h); blobs.push(await square.convertToBlob({ type: 'image/png' }));
      ctx.clearRect(0, 0, size, size); ctx.drawImage(source, x, y, w, h);
      ctx.lineWidth = Math.max(3, stroke.radius * 2 * scale); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = stroke.mode === 'restore' ? '#2be64caa' : '#ff4488aa';
      ctx.beginPath(); stroke.points.forEach((p, i) => { if (i) ctx.lineTo(x + p.x * scale, y + p.y * scale); else ctx.moveTo(x + p.x * scale, y + p.y * scale); });
      const last = stroke.points.at(-1)!; ctx.lineTo(x + last.x * scale + .01, y + last.y * scale); ctx.stroke();
      blobs.push(await square.convertToBlob({ type: 'image/png' }));
    }
    if (blobs.every(blob => blob.size <= 850_000)) break;
    size /= 2;
  }
  if (size < 256) throw new Error('API에 보낼 이미지가 너무 커요. 크기를 줄여 주세요.');
  const response = await fetch('/api/background', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${encodeURIComponent(access)}` }, body: JSON.stringify({ action: stroke?.mode ?? 'remove', images: await Promise.all(blobs.map(dataUrl)) }), signal: AbortSignal.timeout(250_000) });
  if (!response.ok) {
    let message = 'GPT AI 연결에 실패했어요. Vercel의 API 설정을 확인해 주세요.';
    try { const data = await response.json(); if (typeof data.error === 'string') message = data.error; } catch { /* Vercel timeout may return HTML. */ }
    throw new Error(message);
  }
  if (!response.headers.get('content-type')?.startsWith('image/png')) throw new Error('GPT AI가 이미지 결과를 반환하지 않았어요. API 설정을 확인해 주세요.');
  const image = await createImageBitmap(await response.blob());
  try {
    if (image.width !== image.height) throw new Error('AI가 원본과 다른 구도를 반환해 적용하지 않았어요.');
    const scale = Math.min(image.width / width, image.height / height);
    context.clearRect(0, 0, width, height);
    context.drawImage(image, (image.width - width * scale) / 2, (image.height - height * scale) / 2, width * scale, height * scale, 0, 0, width, height);
    return applyAIMask(original, context.getImageData(0, 0, width, height).data, width, height, current, stroke);
  } finally { image.close(); }
}
