import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APISession } from './apiSession';

const png = () => new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]), { headers: { 'Content-Type': 'image/png' } });
beforeEach(() => {
  vi.stubGlobal('createImageBitmap', async () => ({ width: 2, height: 2, close() {} }));
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return { drawImage() {}, getImageData() { return { data: new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255]) }; } }; } });
});
afterEach(() => vi.unstubAllGlobals());

describe('page-scoped paid request reuse', () => {
  it('reuses a success, but separates credentials, image payloads and explicit fresh requests', async () => {
    const fetch = vi.fn().mockImplementation(async () => png()); vi.stubGlobal('fetch', fetch);
    const session = new APISession();
    expect((await session.get('image-a', 'password-a')).cached).toBe(false);
    expect((await session.get('image-a', 'password-a')).cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await session.get('image-b', 'password-a'); await session.get('image-a', 'password-b');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await session.get('image-a', 'password-a', true)).cached).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect((await session.get('image-a', 'password-a')).cached).toBe(true);
  });
  it('coalesces overlapping requests so double clicks do not start two paid calls', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
    const session = new APISession(); const a = session.get('image', 'password'); const b = session.get('image', 'password');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); finish(png());
    const results = await Promise.all([a, b]);
    expect(results.filter(r => r.cached)).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('never caches failures and never automatically retries them', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{"error":"사용 한도"}', { status: 429 })).mockImplementation(async () => png()); vi.stubGlobal('fetch', fetch);
    const session = new APISession(); await expect(session.get('image', 'password')).rejects.toThrow('사용 한도');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await session.get('image', 'password')).cached).toBe(false); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed image responses and evicts old entries', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('bad', { headers: { 'Content-Type': 'image/png' } })).mockImplementation(async () => png()); vi.stubGlobal('fetch', fetch);
    const session = new APISession(); await expect(session.get('image', 'password')).rejects.toThrow('이미지');
    for (let i = 0; i < 65; i++) await session.get(`image-${i}`, 'password');
    expect((await session.get('image-64', 'password')).cached).toBe(true);
    expect((await session.get('image-0', 'password')).cached).toBe(false);
  });
  it('does not reuse an opaque response that failed mask validation', async () => {
    const fetch = vi.fn().mockImplementation(async () => png()); vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return { drawImage() {}, getImageData() { return { data: new Uint8ClampedArray([255, 255, 255, 255]) }; } }; } });
    const session = new APISession();
    await expect(session.get('image', 'password')).rejects.toThrow('유효한');
    await expect(session.get('image', 'password')).rejects.toThrow('유효한');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
