const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(data.length + 12); const view = new DataView(out.buffer);
  view.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < out.length - 4; i++) crc = crcTable[(crc ^ out[i]) & 255] ^ (crc >>> 8);
  view.setUint32(out.length - 4, (crc ^ 0xffffffff) >>> 0); return out;
}
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;

// Full-canvas APNG frames preserve the soft alpha that 1-bit GIF cannot store.
// Reuse each browser-encoded PNG's IDAT; retain only compressed frame bytes.
export class AnimatedPng {
  private parts: BlobPart[] = [signature];
  private sequence = 0;
  private count = 0;
  private header?: Uint8Array;
  constructor(private frames: number, private repeat: number) {}
  async add(png: Blob, delay: number) {
    const bytes = new Uint8Array(await png.arrayBuffer()); const view = new DataView(bytes.buffer);
    if (!signature.every((v, i) => bytes[i] === v)) throw new Error('PNG 프레임을 읽지 못했어요.');
    let header: Uint8Array | undefined; const payloads: Uint8Array[] = [];
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset); if (offset + length + 12 > bytes.length) throw new Error('PNG 프레임이 손상되었어요.');
      const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
      if (type === 'IHDR') header = bytes.slice(offset + 8, offset + 8 + length);
      if (type === 'IDAT') payloads.push(bytes.slice(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    if (!header || header.length !== 13 || header[9] !== 6 || !payloads.length || this.count >= this.frames) throw new Error('움직이는 PNG 프레임 형식이 맞지 않아요.');
    if (!this.header) {
      this.header = header; this.parts.push(chunk('IHDR', header));
      const control = new Uint8Array(8); const c = new DataView(control.buffer);
      c.setUint32(0, this.frames); c.setUint32(4, this.repeat < 0 ? 1 : this.repeat === 0 ? 0 : this.repeat + 1);
      this.parts.push(chunk('acTL', control));
    } else if (!header.every((v, i) => v === this.header![i])) throw new Error('프레임 크기가 서로 달라요.');
    const frame = new Uint8Array(26); const f = new DataView(frame.buffer);
    f.setUint32(0, this.sequence++); frame.set(header.subarray(0, 8), 4);
    const divisor = gcd(delay, 1000); f.setUint16(20, delay / divisor); f.setUint16(22, 1000 / divisor);
    frame[24] = 0; frame[25] = 0; // full source replacement; no compositing ghosts
    this.parts.push(chunk('fcTL', frame));
    for (const payload of payloads) {
      if (!this.count) this.parts.push(chunk('IDAT', payload));
      else { const data = new Uint8Array(payload.length + 4); new DataView(data.buffer).setUint32(0, this.sequence++); data.set(payload, 4); this.parts.push(chunk('fdAT', data)); }
    }
    this.count++;
  }
  finish() {
    if (this.count !== this.frames) throw new Error('움직이는 PNG의 프레임이 빠졌어요.');
    return new Blob([...this.parts, chunk('IEND', new Uint8Array())], { type: 'image/png' });
  }
}
