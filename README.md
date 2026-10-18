# off. — 사진 · GIF 배경 제거

Vercel에 배포하는 React + TypeScript + Vite 웹 앱입니다. 이미지 파일은 서버로 전송하지 않으며, 별도 API 키 없이 브라우저의 Web Worker에서 IMG.LY의 IS-Net 모델로 처리합니다.

## 실행

Node.js 22 이상에서:

```sh
npm ci
npm run dev
```

```sh
npm test
npm run build
npm run preview
```

브라우저 UI 테스트는 `npx playwright install chromium` 후 `npm run test:e2e`로 실행합니다. 시스템 Chromium을 사용한다면 `CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e`로 실행하세요. 다운로드·취소 UI 테스트는 Worker fixture를 사용하며 AI 추론 품질을 검증하는 테스트는 아닙니다. 다른 테스트는 실제 Worker의 파일 검증과 실제 GIF 디코딩·인코딩을 확인합니다.

## Vercel 배포

1. [Vercel 새 프로젝트](https://vercel.com/new)에서 `BAEPPY/removebackground` 저장소를 Import합니다.
2. Framework Preset은 **Vite**, Build Command는 **npm run build**, Output Directory는 **dist**입니다. `vercel.json`에 설정되어 있습니다.
3. 환경변수는 필요하지 않습니다. **Deploy**를 누릅니다.

Vercel CLI를 쓰는 경우, 계정에 로그인한 로컬 터미널에서 `npx vercel --prod`를 실행합니다. 이 저장소에는 토큰을 넣지 않습니다.

`vercel.json`은 ONNX Runtime의 SharedArrayBuffer 지원을 위한 COOP / COEP 헤더도 설정합니다. 다른 호스팅으로 옮기면 동일한 헤더를 유지하세요.

## 기능

- JPG/JPEG, JFIF, PNG, 정적 WebP → 투명 PNG
- GIF → 프레임별 배경 제거 후 투명 GIF. 프레임 수, 원본 지연 시간, 반복 횟수 유지
- GIF의 부분 프레임, 투명 패치, disposal 2/3 복원 처리
- 파일 선택, 드래그 앤 드롭, 클립보드 붙여넣기
- 실제 결과를 이용한 전후 슬라이더, 미리보기 배경색 선택, 다운로드
- 진행률, 취소, 입력 검증, 처리 실패 안내, 반응형 한국어 UI

## 처리 제한

| 항목 | 빠르게 | 꼼꼼하게 |
| --- | --- | --- |
| 모델 | IS-Net uint8 | IS-Net fp16 |
| 사진 긴 변 | 최대 2,048px | 최대 4,096px |
| GIF 긴 변 | 최대 768px | 최대 1,024px |

공통: 파일 최대 20MB, 사진 4,000만 화소, GIF 프레임당 400만 화소·최대 120프레임. 작은 이미지는 확대하지 않습니다. 애니메이션 WebP/APNG는 프레임 손실을 막기 위해 거절합니다. GIF의 256색·1비트 투명도 제한으로 경계가 거칠 수 있고 프레임별 AI 추론 결과에 차이가 있을 수 있습니다. 투명도는 128 기준으로 변환합니다. 배경색 변경은 미리보기 전용이며 저장 파일은 항상 투명합니다.

## 네트워크와 데이터

첫 처리 시 `https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/`에서 모델과 WASM 실행 파일을 내려받습니다. 빠르게 모델은 약 40MB, 꼼꼼하게 모델은 약 80MB이며 실행 파일 다운로드가 추가됩니다. 해당 도메인에 접근할 수 있어야 합니다. 이후에는 브라우저 캐시가 재사용됩니다. 글꼴은 jsDelivr에서 내려받으며 실패 시 시스템 글꼴을 사용합니다. 분석·광고·이미지 업로드 서버는 없습니다. 결과와 원본 Blob URL은 새 파일 선택 또는 페이지 종료 시 해제됩니다.

처리는 별도 Worker에서 실행되며 취소 시 Worker를 종료합니다. UI의 모델 다운로드 수치는 현재 다운로드 중인 자산의 진행률입니다. GIF는 프레임을 한 번에 하나씩 디코딩·처리·인코딩해 디코딩된 모든 프레임을 메모리에 보관하지 않습니다.

## 라이선스

이 프로젝트는 AGPL-3.0-only로 제공하며 `@imgly/background-removal`의 AGPL 조건을 따릅니다. 서비스 하단의 소스 코드 링크는 실제 배포 소스를 가리켜야 합니다. 배포 포크를 만드는 경우 링크도 변경하세요. 상세 라이선스와 외부 라이브러리 정보는 `LICENSE` 및 `THIRD_PARTY_NOTICES.md`에 있습니다. 예시 일러스트는 이 프로젝트에서 제작했습니다.
