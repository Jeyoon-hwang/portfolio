// service worker: 모든 외부 API 호출을 이 파일(과 lib/*)에서만 담당한다.
// content script는 격리된 세계이지만 페이지와 컨텍스트를 공유하므로 API 키를 여기서 다루지 않는다.
import { fetchComments, fetchUploadDate, fetchVideoSnippet } from './lib/youtube.js';
import { classifyComments } from './lib/classifier.js';
import { extractClaim, extractVideoClaim, extractVideoClaimFromMeta, verifyClaim } from './lib/factcheck.js';
import { reverseSearch, extractYoutubeVideoId, extractUrlsFromText } from './lib/reverse-search.js';
import { getCache, setCache } from './lib/cache.js';

const KEY_NAMES = ['youtubeApiKey', 'geminiApiKey', 'visionApiKey'];
const MAX_FACTCHECK_TARGETS = 5;

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: true, message: err?.message || String(err) }));
  return true; // 비동기 sendResponse를 위해 채널을 열어둔다
});

async function getKeys() {
  return chrome.storage.local.get(KEY_NAMES);
}

// content script(격리된 세계)가 아니라 유튜브 페이지 자신의 메인 월드에서 실행되어,
// 페이지의 player.js가 이미 계산해놓은 서명/토큰이 포함된 caption baseUrl을 그대로 읽어온다.
// 우리가 직접 fetch로 watch 페이지를 다시 받아서 파싱하면, 그 응답엔 브라우저가 실제로 실행한
// player.js가 나중에 채워 넣는 값(예: pot 토큰)이 빠져 있을 수 있다 — 서명 검증에 걸려
// 200 OK인데 본문이 빈 응답으로 오는 증상과 정확히 들어맞는다.
//
// 실측 결과 일반 /watch 페이지의 #movie_player + window.ytInitialPlayerResponse로는 쇼츠에서
// 트랙을 못 찾았다 — 쇼츠는 세로 피드로 영상이 넘어갈 때 SPA 전환이라 이 전역이 갱신되지 않고,
// 플레이어 컨테이너 자체도 다른 구조를 쓰는 것으로 보인다. 정확한 내부 구조를 실제 브라우저
// 없이는 확신할 수 없어, 알려진 후보를 여러 개 순서대로 시도한다.
function mainWorldGetCaptionTracks() {
  function tracksFrom(playerResponse) {
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(tracks) && tracks.length ? tracks : null;
  }

  try {
    let tracks = tracksFrom(window.ytInitialPlayerResponse);

    if (!tracks) {
      const moviePlayer = document.querySelector('#movie_player');
      if (moviePlayer && typeof moviePlayer.getPlayerResponse === 'function') {
        tracks = tracksFrom(moviePlayer.getPlayerResponse());
      }
    }

    if (!tracks) {
      // 쇼츠 전용 플레이어 컨테이너로 알려진/추정되는 후보들. 정확한 구조를 확신할 수 없어
      // 여러 셀렉터를 넓게 시도하고, getPlayerResponse를 제공하는 첫 번째 것을 쓴다.
      const candidates = document.querySelectorAll(
        '#shorts-player, ytd-reel-video-renderer[is-active] #player, ytd-reel-video-renderer #player, ytd-shorts [id*="player"]',
      );
      for (const el of candidates) {
        if (el && typeof el.getPlayerResponse === 'function') {
          tracks = tracksFrom(el.getPlayerResponse());
          if (tracks) break;
        }
      }
    }

    if (!tracks) {
      // 마지막 수단: 페이지 안의 모든 후보 엘리먼트 중 getPlayerResponse를 제공하는 것을 훑는다.
      const anyPlayerEl = Array.from(document.querySelectorAll('[id*="player"]')).find(
        (el) => typeof el.getPlayerResponse === 'function',
      );
      if (anyPlayerEl) tracks = tracksFrom(anyPlayerEl.getPlayerResponse());
    }

    if (!tracks) return [];
    return tracks
      .filter((t) => t && t.baseUrl)
      .map((t) => ({ langCode: t.languageCode, kind: t.kind || null, baseUrl: t.baseUrl }));
  } catch {
    return [];
  }
}

