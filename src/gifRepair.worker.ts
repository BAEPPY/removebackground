import { GIFEncoder } from 'gifenc';
import { GifFrames } from './gifFrames';
import { transparentPalette } from './media';
import { analyzeRepair, smartRepair } from './smartRepair';
import { emptyRepairState, pendingAIStrokes, repairMemory, type RepairMemory } from './repairHints';
import { refineEdges } from './edgeMatte';
import type { GifRepairMemory, RepairRequest, RepairUpdate } from './repairProtocol';
import { openAICutout } from './apiImage';
import { AnimatedPng } from './apng';
import { rememberAIBatch } from './aiMask';
import { apiStats, resetAPIStats } from './apiWorker';

let original: GifFrames;
let result: GifFrames;
let width = 0; let height = 0; let selected = 0;
let access = '';
let edits = new Map<number, Blob>();
let memories: Record<number, RepairMemory> = {};
let previous: { edits: Map<number, Blob>; memories: Record<number, RepairMemory> } | null = null;
const send = (message: RepairUpdate) => self.postMessage(message);

async function png(pixels: Uint8ClampedArray<ArrayBuffer>) {
  const surface = new OffscreenCanvas(width, height);
  surface.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0);
  return surface.convertToBlob({ type: 'image/png' });
}
async function editedPixels(index: number) {
  const blob = edits.get(index);
  if (!blob) return result.read(index);
  const image = await createImageBitmap(blob);
  try {
    const surface = new OffscreenCanvas(width, height);
    const context = surface.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  } finally { image.close(); }
}
async function frame(message: string) {
  const source = original.read(selected);
  const memory = memories[selected];
  send({ type: 'frame', frame: selected, frames: original.frames.length, original: await png(source), blob: await png(await clean(selected, source)), canUndo: !!previous, message, pendingMarks: memory ? pendingAIStrokes(memory).length : 0 });
}
async function clean(index: number, source: Uint8ClampedArray<ArrayBuffer>) {
  const memory = memories[index];
  return refineEdges(source, await editedPixels(index), width, height, memory ? new Int8Array(await memory.labels.arrayBuffer()) : undefined);
}
async function encode() {
  const encoder = GIFEncoder();
  const smooth = new AnimatedPng(original.frames.length, original.repeat);
  for (let index = 0; index < original.frames.length; index++) {
    send({ type: 'progress', message: `움직임을 저장하고 있어요 · ${index + 1} / ${original.frames.length} 프레임` });
    const source = original.read(index);
    const cleaned = await clean(index, source);
    await smooth.add(await png(cleaned), original.delay(index));
    const { palette, indices } = transparentPalette(cleaned);
    encoder.writeFrame(indices, width, height, { palette, transparent: true, transparentIndex: 0, dispose: 2, delay: original.delay(index), repeat: original.repeat });
  }
  encoder.finish();
  return { blob: new Blob([encoder.bytes()], { type: 'image/gif' }), smoothBlob: smooth.finish() };
}

async function handle(data: RepairRequest) {
  if (data.type === 'init') {
    access = data.access ?? '';
    width = data.width; height = data.height;
    original = new GifFrames(await data.original.arrayBuffer(), width, height);
    result = new GifFrames(await data.result.arrayBuffer(), width, height);
    if (original.frames.length !== result.frames.length) throw new Error('프레임 수가 맞지 않아요.');
    const memory = data.memory && 'kind' in data.memory ? data.memory : undefined;
    memories = memory?.frames ?? {};
    edits = new Map(Object.entries(memory?.images ?? {}).map(([index, image]) => [Number(index), image])); previous = null; selected = 0;
    await frame('고칠 프레임을 고르고, 남길 부분이나 지울 부분을 대략 표시해 주세요.');
    return;
  }
  if (data.type === 'select') { selected = data.frame; await frame('선택한 프레임에 남길 부분이나 지울 부분을 표시해 주세요.'); return; }
  if (data.type === 'export' || data.type === 'preview') {
    const memory: GifRepairMemory = { kind: 'gif', frames: memories, images: Object.fromEntries(edits) };
    const encoded = await encode();
    if (data.type === 'preview') send({ type: 'preview', blob: encoded.smoothBlob, memory });
    else send({ type: 'export', ...encoded, memory });
    return;
  }
  if (data.type === 'undo') {
    if (previous) { edits = previous.edits; memories = previous.memories; previous = null; }
    await frame('마지막 보정을 되돌렸어요.'); return;
  }
  if (data.type !== 'stroke' && data.type !== 'ai') return;
  const hints = data.type === 'ai' ? pendingAIStrokes(memories[selected] ?? { strokes: [] }) : [data.stroke];
  if (!hints.length) throw new Error('먼저 이 프레임에서 남길 부분이나 지울 부분을 표시해 주세요.');
  resetAPIStats();
  // Commit a multi-frame stroke atomically; cancellation terminates the worker.
  const nextEdits = new Map(edits); const nextMemories = { ...memories };
  const targets = data.scope === 'all' ? original.frames.map((_, i) => i) : [selected];
  let message = '';
  for (const index of targets) {
    send({ type: 'progress', message: `${data.type === 'ai' ? 'GPT로 영역을 보정하고 있어요' : '선택 영역을 보정하고 있어요'} · ${index + 1} / ${original.frames.length} 프레임` });
    const source = original.read(index);
    const memory = memories[index];
    const state = memory ? { ...memory, labels: new Int8Array(await memory.labels.arrayBuffer()) } : emptyRepairState(width, height);
    if (state.labels.length !== width * height) throw new Error('보정 이력을 읽지 못했어요.');
    const current = await editedPixels(index);
    if (data.type === 'ai') {
      // Preserve pending marks made on other frames too. Identical all-frame
      // hints are deduplicated, while order preserves the latest intent.
      const frameHints = index === selected ? hints : [...state.strokes.slice(state.aiApplied ?? 0).filter(h => !hints.some(hint => JSON.stringify(hint) === JSON.stringify(h))), ...hints];
      const output = await openAICutout(source, width, height, access, current, frameHints, data.fresh);
      nextEdits.set(index, await png(output));
      const remembered = rememberAIBatch(current, output, state, frameHints);
      nextMemories[index] = repairMemory(remembered);
      message = 'GPT 영역 보정을 적용했어요. 움직임을 확인하거나 되돌릴 수 있어요.';
      continue;
    }
    const repaired = smartRepair(source, current, width, height, hints[0], analyzeRepair(source, width, height), state);
    nextEdits.set(index, await png(repaired.pixels));
    nextMemories[index] = repairMemory(repaired.state);
    message = repaired.message;
  }
  previous = { edits, memories }; edits = nextEdits; memories = nextMemories;
  await frame(data.type === 'ai' ? `${data.scope === 'all' ? `모든 ${targets.length}프레임 · ` : ''}GPT 영역 보정을 적용했어요 · 새 API ${apiStats.calls}회 · 저장된 결과 ${apiStats.cached}회 재사용` : data.scope === 'all' ? `모든 ${targets.length}프레임의 같은 위치를 보정했어요. 움직임을 확인해 주세요.` : message);
}

// Serialize decode/encode operations even if messages arrive during an await.
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<RepairRequest>) => {
  queue = queue.then(() => handle(data)).catch((error) => send({ type: 'error', message: error instanceof Error && /[가-힣]/.test(error.message) ? error.message : 'GIF를 보정하지 못했어요. 편집을 닫고 다시 시도해 주세요.' }));
};
