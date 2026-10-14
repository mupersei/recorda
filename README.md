# Recorda Chrome Extension

크롬 탭의 **오디오**와 **영상**을 캡처해 파일로 저장하는 Manifest V3 확장 프로그램입니다.
외부 서버나 ffmpeg 없이 브라우저 안에서 인코딩·머싱까지 모두 처리합니다.

## 기능

| 녹화 모드 | 저장되는 파일 | 비고 |
|---|---|---|
| 오디오만 녹음 | 오디오 1개 (`wav` / `mp3`) | 기존 동작 |
| 영상 + 오디오 (파일 1개) | 영상 1개 (`mp4` / `mov` / `avi`) | 영상 파일 안에 오디오 포함 |
| 영상 + 오디오, 오디오 별도 저장 (파일 2개) | 영상 1개 + 오디오 1개 | 두 파일은 같은 타임스탬프 이름을 공유 |

- 오디오 포맷: WAV(16-bit PCM, 무손실) / MP3(lamejs, 128~320kbps)
- 영상 포맷: MP4(ISO BMFF) / MOV(QuickTime) / AVI(RIFF)
  - 영상 코덱: H.264 (WebCodecs `VideoEncoder`, 최대 1920×1080 @ 30fps)
  - 영상 파일에 담기는 오디오: MP3 (선택한 비트레이트). MP4/MOV/AVI 모두에서 재생 가능한 공통 코덱입니다.
- 녹음 중에도 탭 소리는 그대로 들립니다 (AudioContext 루프백).
- 모든 설정(모드, 포맷, 비트레이트, 샘플레이트)은 `chrome.storage.sync`에 저장됩니다.

## 요구 사항

- Chrome 116 이상 (`manifest.json`의 `minimum_chrome_version`; `chrome.runtime.getContexts`, Offscreen Document)
- 영상 녹화는 WebCodecs `VideoEncoder` + `MediaStreamTrackProcessor`(Chrome 94+)와 H.264 인코더가 필요합니다.
  지원되지 않는 환경에서는 "H.264 영상 인코딩을 지원하지 않습니다" 오류를 표시합니다.

## 설치

1. `chrome://extensions` → 개발자 모드 켜기
2. "압축해제된 확장 프로그램을 로드합니다" → 이 폴더(`recorda/`) 선택

## 사용 방법

1. 녹화할 탭에서 미디어를 재생한 뒤 확장 아이콘 클릭
2. 녹화 모드 / 포맷 선택
3. "녹화 시작" → "녹화 중지"
4. 파일이 자동으로 다운로드 폴더에 저장됩니다 (`recorda_YYYYMMDD_HHMMSS.확장자`)

## 아키텍처

```
popup.js ──START_RECORDING──▶ background.js ──START_CAPTURE──▶ offscreen.js
   ▲                            │  (tabCapture.getMediaStreamId,         │
   │ STATE_CHANGED / UPDATE_TIME│   recording-plan 검증,                   │ getUserMedia(tab audio[+video])
   └────────────────────────────┤   chrome.downloads 저장)                 │
                                ◀──DOWNLOAD_FILE / RECORDING_COMPLETE─────┘
```

| 파일 | 역할 |
|---|---|
| `background.js` | 상태 관리, 녹화 계획 검증, Offscreen 생명주기, `chrome.downloads`로 파일 저장 |
| `offscreen.js` | 탭 캡처, AudioWorklet 기반 PCM 추출, 오디오/영상 인코더 구동, 파일 생성 |
| `recording-plan.js` | 모드·포맷 → 캡처 여부와 출력 파일 목록(순수 함수) |
| `encoders.js` | 오디오 단독 파일용 스트리밍 MP3/WAV 인코더 (기존) |
| `container-audio-encoder.js` | 영상 컨테이너에 담을 MP3 프레임 생성 |
| `video-recorder.js` | `VideoTrackEncoder`(WebCodecs H.264) + `VideoRecordingSession`(머싱) |
| `muxers/mp4-muxer.js` | MP4/MOV 머서 (avc1 + mp4a/esds 또는 `.mp3`, MP3 인코더 지연 elst 보정) |
| `muxers/avi-muxer.js` | AVI 머서 (H264 Annex B + MP3, 고정 fps 슬롯·빈 청크로 타이밍 유지) |
| `muxers/h264.js` | Annex B ↔ AVC 변환, avcC 생성/해석, SPS 크기 해석 |
| `muxers/mp3-frames.js` | MP3 바이트열을 프레임 단위로 분리 |
| `muxers/byte-writer.js` | 바이너리 작성 유틸 |

