import { analyzeRepair, smartRepair } from './smartRepair';
import { emptyRepairState, type RepairMemory, type RepairState, type RepairStroke } from './repairHints';

export type RepairRequest =
  | { type: 'init'; original: Blob; result: Blob; width: number; height: number; memory?: RepairMemory }
  | { type: 'stroke'; stroke: RepairStroke }
  | { type: 'undo' };
export type RepairUpdate = { type: 'ready' } | { type: 'result'; blob: Blob; memory: RepairMemory; canUndo: boolean; message: string } | { type: 'error'; message: string };

let width = 0; let height = 0;
let source: Uint8ClampedArray;
let edited: Uint8ClampedArray<ArrayBuffer>;
let state: RepairState;
let previous: { pixels: Uint8ClampedArray<ArrayBuffer>; analysis: ReturnType<typeof analyzeRepair>; state: RepairState } | null = null;
let analysis: ReturnType<typeof analyzeRepair>;
const send = (message: RepairUpdate) => self.postMessage(message);

async function pixels(blob: Blob, context: OffscreenCanvasRenderingContext2D) {
  const image = await createImageBitmap(blob);
  try { context.clearRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height); return context.getImageData(0, 0, width, height).data; }
  finally { image.close(); }
}

self.onmessage = async ({ data }: MessageEvent<RepairRequest>) => {
  try {
    if (data.type === 'init') {
      width = data.width; height = data.height;
      const surface = new OffscreenCanvas(width, height);
      const context = surface.getContext('2d', { willReadFrequently: true })!;
      source = await pixels(data.original, context);
      edited = await pixels(data.result, context);
      analysis = analyzeRepair(source, width, height);
      state = data.memory ? { labels: new Int8Array(await data.memory.labels.arrayBuffer()), strokes: data.memory.strokes } : emptyRepairState(width, height);
      if (state.labels.length !== width * height) throw new Error('Invalid repair history');
      previous = null;
      send({ type: 'ready' });
      return;
    }
    let message = '마지막 보정을 되돌렸어요.';
    if (data.type === 'undo') {
      if (previous) { edited = previous.pixels; analysis = previous.analysis; state = previous.state; previous = null; }
    } else {
      const repaired = smartRepair(source, edited, width, height, data.stroke, analysis, state);
      // Even a stroke that finds no new pixels changes the next retry's reach.
      previous = { pixels: edited, analysis, state };
      edited = repaired.pixels; analysis = repaired.regions; state = repaired.state;
      message = repaired.message;
    }
    const surface = new OffscreenCanvas(width, height);
    surface.getContext('2d')!.putImageData(new ImageData(edited, width, height), 0, 0);
    send({ type: 'result', blob: await surface.convertToBlob({ type: 'image/png' }), memory: { labels: new Blob([state.labels]), strokes: state.strokes }, canUndo: !!previous, message });
  } catch {
    send({ type: 'error', message: '보정하지 못했어요. 편집을 닫고 다시 시도해 주세요.' });
  }
};
