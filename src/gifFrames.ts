import { parseGIF, decompressFrame } from 'gifuct-js';
import { createCompositor, MAX_FRAMES, readRepeat } from './media';

// Keep only a compositing canvas, not an RGBA copy of every animation frame.
// Forward reads are incremental; scrubbing backward replays disposal correctly.
export class GifFrames {
  private gif: ReturnType<typeof parseGIF>;
  readonly frames: Parameters<typeof decompressFrame>[0][];
  readonly repeat;
  private cursor = -1;
  private compose;
  private source;
  private scaled;
  constructor(bytes: ArrayBuffer, readonly width: number, readonly height: number) {
    this.gif = parseGIF(bytes);
    this.frames = this.gif.frames.filter((frame) => 'image' in frame);
    if (!this.frames.length || this.frames.length > MAX_FRAMES || this.gif.lsd.width * this.gif.lsd.height > 4_000_000 || this.frames.some((f) => f.image.descriptor.width * f.image.descriptor.height > 4_000_000)) throw new Error('GIF 크기를 확인해 주세요.');
    this.repeat = readRepeat(this.gif);
    this.compose = this.compositor();
    this.source = new OffscreenCanvas(this.gif.lsd.width, this.gif.lsd.height);
    this.scaled = new OffscreenCanvas(width, height);
  }
  private compositor() {
    const background = this.frames[0].gce?.extras.transparentColorGiven ? [0, 0, 0, 0] : [...(this.gif.gct?.[this.gif.lsd.backgroundColorIndex] ?? [0, 0, 0]), 255];
    return createCompositor(this.gif.lsd.width, this.gif.lsd.height, background);
  }
  read(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.frames.length) throw new Error('GIF 프레임을 찾지 못했어요.');
    if (index <= this.cursor) { this.cursor = -1; this.compose = this.compositor(); }
    const context = this.source.getContext('2d')!;
    while (this.cursor < index) {
      const rgba = this.compose(decompressFrame(this.frames[++this.cursor], this.gif.gct, true));
      if (this.cursor === index) context.putImageData(new ImageData(rgba, this.source.width, this.source.height), 0, 0);
    }
    const output = this.scaled.getContext('2d', { willReadFrequently: true })!;
    output.clearRect(0, 0, this.width, this.height);
    output.drawImage(this.source, 0, 0, this.width, this.height);
    return output.getImageData(0, 0, this.width, this.height).data;
  }
  delay(index: number) { return this.frames[index].gce ? this.frames[index].gce!.delay * 10 : 100; }
}
