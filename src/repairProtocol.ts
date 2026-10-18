import type { RepairMemory, RepairStroke } from './repairHints';

export type GifRepairMemory = { kind: 'gif'; frames: Record<number, RepairMemory> };
export type EditorMemory = RepairMemory | GifRepairMemory;
export type RepairRequest =
  | { type: 'init'; original: Blob; result: Blob; width: number; height: number; memory?: EditorMemory }
  | { type: 'stroke'; stroke: RepairStroke; scope?: 'frame' | 'all' }
  | { type: 'undo' }
  | { type: 'select'; frame: number }
  | { type: 'preview' | 'export' };
export type RepairUpdate =
  | { type: 'ready' }
  | { type: 'result'; blob: Blob; memory: RepairMemory; canUndo: boolean; message: string }
  | { type: 'frame'; blob: Blob; original: Blob; frame: number; frames: number; canUndo: boolean; message: string }
  | { type: 'progress'; message: string }
  | { type: 'preview'; blob: Blob; memory: GifRepairMemory }
  | { type: 'export'; blob: Blob; memory: GifRepairMemory }
  | { type: 'error'; message: string };
