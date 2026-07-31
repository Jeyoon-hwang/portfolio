# 유튜브 쇼츠 팩트체크 확장 프로그램

유튜브 쇼츠와 일반(롱폼) 영상을 볼 때 영상 옆에 패널을 띄워서 세 가지를 알려주는 크롬 확장 프로그램입니다.

1. **댓글 여론 분포** — 댓글이 반박 중심인지 동조 중심인지 도넛 차트 + 카테고리별 대표 댓글(좋아요 최다순 1개)로 표시. 대댓글(답글)도 최대 5개/스레드까지 함께 수집해 분류합니다 — 논쟁은 답글에서 벌어지는 경우가 많기 때문입니다.
2. **반박 댓글 팩트체크** — 영상 자막이 있으면 영상의 핵심 주장을 뽑아 보여주고, 좋아요 상위 반박 댓글의 주장을 그 맥락(영상 주장 + 답글이면 원댓글)과 함께 웹서치로 검증
3. **원본 영상 찾기** — 영상 전체에 고르게 펼친 프레임 최대 5장을 캡처해 역방향 이미지 검색으로 원본 출처 추정 (버튼 클릭 시에만 동작). 여러 프레임에서 공통으로 검색되는 후보일수록 우선순위를 높여(투표수 표시) 우연히 매칭된 무관한 결과를 걸러냅니다.

백엔드 서버 없이 확장 프로그램만으로 동작하며, 외부 API를 직접 호출합니다.

## 설치 방법

1. `chrome://extensions` 접속 → 우측 상단 "개발자 모드" 켜기
2. "압축해제된 확장 프로그램을 로드합니다" → 이 폴더(`shorts-factcheck/`) 선택
3. 확장 프로그램 아이콘 클릭(또는 확장 프로그램 관리 페이지에서 "세부정보 → 확장 프로그램 옵션") → API 키 3종 입력
4. 유튜브 쇼츠(`https://www.youtube.com/shorts/...`) 또는 일반 영상(`https://www.youtube.com/watch?v=...`) 페이지로 이동

## 필요한 API 키

| 키 | 용도 | 발급처 |
|---|---|---|
| YouTube Data API v3 | 댓글 수집 | Google Cloud Console |
| Gemini (Google AI) | 댓글 분류·주장 추출(Flash-Lite) + Google 검색 그라운딩 기반 팩트체크 판정(Pro) | aistudio.google.com |
| Google Cloud Vision | 원본 영상 역방향 이미지 검색 | Google Cloud Console (Vision API 활성화) |

키는 옵션 페이지에서 입력하면 `chrome.storage.local`에만 저장됩니다.

## 아키텍처

```
main-world-hook.js (document_start, MAIN 월드 — fetch/XHR 영구 후킹, 커스텀 이벤트로 통지)
    │  document.dispatchEvent('sfc-caption-captured')
    ▼
content.js (패널 주입, videoId 감지, 프레임 캡처, 자막(timedtext) 직접 fetch)
    │  chrome.runtime.sendMessage
    ▼
background.js (service worker, API 키가 필요한 모든 외부 호출)
    ├─ YouTube Data API v3           (댓글 수집)
    ├─ Gemini API (Flash-Lite)       (댓글 분류, 댓글/영상 주장 추출)
    ├─ Gemini API (Pro) + 검색 그라운딩 (팩트체크 판정: 영상 주장 vs 반박 댓글)
    └─ Google Cloud Vision           (원본 영상 역검색)
    ▼
chrome.storage.local (API 키 + videoId별 결과 캐싱, TTL 7일)
```

API 키가 든 요청은 격리된 컨텍스트인 service worker(background.js)에서만 보낸다. 예외로 자막(timedtext) 관련
작업은 API 키가 필요 없는데도 content.js/background.js 양쪽에 걸쳐 있고, 자막 트랙(baseUrl)을 얻는
방법은 3단계 폴백 체인으로 되어 있다 (실측 결과 하나로는 부족했다):

1. `chrome.scripting.executeScript(..., world: 'MAIN')`으로 유튜브 페이지의 메인 JS 월드에 접근해
   `window.ytInitialPlayerResponse`(또는 `#movie_player`/쇼츠 플레이어 컨테이너의 `getPlayerResponse()`)를
   그대로 읽는다. content script(격리된 세계)는 페이지의 전역 변수에 직접 접근할 수 없어 background.js가
   대신 페이지 메인 월드에 스크립트를 주입한다. `"scripting"` 권한이 이래서 필요하다. — 다만 실측 결과
   쇼츠에서는 이 전역/플레이어 컨테이너 자체를 못 찾는 경우가 있었다(세로 피드 SPA 전환 특성으로 추정).
