import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowRight, Check, ChevronDown, ImagePlus, Layers2, LoaderCircle, LockKeyhole, MoveHorizontal, MousePointer2, Scan, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import { downloadName, validateFile } from './media';
import type { ProcessUpdate, Quality } from './types';

type Result = { url: string; blob: Blob; width: number; height: number; frames: number };
const backgrounds = [
  { name: '투명', color: 'transparent' }, { name: '화이트', color: '#ffffff' },
  { name: '라임', color: '#d9efbc' }, { name: '라벤더', color: '#dcd5f1' }, { name: '다크', color: '#30332d' },
];

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [original, setOriginal] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [quality, setQuality] = useState<Quality>('fast');
  const [error, setError] = useState('');
  const [status, setStatus] = useState({ value: 0, message: '', detail: '' });
  const [split, setSplit] = useState(48);
  const [background, setBackground] = useState('transparent');
  const [view, setView] = useState<'compare' | 'result'>('compare');
  const [dragging, setDragging] = useState(false);
  const [sampleLoading, setSampleLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const urls = useRef<string[]>([]);
  const depth = useRef(0);
  const makeUrl = (blob: Blob) => { const url = URL.createObjectURL(blob); urls.current.push(url); return url; };
  const clearUrls = () => { urls.current.forEach(URL.revokeObjectURL); urls.current = []; };

  useEffect(() => () => { worker.current?.terminate(); urls.current.forEach(URL.revokeObjectURL); }, []);

  const selectFile = useCallback((selected: File) => {
    if (busy) return;
    const issue = validateFile(selected);
    if (issue) { setError(issue); return; }
    // JFIF contains JPEG data, but some systems label it with a generic MIME type.
    const image = /\.jfif$/i.test(selected.name) && selected.type !== 'image/jpeg'
      ? new File([selected], selected.name, { type: 'image/jpeg', lastModified: selected.lastModified })
      : selected;
    clearUrls();
    setError(''); setFile(image); setOriginal(makeUrl(image)); setResult(null);
    setView('compare'); setSplit(48);
  }, [busy]);

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const selected = Array.from(event.clipboardData?.files ?? []).find((item) => item.type.startsWith('image/') || /\.jfif$/i.test(item.name));
      if (selected) { event.preventDefault(); selectFile(selected); }
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, [selectFile]);

  function reset() {
    worker.current?.terminate(); worker.current = null;
    clearUrls(); setBusy(false); setFile(null); setOriginal(''); setResult(null); setError('');
    if (fileInput.current) fileInput.current.value = '';
  }

  function cancel() {
    worker.current?.terminate(); worker.current = null; setBusy(false);
    setStatus({ value: 0, message: '처리를 취소했어요. 다시 시작할 수 있어요.', detail: '' });
  }

  function process() {
    if (!file || busy) return;
    if (!('OffscreenCanvas' in window) || !('Worker' in window)) {
      setError('최신 Chrome, Edge 또는 Safari에서 열어 주세요. 이 브라우저에서는 배경 제거를 지원하지 않아요.'); return;
    }
    setBusy(true); setError(''); setStatus({ value: 2, message: '이미지를 준비하고 있어요', detail: '' });
    try {
      worker.current ??= new Worker(new URL('./processor.worker.ts', import.meta.url), { type: 'module' });
      worker.current.onmessage = ({ data }: MessageEvent<ProcessUpdate>) => {
        if (data.type === 'progress') setStatus({ value: data.value, message: data.message, detail: data.detail ?? '' });
        if (data.type === 'error') {
          setError(data.message); setBusy(false); worker.current?.terminate(); worker.current = null;
        }
        if (data.type === 'done') {
          setResult({ ...data, url: makeUrl(data.blob) }); setBusy(false); setView('compare');
          setStatus({ value: 100, message: '배경 제거가 완료되었어요!', detail: '' });
        }
      };
      worker.current.onerror = () => {
        setError('처리가 중단되었어요. 다른 탭을 닫거나 더 작은 파일로 다시 시도해 주세요.');
        setBusy(false); worker.current?.terminate(); worker.current = null;
      };
      worker.current.postMessage({ file, quality });
    } catch {
      setError('배경 제거를 시작하지 못했어요. 브라우저를 새로고침하고 다시 시도해 주세요.'); setBusy(false);
    }
  }

  async function loadSample() {
    setSampleLoading(true); setError('');
    try {
      const image = new Image(); image.src = '/sample.svg'; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 640;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#eecaba'; context.fillRect(0, 0, 640, 640); context.drawImage(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(), 'image/png'));
      selectFile(new File([blob], 'sunflower.png', { type: 'image/png' }));
    } catch { setError('예시를 불러오지 못했어요. 직접 이미지를 선택해 주세요.'); }
    finally { setSampleLoading(false); }
  }

  function download() {
    if (!result || !file) return;
    const anchor = document.createElement('a'); anchor.href = result.url;
    anchor.download = downloadName(file.name, result.blob.type === 'image/gif');
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
  }

  const isDemo = !file;
  const canCompare = isDemo || !!result;
  const previewStyle = background === 'transparent' ? {} : { backgroundColor: background, backgroundImage: 'none' };
  const outputSrc = result?.url ?? '/sample.svg';

  return <>
    <header className="site-header">
      <a href="#" className="brand" aria-label="off. 홈"><span className="brand-mark"><Scan size={23} strokeWidth={2.2} /></span>off<span className="brand-dot">.</span></a>
      <nav aria-label="주요 메뉴"><a className="active" href="#studio">배경 지우기</a><a href="#how">사용 방법</a><a href="#faq">자주 묻는 질문</a></nav>
      <span className="header-note"><LockKeyhole size={14} /> 내 기기에서 안전하게</span>
    </header>

    <main>
      <section className="hero" id="studio" aria-labelledby="hero-title">
        <div className="hero-copy">
          <div className="eyebrow"><span /> LESS BACKGROUND, MORE YOU</div>
          <h1 id="hero-title">배경은 빼고,<br /><span>주인공만</span> 남기세요<span className="title-dot">.</span></h1>
          <p className="intro">사진 한 장부터 움직이는 GIF까지.<br />복잡한 편집 없이, 필요한 모습만 가볍게 꺼내세요.</p>

          <div className={`upload-card ${dragging ? 'dragging' : ''}`}
            onDragEnter={(event) => { event.preventDefault(); depth.current++; if (!busy) setDragging(true); }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; }}
            onDragLeave={(event) => { event.preventDefault(); depth.current--; if (depth.current <= 0) setDragging(false); }}
            onDrop={(event) => { event.preventDefault(); depth.current = 0; setDragging(false); if (event.dataTransfer.files[0]) selectFile(event.dataTransfer.files[0]); }}>
            <input ref={fileInput} type="file" accept=".jfif,image/jpeg,image/png,image/webp,image/gif" className="visually-hidden" disabled={busy}
              onChange={(event) => { if (event.target.files?.[0]) selectFile(event.target.files[0]); event.target.value = ''; }} aria-label="사진 또는 GIF 선택" />
            {!file ? <>
              <div className="upload-symbol"><ImagePlus size={26} strokeWidth={1.5} /><span className="tiny-spark">✦</span></div>
              <button className="primary upload-button" onClick={() => fileInput.current?.click()}><Upload size={18} /> 이미지 선택 <ArrowRight size={18} /></button>
              <p className="drop-copy">여기에 파일을 끌어다 놓아도 좋아요</p>
              <p className="file-types">JPG · JFIF · PNG · WebP · GIF <span>최대 20MB</span></p>
            </> : <>
              <div className="selected-file"><div className="file-icon"><Layers2 size={22} /></div><div><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(2)} MB · {/\.gif$/i.test(file.name) ? '움직이는 GIF' : '사진'}</span></div><button className="icon-button" onClick={reset} disabled={busy} aria-label="선택한 파일 삭제"><X size={18} /></button></div>
              {busy ? <div className="processing" role="status" aria-live="polite"><div><LoaderCircle size={17} className="spin" /><strong>{status.message}</strong></div><progress max="100" value={status.value} aria-label="배경 제거 진행률" /><p>{status.detail || '이미지에 따라 잠시 시간이 걸릴 수 있어요'}</p><button className="text-button" onClick={cancel}>처리 취소</button></div>
                : result ? <div className="finished"><p><Check size={16} /> 주인공만 쏙, 준비되었어요.</p><button className="primary" onClick={download}><ArrowDownToLine size={18} /> 투명 {result.blob.type === 'image/gif' ? 'GIF' : 'PNG'} 다운로드</button><button className="text-button" onClick={() => fileInput.current?.click()}>다른 이미지 선택</button></div>
                : <><button className="primary process-button" onClick={process}><Sparkles size={18} /> 배경 지우기 <ArrowRight size={18} /></button><button className="text-button" onClick={() => fileInput.current?.click()}>다른 이미지 선택</button></>}
            </>}
          </div>
          {error && <div className="error-message" role="alert">{error}<button onClick={() => setError('')} aria-label="오류 메시지 닫기"><X size={15} /></button></div>}
          <div className="upload-meta"><span><ShieldCheck size={14} /> 파일은 서버에 저장되지 않아요</span><label className="quality-select">처리 모드<select value={quality} onChange={(event) => { setQuality(event.target.value as Quality); if (result) { setResult(null); setStatus({ value: 0, message: '', detail: '' }); } }} disabled={busy}><option value="fast">빠르게</option><option value="detail">꼼꼼하게</option></select><ChevronDown size={12} /></label></div>
          <p className="model-note">첫 사용 시 AI 모델 다운로드가 필요해요. 기기에 따라 처리 시간이 달라요.</p>
          {!file && <div className="sample-row"><span>이미지가 없다면?</span><button className="sample-button" onClick={loadSample} disabled={sampleLoading}><img src="/sample.svg" alt="해바라기 일러스트 예시" />{sampleLoading ? '불러오는 중…' : '예시로 시작하기'}<ArrowRight size={14} /></button></div>}
        </div>

        <div className="preview-column">
          <div className="preview-topline"><span><span className="live-dot" /> {isDemo ? '이렇게 달라져요' : result ? '완성된 이미지' : '내 이미지'}</span><span className="format-pill">{result?.blob.type === 'image/gif' || /\.gif$/i.test(file?.name ?? '') ? 'GIF' : 'PNG'}<span>✦</span> 투명 배경</span></div>
          <div className={`preview checker ${isDemo ? 'demo' : ''} ${busy ? 'is-processing' : ''}`} style={previewStyle}>
            {canCompare ? <>
              <img className="preview-image" src={outputSrc} alt={isDemo ? '투명 배경의 해바라기 일러스트' : '배경을 제거한 결과'} />
              {view === 'compare' && <><div className={`before-layer ${isDemo ? 'sample-before' : ''}`} style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}><img className="preview-image" src={isDemo ? '/sample.svg' : original} alt="배경 제거 전 원본" /></div><div className="divider" style={{ left: `${split}%` }}><span><MoveHorizontal size={21} /></span></div><input className="compare-range" type="range" min="0" max="100" value={split} onChange={(event) => setSplit(Number(event.target.value))} aria-label="배경 제거 전후 비교 위치" /></>}
              <div className="preview-labels">{view === 'compare' && <span>원본</span>}<span className="after-label"><Sparkles size={12} /> 배경 제거</span></div>
            </> : <img className="preview-image" src={original} alt="선택한 원본 이미지" />}
            {busy && <div className="scan-line" />}
            {isDemo && <><div className="preview-sticker"><Sparkles size={17} /> 배경만, 쏙.</div><span className="demo-caption">효과 설명을 위한 일러스트 예시</span></>}
            {!canCompare && !busy && <span className="pending-caption">왼쪽에서 ‘배경 지우기’를 눌러 주세요</span>}
          </div>
          <div className="preview-toolbar"><div className="swatches" aria-label="미리보기 배경색">{backgrounds.map((item) => <button key={item.name} className={`swatch ${item.color === 'transparent' ? 'checker' : ''} ${background === item.color ? 'chosen' : ''}`} style={item.color === 'transparent' ? {} : { background: item.color }} onClick={() => setBackground(item.color)} title={`${item.name} 미리보기`} aria-label={`${item.name} 배경으로 미리보기`} aria-pressed={background === item.color} />)}<span>미리보기 배경</span></div><button className="view-toggle" disabled={!canCompare} onClick={() => setView(view === 'compare' ? 'result' : 'compare')}><Layers2 size={14} />{view === 'compare' ? '결과만 보기' : '전후 비교'}</button></div>
          <div className="preview-bottom">{result ? <span><Check size={13} /> {result.width} × {result.height}px · {result.frames > 1 ? `${result.frames}프레임 · ` : ''}{(result.blob.size / 1024 / 1024).toFixed(2)}MB</span> : <span><MousePointer2 size={14} /> 슬라이더를 움직여 전후를 비교해 보세요</span>}<span>다운로드는 투명하게</span></div>
        </div>
      </section>

      <section className="benefits" aria-label="서비스 특징"><div><span className="benefit-icon"><Sparkles size={21} /></span><div><h2>복잡한 편집 없이</h2><p>AI가 주인공을 찾아 배경을 지워요</p></div></div><div><span className="benefit-icon"><Layers2 size={21} /></span><div><h2>움직임은 그대로</h2><p>GIF의 프레임과 재생 속도를 유지해요</p></div></div><div><span className="benefit-icon"><ShieldCheck size={21} /></span><div><h2>내 파일은 내 기기에</h2><p>업로드한 이미지는 브라우저에서만 처리해요</p></div></div></section>

      <section className="how-section" id="how"><div className="section-heading"><span className="section-kicker">HOW IT WORKS</span><h2>세 번이면 충분해요.</h2><p>덜어내는 과정도, 가벼워야 하니까.</p></div><div className="steps"><div><span>01</span><h3>이미지 가져오기</h3><p>사진이나 GIF를 선택하거나<br />이 페이지에 끌어다 놓으세요.</p></div><ArrowRight className="step-arrow" size={22} /><div><span>02</span><h3>배경 지우기</h3><p>AI가 각 이미지의 배경을 지워요.<br />결과를 비교하며 확인하세요.</p></div><ArrowRight className="step-arrow" size={22} /><div><span>03</span><h3>자유롭게 사용하기</h3><p>투명한 PNG 또는 GIF로 저장해<br />원하는 곳에 활용하세요.</p></div></div></section>

      <section className="faq-section" id="faq"><div><span className="section-kicker">GOOD TO KNOW</span><h2>궁금한 점이 있나요?</h2><p>시작하기 전에 알아두면 좋아요.</p><ArrowDown size={22} /></div><div className="faq-list">
        <details><summary>정말 무료인가요?<ChevronDown size={17} /></summary><p>네. 회원가입이나 API 키 없이 사용할 수 있어요. 배경 제거는 내 기기의 연산으로 진행되며, 처음에는 AI 모델과 실행 파일을 다운로드해요.</p></details>
        <details><summary>움짤도 움직인 채로 저장되나요?<ChevronDown size={17} /></summary><p>GIF의 각 프레임을 처리해 원본의 프레임 수, 재생 간격과 반복 설정을 유지해요. 최대 120프레임·20MB까지 지원해요. GIF는 최대 256색과 완전 투명만 지원하므로 가장자리가 거칠거나 프레임 사이에 경계가 조금 달라질 수 있어요. 움직이는 WebP와 PNG는 GIF로 변환해 주세요.</p></details>
        <details><summary>파일의 크기와 화질은 어떻게 되나요?<ChevronDown size={17} /></summary><p>빠르게 모드는 긴 변 기준 사진 최대 2,048px·GIF 768px, 꼼꼼하게 모드는 사진 4,096px·GIF 1,024px로 저장해요. 작은 이미지는 확대하지 않아요. 사진은 4,000만 화소, GIF는 프레임당 400만 화소까지 지원해요. 복잡한 배경이나 반투명 물체는 결과가 정확하지 않을 수 있어요.</p></details>
        <details><summary>사진이 서버에 남지는 않나요?<ChevronDown size={17} /></summary><p>이미지 파일은 외부 서버로 전송하지 않아요. AI 모델만 IMG.LY 서버에서 내려받고, 배경 제거는 브라우저 안에서 진행해요. 페이지를 닫으면 작업 결과는 사라지므로 필요한 파일은 미리 다운로드해 주세요. 미리보기 배경색은 다운로드 파일에 포함되지 않아요.</p></details>
      </div></section>
    </main>
    <footer><a className="brand footer-brand" href="#">off<span className="brand-dot">.</span></a><span>조금 덜어내고, 더 자유롭게.</span><div><a href="https://github.com/BAEPPY/removebackground" target="_blank" rel="noreferrer">소스 코드</a><span>Made for your next idea.</span></div></footer>
  </>;
}
