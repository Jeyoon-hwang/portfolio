// service worker: 모든 외부 API 호출을 이 파일(과 lib/*)에서만 담당한다.
// content script는 격리된 세계이지만 페이지와 컨텍스트를 공유하므로 API 키를 여기서 다루지 않는다.
import { fetchComments, fetchUploadDate } from './lib/youtube.js';
import { classifyComments } from './lib/classifier.js';
import { extractClaim, extractVideoClaim, verifyClaim } from './lib/factcheck.js';
import { fetchTranscript } from './lib/transcript.js';
import { reverseSearch, extractYoutubeVideoId, extractUrlsFromText } from './lib/reverse-search.js';
import { getCache, setCache } from './lib/cache.js';

const KEY_NAMES = ['youtubeApiKey', 'geminiApiKey', 'visionApiKey'];
const MAX_FACTCHECK_TARGETS = 5;

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: true, message: err?.message || String(err) }));
  return true; // 비동기 sendResponse를 위해 채널을 열어둔다
});

async function getKeys() {
  return chrome.storage.local.get(KEY_NAMES);
}

async function handle(message) {
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

    // 댓글/분류와 독립적인 작업이라, content.js가 GET_COMMENTS와 동시에 이 메시지도 쏴서
    // 팩트체크 단계에 도달할 때쯤엔 이미 끝나 있게 만든다 (임계 경로에서 제거).
    case 'GET_VIDEO_CLAIM': {
      const { geminiApiKey } = await getKeys();
      if (!geminiApiKey) return { error: 'missing_key' };
      const { text: transcript, reason } = await fetchTranscript(message.videoId).catch(() => ({ text: null, reason: 'error' }));
      if (!transcript) return { videoClaim: null, transcriptReason: reason };
      const videoClaim = await extractVideoClaim(transcript, geminiApiKey).catch(() => null);
      return { videoClaim, transcriptReason: videoClaim ? 'ok' : 'no_claim' };
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
  let candidateUrls = [];

  if (visionApiKey && frames && frames.length) {
    try {
      const urls = await reverseSearch(frames, visionApiKey);
      candidateUrls = urls.filter(isVideoPlatformUrl);
    } catch {
      // Vision 검색 실패 시 아래 댓글 URL 폴백으로 진행
    }
  }

  let items = await buildResultItems(candidateUrls, youtubeApiKey);

  // Vision 검색이 0건이면 'source'로 분류된 댓글에서 URL을 추출해 후보로 제시
  if (!items.length && sourceComments && sourceComments.length) {
    const fallbackUrls = [];
    for (const text of sourceComments) {
      fallbackUrls.push(...extractUrlsFromText(text));
    }
    items = await buildResultItems([...new Set(fallbackUrls)], youtubeApiKey);
    items.forEach((item) => (item.fromComment = true));
  }

  items.sort((a, b) => {
    if (a.uploadDate && b.uploadDate) return new Date(a.uploadDate) - new Date(b.uploadDate);
    if (a.uploadDate) return -1;
    if (b.uploadDate) return 1;
    return 0;
  });

  if (items.length && items[0].uploadDate) items[0].isOriginalGuess = true;

  return { items: items.slice(0, 5), found: items.length > 0 };
}

async function buildResultItems(urls, youtubeApiKey) {
  const items = [];
  for (const url of urls) {
    const videoId = extractYoutubeVideoId(url);
    let uploadDate = null;
    if (videoId && youtubeApiKey) {
      uploadDate = await fetchUploadDate(videoId, youtubeApiKey);
    }
    // 유튜브 영상이면 API 호출 없이 공개 썸네일 URL을 바로 쓸 수 있다.
    const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : null;
    items.push({ url, domain: safeHostname(url), videoId, uploadDate, thumbnail });
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