### A/V 동기화

- 오디오 파이프라인 시작 시각과 첫 영상 프레임 도착 시각의 차이를 측정해 영상 타임스탬프에 보정합니다.
- MP4/MOV: 프레임별 실제 간격을 `stts`에 기록하고, MP3 인코더 지연(1105 샘플)은 `elst`로 상쇄합니다.
- AVI: 30fps 고정 타임라인에 프레임을 배치하고 비는 슬롯은 길이 0 청크(이전 프레임 반복)로 채웁니다.
- 정적인 화면은 프레임이 드물게 오므로, 오디오가 더 길면 마지막 영상 프레임을 오디오 끝까지 늘립니다.
- 녹화 중 탭 크기가 바뀌어도 파일 해상도는 첫 프레임 크기로 고정됩니다(파일당 하나의 `avcC`). 비율이 같으면 Chrome `VideoEncoder`가
  스케일링하고, 비율이 바뀐 경우(창 모양 변경)에만 OffscreenCanvas 레터박스로 정규화합니다.

### 장시간 녹화: 디스크 스트리밍 저장소

인코딩된 데이터는 메모리가 아니라 Origin Private File System(OPFS, `navigator.storage.getDirectory()`)에 기록됩니다.

- `storage/chunk-store.js`: 녹화 중 영상 H.264 청크와 컨테이너용 MP3 프레임은 `OpfsChunkStore`에 append(1 MB 버퍼)되고, 메모리에는
  오프셋·크기·타임스탬프 같은 메타데이터만 남습니다(1080p 1시간 ≈ 10만 샘플, 수십 MB).
- 중지 시 머서(`writeMp4` / `writeAvi`)가 레이아웃을 계산한 뒤 디스크의 청크를 한 샘플씩 읽어 결과 파일(OPFS)에 스트리밍으로 씁니다.
  메모리 방식(`buildMp4` / `buildAvi`)과 바이트 단위로 같은 파일을 만든다는 것을 테스트로 보장합니다.
- 오디오 단독 파일도 `WavFileEncoder` / `Mp3FileEncoder`가 디스크 싱크에 바로 기록합니다(WAV는 종료 시 헤더만 패치).
- 결과 파일은 OPFS의 `File`로 다운로드되므로 `Blob` 복사가 없습니다. 임시 파일은 다음 녹화 시작 시 정리됩니다.
- OPFS를 쓸 수 없는 환경에서는 자동으로 메모리 저장소로 폴백합니다.

이 구조 이전에는 1080p 기준 분당 약 27 MB가 RAM에 쌓이고 분리 저장의 WAV는 종료 시 전체를 메모리에 다시 올려,
1시간 20분 전후로 수 GB에 도달해 탭이 멈추는 문제가 있었습니다.

### Service Worker 수명 대응

MV3 Service Worker는 유휴 30초 후 종료될 수 있고, 패키지 설치에서는 `chrome.alarms` 최소 주기가 30초입니다.

