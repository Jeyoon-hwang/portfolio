// document_start 시점(유튜브 자신의 스크립트가 실행되기도 전)에 window.fetch와
// XMLHttpRequest를 영구적으로 후킹해둔다.
//
// 이전엔 chrome.scripting.executeScript로 캡션을 요청하려는 "그 순간에" 후킹을 걸었는데,
// 실측 결과 player.loadModule('captions')/setOption(...)은 에러 없이 성공하는데도 후킹엔
// 아무 요청도 안 잡혔다 — 유튜브 자신의 코드가 그 시점 이전에 이미 원본 fetch/XHR 참조를
// 어딘가에 캐싱해뒀다면, 나중에 우리가 window.fetch를 바꿔치기해도 그 캐싱된 참조에는 전혀
// 보이지 않는다. document_start에 심어두면 유튜브 자신의 스크립트가 원본 참조를 캐싱하기도
// 전에 우리 패치가 먼저 자리를 잡으므로 이 문제를 원천적으로 피할 수 있다.
//
// 이 후킹은 두 가지를 수집한다:
//   1. 캡션(timedtext) 응답 본문 — 유튜브 자신이 쏜 진짜 요청을 가로채는 최후 수단용
//   2. pot(Proof of Origin Token) — 아래 참고. 자막을 "정공법으로" 받아오는 핵심 재료다.
//
// 이 파일은 MAIN 월드에서 실행되므로 content.js(격리된 세계)와 변수를 공유할 수 없다.
// 대신 수집할 때마다 document에 커스텀 이벤트를 던지고, content.js가 그걸 듣는다.
(function () {
  'use strict';

  function extractVideoId(url) {
    try {
      return new URL(url, location.href).searchParams.get('v');
    } catch {
      return null;
    }
  }

  // content.js가 캡션 캡처 이벤트를 듣기 시작하는 시점은 우리가 요청을 실제로 가로챈 시점보다
  // 한참 늦을 수 있다(1~3단계 URL 기반 시도가 먼저 몇 초 걸린 뒤에야 리스너를 붙인다). 유튜브가
  // 이 영상의 캡션을 그 전에(예: 재생 시작과 동시에 자체적으로) 이미 요청해버렸다면, dispatchEvent는
  // 그 순간 듣는 사람이 없어 그대로 유실되고 다시 재현할 방법이 없다 — 실측에서 매번
  // "no event captured within timeout"으로 실패한 게 바로 이 레이스로 보인다. 그래서 videoId별로
  // 최근 캡처본을 잠깐 버퍼링해두고, 늦게 붙는 리스너가 "혹시 이미 잡아둔 거 있어?"라고 물어보면
  // (sfc-caption-query) 즉시 재통지한다.
  const MAX_BUFFERED = 20;
  const captured = new Map();

  // ---------- pot(Proof of Origin Token) 수집 ----------
  //
  // 자막 baseUrl에 `exp=xpe`(또는 xpv)가 붙어 있으면 유튜브는 `pot` 없이 온 요청에
  // 200 OK + 0바이트 본문을 돌려준다. pot은 BotGuard가 런타임에 만들어내는 값이라
  // 페이지 정적 데이터(ytInitialPlayerResponse 등)에는 없지만, **페이지 자신이 보내는
  // 요청에는 들어있다.** 두 군데서 확보한다:
  //
  //   1. Innertube(`/youtubei/...`) 요청 본문에 실려 나가는 poToken — videoId에 바인딩된
  //      값이고, 자막(subs)용 pot도 player와 동일한 바인딩을 쓴다.
  //        (yt-dlp가 자막 지원을 넣을 때 SUBS를 PLAYER와 같은 VIDEO_ID 바인딩으로 처리했다)
  //   2. 이미 pot이 박혀 나가는 URL(page가 쏜 timedtext 등)에서 그대로 뽑기
  //
  // 이 토큰을 자막 baseUrl에 `pot`, `potc=1`, `c=WEB`으로 덧붙이면 실제 브라우저가 보내는
  // 요청과 같아져 정상 본문을 받는다. baseUrl의 서명(signature)은 `sparams`에 나열된
  // 파라미터에만 걸려 있어서, 목록에 없는 pot/potc/c를 "추가"하는 건 서명을 깨지 않는다
  // (기존 파라미터를 지우거나 바꾸면 깨진다 — 그건 여전히 금지).
  const potByVideoId = new Map();
  let latestPot = null;

  function remember(map, key, value) {
    if (!key) return;
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_BUFFERED) map.delete(map.keys().next().value);
  }

  function notify(videoId, text) {
    try {
      document.dispatchEvent(new CustomEvent('sfc-caption-captured', { detail: { videoId, text } }));
    } catch {
      // document가 아직 없는 극초기 타이밍이면 조용히 무시 (이 시점엔 캡션 요청도 있을 수 없다)
    }
  }

  function onCaptured(videoId, text) {
    remember(captured, videoId, text);
    notify(videoId, text);
  }

  // 지금 주소창에 떠 있는 영상. pot이 어느 영상 것인지 요청 자체에 안 적혀 있을 때
  // (아래 harvestPotFromUrl 참고) 이걸로 대신 짚는다.
  function currentPageVideoId() {
    try {
      const shorts = /^\/shorts\/([\w-]{6,})/.exec(location.pathname);
      if (shorts) return shorts[1];
      return new URL(location.href).searchParams.get('v');
    } catch {
      return null;
    }
  }

  function rememberPot(videoId, pot) {
    if (!pot) return;
    latestPot = pot;
    if (videoId) {
      const isNew = potByVideoId.get(videoId) !== pot;
      remember(potByVideoId, videoId, pot);
      if (isNew) console.info('[SFC transcript][pot] collected pot for', videoId);
    }
    try {
      document.dispatchEvent(new CustomEvent('sfc-pot-captured', { detail: { videoId: videoId || null, pot } }));
    } catch {
      // 무시 (극초기 타이밍)
    }
  }

  // 나가는 URL에 pot이 이미 박혀 있으면 그대로 주워둔다.
  //
  // 이게 특히 중요한 이유: **콜드 페이지 로드에서는 Innertube player 요청 자체가 없다.**
  // 유튜브가 첫 영상의 player 응답을 HTML(ytInitialPlayerResponse)에 박아서 내려주기 때문에
  // 가로챌 요청이 아예 안 생긴다. 그래서 첫 영상은 재생이 시작되며 나가는 `videoplayback`
  // (GVS) 요청에 실린 pot이 사실상 유일한 확보 경로다.
  //
  // 그런데 videoplayback URL은 영상 식별자를 `v`가 아니라 `id`(내부 docid)로 달고 나와서
  // videoId로 바로 매핑되지 않는다 — 예전엔 그래서 videoId 없이 저장돼 "이 영상 것"으로
  // 인정받지 못했다. 지금은 주소창의 videoId로 대신 짚는다. 쇼츠가 다음 영상을 미리 로드하는
  // 특성상 옆 영상 pot을 현재 영상 것으로 잘못 붙일 수 있지만, 틀린 pot이면 어차피 본문이
  // 비어서 돌아오고 다음 단계로 넘어갈 뿐이라 안 하는 것보단 낫다.
  function harvestPotFromUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const pot = parsed.searchParams.get('pot');
      if (pot) {
        potFromUrlCount++;
        rememberPot(parsed.searchParams.get('v') || currentPageVideoId(), pot);
      }
    } catch {
      // URL 파싱 실패는 무시
    }
  }

  // 중첩된 JSON 어디에 있든 해당 키의 문자열 값을 찾아낸다(깊이 제한으로 폭주 방지).
  function findStringValue(obj, key, depth) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    const direct = obj[key];
    if (typeof direct === 'string' && direct) return direct;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const found = findStringValue(v, key, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  // ---------- 진단용 ----------
  // 쇼츠에서 pot이 왜 안 잡히는지 추측만 반복하지 않으려고, 우리가 실제로 무엇을 봤는지 센다.
  // pot을 못 구했을 때 content.js가 이 값을 받아 콘솔에 찍는다.
  const seenInnertubePaths = new Map(); // path -> { total, withPot }
  let potFromUrlCount = 0;
  let potFromBodyCount = 0;
  let bodyUnreadableCount = 0;

  function notePath(url, hadPot) {
    try {
      const path = new URL(url, location.href).pathname;
      const entry = seenInnertubePaths.get(path) || { total: 0, withPot: 0 };
      entry.total++;
      if (hadPot) entry.withPot++;
      seenInnertubePaths.set(path, entry);
    } catch {
      // 무시
    }
  }

  // 요청 본문이 항상 문자열인 건 아니다(Blob/ArrayBuffer/URLSearchParams로 보내는 경우가 있다).
  // 예전엔 문자열이 아니면 그냥 건너뛰어서, 그런 방식으로 나간 Innertube 요청은 pot이 실려
  // 있어도 통째로 놓치고 있었다.
  function readBodyText(body) {
    try {
      if (typeof body === 'string') return Promise.resolve(body);
      if (typeof Blob !== 'undefined' && body instanceof Blob) return body.text().catch(() => null);
      if (body instanceof ArrayBuffer) return Promise.resolve(new TextDecoder().decode(body));
      if (ArrayBuffer.isView(body)) return Promise.resolve(new TextDecoder().decode(body));
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return Promise.resolve(body.toString());
      }
    } catch {
      // 아래에서 null 반환
    }
    return Promise.resolve(null);
  }

  // Innertube 요청 본문에서 poToken을 뽑는다.
  //
  // 처음엔 `/youtubei/v1/player` 본문의 `serviceIntegrityDimensions.poToken`만 고정 경로로
  // 읽었는데, 실측 결과 **쇼츠에서는 pot이 단 한 번도 안 잡혔다**(`pot token: NOT available`).
  // 쇼츠는 롱폼과 달리 `/youtubei/v1/player`가 아니라 `/youtubei/v1/reel/reel_item_watch`
  // 같은 다른 엔드포인트로 플레이어 데이터를 받아오기 때문이다. 그래서 경로를 `/youtubei/`
  // 전체로 넓히고, 본문 구조도 고정 경로 대신 재귀 탐색으로 바꿨다 — 엔드포인트마다 poToken과
  // videoId가 박히는 위치가 달라서다.
  function harvestPotFromBody(bodyText, url) {
    // 대부분의 Innertube 요청엔 poToken이 없다. JSON 파싱 전에 문자열로 먼저 걸러 비용을 아낀다.
    if (!bodyText || bodyText.indexOf('poToken') === -1) {
      notePath(url, false);
      return;
    }
    try {
      const body = JSON.parse(bodyText);
      const pot = findStringValue(body, 'poToken', 0);
      notePath(url, !!pot);
      if (pot) {
        potFromBodyCount++;
        rememberPot(findStringValue(body, 'videoId', 0) || currentPageVideoId(), pot);
      }
    } catch {
      notePath(url, false);
    }
  }

  function harvestPotFromRequestBody(body, url) {
    readBodyText(body).then((text) => {
      if (text === null) {
        bodyUnreadableCount++;
        notePath(url, false);
        return;
      }
      harvestPotFromBody(text, url);
    });
  }

  function isInnertubeRequest(url) {
    return typeof url === 'string' && url.indexOf('/youtubei/') !== -1;
  }

  document.addEventListener('sfc-caption-query', (e) => {
    const videoId = e.detail && e.detail.videoId;
    if (videoId && captured.has(videoId)) notify(videoId, captured.get(videoId));
  });

  // content.js가 "이 영상 pot 있어?"라고 물으면 답한다. videoId에 딱 맞는 게 없으면
  // 최근에 본 pot이라도 준다 — 첫 로딩 영상처럼 player 요청을 우리가 못 본 경우가 있어서다.
  // 어차피 틀린 pot이면 본문이 비어서 돌아오니 시도해볼 가치는 있다.
  document.addEventListener('sfc-pot-query', (e) => {
    const videoId = e.detail && e.detail.videoId;
    const exact = videoId ? potByVideoId.get(videoId) || null : null;
    try {
      document.dispatchEvent(
        new CustomEvent('sfc-pot-result', {
          detail: {
            videoId: videoId || null,
            pot: exact || latestPot || null,
            exact: !!exact,
            // BotGuard가 이 세션에서 pot을 단 하나라도 만들어낸 적이 있는지. 아직 하나도
            // 없다면 챌린지가 진행 중이라는 뜻이라, 기다리면 생길 가능성이 높다.
            everSeenPot: latestPot !== null,
          },
        }),
      );
    } catch {
      // 무시
    }
  });

  // pot을 못 구했을 때 content.js가 "뭘 봤는지" 물어본다. 실측으로 확인된 유일한 실패 케이스는
  // 콜드 로드 첫 영상인데(그땐 Innertube player 요청 자체가 없다), 나중에 다른 원인이 생기면
  // 이 값으로 바로 구분할 수 있다.
  document.addEventListener('sfc-pot-debug-query', () => {
    const paths = [];
    for (const [path, entry] of seenInnertubePaths) {
      paths.push(`${path} x${entry.total}${entry.withPot ? ` (pot ${entry.withPot})` : ''}`);
    }
    try {
      document.dispatchEvent(
        new CustomEvent('sfc-pot-debug-result', {
          detail: {
            innertubePaths: paths,
            potFromUrlCount,
            potFromBodyCount,
            bodyUnreadableCount,
            videoIdsWithPot: Array.from(potByVideoId.keys()),
          },
        }),
      );
    } catch {
      // 무시
    }
  });

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;

    if (url) {
      harvestPotFromUrl(url);
      if (isInnertubeRequest(url)) {
        // 본문은 init.body(문자열/Blob/ArrayBuffer 등)이거나 Request 객체 안에 있다.
        // 어느 쪽이든 원본 요청을 건드리지 않도록 복제해서 비동기로 읽는다 — 실패해도
        // 요청 자체엔 영향이 없다.
        try {
          if (init && init.body != null) {
            harvestPotFromRequestBody(init.body, url);
          } else if (input && typeof input !== 'string' && typeof input.clone === 'function') {
            input
              .clone()
              .text()
              .then((text) => harvestPotFromBody(text, url))
              .catch(() => {
                bodyUnreadableCount++;
                notePath(url, false);
              });
          } else {
            notePath(url, false);
          }
        } catch {
          bodyUnreadableCount++;
          notePath(url, false);
        }
      }
    }

    if (url && url.indexOf('/api/timedtext') !== -1) {
      const videoId = extractVideoId(url);
      return originalFetch.call(this, input, init).then((res) => {
        res
          .clone()
          .text()
          .then((text) => onCaptured(videoId, text))
          .catch(() => {});
        return res;
      });
    }
    return originalFetch.apply(this, arguments);
  };

  const OriginalXHR = window.XMLHttpRequest;
  const originalOpen = OriginalXHR.prototype.open;
  const originalSend = OriginalXHR.prototype.send;

  OriginalXHR.prototype.open = function (method, url, ...rest) {
    this.__sfcTimedtextUrl = typeof url === 'string' && url.indexOf('/api/timedtext') !== -1 ? url : null;
    this.__sfcIsInnertube = isInnertubeRequest(url);
    this.__sfcInnertubeUrl = this.__sfcIsInnertube ? url : null;
    if (typeof url === 'string') harvestPotFromUrl(url);
    return originalOpen.call(this, method, url, ...rest);
  };

  OriginalXHR.prototype.send = function (...args) {
    if (this.__sfcIsInnertube) {
      if (args[0] != null) harvestPotFromRequestBody(args[0], this.__sfcInnertubeUrl);
      else notePath(this.__sfcInnertubeUrl, false);
    }
    if (this.__sfcTimedtextUrl) {
      const videoId = extractVideoId(this.__sfcTimedtextUrl);
      this.addEventListener('load', () => onCaptured(videoId, this.responseText));
    }
    return originalSend.apply(this, args);
  };
})();
