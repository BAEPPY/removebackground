import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import handler from '../api/background';

function png() {
  const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.write('IHDR', 12); bytes.writeUInt32BE(64, 16); bytes.writeUInt32BE(64, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
async function call(method: string, data?: unknown, password = 'personal-password-123', headers = {}) {
  const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} as Record<string, string>, output: Buffer.alloc(0), writableEnded: false, destroyed: false,
    setHeader(key: string, value: string) { this.headers[key] = value; },
    end(value: string | Buffer) { this.output = Buffer.from(value); this.writableEnded = true; },
  });
  await handler({ method, headers: { authorization: `Bearer ${encodeURIComponent(password)}`, 'content-type': 'application/json', ...headers }, body: data } as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);
  return res;
}
function configure() { vi.stubEnv('OPENAI_API_KEY', 'server-only-test-key'); vi.stubEnv('APP_PASSWORD', 'personal-password-123'); }
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('personal OpenAI server endpoint', () => {
  it('reports setup without leaking credentials and refuses unconfigured paid calls', async () => {
    vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('APP_PASSWORD', ''); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(JSON.parse((await call('GET')).output.toString())).toMatchObject({ configured: false });
    expect((await call('POST', { images: [png()], action: 'remove' })).statusCode).toBe(503); expect(fetch).not.toHaveBeenCalled();
    configure(); const status = await call('GET'); expect(status.output.toString()).not.toMatch(/server-only|personal-password/);
  });
  it('authenticates before calling OpenAI, rejects malformed and oversized requests', async () => {
    configure(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect((await call('POST', {}, 'wrong')).statusCode).toBe(401);
    expect((await call('POST', { images: ['https://example.com'], action: 'remove' })).statusCode).toBe(400);
    expect((await call('POST', { images: [png()], action: 'erase' })).statusCode).toBe(400);
    expect((await call('POST', {}, undefined, { 'content-length': '5000000' })).statusCode).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requests a transparent high-fidelity edit with server-only credentials', async () => {
    configure(); const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: png().slice(22) }] }), { status: 200 })); vi.stubGlobal('fetch', fetch);
    const res = await call('POST', { images: [png()], action: 'remove' });
    expect(res.statusCode).toBe(200); expect(res.headers['Content-Type']).toBe('image/png'); expect(res.headers['Cache-Control']).toBe('no-store');
    const [url, options] = fetch.mock.calls[0]; expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(options.headers.Authorization).toBe('Bearer server-only-test-key');
    const form: FormData = options.body;
    expect(form.get('model')).toBe('gpt-image-1.5'); expect(form.get('background')).toBe('transparent'); expect(form.get('input_fidelity')).toBe('high'); expect(form.get('n')).toBe('1'); expect(form.getAll('image[]')).toHaveLength(1);
    expect(res.output.toString()).not.toContain('server-only-test-key');
  });
  it('passes original, current result and marked guide for region corrections', async () => {
    configure(); const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: png().slice(22) }] }))); vi.stubGlobal('fetch', fetch);
    await call('POST', { images: [png(), png(), png()], action: 'restore' });
    const form: FormData = fetch.mock.calls[0][1].body;
    expect(form.getAll('image[]')).toHaveLength(3); expect(form.get('prompt')).toContain('green KEEP');
  });
  it('does not retry paid failures or expose upstream errors', async () => {
    configure(); const fetch = vi.fn().mockResolvedValue(new Response('sensitive upstream message', { status: 429 })); vi.stubGlobal('fetch', fetch);
    const res = await call('POST', { images: [png()], action: 'remove' }); expect(res.statusCode).toBe(429); expect(fetch).toHaveBeenCalledTimes(1); expect(res.output.toString()).not.toContain('sensitive');
  });
});
