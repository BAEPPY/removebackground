import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Request = IncomingMessage & { body?: unknown };
const MAX_BODY = 3_700_000;
const MODEL = 'gpt-image-1.5';
const PROMPT = 'Perform precise background removal, not illustration generation. Return exactly the same subject at exactly the same pixel positions, scale, pose and framing as image 1, on a truly transparent background. Do not recenter, crop, expand, redraw, add shadows, or change any details. Keep all actual white fur, skin, eyes, teeth and mouth interiors. Preserve fine dark outlines and hair. Remove exterior background, tiny leftover background speckles and fringes, with clean antialiased edges. The output must use the same square canvas and padding as the input.';
const hash = (value: string) => createHash('sha256').update(value).digest();
function configured() { return !!process.env.OPENAI_API_KEY?.trim() && (process.env.APP_PASSWORD?.length ?? 0) >= 16; }
function reply(res: ServerResponse, status: number, error: string) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error })); }
function png(input: unknown) {
  if (typeof input !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(input) || input.length > 1_200_000) throw new Error('image');
  const bytes = Buffer.from(input.slice(22), 'base64');
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('image');
  const w = bytes.readUInt32BE(16); const h = bytes.readUInt32BE(20);
  if (w !== h || w < 64 || w > 1024) throw new Error('image');
  return { bytes, w };
}
async function body(req: Request) {
  if (req.body !== undefined) {
    const json = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(json) > MAX_BODY) throw new Error('size');
    return JSON.parse(json);
  }
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length; if (length > MAX_BODY) throw new Error('size'); chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export default async function handler(req: Request, res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ configured: configured(), provider: 'openai', model: MODEL })); return;
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); reply(res, 405, '지원하지 않는 요청이에요.'); return; }
  if (!configured()) { reply(res, 503, 'Vercel에 OPENAI_API_KEY와 16자 이상의 APP_PASSWORD를 설정한 뒤 다시 배포해 주세요.'); return; }
  let password = '';
  try { password = decodeURIComponent((req.headers.authorization ?? '').replace(/^Bearer /, '')); } catch { /* Invalid credentials stay empty. */ }
  if (!timingSafeEqual(hash(password), hash(process.env.APP_PASSWORD!))) { reply(res, 401, '개인용 비밀번호가 맞지 않아요.'); return; }
  if (!req.headers['content-type']?.startsWith('application/json')) { reply(res, 415, '이미지 요청 형식을 확인해 주세요.'); return; }
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { reply(res, 413, '이미지가 너무 커요. 크기를 줄여 주세요.'); return; }
  let form: FormData;
  try {
    const data = await body(req);
    if (!data || !['remove', 'restore', 'erase'].includes(data.action) || !Array.isArray(data.images) || data.images.length !== (data.action === 'remove' ? 1 : 3)) throw new Error('request');
    const images = data.images.map(png);
    if (!images.every((image: { w: number }) => image.w === images[0].w)) throw new Error('dimensions');
    form = new FormData();
    for (let i = 0; i < images.length; i++) form.append('image[]', new Blob([images[i].bytes], { type: 'image/png' }), `reference-${i + 1}.png`);
    form.set('model', MODEL); form.set('background', 'transparent'); form.set('output_format', 'png');
    form.set('input_fidelity', 'high'); form.set('quality', 'medium'); form.set('size', '1024x1024'); form.set('n', '1');
    const correction = data.action === 'remove' ? '' : ` Image 2 is the current cutout, image 3 is the original with a rough ${data.action === 'restore' ? 'green KEEP' : 'pink REMOVE'} mark. Use the mark as a semantic hint to ${data.action === 'restore' ? 'restore the original subject including white interior parts' : 'remove unwanted background'} near that mark, following real object contours even if open. Keep the other areas as in image 2. Do not include the colored annotation in the output.`;
    form.set('prompt', PROMPT + correction);
  } catch (error) { reply(res, error instanceof Error && error.message === 'size' ? 413 : 400, '이미지 요청을 읽지 못했어요. 파일을 다시 선택해 주세요.'); return; }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 240_000);
  const disconnect = () => { if (!res.writableEnded) abort.abort(); };
  res.on('close', disconnect);
  try {
    // No automatic retry: another request could create another paid image.
    const response = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}` }, body: form, signal: abort.signal });
    if (!response.ok) {
      const status = response.status;
      reply(res, status === 429 ? 429 : 502, status === 401 || status === 403 ? 'OpenAI API 키와 이미지 모델 사용 권한을 확인해 주세요.' : status === 429 ? 'OpenAI 사용 한도나 잔액을 확인한 뒤 다시 시도해 주세요.' : 'OpenAI가 이미지를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'); return;
    }
    const data = await response.json();
    const encoded = data?.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || encoded.length > 5_700_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('response');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('response');
    res.setHeader('Content-Type', 'image/png'); res.end(bytes);
  } catch {
    if (!res.destroyed) reply(res, abort.signal.aborted ? 504 : 502, abort.signal.aborted ? 'AI 처리 시간이 길어져 중단했어요. 이미 시작한 요청은 과금될 수 있어요.' : 'AI 결과를 받지 못했어요. 자동으로 재요청하지 않았습니다.');
  } finally { clearTimeout(timer); res.off('close', disconnect); }
}