// 확정된 근본 원인(README 참고)은 BotGuard의 pot 토큰이 정적 스냅샷 어디에도 없고, 유튜브 자신의
// 스크립트가 캡션을 "실제로 요청하는 순간"에만 즉석으로 만들어진다는 것이다. 남은 방법은 우리가
// URL을 조립하지 않고, 유튜브 자신의 코드가 그 요청을 쏘도록 유도한 뒤 가로채는 것뿐이다.
// 신뢰도가 낮다는 걸 명확히 밝힌다 — 아래 셀렉터/플레이어 API 호출은 실제 브라우저 없이 검증할
// 방법이 없다. 안 되면 [SFC transcript][capture] 로그를 보고 다음 수를 정한다.
function mainWorldCaptureRealCaption() {
  return new Promise((resolve) => {
    const TIMEOUT_MS = 4500;
    let settled = false;
    const originalFetch = window.fetch;
    let timeoutId;

    function finish(result) {
      if (settled) return;
      settled = true;
      window.fetch = originalFetch;
      clearTimeout(timeoutId);
      console.log('[SFC transcript][capture] finished:', result.reason || (result.ok ? 'ok' : 'fail'));
      resolve(result);
    }

    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && url.indexOf('/api/timedtext') !== -1) {
        console.log('[SFC transcript][capture] intercepted timedtext fetch');
        return originalFetch.call(this, input, init).then((res) => {
          res
            .clone()
            .text()
            .then((text) => finish({ ok: !!text, text, reason: text ? 'ok' : 'empty' }))
            .catch(() => finish({ ok: false, reason: 'read_error' }));
          return res;
        });
      }
      return originalFetch.apply(this, arguments);
    };

    timeoutId = setTimeout(() => finish({ ok: false, reason: 'timeout' }), TIMEOUT_MS);

    function findPlayerEl() {
      return (
        document.querySelector('#movie_player') ||
        document.querySelector('#shorts-player') ||
        document.querySelector('ytd-reel-video-renderer[is-active] #player') ||
        document.querySelector('ytd-reel-video-renderer #player') ||
        Array.from(document.querySelectorAll('[id*="player"]')).find(
          (el) => typeof el.loadModule === 'function' || typeof el.setOption === 'function',
        ) ||
        null
      );
    }

    let triggered = false;
    try {
      const player = findPlayerEl();
      if (player && typeof player.loadModule === 'function') {
        player.loadModule('captions');
        triggered = true;
        console.log('[SFC transcript][capture] called loadModule(captions)');
      }
      if (player && typeof player.setOption === 'function') {
        let track = null;
        try {
          const tracklist = typeof player.getOption === 'function' ? player.getOption('captions', 'tracklist') : null;
          track = Array.isArray(tracklist) && tracklist.length ? tracklist[0] : null;
        } catch {
          // getOption 자체가 없거나 실패해도 무시하고 진행
        }
        player.setOption('captions', 'track', track || {});
        triggered = true;
        console.log('[SFC transcript][capture] called setOption(captions, track, ...)');
      }
    } catch (err) {
      console.log('[SFC transcript][capture] player API call failed:', err && err.message);
    }

    if (!triggered) {
      const btn =
        document.querySelector('.ytp-subtitles-button') ||
        document.querySelector('button[aria-label*="자막"]') ||
        document.querySelector('button[aria-label*="caption" i]') ||
        document.querySelector('button[aria-label*="subtitle" i]');
      if (btn) {
        console.log('[SFC transcript][capture] no player API worked, falling back to CC button click');
        btn.click();
      } else {
        console.log('[SFC transcript][capture] no trigger method available (no player API, no CC button found)');
      }
    }
  });
}

