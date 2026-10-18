import { emptyAPIStats, type APIRequest, type APIResponse } from './apiSession';

let nextId = 0;
export let apiStats = emptyAPIStats();
export function resetAPIStats() { apiStats = emptyAPIStats(); }
export function requestImage(body: string, access: string, fresh = false): Promise<Blob> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const receive = ({ data }: MessageEvent<APIResponse>) => {
      if (data.type !== 'api-response' || data.id !== id) return;
      self.removeEventListener('message', receive);
      if (data.error || !data.blob) reject(new Error(data.error ?? 'AI 결과가 비어 있어요.'));
      else { if (data.cached) apiStats.cached++; else apiStats.calls++; resolve(data.blob); }
    };
    self.addEventListener('message', receive);
    self.postMessage({ type: 'api-request', id, access, body, fresh } satisfies APIRequest);
  });
}
