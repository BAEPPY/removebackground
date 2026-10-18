import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Brush, Eraser, LoaderCircle, Undo2, X } from 'lucide-react';
import type { BrushMode, Point } from './character';
import type { RepairRequest, RepairUpdate } from './repair.worker';
import type { RepairMemory } from './repairHints';

type Props = { original: Blob; result: Blob; width: number; height: number; memory?: RepairMemory; onApply: (blob: Blob, memory?: RepairMemory) => void; onClose: () => void };

export default function MaskEditor({ original, result, width, height, memory, onApply, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const worker = useRef<Worker | null>(null);
  const bitmap = useRef<ImageBitmap | null>(null);
  const output = useRef(result);
  const strokePoints = useRef<Point[]>([]);
  const strokeRadius = useRef(1);
  const outputMemory = useRef(memory);
  const lastPoint = useRef<Point | null>(null);
  const activePointer = useRef<number | null>(null);
  const pending = useRef(false);
  const [mode, setMode] = useState<BrushMode>('restore');
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [message, setMessage] = useState('원본의 윤곽을 살펴보고 있어요…');
  const [error, setError] = useState('');

  function redraw() {
    const context = canvas.current?.getContext('2d');
    if (context && bitmap.current) { context.clearRect(0, 0, width, height); context.drawImage(bitmap.current, 0, 0); }
  }

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    let active = true;
    const processor = new Worker(new URL('./repair.worker.ts', import.meta.url), { type: 'module' });
    worker.current = processor;
    const fail = () => { if (active) { pending.current = false; setBusy(false); setError('편집을 준비하지 못했어요. 닫고 다시 시도해 주세요.'); } };
    processor.onerror = fail;
    processor.onmessage = async ({ data }: MessageEvent<RepairUpdate>) => {
      if (!active) return;
      if (data.type === 'ready') { setReady(true); setMessage('남길 부분이나 지울 부분 안쪽을 한 번 누르거나 대략 그어 주세요.'); return; }
      if (data.type === 'error') { pending.current = false; setBusy(false); setError(data.message); return; }
      try {
        const next = await createImageBitmap(data.blob);
        if (!active) { next.close(); return; }
        bitmap.current?.close(); bitmap.current = next;
        output.current = data.blob;
        outputMemory.current = data.memory;
        redraw();
        setCanUndo(data.canUndo); setMessage(data.message);
        pending.current = false; setBusy(false);
      } catch { fail(); }
    };
    createImageBitmap(result).then((image) => {
      if (!active) { image.close(); return; }
      bitmap.current = image; redraw();
      processor.postMessage({ type: 'init', original, result, width, height, memory } satisfies RepairRequest);
    }).catch(fail);
    return () => { active = false; processor.terminate(); worker.current = null; bitmap.current?.close(); bitmap.current = null; };
  }, [original, result, width, height, memory]);

  function drawHint(event: PointerEvent<HTMLCanvasElement>, start: boolean) {
    if (!ready || pending.current || !canvas.current) return;
    if (start) {
      if (activePointer.current !== null || event.button !== 0) return;
      activePointer.current = event.pointerId;
      canvas.current.setPointerCapture(event.pointerId);
      setDrawing(true); setError('');
    } else if (activePointer.current !== event.pointerId) return;
    const rect = canvas.current.getBoundingClientRect();
    const point = { x: (event.clientX - rect.left) * width / rect.width, y: (event.clientY - rect.top) * height / rect.height };
    if (start) { strokePoints.current = []; strokeRadius.current = 9 * width / rect.width; }
    const previousPoint = strokePoints.current.at(-1);
    if (!previousPoint || Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y) >= Math.max(.5, strokeRadius.current / 4)) {
      strokePoints.current.push(point);
      // Bound very long pointer sessions without dropping the path's endpoints.
      if (strokePoints.current.length > 4096) strokePoints.current = strokePoints.current.filter((_, i, points) => i % 2 === 0 || i === points.length - 1);
    }
    const from = start ? point : lastPoint.current ?? point;
    const context = canvas.current.getContext('2d')!;
    context.strokeStyle = mode === 'restore' ? '#67a83d99' : '#e16d7999';
    context.lineWidth = 18 * width / rect.width;
    context.lineCap = 'round'; context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(point.x + .01, point.y); context.stroke();
    lastPoint.current = point;
  }

  function endStroke(event: PointerEvent<HTMLCanvasElement>, cancel = false) {
    if (activePointer.current !== event.pointerId) return;
    if (!cancel && canvas.current) {
      const rect = canvas.current.getBoundingClientRect();
      strokePoints.current.push({ x: (event.clientX - rect.left) * width / rect.width, y: (event.clientY - rect.top) * height / rect.height });
    }
    activePointer.current = null; lastPoint.current = null; setDrawing(false);
    if (canvas.current?.hasPointerCapture(event.pointerId)) canvas.current.releasePointerCapture(event.pointerId);
    redraw();
    if (!cancel && strokePoints.current.length) {
      pending.current = true; setBusy(true); setMessage('윤곽에 맞춰 보정하고 있어요…');
      worker.current?.postMessage({ type: 'stroke', stroke: { points: strokePoints.current, radius: strokeRadius.current, mode } } satisfies RepairRequest);
    }
    strokePoints.current = [];
  }

  function undo() {
    if (!canUndo || pending.current || activePointer.current !== null) return;
    pending.current = true; setBusy(true); setError('');
    worker.current?.postMessage({ type: 'undo' } satisfies RepairRequest);
  }

  const locked = busy || drawing;
  return <dialog className="mask-editor" ref={dialog} aria-labelledby="editor-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="editor-heading"><div><h2 id="editor-title">남길 곳을 알려 주세요</h2><p>칠한 선 전체를 반영해요. 같은 곳을 다시 칠하면 주변까지 더 넓게 보정해요.</p></div><button className="icon-button" onClick={onClose} aria-label="편집 닫기"><X size={20} /></button></div>
    <div className="editor-tools"><div className="editor-brushes"><button aria-pressed={mode === 'restore'} onClick={() => setMode('restore')} disabled={locked}><Brush size={16} />남길 부분 복원</button><button aria-pressed={mode === 'erase'} onClick={() => setMode('erase')} disabled={locked}><Eraser size={16} />남은 배경 지우기</button></div><button className="editor-undo" onClick={undo} disabled={!canUndo || locked} title="마지막 영역 보정 되돌리기"><Undo2 size={16} />되돌리기</button></div>
    <div className="editor-canvas-wrap checker" aria-busy={!ready || busy}><canvas ref={canvas} width={width} height={height} style={{ width: `min(100%, ${width / height * 44}vh)` }} aria-label="남기거나 지울 영역을 대략 표시할 이미지" onPointerDown={(event) => drawHint(event, true)} onPointerMove={(event) => drawHint(event, false)} onPointerUp={(event) => endStroke(event)} onPointerCancel={(event) => endStroke(event, true)} onLostPointerCapture={(event) => endStroke(event, true)} />{(!ready || busy) && <div className="editor-busy"><LoaderCircle size={20} className="spin" /><span>{ready ? '윤곽에 맞추는 중' : '윤곽을 살펴보는 중'}</span></div>}</div>
    <p className="editor-help" role="status">{message}</p>
    <p className="editor-tip">선이 끊겨 있어도 표시한 부분을 복원해요. 남은 부분까지 이어서 칠하거나 같은 곳을 다시 표시해 주세요. 잘못 반영된 보정은 되돌릴 수 있어요.</p>
    {error && <p role="alert" className="error-message">{error}</p>}
    <div className="editor-actions"><button className="editor-cancel" onClick={onClose}>취소</button><button className="primary" onClick={() => { if (ready && !pending.current && activePointer.current === null) onApply(output.current, outputMemory.current); }} disabled={!ready || locked}>편집 적용</button></div>
  </dialog>;
}