async function handle(message, sender) {
  switch (message.type) {
    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      return {};

    case 'GET_KEYS_STATUS': {
      const keys = await getKeys();
      return {
        youtube: !!keys.youtubeApiKey,
        gemini: !!keys.geminiApiKey,
        vision: !!keys.visionApiKey,
      };
    }

    case 'GET_CACHE':
      return await getCache(message.videoId);

    case 'SET_CACHE':
      return await setCache(message.videoId, message.data);

    case 'GET_COMMENTS': {
      const { youtubeApiKey } = await getKeys();
      if (!youtubeApiKey) return { error: 'missing_key' };
      return await fetchComments(message.videoId, youtubeApiKey);
    }

    case 'GET_CAPTION_TRACKS': {
      if (!sender?.tab?.id) {
        console.warn('[SFC transcript] GET_CAPTION_TRACKS: no sender.tab.id, cannot inject into MAIN world');
        return { tracks: [] };
      }
      if (!chrome.scripting) {
        console.error('[SFC transcript] chrome.scripting unavailable — "scripting" permission not granted yet? reload the extension in chrome://extensions.');
        return { tracks: [] };
      }
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: mainWorldGetCaptionTracks,
        });
        const tracks = Array.isArray(injection?.result) ? injection.result : [];
        console.info('[SFC transcript] MAIN-world extraction returned', tracks.length, 'tracks for tab', sender.tab.id);
        return { tracks };
      } catch (err) {
        console.error('[SFC transcript] chrome.scripting.executeScript failed:', err?.message || err);
        return { tracks: [] };
      }
    }

    // 마지막 폴백 — pot 토큰은 정적 데이터로 존재하지 않으므로, 유튜브 자신의 코드가 캡션을
    // 요청하도록 유도(player API 또는 CC 버튼 클릭)한 뒤 그 실제 네트워크 요청을 가로챈다.
    case 'CAPTURE_REAL_CAPTION': {
      if (!sender?.tab?.id) return { ok: false, reason: 'no_tab' };
      if (!chrome.scripting) return { ok: false, reason: 'no_scripting' };
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: mainWorldCaptureRealCaption,
        });
        return injection?.result || { ok: false, reason: 'no_result' };
      } catch (err) {
        console.error('[SFC transcript][capture] executeScript failed:', err?.message || err);
        return { ok: false, reason: 'error' };
      }
    }

    // 자막 자체는 content.js가 유튜브 페이지 컨텍스트(같은 origin, 실제 쿠키/세션)에서
    // 미리 가져와 message.transcript로 넘겨준다 — 여기(서비스 워커)는 별도 chrome-extension://
    // 출처라 그 fetch를 대신 해줄 수 없다. 그런데도 자막 다운로드는 여전히 실패하는 경우가
    // 많다 — 유튜브가 자동생성(ASR) 자막에 서명 검증을 걸어 signature까지 붙은 정상 URL도
    // 200 OK + 빈 본문으로 돌려주는 사례가 실측으로 확인됐다(쿠키/출처 문제가 아니라 서버
    // 쪽 봇 방지 조치로 보임). 이 경우 자막 없는 영상과 동일하게 취급하지 않고, 공식 API로
    // 안정적으로 얻을 수 있는 제목/설명으로 대체 추정한다 — 정확도는 낮아지지만 완전히
    // 비어 있는 것보다 낫다.
    case 'GET_VIDEO_CLAIM': {
      const { geminiApiKey, youtubeApiKey } = await getKeys();
      if (!geminiApiKey) return { error: 'missing_key' };

      const transcript = message.transcript || null;
      if (transcript) {
        const videoClaim = await extractVideoClaim(transcript, geminiApiKey).catch(() => null);
        return { videoClaim, transcriptReason: videoClaim ? 'ok' : 'no_claim', claimSource: videoClaim ? 'caption' : null };
      }

      if (youtubeApiKey) {
        const meta = await fetchVideoSnippet(message.videoId, youtubeApiKey).catch(() => null);
        if (meta) {
          const videoClaim = await extractVideoClaimFromMeta(meta.title, meta.description, geminiApiKey).catch(() => null);
          if (videoClaim) return { videoClaim, transcriptReason: 'ok', claimSource: 'meta' };
        }
      }

      return { videoClaim: null, transcriptReason: message.transcriptReason || 'no_tracks' };
    }

    case 'CLASSIFY_COMMENTS': {
      const { geminiApiKey } = await getKeys();
      if (!geminiApiKey) return { error: 'missing_key' };
      return await classifyComments(message.comments, geminiApiKey);
    }

    case 'FACTCHECK_COMMENTS': {
      const { geminiApiKey } = await getKeys();
      if (!geminiApiKey) return { error: 'missing_key' };
      return await factcheckComments(message.comments, geminiApiKey, message.videoClaim || null);
    }

    case 'FIND_ORIGINAL': {
      const { visionApiKey, youtubeApiKey } = await getKeys();
      const result = await findOriginal(
        message.frames,
        message.sourceComments,
        visionApiKey,
        youtubeApiKey,
      );
      await setCache(message.videoId, { originalSearch: result });
      return result;
    }

    default:
      throw new Error('Unknown message type: ' + message.type);
  }
}

