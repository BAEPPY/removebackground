import type { ParsedFrame, ParsedGif } from 'gifuct-js';
import { applyPalette, quantize } from 'gifenc';

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_FRAMES = 120;

export function validateFile(file: Pick<File, 'name' | 'size' | 'type'>): string | null {
  if (!file.size) return '비어 있는 파일이에요. 다른 파일을 선택해 주세요.';
  if (file.size > MAX_BYTES) return '20MB 이하의 파일을 선택해 주세요.';
  const jfifMime = /\.jfif$/i.test(file.name) && ['image/jfif', 'image/pjpeg', 'application/octet-stream'].includes(file.type);
  if (!/\.(jpe?g|jfif|png|webp|gif)$/i.test(file.name) ||
      (file.type && !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) && !jfifMime)) {
    return 'JPG, JFIF, PNG, WebP 사진 또는 GIF 움짤을 선택해 주세요.';
  }
  return null;
}

export function fitSize(width: number, height: number, max: number) {
  if (!width || !height || width * height > 40_000_000) throw new Error('이미지가 너무 크거나 손상되었어요. 4,000만 화소 이하의 파일을 사용해 주세요.');
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function downloadName(name: string, animated: boolean) {
  return `${name.replace(/\.[^.]+$/, '').replace(/[\\/<>:"|?*]/g, '_') || 'image'}-off.${animated ? 'gif' : 'png'}`;
}

// Composite each partial GIF frame before segmentation. The generator retains only
// the current canvas and, for disposal 3, the canvas preceding the current frame.
export function createCompositor(width: number, height: number, background: number[]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  let previous: ParsedFrame | undefined;
  let restore: Uint8ClampedArray | undefined;
  const fill = (left: number, top: number, w: number, h: number, color: number[]) => {
    for (let y = Math.max(top, 0); y < Math.min(top + h, height); y++) {
      for (let x = Math.max(left, 0); x < Math.min(left + w, width); x++) {
        pixels.set(color, (y * width + x) * 4);
      }
    }
  };
  fill(0, 0, width, height, background);
  return (frame: ParsedFrame) => {
    if (previous?.disposalType === 2) {
      const d = previous.dims;
      fill(d.left, d.top, d.width, d.height, previous.transparentIndex !== undefined ? [0, 0, 0, 0] : background);
    } else if (previous?.disposalType === 3 && restore) {
      pixels.set(restore);
    }
    restore = frame.disposalType === 3 ? pixels.slice() : undefined;
    const d = frame.dims;
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        if (x + d.left >= width || y + d.top >= height) continue;
        const source = (y * d.width + x) * 4;
        if (frame.patch[source + 3] === 0) continue;
        pixels.set(frame.patch.subarray(source, source + 4), ((y + d.top) * width + x + d.left) * 4);
      }
    }
    previous = frame;
    return pixels;
  };
}

export function readRepeat(gif: ParsedGif) {
  for (const frame of gif.frames) {
    if ('application' in frame && /NETSCAPE|ANIMEXTS/.test(frame.application.id)) {
      const bytes = frame.application.blocks;
      if (bytes.length >= 3 && bytes[0] === 1) return bytes[1] | (bytes[2] << 8);
    }
  }
  return -1;
}

export function transparentPalette(pixels: Uint8ClampedArray) {
  // Reserve index zero, so opaque black never accidentally becomes transparent.
  const colors = quantize(pixels, 255);
  const indices = applyPalette(pixels, colors);
  for (let i = 0; i < indices.length; i++) indices[i] = pixels[i * 4 + 3] < 128 ? 0 : indices[i] + 1;
  return { palette: [[0, 0, 0], ...colors], indices };
}

export function preserveAlpha(output: Uint8ClampedArray, original: Uint8ClampedArray) {
  for (let i = 3; i < output.length; i += 4) output[i] = Math.min(output[i], original[i]);
  return output;
}
