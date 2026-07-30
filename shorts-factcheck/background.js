// service worker: 모든 외부 API 호출을 이 파일(과 lib/*)에서만 담당한다.
// content script는 격리된 세계이지만 페이지와 컨텍스트를 공유하므로 API 키를 여기서 다루지 않는다.
import { fetchComments, fetchUploadDate } from './lib/youtube.js';
import { classifyComments } from './lib/classifier.js';
import { extractClaim, verifyClaim } from './lib/factcheck.js';
import { reverseSearch, extractYoutubeVideoId, extractUrlsFromText } from './lib/reverse-search.js';
import { getCache, setCache } from './lib/cache.js';

const KEY_NAMES = ['youtubeApiKey', 'deepseekApiKey', 'geminiApiKey', 'visionApiKey'];
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
        deepseek: !!keys.deepseekApiKey,
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

    case 'CLASSIFY_COMMENTS': {
      const { deepseekApiKey } = await getKeys();
      if (!deepseekApiKey) return { error: 'missing_key' };
      return await classifyComments(message.comments, deepseekApiKey);
    }

    case 'FACTCHECK_COMMENTS': {
      const { deepseekApiKey, geminiApiKey } = await getKeys();
      if (!deepseekApiKey || !geminiApiKey) return { error: 'missing_key' };
      return await factcheckComments(message.comments, deepseekApiKey, geminiApiKey);
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
async function factcheckComments(comments, deepseekApiKey, geminiApiKey) {
  const topRebuttals = [...comments]
    .sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))
    .slice(0, MAX_FACTCHECK_TARGETS);

  const results = [];
  for (const comment of topRebuttals) {
    const claim = await extractClaim(comment.textOriginal, deepseekApiKey);
    if (!claim) continue; // 욕설/단순 의견 등 검증 불가능한 댓글은 스킵
    const verdict = await verifyClaim(claim, geminiApiKey);
    results.push({ comment: comment.textOriginal, claim, ...verdict });
  }

  return { factchecks: results };
}

async function findOriginal(frames, sourceComments, visionApiKey, youtubeApiKey) {
  let candidateUrls = [];

  if (visionApiKey && frames && frames.length) {
    try {
      candidateUrls = await reverseSearch(frames, visionApiKey);
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
    items.push({ url, domain: safeHostname(url), videoId, uploadDate });
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
