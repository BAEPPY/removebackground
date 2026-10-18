// Kept in the page, shared by processing/editor workers. Nothing is persisted
// to disk; a reload drops the cache and its credential-scoped fingerprints.
export type APIRequest = { type: 'api-request'; id: number; access: string; body: string; fresh: boolean };
export type APIResponse = { type: 'api-response'; id: number; blob?: Blob; cached?: boolean; error?: string };
export type APIStats = { calls: number; cached: number; tracked: number };
export const emptyAPIStats = (): APIStats => ({ calls: 0, cached: 0, tracked: 0 });

export class APISession {
  private cache = new Map<string, Blob>();
  private running = new Map<string, Promise<Blob>>();
  private bytes = 0;

  async get(body: string, access: string, fresh = false) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cutout-v2\0${access}\0${body}`));
    const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const existing = this.cache.get(key);
    if (existing && !fresh) {
      this.cache.delete(key); this.cache.set(key, existing);
      return { blob: existing, cached: true };
    }
    const pending = this.running.get(key);
    if (pending) return { blob: await pending, cached: true };
    const task = this.fetch(body, access);
    this.running.set(key, task);
    try {
      const blob = await task;
      const replaced = this.cache.get(key);
      if (replaced) { this.cache.delete(key); this.bytes -= replaced.size; }
      this.cache.set(key, blob); this.bytes += blob.size;
      while (this.bytes > 32 * 1024 * 1024 || this.cache.size > 64) {
        const oldest = this.cache.keys().next().value!;
        this.bytes -= this.cache.get(oldest)!.size; this.cache.delete(oldest);
      }
      return { blob, cached: false };
    } finally { this.running.delete(key); }
  }

  private async fetch(body: string, access: string) {
    const response = await fetch('/api/background', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${encodeURIComponent(access)}` }, body, signal: AbortSignal.timeout(250_000) });
    if (!response.ok) {
      let message = 'GPT AI 연결에 실패했어요. Vercel의 API 설정을 확인해 주세요.';
      try { const data = await response.json(); if (typeof data.error === 'string') message = data.error; } catch { /* Non-JSON timeout. */ }
      throw new Error(message);
    }
    if (!response.headers.get('content-type')?.startsWith('image/png')) throw new Error('GPT AI가 이미지 결과를 반환하지 않았어요.');
    const blob = await response.blob();
    const header = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if (header.join(',') !== '137,80,78,71,13,10,26,10') throw new Error('GPT AI 결과 이미지를 읽지 못했어요.');
    const image = await createImageBitmap(blob);
    try {
      if (image.width !== image.height || image.width > 2048) throw new Error('AI가 원본과 다른 구도를 반환했어요.');
      const canvas = new OffscreenCanvas(image.width, image.height); const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0); const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      let transparent = false; let solid = false;
      for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] < 128) transparent = true; else solid = true; }
      if (!transparent || !solid) throw new Error('AI가 유효한 투명 윤곽을 반환하지 않았어요. 결과를 저장하지 않았습니다.');
    } finally { image.close(); }
    return blob;
  }

  async handle(worker: Worker, request: APIRequest) {
    let result: APIResponse;
    try { result = { type: 'api-response', id: request.id, ...await this.get(request.body, request.access, request.fresh) }; }
    catch (error) { result = { type: 'api-response', id: request.id, error: error instanceof Error && /[가-힣]/.test(error.message) ? error.message : 'AI 결과를 받지 못했어요. 이미 시작한 요청은 과금될 수 있어요.' }; }
    // A cancelled worker gets no further frames, but its completed paid result
    // stays available for a later retry in this tab.
    worker.postMessage(result);
  }
}
