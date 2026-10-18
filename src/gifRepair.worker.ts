import { GIFEncoder } from 'gifenc';
import { GifFrames } from './gifFrames';
import { transparentPalette } from './media';
import { analyzeRepair, smartRepair } from './smartRepair';
import { emptyRepairState, type RepairMemory } from './repairHints';
import { refineEdges } from './edgeMatte';
import type { GifRepairMemory, RepairRequest, RepairUpdate } from './repairProtocol';

let original: GifFrames;
let result: GifFrames;
let width = 0; let height = 0; let selected = 0;
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
  send({ type: 'frame', frame: selected, frames: original.frames.length, original: await png(source), blob: await png(refineEdges(source, await editedPixels(selected), width, height)), canUndo: !!previous, message });
}
async function encode() {
  const encoder = GIFEncoder();
  for (let index = 0; index < original.frames.length; index++) {
    send({ type: 'progress', message: `움직임을 저장하고 있어요 · ${index + 1} / ${original.frames.length} 프레임` });
    const source = original.read(index);
    const { palette, indices } = transparentPalette(refineEdges(source, await editedPixels(index), width, height));
    encoder.writeFrame(indices, width, height, { palette, transparent: true, transparentIndex: 0, dispose: 2, delay: original.delay(index), repeat: original.repeat });
  }
  encoder.finish();
  return new Blob([encoder.bytes()], { type: 'image/gif' });
}

async function handle(data: RepairRequest) {
  if (data.type === 'init') {
    width = data.width; height = data.height;
    original = new GifFrames(await data.original.arrayBuffer(), width, height);
    result = new GifFrames(await data.result.arrayBuffer(), width, height);
    if (original.frames.length !== result.frames.length) throw new Error('프레임 수가 맞지 않아요.');
    memories = data.memory && 'kind' in data.memory ? data.memory.frames : {};
    edits = new Map(); previous = null; selected = 0;
    await frame('고칠 프레임을 고르고, 남길 부분이나 지울 부분을 대략 표시해 주세요.');
    return;
  }
  if (data.type === 'select') { selected = data.frame; await frame('선택한 프레임에 남길 부분이나 지울 부분을 표시해 주세요.'); return; }
  if (data.type === 'export' || data.type === 'preview') {
    const memory: GifRepairMemory = { kind: 'gif', frames: memories };
    send({ type: data.type, blob: await encode(), memory }); return;
  }
  if (data.type === 'undo') {
    if (previous) { edits = previous.edits; memories = previous.memories; previous = null; }
    await frame('마지막 보정을 되돌렸어요.'); return;
  }
  if (data.type !== 'stroke') return;
  // Commit a multi-frame stroke atomically; cancellation terminates the worker.
  const nextEdits = new Map(edits); const nextMemories = { ...memories };
  const targets = data.scope === 'all' ? original.frames.map((_, i) => i) : [selected];
  let message = '';
  for (const index of targets) {
    send({ type: 'progress', message: `선택 영역을 보정하고 있어요 · ${index + 1} / ${original.frames.length} 프레임` });
    const source = original.read(index);
    const memory = memories[index];
    const state = memory ? { labels: new Int8Array(await memory.labels.arrayBuffer()), strokes: memory.strokes } : emptyRepairState(width, height);
    if (state.labels.length !== width * height) throw new Error('보정 이력을 읽지 못했어요.');
    const repaired = smartRepair(source, await editedPixels(index), width, height, data.stroke, analyzeRepair(source, width, height), state);
    nextEdits.set(index, await png(repaired.pixels));
    nextMemories[index] = { labels: new Blob([repaired.state.labels]), strokes: repaired.state.strokes };
    message = repaired.message;
  }
  previous = { edits, memories }; edits = nextEdits; memories = nextMemories;
  await frame(data.scope === 'all' ? `모든 ${targets.length}프레임의 같은 위치를 보정했어요. 움직임을 확인해 주세요.` : message);
}

// Serialize decode/encode operations even if messages arrive during an await.
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<RepairRequest>) => {
  queue = queue.then(() => handle(data)).catch(() => send({ type: 'error', message: 'GIF를 보정하지 못했어요. 편집을 닫고 다시 시도해 주세요.' }));
};
