import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Brush, Eraser, Undo2, X } from 'lucide-react';
import { paintMask, type BrushMode, type Point } from './character';

type Props = { original: Blob; result: Blob; width: number; height: number; onApply: (blob: Blob) => void; onClose: () => void };

export default function MaskEditor({ original, result, width, height, onApply, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sourcePixels = useRef<Uint8ClampedArray | null>(null);
  const edited = useRef<ImageData | null>(null);
  const previous = useRef<Uint8ClampedArray | null>(null);
  const lastPoint = useRef<Point | null>(null);
  const activePointer = useRef<number | null>(null);
  const [mode, setMode] = useState<BrushMode>('restore');
  const [size, setSize] = useState(24);
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const source = await createImageBitmap(original);
      let cutout: ImageBitmap | undefined;
      try {
        cutout = await createImageBitmap(result);
        if (!active || !canvas.current) return;
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = width; sourceCanvas.height = height;
        const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })!;
        sourceContext.drawImage(source, 0, 0, width, height);
        sourcePixels.current = sourceContext.getImageData(0, 0, width, height).data;
        const context = canvas.current.getContext('2d', { willReadFrequently: true })!;
        context.drawImage(cutout, 0, 0, width, height);
        edited.current = context.getImageData(0, 0, width, height);
        sourceCanvas.width = 0; sourceCanvas.height = 0;
        setReady(true);
      } finally { source.close(); cutout?.close(); }
    };
    load().catch(() => { if (active) setError('편집할 이미지를 불러오지 못했어요. 닫고 다시 시도해 주세요.'); });
    return () => { active = false; sourcePixels.current = null; edited.current = null; previous.current = null; };
  }, [original, result, width, height]);

  function paint(event: PointerEvent<HTMLCanvasElement>, start: boolean) {
    if (!ready || saving || !canvas.current || !edited.current || !sourcePixels.current) return;
    if (start) {
      if (activePointer.current !== null || event.button !== 0) return;
      activePointer.current = event.pointerId;
      canvas.current.setPointerCapture(event.pointerId);
      previous.current = edited.current.data.slice();
      setCanUndo(true);
    } else if (activePointer.current !== event.pointerId) return;
    const rect = canvas.current.getBoundingClientRect();
    const point = { x: (event.clientX - rect.left) * width / rect.width, y: (event.clientY - rect.top) * height / rect.height };
    paintMask(edited.current.data, sourcePixels.current, width, height, start ? point : lastPoint.current ?? point, point, size / 2 * width / rect.width, mode);
    canvas.current.getContext('2d')!.putImageData(edited.current, 0, 0);
    lastPoint.current = point;
  }

  function endStroke(event: PointerEvent<HTMLCanvasElement>) {
    if (activePointer.current !== event.pointerId) return;
    if (canvas.current?.hasPointerCapture(event.pointerId)) canvas.current.releasePointerCapture(event.pointerId);
    activePointer.current = null; lastPoint.current = null;
  }

  function undo() {
    if (!previous.current || !edited.current || !canvas.current) return;
    edited.current.data.set(previous.current);
    canvas.current.getContext('2d')!.putImageData(edited.current, 0, 0);
    previous.current = null; setCanUndo(false);
  }

  function apply() {
    if (!ready || saving || !canvas.current) return;
    setSaving(true);
    canvas.current.toBlob((blob) => {
      if (blob) onApply(blob);
      else { setError('편집 결과를 저장하지 못했어요. 다시 시도해 주세요.'); setSaving(false); }
    }, 'image/png');
  }

  return <dialog className="mask-editor" ref={dialog} aria-labelledby="editor-title" onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="editor-heading"><div><h2 id="editor-title">필요한 부분만 직접 다듬기</h2><p>복원은 원본의 털·눈·입과 색을 그대로 되살려요.</p></div><button className="icon-button" onClick={onClose} disabled={saving} aria-label="편집 닫기"><X size={20} /></button></div>
    <div className="editor-tools"><div className="editor-brushes"><button aria-pressed={mode === 'restore'} onClick={() => setMode('restore')} disabled={saving}><Brush size={16} />복원</button><button aria-pressed={mode === 'erase'} onClick={() => setMode('erase')} disabled={saving}><Eraser size={16} />지우기</button></div><label>브러시 크기<input aria-label="브러시 크기" type="range" min="4" max="80" value={size} onChange={(event) => setSize(Number(event.target.value))} disabled={saving} /><span>{size}</span></label><button className="editor-undo" onClick={undo} disabled={!canUndo || saving} title="마지막 붓질 되돌리기"><Undo2 size={16} />되돌리기</button></div>
    <div className="editor-canvas-wrap checker"><canvas ref={canvas} width={width} height={height} aria-label="복원 또는 지우기 브러시로 편집할 이미지" onPointerDown={(event) => paint(event, true)} onPointerMove={(event) => paint(event, false)} onPointerUp={endStroke} onPointerCancel={endStroke} onLostPointerCapture={endStroke} /></div>
    <p className="editor-help">{ready ? '마우스나 손가락으로 칠해 주세요. 잘못 칠했으면 마지막 붓질을 되돌릴 수 있어요.' : '원본과 결과를 불러오는 중이에요…'}</p>
    {error && <p role="alert" className="error-message">{error}</p>}
    <div className="editor-actions"><button className="editor-cancel" onClick={onClose} disabled={saving}>취소</button><button className="primary" onClick={apply} disabled={!ready || saving}>{saving ? '저장 중…' : '편집 적용'}</button></div>
  </dialog>;
}
