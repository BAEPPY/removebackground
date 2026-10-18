import type { Config } from '@imgly/background-removal';
import { parseGIF, decompressFrame } from 'gifuct-js';
import { GIFEncoder } from 'gifenc';
import { createCompositor, fitSize, MAX_FRAMES, preserveAlpha, readRepeat, transparentPalette, validateFile } from './media';
import type { ProcessRequest, ProcessUpdate } from './types';
import { removeCharacterBackground } from './character';
import { refineEdges } from './edgeMatte';

const send = (update: ProcessUpdate) => self.postMessage(update);
const progress = (value: number, message: string, detail?: string) => send({ type: 'progress', value, message, detail });
function canvas(width: number, height: number) {
  const surface = new OffscreenCanvas(width, height);
  const context = surface.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('이 브라우저에서는 이미지 처리를 지원하지 않아요. 최신 Chrome 또는 Edge에서 열어 주세요.');
  return { surface, context };
}

async function processFile({ file, quality, mode }: ProcessRequest) {
  const invalid = validateFile(file);
  if (invalid) throw new Error(invalid);
  const data = await file.arrayBuffer();
  const header = new TextDecoder('latin1').decode(data.slice(0, 6));
  const isGif = header === 'GIF87a' || header === 'GIF89a';
  if (/\.gif$/i.test(file.name) && !isGif) throw new Error('올바른 GIF 파일이 아니에요. 파일을 다시 확인해 주세요.');
  if (!isGif) {
    // Animated WebP/APNG are deliberately rejected instead of silently losing frames.
    const bytes = new Uint8Array(data);
    const view = new DataView(data);
    const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (tag(0) === 'RIFF' && tag(8) === 'WEBP') {
      for (let offset = 12; offset + 8 <= data.byteLength;) {
        if (tag(offset) === 'ANIM') throw new Error('움직이는 WebP는 GIF로 변환한 뒤 올려 주세요.');
        const length = view.getUint32(offset + 4, true);
        offset += 8 + length + (length % 2);
      }
    }
    if (bytes[0] === 137 && tag(1) === 'PNG\r') {
      for (let offset = 8; offset + 8 <= data.byteLength;) {
        if (tag(offset + 4) === 'acTL') throw new Error('움직이는 PNG는 GIF로 변환한 뒤 올려 주세요.');
        offset += 12 + view.getUint32(offset);
      }
    }
  }
  let frameNumber = 0;
  const config: Config = {
    model: quality === 'detail' ? 'isnet_fp16' : 'isnet_quint8',
    device: 'cpu', proxyToWorker: false, output: { format: 'image/png' },
    progress: (key, current, total) => {
      if (key.startsWith('fetch:')) progress(frameNumber ? 12 : 5, 'AI 모델을 준비하고 있어요', total ? `${Math.round(current / total * 100)}% 다운로드 · 첫 사용 시 조금 더 걸려요` : '첫 사용 시 모델을 다운로드해요');
      if (!isGif && key === 'compute:inference') progress(35, '주인공을 찾고 있어요', '사진에 따라 잠시 시간이 걸릴 수 있어요');
      if (!isGif && key === 'compute:encode') progress(90, '투명한 PNG로 저장하고 있어요');
    },
  };
  // Keep the character path independent of AI/model downloads.
  async function removePhoto(surface: OffscreenCanvas) {
    const { removeBackground } = await import('@imgly/background-removal');
    return removeBackground(await surface.convertToBlob({ type: 'image/png' }), config);
  }
  if (!isGif) {
    progress(8, '사진을 불러오고 있어요');
    const bitmap = await createImageBitmap(file);
    const { width, height } = fitSize(bitmap.width, bitmap.height, quality === 'detail' ? 4096 : 2048);
    const { surface, context } = canvas(width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    progress(18, mode === 'character' ? '캐릭터 안쪽을 보호하고 있어요' : '주인공을 찾고 있어요', '처리 중에도 이 탭을 열어 두세요');
    const originalPixels = context.getImageData(0, 0, width, height);
    let outputPixels: ImageData;
    if (mode === 'character') {
      outputPixels = new ImageData(removeCharacterBackground(originalPixels.data, width, height), width, height);
    } else {
      const cutout = await createImageBitmap(await removePhoto(surface));
      context.clearRect(0, 0, width, height);
      context.drawImage(cutout, 0, 0, width, height);
      cutout.close();
      outputPixels = context.getImageData(0, 0, width, height);
      preserveAlpha(outputPixels.data, originalPixels.data);
    }
    context.putImageData(new ImageData(refineEdges(originalPixels.data, outputPixels.data, width, height), width, height), 0, 0);
    const blob = await surface.convertToBlob({ type: 'image/png' });
    send({ type: 'done', blob, width, height, frames: 1 });
    return;
  }
  progress(3, '움짤의 프레임을 확인하고 있어요');
  const gif = parseGIF(data);
  const frames = gif.frames.filter((frame) => 'image' in frame);
  if (!frames.length) throw new Error('GIF에서 이미지를 찾지 못했어요. 다른 파일을 사용해 주세요.');
  if (frames.length > MAX_FRAMES) throw new Error(`이 움짤은 ${frames.length}프레임이에요. 120프레임 이하로 줄인 뒤 다시 올려 주세요.`);
  const sourceWidth = gif.lsd.width;
  const sourceHeight = gif.lsd.height;
  if (sourceWidth * sourceHeight > 4_000_000) throw new Error('GIF는 프레임당 400만 화소까지 처리할 수 있어요. 크기를 줄여 주세요.');
  if (frames.some((frame) => frame.image.descriptor.width * frame.image.descriptor.height > 4_000_000)) throw new Error('너무 큰 GIF 프레임이 포함되어 있어요. 크기를 줄여 주세요.');
  const { width, height } = fitSize(sourceWidth, sourceHeight, quality === 'detail' ? 1024 : 768);
  const firstTransparent = frames[0].gce?.extras.transparentColorGiven;
  const background = firstTransparent ? [0, 0, 0, 0] : [...(gif.gct?.[gif.lsd.backgroundColorIndex] ?? [0, 0, 0]), 255];
  const compose = createCompositor(sourceWidth, sourceHeight, background);
  const source = canvas(sourceWidth, sourceHeight);
  const output = canvas(width, height);
  const encoder = GIFEncoder();
  const repeat = readRepeat(gif);
  for (const rawFrame of frames) {
    const frame = decompressFrame(rawFrame, gif.gct, true);
    const pixels = compose(frame);
    source.context.putImageData(new ImageData(pixels, sourceWidth, sourceHeight), 0, 0);
    output.context.clearRect(0, 0, width, height);
    output.context.drawImage(source.surface, 0, 0, width, height);
    const originalPixels = output.context.getImageData(0, 0, width, height);
    progress(12 + frameNumber / frames.length * 84, '움직임은 남기고, 배경은 지우는 중', `${frameNumber + 1} / ${frames.length} 프레임 · 창을 닫지 말아 주세요`);
    let outputPixels: Uint8ClampedArray;
    if (mode === 'character') {
      outputPixels = removeCharacterBackground(originalPixels.data, width, height);
    } else {
      const bitmap = await createImageBitmap(await removePhoto(output.surface));
      output.context.clearRect(0, 0, width, height);
      output.context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      outputPixels = output.context.getImageData(0, 0, width, height).data;
      preserveAlpha(outputPixels, originalPixels.data);
    }
    const { palette, indices } = transparentPalette(refineEdges(originalPixels.data, outputPixels, width, height));
    encoder.writeFrame(indices, width, height, {
      palette, transparent: true, transparentIndex: 0, dispose: 2,
      // gifuct defaults zero delays to 100ms, so use the original centiseconds.
      delay: rawFrame.gce ? rawFrame.gce.delay * 10 : 100, repeat,
    });
    frameNumber++;
  }
  progress(98, '투명한 GIF로 저장하고 있어요');
  encoder.finish();
  send({ type: 'done', blob: new Blob([encoder.bytes()], { type: 'image/gif' }), width, height, frames: frames.length });
}

self.onmessage = async ({ data }: MessageEvent<ProcessRequest>) => {
  try { await processFile(data); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    const friendly = /[가-힣]/.test(message) ? message : /fetch|network|resource|session/i.test(message)
      ? 'AI 모델을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.'
      : '파일을 처리하지 못했어요. 더 작은 이미지 또는 다른 파일로 다시 시도해 주세요.';
    send({ type: 'error', message: friendly });
  }
};