// 좋아요 상위 5개 반박 댓글에서만 주장을 추출/검증한다 (비용 폭증 방지).
// 웹서치가 붙는 verifyClaim(Gemini Pro)이 제일 느린 호출이라, 5개를 순차로 돌리면
// 그 지연이 그대로 5배 쌓인다 — 병렬로 돌려서 "가장 느린 1개"의 시간만 들게 한다.
async function factcheckComments(comments, geminiApiKey, videoClaim) {
  const topRebuttals = [...comments]
    .sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))
    .slice(0, MAX_FACTCHECK_TARGETS);

  const results = await Promise.all(
    topRebuttals.map(async (comment) => {
      const claim = await extractClaim(comment.textOriginal, geminiApiKey, {
        videoClaim,
        parentText: comment.isReply ? comment.parentText : null,
      });
      if (!claim) return null; // 욕설/단순 의견 등 검증 불가능한 댓글은 스킵
      const verdict = await verifyClaim(claim, geminiApiKey, videoClaim);
      return { comment: comment.textOriginal, claim, ...verdict };
    }),
  );

  return { factchecks: results.filter(Boolean) };
}

// Vision Web Detection은 화면 워터마크(녹화 프로그램 로고 등)처럼 영상 내용과 무관한
// 시각 요소로도 매칭되어 스크린샷/튜토리얼 사이트 같은 완전히 무관한 후보를 던질 수 있다.
// "원본 영상"을 찾는 게 목적이므로 실제 영상 플랫폼 도메인만 후보로 남긴다.
const VIDEO_HOSTS = [
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'fb.watch',
  'twitter.com',
  'x.com',
  'vimeo.com',
  'dailymotion.com',
  'twitch.tv',
  'kakao.com',
  'naver.com',
  'bilibili.com',
  'reddit.com',
];

function isVideoPlatformUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return VIDEO_HOSTS.some((p) => host === p || host.endsWith('.' + p));
  } catch {
    return false;
  }
}

async function findOriginal(frames, sourceComments, visionApiKey, youtubeApiKey) {
  let candidates = [];

  if (visionApiKey && frames && frames.length) {
    try {
      const results = await reverseSearch(frames, visionApiKey);
      candidates = results.filter((r) => isVideoPlatformUrl(r.url));
    } catch {
      // Vision 검색 실패 시 아래 댓글 URL 폴백으로 진행
    }
  }

  let items = await buildResultItems(candidates, youtubeApiKey);

  // Vision 검색이 0건이면 'source'로 분류된 댓글에서 URL을 추출해 후보로 제시
  if (!items.length && sourceComments && sourceComments.length) {
    const fallbackUrls = [];
    for (const text of sourceComments) {
      fallbackUrls.push(...extractUrlsFromText(text));
    }
    items = await buildResultItems(
      [...new Set(fallbackUrls)].map((url) => ({ url, matchCount: 0 })),
      youtubeApiKey,
    );
    items.forEach((item) => (item.fromComment = true));
  }

  // 여러 프레임에서 공통으로 검색된 후보(matchCount 높음)일수록 우연한 매칭이 아닐
  // 가능성이 높으므로 먼저 정렬하고, 그 안에서는 업로드일이 이른 순으로 정렬한다.
  items.sort((a, b) => {
    if ((b.matchCount || 0) !== (a.matchCount || 0)) return (b.matchCount || 0) - (a.matchCount || 0);
    if (a.uploadDate && b.uploadDate) return new Date(a.uploadDate) - new Date(b.uploadDate);
    if (a.uploadDate) return -1;
    if (b.uploadDate) return 1;
    return 0;
  });

  if (items.length && items[0].uploadDate) items[0].isOriginalGuess = true;

  return { items: items.slice(0, 5), found: items.length > 0 };
}

async function buildResultItems(candidates, youtubeApiKey) {
  const items = [];
  for (const { url, matchCount } of candidates) {
    const videoId = extractYoutubeVideoId(url);
    let uploadDate = null;
    if (videoId && youtubeApiKey) {
      uploadDate = await fetchUploadDate(videoId, youtubeApiKey);
    }
    // 유튜브 영상이면 API 호출 없이 공개 썸네일 URL을 바로 쓸 수 있다.
    const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : null;
    items.push({ url, domain: safeHostname(url), videoId, uploadDate, thumbnail, matchCount: matchCount || 0 });
  }
  return items;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
