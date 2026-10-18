import { analyzeRepair, smartRepair } from './smartRepair';
import { emptyRepairState, type RepairState } from './repairHints';
import { refineEdges } from './edgeMatte';
import type { RepairRequest, RepairUpdate } from './repairProtocol';

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
      const memory = data.memory && !('kind' in data.memory) ? data.memory : undefined;
      state = memory ? { labels: new Int8Array(await memory.labels.arrayBuffer()), strokes: memory.strokes } : emptyRepairState(width, height);
      if (state.labels.length !== width * height) throw new Error('Invalid repair history');
      previous = null;
      send({ type: 'ready' });
      return;
    }
    let message = '마지막 보정을 되돌렸어요.';
    if (data.type === 'undo') {
      if (previous) { edited = previous.pixels; analysis = previous.analysis; state = previous.state; previous = null; }
    } else if (data.type === 'stroke') {
      const repaired = smartRepair(source, edited, width, height, data.stroke, analysis, state);
      // Even a stroke that finds no new pixels changes the next retry's reach.
      previous = { pixels: edited, analysis, state };
      edited = repaired.pixels; analysis = repaired.regions; state = repaired.state;
      message = repaired.message;
    } else return;
    const surface = new OffscreenCanvas(width, height);
    // Keep correction history based on the logical mask. Render the same
    // cleaned RGBA for the editor, the main preview and the downloaded PNG.
    surface.getContext('2d')!.putImageData(new ImageData(refineEdges(source, edited, width, height), width, height), 0, 0);
    send({ type: 'result', blob: await surface.convertToBlob({ type: 'image/png' }), memory: { labels: new Blob([state.labels]), strokes: state.strokes }, canUndo: !!previous, message });
  } catch {
    send({ type: 'error', message: '보정하지 못했어요. 편집을 닫고 다시 시도해 주세요.' });
  }
};
