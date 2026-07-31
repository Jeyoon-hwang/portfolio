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

  function notify(videoId, text) {
    try {
      document.dispatchEvent(new CustomEvent('sfc-caption-captured', { detail: { videoId, text } }));
    } catch {
      // document가 아직 없는 극초기 타이밍이면 조용히 무시 (이 시점엔 캡션 요청도 있을 수 없다)
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    if (url && url.indexOf('/api/timedtext') !== -1) {
      const videoId = extractVideoId(url);
      return originalFetch.call(this, input, init).then((res) => {
        res
          .clone()
          .text()
          .then((text) => notify(videoId, text))
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
      this.addEventListener('load', () => notify(videoId, this.responseText));
    }
    return originalSend.apply(this, args);
  };
})();
