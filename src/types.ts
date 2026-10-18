export type Quality = 'fast' | 'detail';
export type RemovalMode = 'character' | 'photo' | 'openai';
export type ProcessRequest = { file: File; quality: Quality; mode: RemovalMode; access?: string };
export type ProcessUpdate =
  | { type: 'progress'; value: number; message: string; detail?: string }
  | { type: 'done'; blob: Blob; smoothBlob?: Blob; repair?: EditorMemory; width: number; height: number; frames: number }
  | { type: 'error'; message: string };
import type { EditorMemory } from './repairProtocol';