- 녹화 상태는 `chrome.storage.session`에 저장되고 SW 시작 시 복원됩니다(Offscreen 문서가 살아 있을 때만).
- Offscreen은 녹화 중 20초마다 `RECORDING_HEARTBEAT`(tabId, startTime, plan)를 보내 SW를 깨우고, 상태를 잃었으면 복구시킵니다.
- 다운로드 대기 목록도 `chrome.storage.session`에 두어 SW가 재시작된 뒤 도착한 `downloads.onChanged`도 처리하며, 타임아웃은 `chrome.alarms`로 걸어 둡니다.
- 팝업은 `startTime` 기준 자체 타이머로 경과 시간을 표시합니다.
- 녹화 중인 탭이 닫히면(`tabs.onRemoved`, 트랙 `onended`) 자동으로 녹화를 마무리합니다.

## 테스트

Node.js 20 이상이면 추가 설치 없이 실행됩니다.

```bash
npm test
```

- 순수 모듈(계획, 파일명, 바이트 라이터, MP3 프레임, H.264 유틸, MP4/MOV/AVI 머서)은 단위 테스트로 검증합니다.
- `tests/fixtures/*.h264`는 ffmpeg(libx264)로 만든 실제 H.264 스트림이며, 머서 출력은 박스/청크 구조를 직접 파싱해 확인합니다.
- `ffprobe`/`ffmpeg`가 PATH에 있거나 `RECORDA_FFPROBE`, `RECORDA_FFMPEG` 환경 변수로 지정되면
  생성된 MP4/MOV/AVI를 실제로 디코딩해 스트림 정보와 디코딩 오류 유무까지 검사합니다. 없으면 해당 테스트는 건너뜁니다.
- `background.js`, `offscreen.js`는 가짜 `chrome.*` / WebCodecs / Web Audio 객체로 메시지 흐름을 통합 테스트합니다.

### E2E (실제 Chrome)

```bash
npm run test:e2e            # e2e/ 에 puppeteer 설치 후 헤드리스 Chrome에 확장을 로드해 실행
cd e2e && node run.mjs --duration=10 --long=60 --only=video-mp4,split-avi-wav
```

- Puppeteer가 Chrome for Testing을 내려받아 `--load-extension`으로 이 확장을 로드합니다. 리눅스 샌드박스처럼 공유 라이브러리가 없으면
  `CHROME_LIB_DIR`에 추출한 라이브러리 경로를 지정할 수 있습니다. 결과 파일 검증에는 `RECORDA_FFPROBE` / `RECORDA_FFMPEG`가 필요합니다.
- `chrome.tabCapture.getMediaStreamId`는 사용자의 확장 아이콘 클릭이 있어야만 동작하므로 자동화할 수 없습니다. 하네스는 Service Worker에서
  이 호출과 Offscreen 생성 API만 스텁하고, `offscreen.html`을 탭으로 열어 `getUserMedia`를 캔버스(영상)+오실레이터(오디오) 스트림으로 대체합니다.
  팝업 → Background → Offscreen → WebCodecs 인코딩 → 머싱 → `chrome.downloads` 저장까지는 모두 실제 코드가 실행됩니다.
- 팝업 레이아웃 테스트: `npm run test:popup`. 실제 Chrome에서 popup.html을 열어 모든 모드·상태(완료 메시지, 시:분:초 표시 포함)에서
  콘텐츠 높이가 Chrome 팝업 최대 높이(600px) 이내라 스크롤이 생기지 않는지, 선택 상자 텍스트가 잘리지 않는지 검사합니다.
  현재 높이: 오디오만 353px, 영상+오디오 374px, 분리 저장 416px.
- 시나리오: 오디오만(mp3/wav), 영상+오디오(mp4/mov/avi), 분리 저장(mp4+mp3, avi+wav), 녹화 중 탭 크기 변경, 1080p 60초 장시간 녹화.
  각 파일은 ffprobe 스트림 정보, 전체 디코딩, 프레임 타임스탬프 단조성, A/V 길이 차, 파일명 규칙을 검사하고
  녹화 중 CPU/메모리(PSS, offscreen JS 힙)를 1초 간격으로 측정해 `e2e/output/report.json`에 남깁니다.

## 리소스 사용량 (헤드리스 Chrome 148, 소프트웨어 H.264, 12코어 샌드박스)

