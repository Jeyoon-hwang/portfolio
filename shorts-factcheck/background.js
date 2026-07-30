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
function mainWorldGetCaptionTracks() {
  try {
    let playerResponse = window.ytInitialPlayerResponse;
    if (!playerResponse || !playerResponse.captions) {
      const player = document.querySelector('#movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        playerResponse = player.getPlayerResponse();
      }
    }
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks)) return [];
    return tracks
      .filter((t) => t && t.baseUrl)
      .map((t) => ({ langCode: t.languageCode, kind: t.kind || null, baseUrl: t.baseUrl }));
  } catch {
    return [];
  }
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
      if (!sender?.tab?.id) return { tracks: [] };
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: mainWorldGetCaptionTracks,
        });
        return { tracks: Array.isArray(injection?.result) ? injection.result : [] };
      } catch {
        return { tracks: [] };
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