2. (1)이 실패하면 watch 페이지를 다시 fetch해 정적 HTML에 박힌 `ytInitialPlayerResponse`를 파싱한다.
3. 그래도 실패하거나, 트랙은 찾았는데 실제 다운로드가 빈 응답으로 오면(서명이 이미 만료됐을 가능성),
   유튜브 웹플레이어 자신이 내부적으로 쓰는 Innertube `/youtubei/v1/player` 엔드포인트를 직접 호출해
   "요청 시점 기준으로" 새로 서명된 baseUrl을 받는다. content script가 youtube.com origin에서
   실행되므로 same-origin이라 CORS에 걸리지 않는다. 여기 박힌 WEB 클라이언트 API 키는 yt-dlp 등에서도
   써온 공개된 값이라 언젠가 유튜브가 로테이션/차단하면 이 함수만 갱신하면 된다.

baseUrl로 실제 자막 텍스트를 받는 fetch 자체는 content.js에서 한다 — service worker는
`chrome-extension://`라는 별도 출처라 쿠키/세션이 안 실리는 반면, content script는 유튜브 페이지
자체(same-origin)에서 실행되므로 실제 브라우저 세션이 자연스럽게 실린다. baseUrl의 쿼리 파라미터는
절대 건드리지 않는다 — 서명이 파라미터 전체에 걸려 계산되므로, `fmt` 하나만 지워도 서명 검증에 걸려
200 OK + 빈 본문으로 돌아온다.

### 자동생성(ASR) 자막이 자주 빈 본문으로 오는 이유 — 확정된 근본 원인

실측(콘솔 로그)으로 확인된 근본 원인: **200 OK, 서명 검증은 통과, 그런데 본문이 0바이트.** 이건 서명이
틀려서 거부된 게(403) 아니라, 구글의 봇 방지 챌린지(BotGuard)가 만들어내는 `pot`(Proof of Origin
Token) 파라미터가 요청에 없어서다. `pot`은 정적 데이터가 아니다 — `ytInitialPlayerResponse`에도,
페이지가 이미 로드한 라이브 player 객체에도 미리 박혀있지 않고, 유튜브 자신의 스크립트가 캡션을
"실제로 요청하는 그 순간" BotGuard 챌린지를 풀어서 즉석으로 붙이는 값이다. 그래서 baseUrl을 위 3단계
중 어느 방법으로 아무리 신선하게 다시 받아도 이 값 자체가 애초에 안 들어있다.

**4번째(최후) 수단으로 캡처 방식을 추가했다.** 유튜브 자신의 코드가 캡션을 요청하게 유도한 뒤(플레이어
API `loadModule('captions')`/`setOption('captions', 'track', ...)` 우선 시도, 안 먹히면 CC 버튼 클릭
폴백) 그 실제 네트워크 요청을 가로챈다 — 이건 유튜브 자신의 코드가 만든 요청이라 pot이 정상적으로
실려있을 것이라는 전제다.

처음엔 이 후킹을 `chrome.scripting.executeScript`로 캡션을 요청하려는 "그 순간에" 걸었는데, 실측
결과 `loadModule`/`setOption` 호출은 에러 없이 성공하는데도 `window.fetch`·`XMLHttpRequest` 후킹
둘 다 아무 요청도 못 잡았다. 유튜브 자신의 코드가 그 시점 이전에 이미 원본 fetch/XHR 참조를 어딘가에
캐싱해뒀다면, 나중에 우리가 `window.fetch`를 바꿔치기해도 그 캐싱된 참조에는 전혀 보이지 않기
때문으로 보인다. 그래서 실제 후킹은 **`main-world-hook.js`로 분리해 `document_start` 시점(유튜브
자신의 스크립트가 실행되기도 전)에 영구적으로 걸어둔다** — `manifest.json`에 `world: "MAIN"`,
`run_at: "document_start"`로 별도 등록되어 있다. 잡힌 응답은 `document`에 커스텀 이벤트
(`sfc-caption-captured`)로 던져지고, content.js가 `document.addEventListener`로 직접 듣는다
(MAIN 월드와 격리된 세계는 변수를 공유 못 하므로 DOM 이벤트로만 통신 가능). `background.js`의
`mainWorldTriggerCaptionLoad()`는 순수하게 "캡션을 요청하도록 유도"만 담당하고, content.js
`fetchTranscript()`의 4단계가 이벤트를 기다린다. 콘솔에 `[SFC transcript][capture]` 태그로 각
단계를 찍는다.