E2E 하네스의 합산 수치(`e2e/output/report.json`)에는 테스트용 가짜 소스(캔버스 30fps + 오실레이터)와 같은 렌더러를 재사용하며
누적된 캐시가 포함되어 있어, 구성 요소별로 분리 측정한 값이 실제 확장의 비용에 가깝습니다. CPU는 1코어 = 100% 기준입니다.

| 구성 요소 (10초 녹화, 새 브라우저에서 측정) | CPU | 메모리 증가(PSS) |
|---|---|---|
| offscreen 문서 생성 | 0% | +8 MB |
| 오디오 서비스 프로세스 (캡처/재생 스택) | 1% | +27 MB |
| 오디오 녹음 파이프라인 (AudioWorklet + lamejs MP3 128kbps, 48kHz 스테레오) | 약 24% | +60 MB |
| H.264 소프트웨어 인코더 파이프라인, 720p 30fps | 약 56% | +20 MB |
| H.264 소프트웨어 인코더 파이프라인, 1080p 30fps | 약 82% | +45 MB |
| 인코딩된 H.264 청크 보관 | 0% | 약 27 MB/분 (1080p, 6 Mbps) |
| 테스트용 가짜 영상 소스 (실제 탭 캡처에는 없음, 720p / 1080p) | 36% / 47% | +20 / +50 MB |
| 중지 시 파일 생성 (`new Blob`) | 0.1~0.5초 동안 1코어 | 일시적으로 파일 크기만큼 |
| 녹화 중 비율 변경 시 캔버스 레터박스 경로 | 추가 약 10% | 최대 수백 MB (캔버스 이미지 캐시) |

- 실제 사용 시 합계는 오디오만 약 25%, 720p 영상+오디오 약 80%, 1080p 영상+오디오 약 105%(소프트웨어 인코딩 기준)입니다.
  하드웨어 인코더가 있는 PC에서는 영상 인코딩 CPU가 크게 낮아집니다.
- MP3 인코딩(lamejs, 순수 JS)이 오디오 쪽 CPU의 대부분입니다. WAV는 변환이 거의 없어 10% 미만입니다.
- 디스크 스트리밍 저장소 도입 후에는 청크 보관과 중지 시 Blob 복사가 사라져, 녹화 길이에 비례해 늘어나는 메모리 항목은 샘플 메타데이터뿐입니다.

### 모드 × 확장자별 전체 파이프라인 비용 (720p 30fps, 15초 녹화, 조합마다 새 브라우저에서 3회 측정, 중앙값과 범위)

"총"은 테스트 하네스의 가짜 소스(오디오만: CPU 3% / +28 MB, 영상: CPU 36% / +49 MB)를 포함한 값이고, "차감"은 그것을 뺀 확장 자체의 비용입니다.
영상 CPU는 실행마다 약 50%와 약 95% 두 수준으로 갈리는데(공유 샌드박스의 부하 변동과 realtime 인코더의 복잡도 적응), 프레임 수와 파일 크기는 동일했습니다.

| 모드 | 저장 파일 | CPU 평균 % (총) | CPU 평균 % (차감) | CPU 피크 % | 메모리 증가 MB (총) | 메모리 증가 MB (차감) | 중지→파일 생성 ms | 파일 크기 MB/분 |
|---|---|---|---|---|---|---|---|---|
| 오디오만 | wav | 15 (13~16) | 12 | 41 | 87 | 59 | 128 | 10.5 |
| 오디오만 | mp3 | 33 (32~34) | 30 | 70 | 123 | 95 | 81 | 1.0 |
| 영상+오디오 | mp4 | 94 (91~99) | 58 | 128 | 146 | 97 | 148 | 16.6 |
| 영상+오디오 | mov | 51 (48~101) | 15~65 | 109 | 154 | 105 | 87 | 16.6 |
| 영상+오디오 | avi | 77 (70~98) | 41~62 | 127 | 150 | 101 | 117 | 16.8 |
| 분리 저장 | mp4 + wav | 96 (48~100) | 12~64 | 116 | 156 | 107 | 137 | 27.0 |
| 분리 저장 | mp4 + mp3 | 80 (80~89) | 44~53 | 113 | 163 | 114 | 106 | 17.2 |
| 분리 저장 | mov + wav | 86 (78~95) | 42~59 | 116 | 157 | 108 | 154 | 27.2 |
| 분리 저장 | mov + mp3 | 83 (75~90) | 39~54 | 106 | 163 | 114 | 104 | 17.2 |
| 분리 저장 | avi + wav | 96 (94~104) | 58~68 | 116 | 159 | 110 | 150 | 27.2 |
| 분리 저장 | avi + mp3 | 88 (87~90) | 51~54 | 114 | 169 | 120 | 133 | 17.2 |

