# Recorda Chrome Extension

크롬 탭의 **오디오**와 **영상**을 캡처해 파일로 저장하는 Manifest V3 확장 프로그램입니다.
외부 서버나 ffmpeg 없이 브라우저 안에서 인코딩·머싱까지 모두 처리합니다.

## 기능

| 녹화 모드 | 저장되는 파일 | 비고 |
|---|---|---|
| 오디오만 녹음 | 오디오 1개 (`wav` / `mp3`) | 기존 동작 |
| 영상 + 오디오 (파일 1개) | 영상 1개 (`mp4` / fMP4(`.mp4`) / `mov` / `avi`) | 영상 파일 안에 오디오 포함 |
| 영상 + 오디오, 오디오 별도 저장 (파일 2개) | 영상 1개 + 오디오 1개 | 두 파일은 같은 타임스탬프 이름을 공유 |

- 오디오 포맷: WAV(16-bit PCM, 무손실) / MP3(lamejs, 128~320kbps)
- 영상 포맷: MP4(ISO BMFF) / fMP4(조각 MP4, `.mp4`로 저장) / MOV(QuickTime) / AVI(RIFF)
  - 영상 코덱: H.264 (WebCodecs `VideoEncoder`, 최대 1920×1080 @ 30fps)
  - 영상 파일에 담기는 오디오: MP3 (선택한 비트레이트). MP4/MOV/AVI 모두에서 재생 가능한 공통 코덱입니다.
  - MP4·MOV·fMP4는 녹화 중 인코딩된 샘플을 **결과 파일에 바로** 기록하므로 중지 후에는 색인(moov) 또는 마지막 조각만 쓰고 끝납니다
    (녹화 길이와 무관하게 1초 미만). AVI만 기존처럼 녹화 데이터를 모아 두었다가 중지 시 파일로 만듭니다. → [녹화 중 직접 기록](#장시간-녹화-결과-파일-직접-기록-mp4movfmp4--청크-저장소-avi)
  - fMP4(조각): 약 2초마다 `moof`+`mdat` 조각을 기록합니다. 브라우저가 비정상 종료돼도 저장 폴더에 남은 임시 파일(`*.crswap`)의
    이름을 `.mp4`로 바꾸면 그때까지 기록된 조각을 재생할 수 있습니다. → [fMP4 (조각 MP4)](#fmp4-조각-mp4)
- 녹음 중에도 탭 소리는 그대로 들립니다 (AudioContext 루프백).
- 일시정지 / 재개: 녹화 중 "일시정지"를 누르면 캡처는 유지한 채 인코딩만 멈추고, "재개"하면 같은 파일에 이어서 기록합니다.
  일시정지 구간은 파일에 남지 않으며(8초 녹화 + 4초 일시정지 + 4초 녹화 → 약 12초 파일), 일시정지 중에도 중지할 수 있습니다.
- 저장 위치: 기본은 Chrome 다운로드 폴더(`chrome.downloads`). 설정 페이지(팝업 ⚙)에서 폴더를 한 번 고르면 녹화 파일을 그 폴더에
  **직접 기록**해 다운로드 복사 단계(1080p 1시간 기준 약 49초)가 없어집니다. MP4·MOV·fMP4 영상은 녹화하는 동안 그 폴더의 최종 파일에
  바로 쓰입니다. → [저장 폴더](#저장-폴더-설정-페이지-file-system-access-api)
- 모든 설정(모드, 포맷, 비트레이트, 샘플레이트, 저장 위치 모드·폴더 이름)은 `chrome.storage.sync`에 저장됩니다. 폴더 핸들 자체는 IndexedDB에 보관합니다.

## 요구 사항

- Chrome 116 이상 (`manifest.json`의 `minimum_chrome_version`; `chrome.runtime.getContexts`, Offscreen Document)
- 영상 녹화는 WebCodecs `VideoEncoder` + `MediaStreamTrackProcessor`(Chrome 94+)와 H.264 인코더가 필요합니다.
  지원되지 않는 환경에서는 "H.264 영상 인코딩을 지원하지 않습니다" 오류를 표시합니다.

## 설치

1. `chrome://extensions` → 개발자 모드 켜기
2. "압축해제된 확장 프로그램을 로드합니다" → 이 폴더(`recorda/`) 선택

## 사용 방법

1. 녹화할 탭에서 미디어를 재생한 뒤 확장 아이콘 클릭
2. 녹화 모드 선택 → 왼쪽 "영상" 열에서 영상 포맷(MP4 / fMP4 (조각) / MOV / AVI), 오른쪽 "오디오" 열에서 오디오 포맷·MP3 비트레이트·샘플레이트 선택
3. "녹화 시작" → (필요하면 "일시정지" / "재개") → "녹화 중지"
4. 파일은 설정 페이지에서 정한 위치(기본: 다운로드 폴더, 또는 고른 폴더)에 저장되고, 완료 메시지에 저장된 곳이 표시됩니다
   (`recorda_YYYYMMDD_HHMMSS.확장자`, 녹화 **시작** 시각 기준. 분리 저장의 두 파일은 같은 이름을 공유)
5. 저장 위치는 팝업에 표시하지 않습니다. 확인하거나 바꾸려면 팝업 오른쪽 위 ⚙(또는 `chrome://extensions` → 확장 프로그램 옵션)으로 설정 페이지를 엽니다.

### 팝업 화면

- 맨 위 한 줄: 제목, 상태(대기 중 / 녹화 중... / 일시정지 / 파일 생성 중...), 설정(⚙) 버튼. 세 요소는 같은 높이(24px)의 줄 상자를 쓰는
  flex 행에서 세로 중앙선을 공유합니다. ⚙는 상태 줄과 같은 높이의 24px 정사각형 버튼(위쪽 여백·위치 보정 없음)이고, 오른쪽 끝이 아래 콘텐츠
  (녹화 모드 선택 상자, 녹화 버튼)의 오른쪽 끝과 맞습니다. 그 아래 경과 시간과 녹화 모드(전체 폭).
- 녹화 모드 아래 두 열: **왼쪽 "영상"**(영상 포맷), **오른쪽 "오디오"**(오디오 포맷, MP3 비트레이트, 샘플레이트). 폭 420px.
- 모드별 활성 규칙 (녹화·일시정지·처리 중에는 모든 설정이 비활성):

| 모드 | 영상 열 | 오디오 포맷 | 비트레이트 / 샘플레이트 |
|---|---|---|---|
| 오디오만 녹음 | 비활성(회색) + "영상 녹화 안 함" | 활성 | 활성 |
| 영상 + 오디오 (파일 1개) | 활성 | 비활성 + "영상 파일에 포함" | 활성 (영상 파일 속 MP3에 적용) |
| 영상 + 오디오, 오디오 별도 저장 | 활성 | 활성 | 활성 |

- 저장 위치는 팝업에 표시하지 않습니다(설정 페이지에서만 확인·변경). 녹화가 끝나면 완료 메시지에 파일이 저장된 곳을 적습니다
  (`녹화가 완료되어 2개 파일이 'Recordings'에 저장되었습니다. (MP4, WAV)` / `... 다운로드 폴더에 저장되었습니다.`).
- 높이(대기·녹화 중·일시정지 동일, Chrome 팝업 최대 600px): 오디오만 437px, 영상+오디오 454px, 분리 저장 437px. 4줄짜리 완료/오류 메시지가
  붙는 가장 긴 상태는 519~536px입니다(Noto Sans KR 기준). 줄 높이와 선택 상자 높이를 고정해 메시지를 뺀 부분의 높이는 사용자의 한글 폰트
  (맑은 고딕, Apple SD Gothic Neo, Noto Sans CJK 등)의 기본 줄 간격과 무관합니다(DejaVu·Noto Sans KR에서 같은 값). 메시지 줄 수만 글꼴 폭에 따라 달라집니다.

## 아키텍처

```
popup.js ──START/PAUSE/RESUME/STOP_RECORDING──▶ background.js ──START/PAUSE/RESUME/STOP_CAPTURE──▶ offscreen.js
   ▲                                              │  (tabCapture.getMediaStreamId,                     │
   │ STATE_CHANGED / UPDATE_TIME                  │   recording-plan 검증, 상태 머신,                  │ getUserMedia(tab audio[+video])
   └──────────────────────────────────────────────┤   chrome.downloads 저장)                           │
                                                  ◀──DOWNLOAD_FILE / RECORDING_COMPLETE / HEARTBEAT───┘
```

| 메시지 | 방향 | 내용 |
|---|---|---|
| `START_RECORDING` / `STOP_RECORDING` | Popup → Background | 녹화 시작(IDLE에서만, `saveLocation: 'folder' \| 'downloads'`) / 중지(RECORDING·PAUSED → PROCESSING) |
| `PAUSE_RECORDING` / `RESUME_RECORDING` | Popup → Background | 일시정지(RECORDING → PAUSED) / 재개(PAUSED → RECORDING). 응답에 최신 상태 포함 |
| `START_CAPTURE` / `STOP_CAPTURE` | Background → Offscreen | 캡처·인코딩 시작(`saveToFolder: true/false`) / 중지 후 파일 생성 |
| `DOWNLOAD_FILE` | Offscreen → Background | 다운로드 폴더로 저장할 파일의 Blob URL (폴더에 직접 저장한 파일은 보내지 않음) |
| `RECORDING_COMPLETE` | Offscreen → Background | 결과 파일 목록 `files[]`(`format`: 녹화 포맷(fMP4는 `fmp4`), `label`: 표시 이름(fMP4는 `MP4`), `savedTo: 'folder' \| 'downloads'`, `location`: 폴더 이름), `savedTo` 요약(`folder`/`downloads`/`mixed`), `warning`, 단계별 `timings` |
| `RECORDING_ERROR` | Offscreen → Background | 시작·중지 실패, 또는 녹화 중 영상 파일 쓰기 실패로 녹화를 스스로 멈춘 경우(`ERROR_MESSAGES.VIDEO_WRITE_FAILED` + 원인) |
| `PAUSE_CAPTURE` / `RESUME_CAPTURE` | Background → Offscreen | 인코더 입력 중단 / 재개 (캡처 스트림·루프백·하트비트는 유지) |
| `RECORDING_HEARTBEAT` | Offscreen → Background | 20초마다. SW 상태 복구용 (`paused`, `pausedAt`, `pausedTotalMs` 포함) |
| `STATE_CHANGED` / `UPDATE_TIME` | Background → Popup | 상태와 일시정지 시간을 뺀 경과 시간 (`paused`, `pausedTotalMs`, `effectiveStartTime` 포함) |

| 파일 | 역할 |
|---|---|
| `background.js` | 상태 관리, 녹화 계획 검증, Offscreen 생명주기, `chrome.downloads`로 파일 저장 |
| `offscreen.js` | 탭 캡처, AudioWorklet 기반 PCM 추출, 오디오/영상 인코더 구동, 파일 생성 (저장 폴더 직접 기록 또는 다운로드) |
| `popup.html` / `popup.js` | 녹화 UI (영상/오디오 두 열, 녹화 시작 시 폴더 권한 확인. 저장 위치는 표시하지 않음) |
| `settings.html` / `settings.js` | 설정 페이지(`options_page`): 현재 저장 위치 표시(저장 위치를 보여 주는 유일한 화면), 저장 폴더 선택·권한 상태·권한 다시 요청·기본으로 되돌리기 |
| `save-location.js` | 폴더 핸들 IndexedDB 보관, `chrome.storage.sync` 미러, 권한 조회/요청, 쓰기 확인, 겹치지 않는 파일명 |
| `recording-plan.js` | 모드·포맷 → 캡처 여부와 출력 파일 목록(순수 함수) |
| `encoders.js` | 오디오 단독 파일용 스트리밍 MP3/WAV 인코더 (기존) |
| `container-audio-encoder.js` | 영상 컨테이너에 담을 MP3 프레임 생성 (작성기로 바로 넘기거나 AVI 청크 저장소에 쌓음) |
| `video-recorder.js` | `VideoTrackEncoder`(WebCodecs H.264, 원본 타임스탬프 + `adjustTimestamp` 보정) + `VideoRecordingSession`(MP4/MOV/fMP4 직접 기록, AVI 머싱, 녹화 중 쓰기 실패 알림) |
| `muxers/direct-mp4-writer.js` | `DirectMp4Writer`: 녹화 중 샘플을 최종 MP4/MOV의 mdat에 도착 순서대로 쓰고(8 MB 고정 버퍼), 중지 시 64비트 mdat 크기 패치 + moov만 작성 |
| `muxers/fmp4-writer.js` | `FragmentedMp4Writer`: 조각 MP4 - 초기화 moov(mvex/trex) 뒤에 약 2초마다 `moof`+`mdat` 조각 기록, 쓰다 만 조각은 `free`로 남김(활성화), 기록한 조각은 메모리에서 버림 |
| `muxers/mp4-muxer.js` | MP4/MOV 머서와 공통 moov 작성(`prepareMp4Tracks` + `buildMp4Moov`, 샘플 접근자·청크 오프셋 접근자 입력: 머서·직접 기록·fMP4 초기화 세그먼트가 같은 구현 사용). avc1 + mp4a/esds 또는 `.mp3`, MP3 인코더 지연 elst 보정 |
| `muxers/avi-muxer.js` | AVI 머서 (H264 Annex B + MP3, 고정 fps 슬롯·빈 청크로 타이밍 유지) |
| `muxers/h264.js` | Annex B ↔ AVC 변환, avcC 생성/해석, SPS 크기 해석 |
| `muxers/mp3-frames.js` | MP3 바이트열을 프레임 단위로 분리 |
| `muxers/byte-writer.js` | 바이너리 작성 유틸 |
| `storage/chunk-store.js` | OPFS 청크 저장소(AVI용, 고정 버퍼 2개 append, BYOB `readInto`), `DirectoryFileSink`(OPFS·사용자 폴더 공용, `writeAt` 위치 쓰기), `FailoverFileSink`(폴더 + OPFS 예비본, 오디오 파일용) |
| `storage/sample-index.js` | `SampleIndex`: 샘플 메타데이터를 객체 없이 열(column)별 typed array로 보관 (영상 23 B/샘플, 오디오 14 B/프레임) |
| `muxers/sample-access.js` | 머서 입력 접근자: 샘플 배열과 `SampleIndex`를 같은 인덱스 API로 읽음 (샘플마다 객체를 만들지 않음) |

### A/V 동기화

- 오디오 파이프라인 시작 시각과 첫 영상 프레임 도착 시각의 차이를 측정해 영상 타임스탬프에 보정합니다.
- MP4/MOV: 프레임별 실제 간격을 `stts`에 기록하고, MP3 인코더 지연(1105 샘플)은 `elst`로 상쇄합니다.
- fMP4: 같은 간격을 조각마다 `trun`(샘플 길이)·`tfdt`(조각 시작 시각)에 기록하고, 인코더 지연은 초기화 moov의 `elst`(media_time 1105,
  segment_duration 0 = 이후 모든 조각에 적용, ffmpeg 조각 출력과 같은 방식)로 상쇄합니다. ffmpeg 계열은 조각 파일의 elst를 앞부분 잘라내기 대신
  오디오 타임스탬프를 당겨 적용하므로 오디오 `start_time`이 -0.025초(인코더 지연 무음)로 보이지만, 영상 기준 소리 위치는 MP4와 같습니다.
- 타임스탬프 보정(정렬 오프셋, 일시정지 구간 제외)은 `VideoTrackEncoder.adjustTimestamp(원본, i)` 하나로 계산합니다. MP4/MOV·AVI는 원본
  타임스탬프를 인덱스에 두고 중지 시 접근자로, fMP4는 샘플이 들어올 때 적용하며 결과가 같습니다(필요한 값이 그 샘플 인코딩 전에 정해짐).
- AVI: 30fps 고정 타임라인에 프레임을 배치하고 비는 슬롯은 길이 0 청크(이전 프레임 반복)로 채웁니다.
- 정적인 화면은 프레임이 드물게 오므로, 오디오가 더 길면 마지막 영상 프레임을 오디오 끝까지 늘립니다.
- 녹화 중 탭 크기가 바뀌어도 파일 해상도는 첫 프레임 크기로 고정됩니다(파일당 하나의 `avcC`). 비율이 같으면 Chrome `VideoEncoder`가
  스케일링하고, 비율이 바뀐 경우(창 모양 변경)에만 OffscreenCanvas 레터박스로 정규화합니다.

### 일시정지 / 재개

상태는 `IDLE → RECORDING ⇄ PAUSED → PROCESSING → IDLE`로 바뀝니다. 시작은 IDLE에서만, 중지는 RECORDING·PAUSED 모두에서 할 수 있습니다.

- Background: 일시정지 시작 시각(`pausedAt`)과 끝난 일시정지들의 누적 시간(`pausedTotalMs`)을 다른 상태와 함께 `chrome.storage.session`에
  저장합니다. GET_STATE / STATE_CHANGED / UPDATE_TIME의 경과 시간은 일시정지 시간을 뺀 값이고 일시정지 중에는 멈춥니다. 배지는 녹화 중 `REC`,
  일시정지 중 `II`입니다. Offscreen이 일시정지/재개를 거부하면 이전 상태로 되돌리고 오류를 응답합니다.
- Popup: 녹화 중에는 중지 버튼 옆에 "일시정지"(일시정지 중에는 "재개") 버튼이 나타납니다. 상태 페이로드의 `effectiveStartTime`
  (= startTime + pausedTotalMs)으로 자체 타이머를 돌리므로 일시정지 중에는 시간이 멈추고 재개하면 멈춘 값에서 이어집니다.
- Offscreen: 캡처 스트림, 루프백(탭 소리), 하트비트는 그대로 두고 인코더 입력만 멈춥니다.
  - 오디오: 워크릿에 `pause`를 보내면 워크릿이 그때까지 모은 PCM(4096 샘플 배치 미만)을 먼저 보내고 `paused`로 응답합니다. 그 전에 도착한
    PCM은 기록하고, 이후 PCM은 오디오 파일 인코더와 영상 세션 어느 쪽에도 넘기지 않습니다. 배치(44.1 kHz에서 약 93 ms)가 아니라 렌더 퀀텀
    (128 샘플, 약 3 ms) 단위로 잘리므로 재개 후 A/V가 어긋나지 않습니다. 응답이 300 ms 안에 없으면 그 뒤 PCM은 버립니다.
  - 영상: `VideoTrackEncoder`는 트랙을 계속 읽되 프레임을 인코딩하지 않고 닫습니다(`pausedFrames`, 드롭과 별도 집계). 재개 후 첫 프레임은
    키프레임으로 인코딩하고 일시정지 구간을 이후 타임스탬프에서 뺍니다. 구간 길이는 프레임 타임스탬프(일시정지 전 마지막 프레임 → 재개 후 첫 프레임,
    한 프레임 간격은 남김)로 계산해 끊김 없이 이어 붙입니다. 정적인 화면처럼 프레임이 드물어 이 값이 실제 일시정지보다 길면 그 차이만큼 영상이
    오디오보다 앞서게 되므로, 실제(벽시계) 일시정지 시간 + 1프레임을 상한으로 둡니다.
- 일시정지 중 중지하면 일시정지 전까지의 데이터로 정상적으로 파일을 만들고, 일시정지 중 탭이 닫혀도 녹화를 마무리합니다.
- 실측 (E2E `pause-mp4`, 720p, 8초 녹화 → 4초 일시정지 → 4초 녹화): 파일 길이 12.7초(일시정지를 포함했다면 약 16.9초), 재개 지점 포함 최대
  프레임 간격 82 ms, A/V 길이 차 0.00초. 가짜 소스의 영상 배경색(시간에 비례한 색상)과 오디오 LFO 위상을 일시정지 앞뒤로 비교하면 영상은 4160 ms,
  오디오는 4159 ms가 빠져 재개 후 A/V 어긋남은 1 ms 미만이었습니다. 일시정지 동안 CPU는 녹화 중 약 90%에서 약 30%(테스트용 가짜 소스 비용 포함)로
  줄었습니다.

### 장시간 녹화: 결과 파일 직접 기록 (MP4/MOV/fMP4) / 청크 저장소 (AVI)

인코딩된 데이터는 메모리에 쌓지 않고 디스크에 바로 기록합니다. MP4·MOV·fMP4는 녹화하는 동안 **최종 결과 파일**에 쓰고, AVI만 녹화 중
Origin Private File System(OPFS, `navigator.storage.getDirectory()`)의 청크 저장소에 모았다가 중지 시 파일로 만듭니다.

이전에는 모든 영상 포맷이 녹화 중 OPFS 청크 저장소에 쌓은 뒤 중지 시 최종 파일로 다시 복사(머싱)했습니다. 3시간 720p 녹화(MP4 3.07 GB,
폴더 저장)에서는 중지 후 101초 중 100.9초가 이 복사였습니다. 지금은 이 복사가 없습니다(아래 표).

- MP4·MOV (`muxers/direct-mp4-writer.js`, `DirectMp4Writer`): mdat을 앞에 두는 레이아웃으로 처음부터 결과 파일에 씁니다.

  ```
  ftyp | mdat(16바이트 헤더: size=1 + 64비트 largesize 자리) | 영상·오디오 샘플(도착 순서) ... | moov
  ```

  샘플은 `BatchWriter`(8 MB 고정 버퍼 하나)로 묶어 순서대로 쓰고, 메모리에는 `SampleIndex`에 샘플의 **파일 안 실제 위치**(헤더 길이 +
  지금까지 쓴 바이트)·크기·원본 타임스탬프·키프레임만 남깁니다(영상 23 B / 오디오 14 B, 샘플마다 객체 없음). 중지 시에는 버퍼를 비우고,
  `sink.writeAt`으로 mdat 크기를 패치한 뒤 moov만 씁니다. moov는 `planMp4`와 같은 구현(`prepareMp4Tracks` + `buildMp4Moov`, 샘플·청크
  오프셋 접근자 입력)으로 만들어 stts/stss/stsz/elst·마지막 샘플 연장·정렬/일시정지 보정이 기존 머서와 같습니다(테스트로 비교). 오프셋이
  2^32-1을 넘으면 `co64`를 씁니다. 결과 파일은 녹화 시작 때 만들어지므로(첫 쓰기) 쓸 수 없는 위치는 시작할 때 드러납니다.
- fMP4 (`muxers/fmp4-writer.js`): 약 2초마다 `moof`+`mdat` 조각을 바로 씁니다 → [fMP4 (조각 MP4)](#fmp4-조각-mp4).
- AVI: 녹화 중 영상 H.264 청크와 컨테이너용 MP3 프레임을 `OpfsChunkStore`에 append하고(1 MB 고정 버퍼 2개를 번갈아 채워 씀), 중지 시
  `writeAvi`가 청크를 순차로 읽어 결과 파일에 씁니다(2 GB 초과 예상 시 같은 청크로 MP4를 만듦). 메모리 방식(`buildAvi`)과 바이트 단위로 같은
  파일을 만든다는 것을 테스트로 보장합니다. 머싱 중 폴더 쓰기가 실패해도 청크 저장소에서 OPFS로 다시 만들 수 있습니다.
- 결과 파일 위치: 폴더 저장이면 처음부터 사용자 폴더의 파일, 기본(다운로드)이면 OPFS의 `video.mp4`/`video.mov`를 만든 뒤 그 `File`을
  `chrome.downloads`로 저장합니다(`Blob` 복사 없음). OPFS 디스크 사용량도 이전(청크 저장소 + 결과 파일 = 영상 크기의 2배)의 절반 이하입니다.
- 녹화 중 결과 파일 쓰기가 실패하면(권한 회수, 드라이브 분리, 디스크 부족) 조용히 계속하지 않고 녹화를 멈춰 `ERROR_MESSAGES.VIDEO_WRITE_FAILED`
  ("영상 파일을 저장 위치에 쓰지 못해 녹화를 중지했습니다…" + 원인)로 알립니다. 청크 저장소가 없어 다른 곳에 다시 만들 수 없기 때문입니다.
  완성할 수 없는 영상 파일은 지우고, 분리 저장의 오디오 파일은 기존처럼 OPFS 예비본으로 온전히 저장합니다.
- 오디오 단독 파일도 `WavFileEncoder` / `Mp3FileEncoder`가 디스크 싱크에 바로 기록합니다(WAV는 종료 시 헤더만 패치).
- OPFS 임시 파일은 다음 녹화 시작 시(폴더 저장은 완료 즉시) 정리되고, OPFS를 쓸 수 없는 환경에서는 메모리 저장소로 폴백합니다.

이 구조 이전에는 1080p 기준 분당 약 27 MB가 RAM에 쌓이고 분리 저장의 WAV는 종료 시 전체를 메모리에 다시 올려,
1시간 20분 전후로 수 GB에 도달해 탭이 멈추는 문제가 있었습니다.

### fMP4 (조각 MP4)

팝업의 영상 포맷 "fMP4 (조각)"을 고르면 조각(fragmented) MP4를 `.mp4` 파일로 저장합니다(MIME `video/mp4`, 설정 값 `videoFormat: 'fmp4'`,
완료 메시지에는 "MP4"로 표시). 일반 MP4처럼 중지가 빠르고, 추가로 녹화 중 기록된 조각은 브라우저가 비정상 종료돼도 파일에 남습니다.

```
ftyp(iso5: iso5 iso6 isom mp41) | moov(빈 샘플 표 + 오디오 elst 1105 + mvex[mehd 자리, trex×2]) | moof mdat | moof mdat | ...
```

- 초기화 세그먼트: 첫 키프레임의 `avcC`가 정해지면 `moov`를 씁니다. 샘플 표(stts/stsc/stsz/stco)는 항목 0개이고, `mvex`에 트랙별
  `trex`와 `mehd` 자리(같은 크기의 `free`)를 둡니다. 정상 종료 시 이 자리를 전체 길이의 `mehd`로 덮어씁니다(`mvhd` 길이는 규격대로 0).
- 조각: 키프레임이 오면 그 앞까지를 닫아 조각이 키프레임으로 시작하게 하고(인코더 키프레임 60프레임 = 30fps에서 2초), 키프레임이 드물면
  영상 2초(+10% 여유, 2.2초)에서 닫습니다. 영상 프레임이 오래 안 오는 정적인 화면에서는 오디오가 4초 쌓이면 닫습니다. 조각 하나 =
  `moof`(mfhd 순번, 트랙별 tfhd[default-base-is-moof + 기본 샘플 플래그] / tfdt v1 / trun[data-offset, 샘플 길이, 크기, 영상은 sync/non-sync 플래그])
  + `mdat`(영상 샘플 → 오디오 프레임)이고 write 한 번으로 기록합니다.
- 영상 샘플 길이는 다음 샘플의 타임스탬프로 정해지므로 가장 최근 샘플 하나를 다음 샘플이 올 때까지 붙잡아 둡니다. 마지막 샘플은 직전 간격을
  쓰고 오디오가 더 길면 오디오 끝까지 늘립니다(MP4와 같은 규칙, 테스트로 `buildMp4`의 stts와 같음을 확인). 파일 첫 샘플의 길이에는 A/V 정렬
  오프셋이 들어 있으므로 조각 길이를 잴 때는 빼고 잽니다(그러지 않으면 첫 조각이 키프레임 직전에 잘림, E2E `pause-fmp4`에서 발견해 수정).
- 메모리: 기록한 조각의 샘플 데이터와 목록은 버리고 개수·누적 길이만 남깁니다. 영상 73만 + 오디오 41만 샘플을 넣어도 JS 힙 증가가 30 MB 미만입니다.
- **조각 활성화**(비정상 종료 대비): 조각은 `moof` 자리의 상자 타입을 `free`로 써 두었다가 조각 전체(moof + mdat) 쓰기가 끝난 뒤 4바이트를
  `moof`로 바꿉니다(`writeAt`). 이 컨테이너의 ffmpeg(2018 정적 빌드)는 moof의 tfhd~trun 중간에서 잘린 파일을 **통째로** 열지 못하는데
  (`error reading header`, 단위 테스트로 확인), 이렇게 하면 쓰다 만 조각은 항상 건너뛰는 `free` 상자로 남아 그 앞의 조각까지 정상 재생됩니다.
  `moof`로 보이는 조각은 mdat까지 모두 기록된 것입니다. 비용은 조각마다(약 2초) 작은 위치 쓰기 1회입니다.
- 오디오 인코더 지연(1105 샘플)은 초기화 moov의 `elst`(segment_duration 0)로 상쇄합니다 → [A/V 동기화](#av-동기화).
- 길이: `mehd`를 읽는 플레이어는 조각을 다 읽지 않고도 길이를 압니다. ffmpeg는 열 때 모든 moof를 읽어 길이를 계산하므로 `mehd` 없이도(비정상
  종료로 남은 파일) 길이·탐색이 동작합니다. `sidx`/`mfra`(조각 색인)는 쓰지 않습니다.
- 비정상 종료 후 복구: 사용자 폴더에 저장 중이면 Chrome은 쓰는 내용을 같은 폴더의 `<이름>.mp4.crswap` 스왑 파일에 두었다가 닫을 때 바꿔 넣습니다.
  브라우저가 비정상 종료되면 이 스왑 파일(과 크기 0인 `<이름>.mp4`)이 남는데, 스왑 파일 이름 끝의 `.crswap`을 지워 `.mp4`로 바꾸면 마지막으로
  활성화된 조각까지 재생됩니다(설정 페이지에도 안내). 기본(다운로드 폴더) 저장은 녹화 중 브라우저 내부 저장소(OPFS)에 기록하므로 복구할 수 없습니다.
- 녹화 중 쓰기 실패는 MP4와 같이 녹화를 멈추고 알립니다(스트림이 오류 상태가 되면 스왑 파일도 버려지므로 그때까지의 조각은 남지 않음).
- 실측 (E2E `crash-fmp4`, 720p fMP4, 폴더 = OPFS 루트, 녹화 20초 뒤 Chrome 브라우저 프로세스 SIGKILL): 죽이기 직전 OPFS 루트에는 크기 0인
  `recorda_….mp4`와 5,545,866 B의 `recorda_….mp4.crswap`이 있었고, 디스크에는 프로필 `Default/File System/000/t/00/00000001`(5.29 MB)로
  남았습니다. 이 파일은 ftyp iso5 → moov → 조각 10개(활성화 안 된 조각 0, tfdt 연속, 모두 키프레임으로 시작)이고 ffprobe가 영상 600프레임
  (20.42초)·오디오 774프레임을 오류 없이 디코딩했습니다(마지막 조각까지 전부). 헤드리스에서는 실제 로컬 폴더를 고를 수 없어 사용자 폴더의
  `.crswap` 이름 바꾸기 복구 자체와 QuickTime·Windows 기본 플레이어 재생은 확인하지 못했습니다.

### 녹화 종료 후 파일 생성 시간

**직접 기록 이후 (MP4·MOV·fMP4)**: 중지 후에는 인코더 마감, 쓰기 버퍼 비우기 + moov(또는 마지막 조각), WAV 헤더 패치뿐이라 녹화 길이와
거의 무관합니다. E2E `folder-split-*-wav`, 720p, 폴더 = OPFS 루트, `--verify=light --recordAgain`, 2코어 컨테이너 실측:

| 녹화 길이 | 영상 포맷 | 데이터 (영상 + WAV) | 중지 → `RECORDING_COMPLETE` | → 팝업 완료 | → 다시 녹화 가능 | Offscreen 처리 (영상 / WAV 마감 / 합계) | 영상 단계 (인코더 / 컨테이너 오디오 / moov 계산 / 기록 / 닫기) | 이어서 10초 다시 녹화 (중지 → 완료 / 다시 녹화 가능) | 프로필(OPFS) 디스크 최대 |
|---|---|---|---|---|---|---|---|---|---|
| 10분 | **MP4 직접 기록** | 164 + 100 MB | **112 ms** | 130 ms | 215 ms | 42 / 6 / 55 ms | 1 / 11 / 11 / 17 / 2 ms | 96 / 143 ms | 371 MB |
| 10분 | **fMP4** | 165 + 101 MB | **41 ms** | 55 ms | 144 ms | 10 / 6 / 26 ms | 1 / 3 / 0 / 3 / 2 ms | 144 / 254 ms | 376 MB |
| 10분 | 이전: MP4 중지 시 머싱 (2026-10-16) | 166 + 101 MB | 1,897 ms | 1,916 ms | 2,005 ms | 1,639 / 224 / 1,871 ms | 9 / 7 / 13 / 1,607 / 1 ms | 108 / 126 ms | 378 MB |
| 60분 | **MP4 직접 기록** | 1,009 + 603 MB | **104 ms** | 124 ms | 118 ms | 72 / 6 / 92 ms | 2 / 3 / 30 / 34 / 2 ms | 96 / 176 ms | 2,217 MB |
| 60분 | **fMP4** | 1,007 + 602 MB | **63 ms** | 87 ms | 217 ms | 12 / 7 / 28 ms | 1 / 4 / 0 / 4 / 3 ms | 75 / 87 ms | 2,222 MB |
| 3시간 | 이전: MP4 중지 시 머싱 (2026-10-17) | 3,073 + 1,816 MB | 101.1 s | 101.1 s | 101.2 s | 100.9 s / 37 ms / 101 s | - / - / 73 ms / 100.9 s / - | 170 / 190 ms | 9,758 MB |

- 중지 후 시간은 녹화 길이와 거의 무관합니다. MP4는 moov 계산(60분 30 ms, 영상 10.7만 + 오디오 13.7만 샘플)과 버퍼에 남은 데이터 + moov
  쓰기(34 ms)만, fMP4는 마지막 조각과 `mehd` 패치만 씁니다. 이전 3시간 실행의 101초는 청크 저장소 → 결과 파일 복사(3.07 GB)였고 이제 없습니다.
- 프로필 디스크 최대는 폴더(= 헤드리스에서는 OPFS 루트)의 결과 파일(쓰는 동안 `.crswap`) + WAV + WAV 예비본입니다. 이전에는 청크 저장소와
  결과 파일이 함께 있어(3시간 9.76 GB) 영상 크기만큼 더 필요했습니다.
- 녹화 중 메모리는 일정했습니다(60분, 0/10/30/60분: MP4 Chrome PSS 389/546/584/589 MB·렌더러 73/202/239/244 MB·offscreen JS 힙 2/8/15/8 MB,
  fMP4 388/570/601/582 MB·73/224/256/236 MB·2/7/23/5 MB, 선형 추세 +29~49 MB/시간은 렌더러 캐시 변동 범위). MP4 인덱스는 60분 6.4 MB입니다.
- 파일 검증(60분): MP4 영상 107,047 / 오디오 137,218 패킷, fMP4 106,871 / 137,014 패킷(조각 1,835개, tfdt 연속, 97%가 키프레임으로 시작),
  마지막 20초·중간 20초 디코딩 오류 없음, 프레임 DTS 단조 증가. 두 실행 모두 오디오가 영상보다 짧았는데(10분 2.9~4.0초, 60분 18.6~24.1초),
  WAV도 같은 만큼 짧아 인코더·머서 앞(헤드리스 가짜 소스 → 캡처 AudioContext)에서 PCM이 빠진 것입니다. fMP4 60분 실행의 WAV에서 시험 신호
  (440 Hz FM 사인)의 위상 불연속을 찾으면 약 620곳이 1시간에 고르게 흩어져 있고 조각 쓰기(2초) 주기와 맞지 않았습니다. 같은 조건의 변경 전/후
  5분 비교는 아래 "알려진 제한"을 참고하세요.

**이전 구조(중지 시 머싱, 현재는 AVI)**: 중지 후에는 저장소 마감, 머싱(디스크의 샘플을 읽어 MP4/MOV/AVI로 기록), `chrome.downloads` 저장이 순서대로 일어납니다.
머싱은 저장소에서 8 MB 단위로 순차 읽기해 8 MB 고정 버퍼에 모은 뒤 한 번에 씁니다(`muxers/batch-io.js`).
샘플마다 쓰거나 디스크 파일 조각(Blob slice)을 묶으면 1시간 녹화(약 25만 샘플)에서 브라우저 IPC가 수십만 번 생기고
브라우저 프로세스 메모리가 GB 단위로 늘기 때문입니다.

측정: `npm run bench:finalize -- --mode=count --minutes=60` (호출 횟수 비용), `-- --mode=bytes --minutes=3 --mbps=6` (데이터 양 비용).
헤드리스 Chrome 148, 합성 샘플, 2코어 컨테이너 기준입니다.

| 1시간 녹화 기준 | 개선 전 | 개선 후 |
|---|---|---|
| MP4 머싱 (샘플 25.8만 개, 6 Mbps 2.6 GB) | 약 180초 + 브라우저 메모리 1 GB 이상 증가 | 약 9초 |
| AVI 머싱 (2.5 Mbps 1.1 GB, 6 Mbps는 2 GB 초과로 MP4 저장) | 약 310초 | 약 5초 |
| 다운로드 폴더로 복사 (`chrome.downloads`) | 6 Mbps 약 41초 / 2.5 Mbps 약 17초 | 같음 |
| **중지 → 파일 저장 완료 합계 (6 Mbps)** | **약 3분 40초** | **약 50초** |
| **중지 → 파일 저장 완료 합계 (2.5 Mbps)** | **약 3분 20초** | **약 21초** |

남은 시간의 대부분은 다운로드 폴더로의 파일 복사이며 디스크 속도에 비례합니다.

실제 확장 녹화 실측 (1080p 분리 저장 MP4+WAV, 실측 영상 비트레이트 약 3.8 Mbps, 2코어 컨테이너):

| 녹화 길이 | 데이터 (MP4 + WAV) | 중지 → 두 파일 저장 완료 | 단계별 (영상 머싱 / WAV 마감 / 다운로드 복사) |
|---|---|---|---|
| 2분 | 56 + 21 MB | 1.7~1.8초 | 0.6초 / 0.01초 / 1.1초 |
| 10분 | 285 + 106 MB | 12.3초 | 2.7초 / 1.5초 / 8.1초 |
| 60분 (외삽) | 약 1.7 + 0.63 GB | 약 75~80초 | 약 16초 / 9초 / 49초 |

- 1시간 녹화 구간은 실제로 수행해 메모리가 일정함(Chrome 약 560~630 MB)을 확인했습니다. 1시간 데이터의 중지 단계는 이 컨테이너의
  메모리 상한(디스크 캐시 포함 4 GiB)에 걸려 끝까지 측정할 수 없어 2분·10분 실측에서 선형 외삽했습니다.
- 측정 중 디스크 캐시를 강제로 비웠으므로 디스크 기록 속도에 묶인 보수적인 값입니다. 메모리가 충분한 일반 PC에서는 더 짧습니다.

### 중지 단계 메모리 (장시간 녹화)

> 아래는 중지 시 머싱하던 구조(현재는 AVI만 해당)에서 3시간 녹화의 중지 단계 메모리를 줄인 기록입니다. MP4·MOV·fMP4는 이제 중지 시 샘플을
> 다시 읽지 않고 moov(3시간 약 10 MB, 같은 `buildMp4Moov` 구현) 또는 마지막 조각만 씁니다.

이전 3시간 실행(720p 분리 저장 MP4+WAV, 폴더 저장)은 녹화 중에는 정상이었지만(Chrome PSS 523 → 653 MB, CPU 약 90%) 중지 4.6초 만에
컨테이너 메모리가 2.7 → 3.46 GB로 뛰어 하네스 가드가 Chrome을 종료했습니다. 원인은 녹화 길이에 비례하는 중지 단계 할당이었습니다.

| 원인 (이전) | 지금 |
|---|---|
| 녹화 중 샘플마다 `{ ref:{offset,size}, timestamp, keyframe, nalCount }` 객체 (3시간 약 55 MB, JS 힙 6 → 60 MB) | `SampleIndex` typed array (샘플당 23 / 14바이트) |
| 중지 시 `getSamples()`가 샘플 객체를 다시 복사, `planMp4`/`planAvi`가 샘플마다 객체 2~3개 + 배치 항목 객체 + 정렬 (73만 샘플에 힙 +212 MB, 프로세스 +347 MB / 1.2초) | 접근자(`muxers/sample-access.js`)로 바로 읽음. 영상 dts만 `Float64Array` 하나, mdat 배치 순서는 시간순인 두 트랙의 2-포인터 병합 결과를 `Uint8Array`(0 = 영상, 1 = 오디오)로 보관 (정렬 없음) |
| `moov` 작성 시 stbl → minf → mdia → trak → moov 단계마다 표 전체를 다시 복사 (ByteWriter 두 배 증가 포함) | 표 크기를 먼저 세어 버퍼 하나를 잡고 상자를 바로 써 내려감. stts/stss/stsz는 typed array에서, stco/co64는 오프셋 배열 없이 배치 순서를 다시 따라가며 계산 (co64 항목마다 BigInt도 만들지 않음) |
| AVI: 슬롯마다 청크 객체·헤더 `Uint8Array`, 영상 청크마다 Annex B 변환 버퍼 | 청크 순서 `Uint8Array`(영상/빈 슬롯/오디오) + 정확한 크기의 `idx1` 버퍼 하나, 변환은 시작 코드와 NAL 뷰를 BatchWriter에 바로 씀 |
| 순차 읽기 창마다 `file.slice().arrayBuffer()`로 8 MB 새 버퍼 → GC 전까지 렌더러에 누적 | 창 버퍼 하나를 `readInto`(Blob 바이트 스트림 BYOB 리더)로 같은 메모리에 다시 채움 (BYOB를 못 쓰면 읽은 뒤 복사) |

- 쓰기는 이전과 같이 8 MB 고정 버퍼 하나(`BatchWriter`)에 모아 `sink.write(subarray)`를 **await**한 뒤 버퍼를 재사용합니다(디스크 속도에 맞춰
  진행, 동시에 진행 중인 쓰기 최대 1개). `DirectoryFileSink.write`는 받은 뷰를 복사 없이 `FileSystemWritableFileStream.write`에 넘깁니다.
- 폴더 저장은 영상·오디오 파일을 모두 닫은 뒤에 OPFS 임시 데이터(청크 저장소·오디오 예비본)를 지우고(테스트로 순서 보장), 저장된 `File` 참조도 바로 놓습니다.
- 기존 메모리 방식(`buildMp4`/`buildAvi`, 샘플 배열)은 그대로 지원하며, 리팩터링 전 구현이 만든 22개 케이스의 출력과 SHA-256이 같고
  (`tests/muxer-golden.test.js`), `SampleIndex` 경로도 배열 경로와 바이트 단위로 같습니다.
- `RECORDING_COMPLETE.timings.video`에 영상 단계 세부(인코더 마감 / 컨테이너 오디오 마감 / 머싱 계획 / 기록 / 출력 닫기, ms)를 보고합니다.

측정 1 - 머싱 계획 (Node 24, `tests/muxer-scale.test.js`, 영상 734,400 + 오디오 411,000 샘플, 저장소 참조만. 실제 3시간은 영상 약 32만 + 오디오 약 41~45만):

| | 이전 (샘플 객체) | 지금 (SampleIndex) |
|---|---|---|
| `planMp4` 시간 | 2,565 ms | 83~85 ms |
| `planMp4` 계획 결과가 붙잡는 메모리 (GC 후) | +304 MB | +11.3 MB (moov 10 MB 포함) |
| `planMp4` 계획 중 증가 (GC 전) / RSS 증가 | +330 MB / +459 MB | +17.6 MB / +11 MB |
| `planAvi` 시간 | 1,830 ms | 83 ms |
| `planAvi` 유지 (GC 후) / RSS 증가 | +454 MB / +567 MB | +18.6 MB (idx1 17.5 MB) / +1 MB |

측정 2 - 실제 Chrome 머싱 쓰기 경로 (`npm run bench:finalize -- --mode=bytes --minutes=10 --mbps=2.5 --format=mp4`, 189 MB, 100 ms 간격 RSS):

| | 이전 | 지금 |
|---|---|---|
| 확장 렌더러 RSS (머싱 중 피크 - 시작) | +36~58 MB (RssAnon 96 → 129~151 MB) | +0 MB (RssAnon 79 → 79 MB) |
| 브라우저 프로세스 RSS | +4~5 MB | +3~4 MB |
| 컨테이너 anon (cgroup) | +45~79 MB | +8~10 MB |
| 머싱 시간 (finalize 포함) | 1.42~1.6초 | 1.31~1.55초 |
| 저장소 읽기 방식 | `arrayBuffer()` 창마다 새 버퍼 | BYOB `readInto` (창 버퍼 재사용) |

측정 3 - E2E (`folder-split-mp4-wav`, 720p, 폴더 = OPFS 루트, `--verify=light --recordAgain`):

| 녹화 길이 | 데이터 (MP4 + WAV) | 중지 → `RECORDING_COMPLETE` | → 팝업 완료 | → 다시 녹화 가능 (대기 중·버튼 활성·SW IDLE·임시 정리) | 단계별 (영상 계획 / 기록 / WAV 마감 / 임시 정리) | 이어서 10초 다시 녹화 (중지 → 완료 / 다시 녹화 가능) |
|---|---|---|---|---|---|---|
| 10분 | 166 + 101 MB | 1.90초 | 1.92초 | 2.01초 | 13 ms / 1.61초 / 224 ms / 15 ms | 0.11초 / 0.13초 |
| **3시간** | **3,073 + 1,816 MB** | **101.1초** | **101.1초** | **101.2초** | 73 ms / 100.9초 / 37 ms / 4 ms | 0.17초 / 0.19초 |

- 3시간 실행(2026-10-17): 녹화 중 Chrome PSS 581 → 615 MB, JS 힙 10~22 MB, CPU 60초 평균 61~93%로 평탄. 샘플 인덱스는 11.5 MB.
  중지 후 101초의 기록 구간에서 컨테이너 anon 1,42x MB로 변화 없음, 디스크 캐시(file) 약 600 MB 유지(상시 해제). 중지 시간은 사실상
  MP4 3.07 GB를 폴더에 쓰는 디스크 처리량(약 30 MB/s, 이 컨테이너 기준)이 전부입니다. 결과 파일은 전체 디코딩과 중간 20초 디코딩 모두 오류 없음,
  영상 323,602프레임 드롭 0. 바로 이어서 10초 녹화가 정상 완료됐습니다.
- 3시간 파일의 A/V 길이 차이는 8.1초(영상 10,802초, 오디오 10,794초, 0.075%)로 남아 있습니다. 헤드리스 가상 오디오 장치의 샘플 누락으로
  추정되지만 실제 PC에서 확인이 필요합니다(이전 실행에서는 70초였으며, 환경 부하에 따라 달라집니다).

- 10분 실행의 중지 구간(1초 표본)에서 컨테이너 anon은 1,207 → 1,219 → 1,187 MB로 늘지 않았고, 기록한 MP4의 디스크 캐시(file)만
  2초 동안 +200 MB 생겼다가 비워졌습니다. 프로필(OPFS) 디스크는 최대 378 MB → 정리 후 278 MB(폴더에 저장된 두 파일).

### 저장 폴더 (설정 페이지, File System Access API)

기본 저장 방식은 OPFS에 파일을 만든 뒤 `chrome.downloads`로 다운로드 폴더에 **복사**합니다. 이 복사는 디스크 속도에 비례해
1080p 1시간 녹화에서 약 49초가 걸립니다(위 표). 설정 페이지에서 폴더를 고르면 결과 파일을 그 폴더에 처음부터 기록하므로 복사 단계가 없습니다.

```
설정 페이지 ── showDirectoryPicker({mode:'readwrite'}) → 확인 파일 생성·삭제 → IndexedDB(핸들) + storage.sync(모드·이름 미러)
팝업 (녹화 시작 클릭) ── 핸들 queryPermission → granted가 아니면 requestPermission ──▶ START_RECORDING { saveLocation }
Background ──▶ START_CAPTURE { saveToFolder } ──▶ Offscreen: IndexedDB에서 핸들 로드 → queryPermission → 폴더에 직접 기록
```

- 설정 페이지: 현재 위치(`기본: 다운로드 폴더` 또는 폴더 이름. 팝업에는 저장 위치를 표시하지 않으므로 여기서만 확인), "폴더 선택", "기본 폴더(다운로드)로 되돌리기", 권한 상태(허용됨 / 확인 필요 /
  거부됨)와 "권한 다시 요청" 버튼. 폴더를 고르면 작은 확인 파일을 만들고 지워서 실제로 쓸 수 있는지 확인한 뒤에만 저장합니다.
  폴더 선택 창은 팝업에서 열면 팝업이 포커스를 잃고 닫히므로 설정 페이지(탭)에서만 엽니다.
- 핸들 보관: `FileSystemDirectoryHandle`은 `chrome.storage`에 넣을 수 없어(구조화 복제만 가능) 확장 출처의 IndexedDB에 둡니다
  (`save-location.js`). 팝업이 IndexedDB를 열지 않고도 폴더 모드인지 알 수 있도록(녹화 시작 때 권한 확인 여부 결정) `{ saveLocationMode, saveLocationName }`
  문자열만 `chrome.storage.sync`에 미러링합니다. 핸들은 다른 PC로 동기화되지 않으므로, 동기화된 미러만 있고 핸들이 없으면 다운로드로 저장합니다.
- 기록 방식:
  - 오디오 파일(오디오만 / 분리 저장): 녹화 시작 때 폴더에 파일을 만들고 PCM·MP3를 바로 씁니다. 같은 내용을 OPFS에도 예비본으로 써 두는데
    (`FailoverFileSink`, WAV 기준 분당 약 10 MB의 추가 디스크 쓰기), 녹화 도중 폴더 쓰기가 실패하면(권한 회수, USB 분리, 디스크 부족)
    예비본으로 온전한 파일을 다운로드합니다. 정상 종료 시 예비본은 버립니다.
  - 영상 파일 MP4·MOV·fMP4: 녹화 시작 때 폴더에 결과 파일을 만들고(`VideoRecordingSession`의 `outputSinkFactory`) 녹화하는 동안 그 파일에
    바로 씁니다. OPFS에는 영상 데이터를 두지 않습니다(청크 저장소 없음). 시작 때 폴더 파일을 열지 못하면 그 영상만 OPFS에 기록해 다운로드하고
    `warning`으로 알립니다. **녹화 도중** 폴더 쓰기가 실패하면 다른 곳에 다시 만들 수 없으므로 녹화를 멈추고 `VIDEO_WRITE_FAILED`로 알리며
    (영상 단일 파일 → `RECORDING_ERROR`, 분리 저장 → 오디오 파일은 예비본으로 저장 + `warning`), 완성할 수 없는 영상 파일은 지웁니다.
    8 MB 쓰기 버퍼(MP4·MOV) 또는 조각(fMP4, 약 2초)마다 실제로 쓰므로 실패는 그 주기 안에 드러납니다.
  - 영상 파일 AVI: 녹화 중에는 OPFS 청크 저장소에 쌓고, 중지 시 머서가 결과 파일을 OPFS가 아니라 **폴더에 바로** 씁니다.
    폴더에 쓰다 실패하면 청크 저장소에서 OPFS로 다시 머싱해 다운로드합니다(데이터 손실 없음).
  - 모든 파일이 폴더에 저장되면 `DOWNLOAD_FILE` 없이 `RECORDING_COMPLETE`만 보내므로 Background가 Offscreen을 바로 닫고,
    OPFS 임시 데이터(오디오 예비본, AVI 청크)도 즉시 지웁니다(다운로드 방식은 Blob URL 때문에 다음 녹화 시작 때 정리).
- 파일 이름: 녹화 시작 시각 기준 `recorda_YYYYMMDD_HHMMSS.확장자`(다운로드 방식도 같은 규칙). 폴더에 같은 이름이 있으면 덮어쓰지 않고
  ` (1)`, ` (2)`…를 붙이며, 분리 저장의 두 파일은 같은 새 이름을 공유합니다(fMP4는 `.mp4`). 녹화 중에는 Chrome이 같은 폴더에 빈 대상 파일과
  임시 스왑 파일(`<이름>.crswap`)을 두었다가 닫을 때 바꿔 넣습니다. 브라우저가 비정상 종료되면 이 두 파일이 남을 수 있습니다. fMP4의 스왑 파일은
  이름을 `.mp4`로 바꾸면 마지막으로 기록된 조각까지 재생됩니다(→ [fMP4](#fmp4-조각-mp4)). MP4·MOV의 스왑 파일에는 색인(moov)이 없어 그대로는 재생되지 않습니다.
- 권한:
  - 확장 페이지(설정 탭)에서 허용한 권한은 같은 출처의 팝업·Offscreen 문서에도 적용됩니다. Offscreen 문서는 사용자 제스처가 없어
    권한을 요청할 수 없으므로 녹화 시작 클릭 때 팝업이 `queryPermission` → 필요하면 `requestPermission`을 호출합니다.
  - Chrome은 "이번만 허용" 권한을 브라우저를 다시 시작하거나 확장의 탭을 모두 닫으면 회수할 수 있습니다. 이때 녹화 시작 시 다시 묻고
    (팝업에서 권한 창을 띄울 수 없는 환경이면 설정 페이지의 "권한 다시 요청"), 권한 창에서 계속 허용(Allow on every visit, Chrome 122+)을
    고르면 유지됩니다. 영구 권한은 사용자가 직접 허용해야 하며 확장이 대신 얻을 수 없습니다.
  - 권한을 얻지 못하면 그 녹화만 다운로드 폴더에 저장하고 팝업에 안내합니다. Offscreen에서 폴더를 쓸 수 없으면(핸들 없음, 권한 없음,
    `createWritable` 거부) 해당 파일을 다운로드로 저장하고 `RECORDING_COMPLETE`의 `warning`으로 알립니다. 녹화 중 쓰기 실패는 위 "기록 방식" 참고.
  - Chrome은 다운로드·문서·바탕화면·홈 폴더 자체는 선택을 막을 수 있으므로 그 안의 하위 폴더(예: `다운로드/Recorda`)를 고르세요.
- 실측 (E2E `folder-split-mp4-wav`, 720p 10초 분리 저장 MP4+WAV, 폴더 = OPFS 루트): 직접 기록 이후 중지 클릭 → `RECORDING_COMPLETE` 123 ms,
  → 팝업 완료 메시지 133 ms (Offscreen 처리 42 ms: 영상 30(인코더 마감 5 / 컨테이너 오디오 10 / moov 1 / 기록 12 / 닫기 2) / WAV 마감 6 / OPFS 임시 정리 1).
  fMP4(`folder-split-fmp4-wav`)는 52 ms / 70 ms였습니다. 이전(중지 시 머싱)에는 187 ms / 200 ms(영상 머싱·기록 100 ms)였고, 차이는 녹화 길이에
  비례해 커집니다(10분·60분 실측은 [녹화 종료 후 파일 생성 시간](#녹화-종료-후-파일-생성-시간)).
  실제 로컬 폴더에서는 Chrome이 파일을 닫을 때 안전 검사(Safe Browsing)를 할 수 있어 OPFS 루트보다 조금 더 걸릴 수 있습니다(미측정).

### Service Worker 수명 대응

MV3 Service Worker는 유휴 30초 후 종료될 수 있고, 패키지 설치에서는 `chrome.alarms` 최소 주기가 30초입니다.

- 녹화 상태(일시정지 시각·누적 일시정지 시간 포함)는 `chrome.storage.session`에 저장되고 SW 시작 시 복원됩니다(Offscreen 문서가 살아 있을 때만).
- Offscreen은 녹화 중(일시정지 중 포함) 20초마다 `RECORDING_HEARTBEAT`(tabId, startTime, plan, paused, pausedAt, pausedTotalMs)를 보내
  SW를 깨우고, 상태를 잃었으면 RECORDING 또는 PAUSED로 복구시킵니다.
- 다운로드 대기 목록도 `chrome.storage.session`에 두어 SW가 재시작된 뒤 도착한 `downloads.onChanged`도 처리하며, 타임아웃은 `chrome.alarms`로 걸어 둡니다.
- 팝업은 `effectiveStartTime`(startTime + 누적 일시정지 시간) 기준 자체 타이머로 경과 시간을 표시하고, 일시정지 중에는 타이머를 멈춥니다.
- 녹화 중인 탭이 닫히면(`tabs.onRemoved`, 트랙 `onended`) 일시정지 중이어도 자동으로 녹화를 마무리합니다.

## 테스트

Node.js 20 이상이면 추가 설치 없이 실행됩니다.

```bash
npm test
```

- 순수 모듈(계획, 파일명, 바이트 라이터, MP3 프레임, H.264 유틸, MP4/MOV/AVI 머서, 직접 기록 MP4·fMP4 작성기)은 단위 테스트로 검증합니다.
- `tests/fixtures/*.h264`는 ffmpeg(libx264)로 만든 실제 H.264 스트림이며, 머서 출력은 박스/청크 구조를 직접 파싱해 확인합니다.
- `ffprobe`/`ffmpeg`가 PATH에 있거나 `RECORDA_FFPROBE`, `RECORDA_FFMPEG` 환경 변수로 지정되면
  생성된 MP4/MOV/AVI를 실제로 디코딩해 스트림 정보와 디코딩 오류 유무까지 검사합니다. 없으면 해당 테스트는 건너뜁니다.
- `background.js`, `offscreen.js`는 가짜 `chrome.*` / WebCodecs / Web Audio 객체로 메시지 흐름을 통합 테스트합니다.
  저장 폴더는 가짜 IndexedDB(`tests/helpers/fake-idb.js`, `setIndexedDBFactory`로 주입)와 권한·오류 주입이 되는 가짜 디렉토리 핸들
  (`tests/helpers/fake-opfs.js`)로 검증합니다: 폴더 직접 기록(DOWNLOAD_FILE 없음, OPFS 결과 사본 없음), 권한 없음·`createWritable` 거부·핸들 없음 →
  다운로드 + warning, 녹화 중 쓰기 실패 → 오디오·AVI는 예비본·청크 저장소로 데이터 손실 없음 / MP4·MOV·fMP4는 녹화를 스스로 멈추고
  `VIDEO_WRITE_FAILED`(영상 단일 파일 → `RECORDING_ERROR`, 분리 저장 → 오디오 저장 + warning), 같은 이름 파일 → ` (1)`(`offscreen.test.js`,
  `save-location.test.js`, `chunk-store.test.js`, `video-recorder.test.js`, `background.test.js`).
  일시정지/재개는 상태 전환·영속화·하트비트 복구(`background-pause.test.js`), 일시정지 중 PCM·영상 프레임 차단(`offscreen.test.js`),
  타임스탬프 이어 붙이기·키프레임(`video-recorder.test.js`), 워크릿 경계 처리(`audio-worklet-processor.test.js`, vm에서 실행)로 검증합니다.
- 장시간 녹화 메모리: `SampleIndex` 단위 테스트(`sample-index.test.js`), 리팩터링 전 구현 출력과의 SHA-256 골든 비교 22케이스 + SampleIndex 경로 =
  배열 경로(`muxer-golden.test.js`), 영상 734,400 + 오디오 411,000 샘플 계획이 60 MB·10초 미만인지(`muxer-scale.test.js`),
  고정 버퍼 재사용(`batch-io.test.js`, `chunk-store.test.js`). 메모리 측정에 GC를 쓰므로 `npm test`는 `node --expose-gc --test`로 실행합니다
  (플래그 없이 파일 하나만 돌려도 `v8.setFlagsFromString('--expose-gc')`로 GC를 얻음).
- 직접 기록 MP4/MOV (`direct-mp4-writer.test.js`): 같은 샘플(지터·몰림·빠짐 + 정렬 오프셋 + 2초 일시정지)을 `buildMp4`(메모리 배열)와
  `DirectMp4Writer`(원본 타임스탬프 + 보정 접근자, 도착 순서)로 만들어 두 moov의 stts·stss·stsz·elst·stsd·mvhd/tkhd/mdhd 길이가 같고,
  모든 stco/co64 값이 direct 파일의 실제 샘플 바이트를 가리키는지 확인합니다. 4 GB 초과(2 MB × 2,200 샘플, 데이터를 버리는 싱크) → co64·64비트
  mdat 크기, 8 MB 고정 버퍼 하나로 묶어 쓰기, 녹화 중 쓰기 실패 → onError 1회·이후 샘플 거부, ffprobe 패킷 수·길이 = `buildMp4` 파일,
  영상 73만 + 오디오 41만 샘플 기록 중 메모리 = 인덱스 + 8 MB 버퍼.
- fMP4 (`fmp4-writer.test.js`): 초기화 세그먼트(iso5, 빈 표, mvex/trex, 오디오 elst 1105/0), mfhd 순번, tfhd/tfdt/trun 플래그, 키프레임 경계·
  2초(+10%) 조각 규칙(29.9fps 캡처, 정렬 오프셋이 있는 첫 조각 포함), 샘플 길이 = `buildMp4` stts(일시정지·정렬·마지막 샘플 연장), tfdt 연속,
  data_offset이 가리키는 바이트 = 원본 샘플, 조각 활성화 순서(free 쓰기 → moof 패치), 73만 + 41만 샘플에서 JS 힙 증가 < 30 MB, 쓰기 실패,
  ffprobe(패킷 수·재생 구간 = `buildMp4` 파일), `mehd`·`-sseof`, `ffmpeg -c copy -f mp4` 재머싱 경고 없음, **비정상 종료 안전성**: 쓰기 기록을
  재생해 조각 moof 안·trun 중간·mdat 중간·활성화 직전·조각 사이·마지막 바이트 직전에서 멈춘 파일과 완료 파일을 mdat 안·조각 사이에서 자른
  파일 모두 그 앞의 완전한 조각을 전부 디코딩하는지 ffprobe로 확인합니다.
- 세션(`video-recorder.test.js`): MP4/MOV/fMP4는 녹화 시작 때 결과 파일만 만들고(OPFS 청크 저장소 없음) 녹화 중 바로 기록, fMP4는 녹화 중
  조각 기록, `outputSinkFactory`를 시작 때 실제 포맷·MIME으로 요청(fmp4 → `.mp4`, `video/mp4`), AVI는 기존 중지 시 머싱, 녹화 중 쓰기 실패 →
  `onError(VIDEO_WRITE_FAILED)`·`stop()` 거부·실패 파일 삭제, `adjustTimestamp` = 메모리 경로 보정, fMP4 일시정지 연속성.

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
- 팝업 레이아웃 테스트: `npm run test:popup`. 실제 Chrome에서 popup.html을 열어 모든 모드·상태(완료 메시지, 시:분:초 표시, 녹화 중·일시정지 포함)에서
  콘텐츠 높이가 Chrome 팝업 최대 높이(600px) 이내라 스크롤이 생기지 않는지, 선택 상자 텍스트가 잘리지 않는지 검사합니다. 녹화 중·일시정지 상태는
  SW에서 `STATE_CHANGED`를 보내 실제 `updateUI` 경로로 만들고, 일시정지/재개 버튼 배치, 일시정지 중 시간 고정, 재개 후 이어짐을 확인합니다.
  영상(왼쪽)/오디오(오른쪽) 두 열 배치, 모드별 비활성 규칙, ⚙ 버튼(설정 페이지 열림), 헤더 정렬(대기·녹화 중·일시정지·파일 생성 중 모두
  상태와 ⚙의 세로 중심 차 ≤ 2px, ⚙ = 상태 줄 높이의 정사각형·위쪽 오프셋 없음, ⚙ 오른쪽 끝 = 콘텐츠 오른쪽 끝 ±2px), 팝업에 저장 위치 줄·문구가
  없음(기본·폴더 설정, 대기·녹화 중·일시정지), 녹화 시작 시 폴더 권한 확인(granted / 요청 / 거부 → 다운로드 안내 / 핸들 없음), 설정 페이지(폴더 선택은
  헤드리스에서 창을 띄울 수 없어 `showDirectoryPicker`를 OPFS 하위 폴더를 돌려주는 스텁으로 대체, 쓰기 불가 폴더 거부, 권한 다시 요청, 되돌리기)도
  검사하고 `e2e/output/popup-<모드>.png`(대기), `popup-<모드>-RECORDING.png`(녹화 중), `settings-page.png` 스크린샷을 남깁니다.
  컨테이너에 한글 폰트가 없으면 글자가 네모로 그려지고 높이도 실제와 달라지므로 `FONTCONFIG_FILE`로 한글 폰트(예: Noto Sans KR)를 포함한
  fontconfig 설정을 지정해 실행하는 것을 권장합니다.
- 시나리오: 오디오만(mp3/wav), 영상+오디오(mp4/mov/avi/fmp4), 분리 저장(mp4+mp3, avi+wav), 녹화 중 탭 크기 변경, 1080p 60초 장시간 녹화,
  fMP4(`video-fmp4`, `folder-split-fmp4-wav`, `pause-fmp4`: 파일은 `.mp4`로 검증. ftyp iso5 → moov → moof/mdat 구조, mfhd 순번, 활성화 안 된
  조각 없음, 트랙별 tfdt 연속(일시정지 앞뒤 포함), 조각 길이·키프레임으로 시작하는 비율, 조각 샘플 수 = ffprobe 패킷 수를 moof 헤더만 읽어 검사),
  비정상 종료(`crash-fmp4`, `--only`로만: fMP4 폴더 녹화 20초 뒤 Chrome 브라우저 프로세스를 SIGKILL하고 프로필 `Default/File System` 아래 가장 큰
  최근 파일을 ffprobe로 확인 - 결과는 [fMP4](#fmp4-조각-mp4) 참고),
  일시정지/재개(`pause-mp4`: 팝업 버튼으로 8초 녹화 → 4초 일시정지 → 4초 녹화. 일시정지 중 상태 "일시정지"·시간 고정·SW 세션 상태 PAUSED,
  파일 길이 ≈ 12초, 재개 지점 프레임 간격 < 300 ms, 영상에서 뺀 구간 ≈ SW가 기록한 일시정지 시간),
  폴더 직접 저장(`folder-split-mp4-wav`, 또는 `--saveToFolder`로 모든 시나리오: offscreen 페이지에서 `save-location.js`로 OPFS 루트 핸들을
  저장 폴더로 등록한 뒤 녹화. `storage.sync` 미러 = folder·팝업에 저장 위치 미표시, DOWNLOAD_FILE·`chrome.downloads` 호출 0회, `RECORDING_COMPLETE.savedTo = 'folder'`, OPFS 루트에 두 파일 존재와
  크기 일치, 중지 → 완료 시간 보고, 파일은 내보내 ffprobe로 검증).
  모든 시나리오에서 중지 클릭부터 "다시 녹화 가능"(팝업 "대기 중"·녹화 버튼 활성, SW `storage.session` IDLE, 폴더 저장이면 OPFS 임시 데이터 삭제)까지를
  50 ms 간격으로 감시해 `stopToReadyMs`로 보고합니다. `--recordAgain[=초]`(기본 10초)를 주면 폴더 저장 시나리오에서 첫 녹화 직후 같은 브라우저에서
  offscreen 문서를 새로 불러와(실제 확장은 완료 후 Offscreen을 닫고 다음 시작 때 새로 만듦) 두 번째 녹화를 실제로 하고, 그 중지 시간과 파일까지 검증합니다.
  `--verify=light`(장시간용)는 전체 디코딩 대신 패킷 수, 마지막 20초 디코딩, 파일 중간(기본: 길이의 절반, `--decodeAt=초`) 20초 디코딩을 검사합니다.
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
- 디스크 스트리밍 저장소 도입 후에는 청크 보관과 중지 시 Blob 복사가 사라져, 녹화 길이에 비례해 늘어나는 메모리 항목은 샘플 메타데이터
  (`SampleIndex`, 3시간 약 20 MB)뿐입니다. 중지 단계의 머싱 계획·쓰기도 녹화 길이와 무관한 고정 버퍼만 씁니다("중지 단계 메모리").

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

- 긴 녹화는 결과 파일만큼의 디스크 여유 공간이 필요합니다(1080p 약 1.6 GB/시간). 폴더 저장의 MP4·MOV·fMP4는 영상 데이터를 폴더에만 쓰고
  (Chrome이 닫을 때까지 같은 폴더의 `.crswap`에 기록), 프로필(OPFS)에는 오디오 파일의 예비본만 둡니다. 다운로드 저장은 OPFS에 결과 파일을 만든 뒤
  다운로드 폴더로 복사하므로 프로필 디스크에 결과 파일만큼, AVI는 청크 저장소 + 결과 파일만큼 필요합니다.
- MP4·MOV·fMP4 영상은 녹화 중 저장 위치에 바로 쓰므로, 녹화 도중 쓰기가 실패하면(권한 회수, 드라이브 분리, 디스크 부족) 그 영상은 다른 곳에 다시
  만들 수 없습니다. 이때 녹화를 멈추고 알리며(오디오 파일은 예비본으로 저장), 실패는 8 MB 쓰기 버퍼(MP4·MOV, 720p 기준 약 30초) 또는 조각(fMP4, 약 2초)
  주기 안에 드러납니다.
- 비정상 종료 복구는 fMP4 + 폴더 저장에서만 사용자가 직접 할 수 있습니다(`.crswap` → `.mp4`). MP4·MOV의 스왑 파일에는 색인(moov)이 없어 재생되지
  않고, 다운로드 저장의 부분 파일은 브라우저 프로필 안(OPFS)에 있어 확장이 꺼내 주지 않습니다(E2E `crash-fmp4`에서 OPFS 스왑 파일도 마지막 조각까지
  디코딩되는 것을 확인했지만 복구 기능은 없음). 향후 선택지: 전용 Worker에서 OPFS `createSyncAccessHandle()`로 스왑 파일 없이 제자리에 쓰고,
  다음 실행 때 남은 조각 파일을 찾아 저장해 주는 복구 기능.
- fMP4는 대부분의 플레이어(Chrome, VLC, mpv, ffmpeg 계열)가 재생하지만 일부 오래된 플레이어·편집 프로그램은 조각 MP4를 지원하지 않을 수 있습니다
  (QuickTime·Windows 기본 앱은 미검증). 그럴 때는 `ffmpeg -i in.mp4 -c copy out.mp4`로 일반 MP4로 바꿀 수 있습니다(재인코딩 없음, 테스트에서 경고 없이 성공).
- 저장 폴더 권한은 Chrome 정책에 따라 회수될 수 있습니다(브라우저 재시작, 확장 탭을 모두 닫음). 계속 허용을 고르지 않았다면 녹화 시작 때
  다시 물으며, 권한을 얻지 못한 녹화는 다운로드 폴더에 저장됩니다.
- 헤드리스 E2E의 장시간 녹화에서 오디오가 영상보다 짧게 기록됩니다(2026-10-18: 10분 2.9~4.0초, 60분 18.6~24.1초. 이전 3시간 실행 8.1초,
  그보다 전에는 70초). WAV와 영상 속 MP3가 같은 만큼 짧아 인코더·머서 앞, 즉 테스트용 가짜 소스(오실레이터 AudioContext → MediaStream →
  녹음 AudioContext)에서 렌더 구간이 빠진 것입니다(워크릿은 받은 PCM을 버리지 않고, 입력 채널이 0개인 렌더 퀀텀만 건너뜀). fMP4 60분 WAV의
  시험 신호 위상 불연속은 약 620곳으로 1시간에 고르게 흩어져 있고 조각 쓰기(2초) 주기와 맞지 않았으며, 작은 쓰기를 자주 하는 fMP4가 8 MB씩
  쓰는 MP4보다 덜 빠지지도 않았습니다. 같은 조건(evictd 1개, 2026-10-19)에서 변경 전/후 확장으로 5분씩 녹화한 비교는 변경 전 1.17초 / 변경 후
  1.92초였는데, 같은 변경 전 코드가 2026-10-16에는 10분에 0.21초만 잃었으므로 환경 부하의 영향이 지배적입니다(한 번씩의 비교라 직접 기록 경로의
  작은 기여는 배제하지 못함). 10-18 장시간 실행에는 이전 세션의 캐시 해제 데몬(evictd-v2)이 계속 돌고 있었습니다. 실제 탭 캡처·오디오 장치가
  있는 PC에서 확인이 필요합니다.
- WAV 파일은 RIFF 한계로 4 GB(48 kHz 스테레오 약 6시간)를 넘을 수 없으며, 2 GB를 넘으면 일부 플레이어가 열지 못합니다.
- AVI는 RIFF 32비트 한계 때문에 2GB를 넘을 수 없습니다. 초과가 예상되면 자동으로 MP4로 저장하고 안내합니다.
- 영상 파일의 오디오는 항상 MP3입니다(AAC 미지원). 오디오 포맷 선택은 별도 저장되는 오디오 파일에만 적용됩니다.
- Chrome `<video>`는 AVI를 재생하지 않습니다(VLC, mpv, Windows 미디어 플레이어 등에서 재생).
- 화면 변화가 없는 탭은 프레임이 거의 생성되지 않으며, 이 경우 마지막 프레임이 오디오 끝까지 유지됩니다.
