import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Brush, Eraser, Eye, LoaderCircle, Play, Square, Undo2, X } from 'lucide-react';
import type { BrushMode, Point } from './character';
import type { EditorMemory, RepairRequest, RepairUpdate } from './repairProtocol';

type Props = { original: Blob; result: Blob; width: number; height: number; memory?: EditorMemory; onApply: (blob: Blob, memory?: EditorMemory) => void; onClose: () => void };

export default function MaskEditor({ original, result, width, height, memory, onApply, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const worker = useRef<Worker | null>(null);
  const bitmap = useRef<ImageBitmap | null>(null);
  const sourceBitmap = useRef<ImageBitmap | null>(null);
  const showOriginal = useRef(false);
  const previewUrl = useRef('');
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
  const animated = result.type === 'image/gif';
  const [frame, setFrame] = useState(0);
  const [frames, setFrames] = useState(1);
  const [scope, setScope] = useState<'frame' | 'all'>('frame');
  const [sourceVisible, setSourceVisible] = useState(false);
  const [playing, setPlaying] = useState('');

  function redraw() {
    const context = canvas.current?.getContext('2d');
    const image = showOriginal.current ? sourceBitmap.current : bitmap.current;
    if (context && image) { context.clearRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height); }
  }

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    let active = true;
    const processor = animated
      ? new Worker(new URL('./gifRepair.worker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./repair.worker.ts', import.meta.url), { type: 'module' });
    worker.current = processor;
    const fail = () => { if (active) { pending.current = false; setBusy(false); setError('편집을 준비하지 못했어요. 닫고 다시 시도해 주세요.'); } };
    processor.onerror = fail;
    processor.onmessage = async ({ data }: MessageEvent<RepairUpdate>) => {
      if (!active) return;
      if (data.type === 'ready') { setReady(true); setMessage('남길 부분이나 지울 부분 안쪽을 한 번 누르거나 대략 그어 주세요.'); return; }
      if (data.type === 'progress') { setMessage(data.message); return; }
      if (data.type === 'error') { pending.current = false; setBusy(false); setError(data.message); return; }
      try {
        if (data.type === 'export') { onApply(data.blob, data.memory); return; }
        if (data.type === 'preview') {
          if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
          previewUrl.current = URL.createObjectURL(data.blob); setPlaying(previewUrl.current);
          pending.current = false; setBusy(false); setMessage('움직임을 확인한 뒤 편집으로 돌아가거나 적용해 주세요.'); return;
        }
        const next = await createImageBitmap(data.blob);
        if (!active) { next.close(); return; }
        bitmap.current?.close(); bitmap.current = next;
        if (data.type === 'frame') {
          const source = await createImageBitmap(data.original);
          if (!active) { source.close(); return; }
          sourceBitmap.current?.close(); sourceBitmap.current = source;
          setFrame(data.frame); setFrames(data.frames); setReady(true);
        } else {
          output.current = data.blob; outputMemory.current = data.memory;
        }
        redraw();
        setCanUndo(data.canUndo); setMessage(data.message);
        pending.current = false; setBusy(false);
      } catch { fail(); }
    };
    async function initialize() {
      if (animated) { processor.postMessage({ type: 'init', original, result, width, height, memory } satisfies RepairRequest); return; }
      const image = await createImageBitmap(result);
      if (!active) { image.close(); return; }
      bitmap.current = image; redraw();
      const source = await createImageBitmap(original);
      if (!active) { source.close(); return; }
      sourceBitmap.current = source;
      processor.postMessage({ type: 'init', original, result, width, height, memory } satisfies RepairRequest);
    }
    void initialize().catch(fail);
    return () => { active = false; processor.terminate(); worker.current = null; bitmap.current?.close(); bitmap.current = null; sourceBitmap.current?.close(); sourceBitmap.current = null; if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); };
  }, [original, result, width, height, memory]);

  function drawHint(event: PointerEvent<HTMLCanvasElement>, start: boolean) {
    if (!ready || pending.current || playing || !canvas.current) return;
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
      showOriginal.current = false; setSourceVisible(false);
      worker.current?.postMessage({ type: 'stroke', stroke: { points: strokePoints.current, radius: strokeRadius.current, mode }, scope } satisfies RepairRequest);
    }
    strokePoints.current = [];
  }

  function undo() {
    if (!canUndo || pending.current || activePointer.current !== null) return;
    pending.current = true; setBusy(true); setError('');
    worker.current?.postMessage({ type: 'undo' } satisfies RepairRequest);
  }

  function request(data: RepairRequest) {
    if (!ready || pending.current || activePointer.current !== null) return;
    pending.current = true; setBusy(true); setError('');
    worker.current?.postMessage(data);
  }

  function apply() {
    if (!ready || pending.current || activePointer.current !== null) return;
    if (animated) request({ type: 'export' });
    else onApply(output.current, outputMemory.current);
  }

  const locked = busy || drawing || !!playing || !ready;
  return <dialog className="mask-editor" ref={dialog} aria-labelledby="editor-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="editor-heading"><div><h2 id="editor-title">남길 곳을 알려 주세요</h2><p>칠한 선 전체를 반영해요. 같은 곳을 다시 칠하면 주변까지 더 넓게 보정해요.</p></div><button className="icon-button" onClick={onClose} aria-label="편집 닫기"><X size={20} /></button></div>
    <div className="editor-tools"><div className="editor-brushes"><button aria-pressed={mode === 'restore'} onClick={() => setMode('restore')} disabled={locked}><Brush size={16} />남길 부분 복원</button><button aria-pressed={mode === 'erase'} onClick={() => setMode('erase')} disabled={locked}><Eraser size={16} />남은 배경 지우기</button></div><button className="editor-undo" onClick={undo} disabled={!canUndo || locked} title="마지막 영역 보정 되돌리기"><Undo2 size={16} />되돌리기</button></div>
    {animated && <div className="editor-timeline"><label>프레임 <strong>{frame + 1} / {frames}</strong><input type="range" min="0" max={frames - 1} value={frame} disabled={locked} aria-label="GIF 편집 프레임" onChange={(event) => request({ type: 'select', frame: Number(event.target.value) })} /></label><label>표시를 적용할 곳<select value={scope} disabled={locked} onChange={(event) => setScope(event.target.value as 'frame' | 'all')} aria-label="GIF 보정 적용 범위"><option value="frame">이 프레임만</option><option value="all">모든 프레임의 같은 위치</option></select></label><p>움직임을 자동으로 따라가지는 않아요. 위치가 달라지는 부분은 프레임을 골라 표시해 주세요.</p></div>}
    <div className="editor-view-tools"><button aria-pressed={sourceVisible} disabled={locked} onClick={() => { showOriginal.current = !showOriginal.current; setSourceVisible(showOriginal.current); redraw(); }}><Eye size={15} />{sourceVisible ? '보정 결과 보기' : '원본 보며 표시'}</button>{animated && <button disabled={busy || drawing || !ready} onClick={() => { if (playing) setPlaying(''); else request({ type: 'preview' }); }}>{playing ? <Square size={14} /> : <Play size={14} />}{playing ? '편집으로 돌아가기' : '움직임 미리보기'}</button>}</div>
    <div className="editor-canvas-wrap checker" aria-busy={!ready || busy}><canvas ref={canvas} width={width} height={height} style={{ width: `min(100%, ${width / height * 44}vh)`, display: playing ? 'none' : undefined }} aria-label="남기거나 지울 영역을 대략 표시할 이미지" onPointerDown={(event) => drawHint(event, true)} onPointerMove={(event) => drawHint(event, false)} onPointerUp={(event) => endStroke(event)} onPointerCancel={(event) => endStroke(event, true)} onLostPointerCapture={(event) => endStroke(event, true)} />{playing && <img src={playing} alt="영역 보정한 GIF 움직임 미리보기" style={{ width: `min(100%, ${width / height * 44}vh)` }} />}{(!ready || busy) && <div className="editor-busy"><LoaderCircle size={20} className="spin" /><span>{ready ? '보정 결과를 준비하는 중' : '윤곽을 살펴보는 중'}</span></div>}</div>
    <p className="editor-help" role="status">{message}</p>
    <p className="editor-tip">선이 끊겨 있어도 표시한 부분을 복원해요. 남은 부분까지 이어서 칠하거나 같은 곳을 다시 표시해 주세요. 잘못 반영된 보정은 되돌릴 수 있어요.</p>
    {error && <p role="alert" className="error-message">{error}</p>}
    <div className="editor-actions"><button className="editor-cancel" onClick={onClose}>취소</button><button className="primary" onClick={apply} disabled={!ready || busy || drawing}>편집 적용</button></div>
  </dialog>;
}