**단, 이건 명백히 신뢰도가 낮은 실험적 경로임을 밝힌다:**
1. 쇼츠의 CC 버튼/플레이어 컨테이너 셀렉터를 실제 브라우저 없이 확신할 수 없다(롱폼의
   `.ytp-subtitles-button`과 달리 쇼츠는 UI 구조가 다르다) — 후보를 여러 개 시도하지만 다 틀릴 수 있다.
   실측으로 확인된 더 심각한 함정: 쇼츠는 부드러운 스크롤을 위해 다음/이전 영상을 DOM에 미리
   로드해두는데, 셀렉터가 "활성" 플레이어가 아니라 옆에 미리 로드된 다른 영상의 플레이어를 잡으면
   전혀 다른 영상의 캡션을 가져오게 된다(실제로 재현됨 — 요청 URL의 `v=`가 현재 보고 있는 영상과
   달랐다). 그래서 모든 후보에서 `playerResponse.videoDetails.videoId`(또는 가로챈 요청의 `v=`
   파라미터)가 기대한 videoId와 일치하는지 반드시 검증한 뒤에만 사용한다.
2. 타임아웃(4.5초)까지 기다렸다가 실패하면, 이 지연이 그대로 팩트체크 파이프라인의 임계 경로에
   더해진다 — "쇼츠 시청 시간의 절반 안에 끝내야 한다"는 속도 목표와 정면으로 부딪힌다. ASR 자막
   영상에서는 사실상 매번 이 최후 수단까지 가게 되므로, 실사용에서 체감 속도가 나빠지면 타임아웃을
   줄이거나 이 단계 자체를 끄는 것을 고려해야 한다.
3. BotGuard는 구글이 의도적으로 만든 안티스크래핑 장벽이라, `document_start` 후킹으로도 결국 안
   뚫릴 수 있다 — `loadModule`/`setOption` 호출 자체가 진짜 내부 재생 로직을 안 건드리고 있을
   가능성도 있다.

**실측 결과 리스너-타이밍 레이스도 확인돼 고쳤다.** 쇼츠 4개 연속 테스트에서 `loadModule`/`setOption`
호출은 매번 에러 없이 성공했는데도 `main-world-hook.js`가 진짜 요청을 단 한 번도 못 잡았다(`no event
captured within timeout`). 원인은 `notify()`가 캡션을 잡은 순간 그냥 커스텀 이벤트만 던지고 아무 데도
저장해두지 않았다는 것 — content.js는 1~3단계가 먼저 몇 초 걸린 뒤에야 리스너를 붙이는데, 유튜브가
재생 시작과 동시에 이 영상 캡션을 이미 자체적으로 요청해버렸다면 그 이벤트는 듣는 사람 없이 지나가
영원히 유실된다. 그래서 `main-world-hook.js`가 videoId별로 최근 캡처본을 최대 20개까지 버퍼링해두고,
content.js가 리스너를 붙이자마자 `sfc-caption-query` 이벤트로 "혹시 이미 잡아둔 거 있어?"라고 즉시
물어보도록 고쳤다 — 있으면 그 자리에서 바로 재통지된다. (이건 리스너 타이밍 문제만 고친 것이고, 위
1~3번 한계는 여전히 유효하다.)

**그래서 제목/설명 기반 추정(`claimSource: 'meta'`)은 캡처까지 실패했을 때의 "정식 처리 경로"로
유지된다.** 패널에 "(자막 접근 제한 — 제목/설명 기반 추정)" 배지를 명확히 달아 자막 기반 결과와
혼동되지 않게 했다 — 이건 버그가 아니라 정직하게 설계된 성능 저하(graceful degradation)다.

## 한계 (알고 사용할 것)