- 컨테이너(mp4/mov/avi) 선택은 CPU·메모리·파일 크기에 유의미한 차이를 만들지 않습니다. 비용을 결정하는 것은 영상 포함 여부와 오디오 코덱입니다.
- 오디오 파일 포맷: WAV는 CPU 약 12%, MP3(lamejs)는 약 30%. 파일 크기는 WAV 10.5 MB/분, MP3 1.0 MB/분.
- 분리 저장 + MP3는 같은 소리를 두 번 인코딩하므로(컨테이너용 + 별도 파일용) 영상+오디오 단일 파일보다 약 25~30% 더 씁니다.

### 설정별 비용 (가짜 소스 비용 차감 후, 소프트웨어 H.264)

| 설정 | 인코더 CPU | 인코더 메모리 |
|---|---|---|
| 1080p 30fps (현재 기본) | 약 80% | +45 MB |
| 1080p 15fps | 약 63% | +45 MB |
| 720p 30fps | 약 63% | +25 MB |
| 720p 15fps | 약 41% | +22 MB |
| 비트레이트 6 → 3 Mbps | 변화 없음 | 변화 없음 |
| `latencyMode` realtime ↔ quality | 변화 없음 | 변화 없음 |
| `hardwareAcceleration: prefer-hardware` (GPU 없는 환경) | 인코더가 아무 프레임도 출력하지 않음 | - |

| 오디오 인코딩 (48kHz 스테레오) | CPU | 메모리 |
|---|---|---|
| WAV (Int16 변환만) | 약 6% | +48 MB |
| MP3 lamejs 128kbps (현재) | 약 31% | +90 MB |
| WebCodecs Opus 128kbps | 약 11% | +51 MB |
| WebCodecs AAC | 리눅스 Chrome 미지원 | - |

`prefer-hardware`는 하드웨어 인코더가 없으면 조용히 실패하므로 사용하지 않습니다(`no-preference`가 가능할 때 하드웨어를 선택).

## 알려진 제한

- 녹화 데이터는 OPFS(브라우저 프로필 디스크)에 기록되므로 긴 녹화는 그만큼의 디스크 여유 공간이 필요합니다(1080p 약 1.6 GB/시간).
- WAV 파일은 RIFF 한계로 4 GB(48 kHz 스테레오 약 6시간)를 넘을 수 없으며, 2 GB를 넘으면 일부 플레이어가 열지 못합니다.
- AVI는 RIFF 32비트 한계 때문에 2GB를 넘을 수 없습니다. 초과가 예상되면 자동으로 MP4로 저장하고 안내합니다.
- 영상 파일의 오디오는 항상 MP3입니다(AAC 미지원). 오디오 포맷 선택은 별도 저장되는 오디오 파일에만 적용됩니다.
- Chrome `<video>`는 AVI를 재생하지 않습니다(VLC, mpv, Windows 미디어 플레이어 등에서 재생).
- 화면 변화가 없는 탭은 프레임이 거의 생성되지 않으며, 이 경우 마지막 프레임이 오디오 끝까지 유지됩니다.
