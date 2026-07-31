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
// 이 파일은 MAIN 월드에서 실행되므로 content.js(격리된 세계)와 변수를 공유할 수 없다.
// 대신 캡션 응답을 잡을 때마다 document에 커스텀 이벤트를 던지고, content.js가 그걸 듣는다.
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

  function remember(videoId, text) {
    if (!videoId) return;
    captured.delete(videoId);
    captured.set(videoId, text);
    if (captured.size > MAX_BUFFERED) {
      captured.delete(captured.keys().next().value);
    }
  }

  function notify(videoId, text) {
    try {
      document.dispatchEvent(new CustomEvent('sfc-caption-captured', { detail: { videoId, text } }));
    } catch {
      // document가 아직 없는 극초기 타이밍이면 조용히 무시 (이 시점엔 캡션 요청도 있을 수 없다)
    }
  }

  function onCaptured(videoId, text) {
    remember(videoId, text);
    notify(videoId, text);
  }

  document.addEventListener('sfc-caption-query', (e) => {
    const videoId = e.detail && e.detail.videoId;
    if (videoId && captured.has(videoId)) notify(videoId, captured.get(videoId));
  });

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
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
    return originalOpen.call(this, method, url, ...rest);
  };

  OriginalXHR.prototype.send = function (...args) {
    if (this.__sfcTimedtextUrl) {
      const videoId = extractVideoId(this.__sfcTimedtextUrl);
      this.addEventListener('load', () => onCaptured(videoId, this.responseText));
    }
    return originalSend.apply(this, args);
  };
})();