- **원본 영상 찾기는 "확정"이 아니라 "후보 제시"입니다.** 이미 수천 번 퍼진 밈 영상은 후보가 너무 많아 판별이 어렵고, 반대로 원본이 웹에 거의 노출되지 않은 마이너 영상은 검색 자체가 실패할 수 있습니다. UI에는 항상 "원본 추정"이라는 표현만 사용합니다.
- **팩트체크는 좋아요 상위 5개 반박 댓글까지만** 검증합니다 (비용/속도 문제).
- **답글은 스레드당 최대 5개(최신순)까지만** 수집됩니다. `commentThreads.list`가 무료로 함께 주는 만큼만 쓰기 때문 — 스레드마다 `comments.list`를 추가로 부르면 쿼터가 스레드 수만큼 늘어나 감당이 안 됩니다.
- **댓글은 최대 300개(3페이지)까지만** 수집합니다.
- **영상 핵심 주장은 자막을 우선 사용**하지만, 자동생성(ASR) 자막은 구글의 BotGuard `pot` 토큰 요구사항 때문에 다운로드가 안 되는 경우가 흔합니다(아래 "자동생성 자막이 자주 빈 본문으로 오는 이유" 참고). 이 경우 제목/설명으로 자동 대체 추정하며, 패널에 "(자막 접근 제한 — 제목/설명 기반 추정)"이라고 명시되어 자막 기반 결과와 혼동되지 않게 했습니다. 제목/설명조차 없거나 둘 다 실패하면 반박 댓글 주장만 독립적으로 검증합니다. 사람이 직접 입력한 수동 자막은 이 제약이 없어 상대적으로 안정적입니다.
- **일반(롱폼) 영상도 지원합니다** (`/watch?v=...`). 다만 "쇼츠 시청 시간의 절반 안에 끝내야 한다"는 속도 목표는 애초에 쇼츠(대개 1분 이내)를 염두에 두고 정한 기준이라 롱폼에는 그대로 적용하지 않았습니다 — 파이프라인 자체는 동일하게 병렬로 돌아가지만, 댓글이 훨씬 많거나 자막이 긴 영상은 그만큼 더 걸릴 수 있습니다.
- 반박 댓글이 많아 팩트체크 대기 시간이 길어지면, MV3 service worker의 유휴 종료 정책으로 인해 드물게 응답이 끊길 수 있습니다. 이 경우 패널을 새로고침(다른 영상으로 넘겼다가 돌아오기)하면 캐시가 없는 부분부터 재시도됩니다.
- **속도**: 댓글 분류 배치, 영상 자막 처리, 반박 댓글 5개의 추출·판정을 모두 병렬로 돌려서 전체 지연을 "가장 느린 호출 1개" 수준으로 줄였습니다. 다만 웹서치가 붙는 판정 호출 자체의 응답 시간(네트워크 + LLM 생성 + 검색)에는 하한선이 있어서, 매우 짧은(15초 이하) 쇼츠에서는 시청 시간의 절반 안에 못 끝날 수도 있습니다.

## 보안 주의사항

- API 키는 소스코드에 하드코딩되어 있지 않습니다. 반드시 옵션 페이지에서 입력하세요.
- 확장 프로그램 특성상 키는 이 브라우저에 로컬 평문으로 저장됩니다. **개인 사용을 전제로 합니다.** 이 브라우저 프로필을 공유하거나, 이 저장소를 포크해 공개 배포하려면 키를 대신 보관·중계하는 프록시 서버가 별도로 필요합니다.
- `manifest.json`의 `host_permissions`는 실제로 호출하는 3개 API 도메인으로만 한정되어 있습니다 (`<all_urls>` 미사용).
- 모든 외부 API 호출(키가 든 요청 포함)은 확장 프로그램의 격리된 컨텍스트인 service worker(background.js)에서만 보냅니다.

## 예상 비용

영상 1건 분석 기준 100원 미만 (댓글 분류·주장 추출: Gemini Flash-Lite 수 원 미만, 팩트체크 3~5건: Gemini Pro 수 원, 원본 검색: 이미지 3장 거의 0원). 정확한 단가는 Google AI 최신 요금표를 확인하세요.

## 참고: Gemini 모델 이름은 몇 달 단위로 깨질 수 있습니다

Gemini 모델은 세대교체가 빠릅니다. 실제로 개발 중 `gemini-2.5-pro`가 셧다운(2026-06-17)됐고, 그 후계 `gemini-3-pro-preview`조차 이미 또 셧다운(2026-03-09)된 걸 확인했습니다. 현재 `lib/gemini.js`는 `gemini-3.1-flash-lite`(GA)와 `gemini-3.1-pro-preview`(preview)를 쓰고 있는데, 이것도 언젠가 또 깨질 수 있습니다.

**증상**: 팩트체크가 `Gemini API error 404: ... is no longer available to new users` 같은 에러로 실패합니다.
**해결**: [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)에서 현재 사용 가능한 모델 ID를 확인해 `lib/gemini.js`의 `GEMINI_FLASH_LITE_MODEL`/`GEMINI_PRO_MODEL` 상수만 교체하면 됩니다. `googleSearch` 그라운딩 툴 키 이름도 API 버전에 따라 바뀔 수 있으니, 팩트체크 응답에 출처(`groundingMetadata`)가 계속 비어 있으면 이것도 의심하세요.
