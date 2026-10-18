export type Quality = 'fast' | 'detail';
export type ProcessRequest = { file: File; quality: Quality };
export type ProcessUpdate =
  | { type: 'progress'; value: number; message: string; detail?: string }
  | { type: 'done'; blob: Blob; width: number; height: number; frames: number }
  | { type: 'error'; message: string };
