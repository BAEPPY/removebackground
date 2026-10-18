import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowRight, Brush, Check, ChevronDown, ImagePlus, Layers2, LoaderCircle, LockKeyhole, MoveHorizontal, MousePointer2, Scan, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import { downloadName, validateFile } from './media';
import type { ProcessUpdate, Quality, RemovalMode } from './types';
import MaskEditor from './MaskEditor';
import type { EditorMemory } from './repairProtocol';
import { APISession, type APIRequest, type APIStats } from './apiSession';

type Result = { url: string; blob: Blob; width: number; height: number; frames: number; repair?: EditorMemory; smoothBlob?: Blob; smoothUrl?: string; apiStats?: APIStats };
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
  const [mode, setMode] = useState<RemovalMode>('character');
  const [editing, setEditing] = useState(false);
  const [access, setAccess] = useState('');
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [apiFrames, setApiFrames] = useState<number | null>(1);
  const [saveGif, setSaveGif] = useState(true);
  const [freshAI, setFreshAI] = useState(false);
  const apiSession = useRef(new APISession());
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

  useEffect(() => {
    if (mode !== 'openai') return;
    let active = true; setApiReady(null);
    fetch('/api/background', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json(); if (active) setApiReady(data.configured === true);
    }).catch(() => { if (active) setApiReady(false); });
    return () => { active = false; };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'openai' || !file) { setApiFrames(1); return; }
    let active = true; setApiFrames(null);
    void file.arrayBuffer().then(async bytes => {
      const header = new TextDecoder('latin1').decode(bytes.slice(0, 6));
      const count = /^GIF8[79]a$/.test(header) ? (await import('gifuct-js')).parseGIF(bytes).frames.filter(frame => 'image' in frame).length : 1;
      if (active) setApiFrames(count);
    }).catch(() => { if (active) setApiFrames(0); });
    return () => { active = false; };
  }, [file, mode]);

  const selectFile = useCallback((selected: File) => {
    if (busy) return;
    const issue = validateFile(selected);
    if (issue) { setError(issue); return; }
    // JFIF contains JPEG data, but some systems label it with a generic MIME type.
    const image = /\.jfif$/i.test(selected.name) && selected.type !== 'image/jpeg'
      ? new File([selected], selected.name, { type: 'image/jpeg', lastModified: selected.lastModified })
      : selected;
    clearUrls();
    setError(''); setFile(image); setOriginal(makeUrl(image)); setResult(null); setEditing(false);
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
    clearUrls(); setBusy(false); setFile(null); setOriginal(''); setResult(null); setError(''); setEditing(false);
    if (fileInput.current) fileInput.current.value = '';
  }

  function cancel() {
    worker.current?.terminate(); worker.current = null; setBusy(false);
    setStatus({ value: 0, message: '처리를 취소했어요. 다시 시작할 수 있어요.', detail: '' });
  }

  function process() {
    if (!file || busy) return;
    if (mode === 'openai' && (!apiReady || !access.trim() || !apiFrames)) { setError('GPT AI 설정과 개인용 비밀번호를 확인해 주세요.'); return; }
    if (!('OffscreenCanvas' in window) || !('Worker' in window)) {
      setError('최신 Chrome, Edge 또는 Safari에서 열어 주세요. 이 브라우저에서는 배경 제거를 지원하지 않아요.'); return;
    }
    setBusy(true); setError(''); setStatus({ value: 2, message: '이미지를 준비하고 있어요', detail: '' });
    try {
      worker.current ??= new Worker(new URL('./processor.worker.ts', import.meta.url), { type: 'module' });
      const processor = worker.current;
      worker.current.onmessage = ({ data }: MessageEvent<ProcessUpdate | APIRequest>) => {
        if (data.type === 'api-request') { void apiSession.current.handle(processor, data); return; }
        if (data.type === 'progress') setStatus({ value: data.value, message: data.message, detail: data.detail ?? '' });
        if (data.type === 'error') {
          setError(data.message); setBusy(false); worker.current?.terminate(); worker.current = null;
        }
        if (data.type === 'done') {
          setResult({ ...data, url: makeUrl(data.blob), smoothUrl: data.smoothBlob ? makeUrl(data.smoothBlob) : undefined }); setBusy(false); setView('compare');
          setStatus({ value: 100, message: '배경 제거가 완료되었어요!', detail: '' });
        }
      };
      worker.current.onerror = () => {
        setError('처리가 중단되었어요. 다른 탭을 닫거나 더 작은 파일로 다시 시도해 주세요.');
        setBusy(false); worker.current?.terminate(); worker.current = null;
      };
      worker.current.postMessage({ file, quality, mode, access: mode === 'openai' ? access : undefined, saveGif, fresh: freshAI });
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

  function changeMode(value: RemovalMode) {
    if (busy || mode === value) return;
    worker.current?.terminate(); worker.current = null;
    setMode(value); setError(''); setResult(null); setEditing(false);
  }

  function applyEdit(blob: Blob, repair?: EditorMemory, smoothBlob?: Blob) {
    if (!result) return;
    URL.revokeObjectURL(result.url);
    if (result.smoothUrl) URL.revokeObjectURL(result.smoothUrl);
    setResult({ ...result, blob, repair, smoothBlob, smoothUrl: smoothBlob ? makeUrl(smoothBlob) : undefined, url: makeUrl(blob) }); setEditing(false); setView('result');
  }

  const isDemo = !file;
  const canCompare = isDemo || !!result;
  const previewStyle = background === 'transparent' ? {} : { backgroundColor: background, backgroundImage: 'none' };
  const outputSrc = result?.smoothUrl ?? result?.url ?? '/sample.svg';

  return <>
    <header className="site-header">
      <a href="#" className="brand" aria-label="off. 홈"><span className="brand-mark"><Scan size={23} strokeWidth={2.2} /></span>off<span className="brand-dot">.</span></a>
      <nav aria-label="주요 메뉴"><a className="active" href="#studio">배경 지우기</a><a href="#how">사용 방법</a><a href="#faq">자주 묻는 질문</a></nav>
      <span className="header-note"><LockKeyhole size={14} /> {mode === 'openai' ? '개인용 GPT API' : '내 기기에서 안전하게'}</span>
    </header>

    <main>
      <section className="hero" id="studio" aria-labelledby="hero-title">
        <div className="hero-copy">
          <div className="eyebrow"><span /> LESS BACKGROUND, MORE YOU</div>
          <h1 id="hero-title">배경은 빼고,<br /><span>주인공만</span> 남기세요<span className="title-dot">.</span></h1>
          <p className="intro">사진 한 장부터 움직이는 GIF까지.<br />복잡한 편집 없이, 필요한 모습만 가볍게 꺼내세요.</p>

          <div className="removal-modes" role="group" aria-label="배경 제거 방식"><button aria-pressed={mode === 'character'} disabled={busy} onClick={() => changeMode('character')}><ShieldCheck size={16} />캐릭터 보호</button><button aria-pressed={mode === 'photo'} disabled={busy} onClick={() => changeMode('photo')}><Sparkles size={16} />사진 AI</button><button aria-pressed={mode === 'openai'} disabled={busy} onClick={() => changeMode('openai')}><Sparkles size={16} />GPT AI</button></div>
          <p className="mode-description">{mode === 'character' ? '단색 배경의 캐릭터용 · 외곽선 안의 흰 털, 눈, 입을 보존해요.' : mode === 'photo' ? '인물·사물·복잡한 배경용 · 기기 안에서 AI가 주인공을 찾아요.' : 'OpenAI로 윤곽을 구분하고, 실제 색과 얼굴은 원본에서 가져와요.'}</p>

          {mode === 'openai' && <div className="api-settings">
            <p className="api-connection">{apiReady === null ? 'API 설정 확인 중…' : apiReady ? '서버 API 설정 완료 · 개인용 비밀번호로 사용' : '서버 API 설정이 필요해요'}</p>
            {apiReady === false && <p>Vercel 환경변수에 <code>OPENAI_API_KEY</code>와 16자 이상의 <code>APP_PASSWORD</code>를 등록하고 다시 배포해 주세요. OpenAI 키는 이 화면에 입력하지 않아요.</p>}
            <label>개인용 비밀번호<input type="password" value={access} onChange={event => setAccess(event.target.value)} disabled={busy} autoComplete="off" placeholder="APP_PASSWORD에 설정한 비밀번호" /></label>
            <p>원본 이미지를 OpenAI로 전송해요. ChatGPT 구독과 별도로 API 사용료가 발생해요. 비밀번호는 이 탭을 닫거나 새로고침하면 사라져요.</p>
            {(apiFrames ?? 0) > 1 && <label className="api-option"><input type="checkbox" checked={saveGif} disabled={busy} onChange={event => setSaveGif(event.target.checked)} />GIF 절약 처리 · 비슷한 장면은 움직임을 따라 재사용</label>}
            <label className="api-option"><input type="checkbox" checked={freshAI} disabled={busy} onChange={event => setFreshAI(event.target.checked)} />저장된 결과 대신 새로 분석 (추가 과금)</label>
            {file && <p className="api-cost">{apiFrames === null ? '호출 횟수 확인 중…' : `이번 배경 제거: API 최대 ${apiFrames}회`}{(apiFrames ?? 0) > 1 && (saveGif ? ' · 확실히 추적되는 장면은 무료 재사용, 변화가 크면 추가 분석해요.' : ' · 모든 프레임을 개별 분석해요.')}</p>}
            <p>같은 요청은 이 탭에 저장된 결과를 재사용해요. 새로고침하면 저장된 결과가 사라져요. 중간 품질은 그대로 유지해요.</p>
          </div>}

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
                : result ? <div className="finished"><p><Check size={16} /> 주인공만 쏙, 준비되었어요.</p><button className="primary" onClick={download}><ArrowDownToLine size={18} /> 투명 {result.blob.type === 'image/gif' ? 'GIF' : 'PNG'} 다운로드</button>{result.smoothUrl && <a className="smooth-download" href={result.smoothUrl} download={downloadName(file.name, false).replace('.png', '-smooth.png')}>부드러운 APNG 다운로드</a>}<button className="text-button" onClick={() => fileInput.current?.click()}>다른 이미지 선택</button></div>
                : <><button className="primary process-button" disabled={mode === 'openai' && (!apiReady || !access.trim() || !apiFrames)} onClick={process}><Sparkles size={18} /> 배경 지우기 <ArrowRight size={18} /></button><button className="text-button" onClick={() => fileInput.current?.click()}>다른 이미지 선택</button></>}
            </>}
          </div>
          {error && <div className="error-message" role="alert">{error}<button onClick={() => setError('')} aria-label="오류 메시지 닫기"><X size={15} /></button></div>}
          <div className="upload-meta"><span><ShieldCheck size={14} /> {mode === 'openai' ? 'GPT 처리 시 OpenAI로 전송돼요' : '파일은 브라우저에서만 처리해요'}</span><label className="quality-select">처리 모드<select value={quality} onChange={(event) => { setQuality(event.target.value as Quality); if (result) { setResult(null); setStatus({ value: 0, message: '', detail: '' }); } }} disabled={busy}><option value="fast">빠르게</option><option value="detail">꼼꼼하게</option></select><ChevronDown size={12} /></label></div>
          <p className="model-note">{mode === 'character' ? '결과가 아쉬우면 ‘대략 표시해서 자동 보정’에서 남길 부분과 지울 부분을 알려 주세요.' : mode === 'photo' ? '첫 사용 시 AI 모델 다운로드가 필요해요. 기기에 따라 처리 시간이 달라요.' : '원본과 비교해 윤곽을 확인해 주세요. 취소하더라도 이미 시작한 API 요청은 과금될 수 있어요.'}</p>
          {!file && <div className="sample-row"><span>이미지가 없다면?</span><button className="sample-button" onClick={loadSample} disabled={sampleLoading}><img src="/sample.svg" alt="해바라기 일러스트 예시" />{sampleLoading ? '불러오는 중…' : '예시로 시작하기'}<ArrowRight size={14} /></button></div>}
        </div>

        <div className="preview-column">
          <div className="preview-topline"><span><span className="live-dot" /> {isDemo ? '이렇게 달라져요' : result ? '완성된 이미지' : '내 이미지'}</span><span className="format-pill">{result?.blob.type === 'image/gif' || /\.gif$/i.test(file?.name ?? '') ? 'GIF' : 'PNG'}<span>✦</span> 투명 배경</span></div>
          <div className={`preview checker ${isDemo ? 'demo' : ''} ${busy ? 'is-processing' : ''}`} style={previewStyle}>
            {canCompare ? <>
              <img className="preview-image" src={outputSrc} alt={isDemo ? '투명 배경의 해바라기 일러스트' : '배경을 제거한 결과'} />
              {view === 'compare' && <><div className={`before-layer ${isDemo ? 'sample-before' : 'source-checker'}`} style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}><img className="preview-image" src={isDemo ? '/sample.svg' : original} alt="배경 제거 전 원본" /></div><div className="divider" style={{ left: `${split}%` }}><span><MoveHorizontal size={21} /></span></div><input className="compare-range" type="range" min="0" max="100" value={split} onChange={(event) => setSplit(Number(event.target.value))} aria-label="배경 제거 전후 비교 위치" /></>}
              <div className="preview-labels">{view === 'compare' && <span>원본</span>}<span className="after-label"><Sparkles size={12} /> 배경 제거</span></div>
            </> : <img className="preview-image" src={original} alt="선택한 원본 이미지" />}
            {busy && <div className="scan-line" />}
            {isDemo && <><div className="preview-sticker"><Sparkles size={17} /> 배경만, 쏙.</div><span className="demo-caption">효과 설명을 위한 일러스트 예시</span></>}
            {!canCompare && !busy && <span className="pending-caption">왼쪽에서 ‘배경 지우기’를 눌러 주세요</span>}
          </div>
          <div className="preview-toolbar"><div className="swatches" aria-label="미리보기 배경색">{backgrounds.map((item) => <button key={item.name} className={`swatch ${item.color === 'transparent' ? 'checker' : ''} ${background === item.color ? 'chosen' : ''}`} style={item.color === 'transparent' ? {} : { background: item.color }} onClick={() => setBackground(item.color)} title={`${item.name} 미리보기`} aria-label={`${item.name} 배경으로 미리보기`} aria-pressed={background === item.color} />)}<span>미리보기 배경</span></div><button className="view-toggle" disabled={!canCompare} onClick={() => setView(view === 'compare' ? 'result' : 'compare')}><Layers2 size={14} />{view === 'compare' ? '결과만 보기' : '전후 비교'}</button></div>
          <div className="preview-bottom">{result ? <span><Check size={13} /> {result.width} × {result.height}px · {result.frames > 1 ? `${result.frames}프레임 · ` : ''}{(result.blob.size / 1024 / 1024).toFixed(2)}MB</span> : <span><MousePointer2 size={14} /> 슬라이더를 움직여 전후를 비교해 보세요</span>}<span>{result?.smoothUrl ? '부드러운 APNG 미리보기 · GIF도 저장 가능' : '다운로드는 투명하게'}</span></div>
          {result?.apiStats && <p className="api-summary" role="status">배경 제거: 새 API {result.apiStats.calls}회 · 저장된 결과 {result.apiStats.cached}회 · 움직임 추적 {result.apiStats.tracked}프레임 재사용</p>}
          {result && <div className="repair-controls"><button onClick={() => { worker.current?.terminate(); worker.current = null; setEditing(true); }}><Brush size={15} />대략 표시해서 자동 보정</button></div>}
        </div>
      </section>

      <section className="benefits" aria-label="서비스 특징"><div><span className="benefit-icon"><Sparkles size={21} /></span><div><h2>캐릭터의 색은 그대로</h2><p>외곽선 안의 털·눈·입을 보호해요</p></div></div><div><span className="benefit-icon"><Layers2 size={21} /></span><div><h2>움직임은 그대로</h2><p>GIF의 프레임과 재생 속도를 유지해요</p></div></div><div><span className="benefit-icon"><ShieldCheck size={21} /></span><div><h2>처리 방식을 직접 선택</h2><p>기기 내 처리 또는 개인용 GPT API</p></div></div></section>

      <section className="how-section" id="how"><div className="section-heading"><span className="section-kicker">HOW IT WORKS</span><h2>세 번이면 충분해요.</h2><p>덜어내는 과정도, 가벼워야 하니까.</p></div><div className="steps"><div><span>01</span><h3>이미지 가져오기</h3><p>사진이나 GIF를 선택하거나<br />이 페이지에 끌어다 놓으세요.</p></div><ArrowRight className="step-arrow" size={22} /><div><span>02</span><h3>배경 지우기</h3><p>기기 내 처리 또는 GPT AI를 골라요.<br />필요한 부분은 복원으로 다듬어요.</p></div><ArrowRight className="step-arrow" size={22} /><div><span>03</span><h3>자유롭게 사용하기</h3><p>투명한 PNG 또는 GIF로 저장해<br />원하는 곳에 활용하세요.</p></div></div></section>

      <section className="faq-section" id="faq"><div><span className="section-kicker">GOOD TO KNOW</span><h2>궁금한 점이 있나요?</h2><p>시작하기 전에 알아두면 좋아요.</p><ArrowDown size={22} /></div><div className="faq-list">
        <details><summary>흰 털이나 눈·입이 지워지면 어떻게 하나요?<ChevronDown size={17} /></summary><p>단색 배경의 그림은 기본 선택된 캐릭터 보호로 처리해 주세요. 캔버스 바깥과 이어진 배경만 지우고, 외곽선 안의 흰색과 원래 색을 보존해요. 끊긴 선은 그림 크기에 맞춰 보완해요. 사진·GIF 결과의 ‘대략 표시해서 자동 보정’은 칠한 선 전체를 반영해요. 윤곽이 열려 있어도 표시한 곳과 주변을 복원하고, 같은 곳을 다시 칠하면 더 넓게 보정해요. 적용 후 다시 열어도 이전 표시를 기억해요. 원치 않는 곳까지 반영되면 되돌리거나 반대 도구로 수정할 수 있어요. 사진 AI 결과도 같은 방식으로 수정할 수 있어요. GIF는 프레임을 골라 수정하거나 모든 프레임의 같은 위치에 적용할 수 있어요. 움직임 미리보기로 확인한 뒤 저장해 주세요.</p></details>
        <details><summary>정말 무료인가요?<ChevronDown size={17} /></summary><p>캐릭터 보호와 사진 AI는 API 키 없이 무료로 사용해요. GPT AI는 서버에 설정한 OpenAI API 키로 호출하며 ChatGPT 구독과 별도로 과금돼요. 여러 표시를 한 번에 보정하고 같은 요청은 이 탭에서 재사용해요. GIF 절약 처리는 확실히 맞는 이동만 추적하고 변화가 크면 새로 분석해요. 시작 전 최대 호출 수와 완료 후 새 API 요청 수를 확인해 주세요. Claude는 편집된 이미지를 직접 반환하지 않아 GPT 이미지 편집 API를 사용해요.</p></details>
        <details><summary>움짤도 움직인 채로 저장되나요?<ChevronDown size={17} /></summary><p>GIF의 각 프레임을 처리해 원본의 프레임 수, 재생 간격과 반복 설정을 유지해요. 최대 120프레임·20MB까지 지원해요. GIF는 최대 256색과 완전 투명만 지원하므로 가장자리가 거칠 수 있어요. 부드러운 경계가 필요하면 함께 제공되는 APNG를 저장해 주세요. 움직이는 PNG를 지원하는 브라우저·앱에서 재생되며, 지원하지 않는 앱에서는 정지 이미지로 보일 수 있어요. 움직이는 WebP와 PNG는 GIF로 변환해 주세요.</p></details>
        <details><summary>파일의 크기와 화질은 어떻게 되나요?<ChevronDown size={17} /></summary><p>빠르게 모드는 긴 변 기준 사진 최대 2,048px·GIF 768px, 꼼꼼하게 모드는 사진 4,096px·GIF 1,024px로 저장해요. 작은 이미지는 확대하지 않아요. 사진은 4,000만 화소, GIF는 프레임당 400만 화소까지 지원해요. 복잡한 배경이나 반투명 물체는 결과가 정확하지 않을 수 있어요.</p></details>
        <details><summary>사진이 서버에 남지는 않나요?<ChevronDown size={17} /></summary><p>캐릭터 보호와 사진 AI는 이미지 파일을 외부 서버로 보내지 않아요. 새 GPT AI 요청은 원본·표시 이미지를 Vercel 서버를 거쳐 OpenAI로 전송하며 OpenAI의 API 데이터 정책이 적용돼요. 이 앱은 파일이나 비밀번호를 서버·디스크에 별도로 저장하지 않아요. 성공한 GPT 결과는 현재 탭 메모리에 잠시 보관해 같은 요청에 재사용해요. 페이지를 닫으면 작업 결과는 사라지므로 필요한 파일은 미리 다운로드해 주세요. 미리보기 배경색은 다운로드 파일에 포함되지 않아요.</p></details>
      </div></section>
    </main>
    {editing && result && file && <MaskEditor original={file} result={result.blob} width={result.width} height={result.height} memory={result.repair} access={mode === 'openai' ? access : undefined} apiSession={apiSession.current} onApply={applyEdit} onClose={() => setEditing(false)} />}
    <footer><a className="brand footer-brand" href="#">off<span className="brand-dot">.</span></a><span>조금 덜어내고, 더 자유롭게.</span><div><a href="https://github.com/BAEPPY/removebackground" target="_blank" rel="noreferrer">소스 코드</a><span>Made for your next idea.</span></div></footer>
  </>;
}
