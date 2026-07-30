// 유튜브 자막을 가져와 텍스트로 합친다. 두 가지 방법을 순서대로 시도한다:
// 1) watch 페이지에 내장된 ytInitialPlayerResponse에서 caption track의 baseUrl을 직접 얻는 방법.
//    자막이 있는데도 예전 방식(timedtext?type=list)이 빈 목록을 주는 영상이 많아서
//    yt-dlp 등에서도 쓰는 이 방법을 기본으로 삼는다.
// 2) 위가 실패하면 예전 timedtext?type=list 목록 조회로 폴백.
// 어느 쪽이든 공식 API가 아니라 예고 없이 막힐 수 있고, 자막이 없는 쇼츠(노래/밈 클립 등)는
// 애초에 트랙 자체가 없어 null을 반환한다 — 호출부에서 반드시 null을 허용해야 한다.

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function parseTranscriptText(xml) {
  const textRe = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
  const parts = [];
  let m;
  while ((m = textRe.exec(xml))) {
    parts.push(decodeHtmlEntities(m[1]));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function pickTrack(tracks) {
  if (!tracks.length) return null;
  const manual = tracks.filter((t) => !t.kind);
  const asr = tracks.filter((t) => t.kind === 'asr');
  return manual.find((t) => t.langCode === 'ko') || manual[0] || asr.find((t) => t.langCode === 'ko') || asr[0] || tracks[0];
}

// JSON.parse가 실패하지 않도록, 마커 뒤 첫 '{'부터 문자열 안의 중괄호는 무시하고
// 실제로 짝이 맞는 지점까지 잘라낸다. 정규식으로 "};"까지 자르면 문자열 값 안에
// 세미콜론/중괄호가 있을 때 잘못 잘린다.
function extractBalancedJson(html, marker) {
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;
  const start = html.indexOf('{', markerIdx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

async function fetchTracksFromWatchPage(videoId) {
  // credentials:'include'가 없으면 이 fetch는 완전히 쿠키 없는 익명 요청으로 나간다.
  // CONSENT 쿠키가 없는 상태로 요청하면 유튜브가 실제 watch 페이지 대신 동의 안내
  // 페이지를 돌려줄 수 있고, 그 페이지엔 ytInitialPlayerResponse 자체가 없다 —
  // 자막이 실제로 있는 영상에서도 매번 못 찾는 증상의 유력한 원인이라 쿠키를 포함시킨다.
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    credentials: 'include',
    headers: { 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });
  if (!res.ok) {
    console.warn('[SFC transcript] watch page fetch failed', videoId, res.status);
    return [];
  }
  const html = await res.text();

  const jsonText = extractBalancedJson(html, 'ytInitialPlayerResponse');
  if (!jsonText) {
    console.warn('[SFC transcript] ytInitialPlayerResponse marker not found', videoId);
    return [];
  }

  let playerResponse;
  try {
    playerResponse = JSON.parse(jsonText);
  } catch (err) {
    console.warn('[SFC transcript] ytInitialPlayerResponse JSON parse failed', videoId, err);
    return [];
  }

  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks)) {
    console.info('[SFC transcript] no captionTracks in playerResponse (video likely has no captions)', videoId);
    return [];
  }

  return tracks
    .filter((t) => t.baseUrl)
    .map((t) => ({ langCode: t.languageCode, kind: t.kind || null, baseUrl: t.baseUrl }));
}

function parseListTracks(xml) {
  const tracks = [];
  const tagRe = /<track\b([^>]*)\/>/g;
  let m;
  while ((m = tagRe.exec(xml))) {
    const attrs = m[1];
    const langMatch = attrs.match(/lang_code="([^"]*)"/);
    const kindMatch = attrs.match(/kind="([^"]*)"/);
    if (langMatch) tracks.push({ langCode: langMatch[1], kind: kindMatch ? kindMatch[1] : null });
  }
  return tracks;
}

async function fetchTracksFromListEndpoint(videoId) {
  const res = await fetch(`https://www.youtube.com/api/timedtext?type=list&v=${videoId}`, {
    credentials: 'include',
  });
  if (!res.ok) return [];
  return parseListTracks(await res.text());
}

function buildFallbackTimedtextUrl(videoId, track) {
  const params = new URLSearchParams({ v: videoId, lang: track.langCode });
  if (track.kind) params.set('kind', track.kind);
  return `https://www.youtube.com/api/timedtext?${params.toString()}`;
}

async function fetchOneTrackUrl(url) {
  try {
    // baseUrl에 fmt 파라미터가 이미 들어있으면 WebVTT/JSON3 등 우리 정규식이 못 읽는
    // 형식으로 올 수 있어, 항상 기본 XML(<text> 태그) 형식이 오도록 fmt를 제거한다.
    const u = new URL(url);
    u.searchParams.delete('fmt');
    url = u.toString();
  } catch {
    // baseUrl이 상대경로 등 URL 파싱이 안 되면 원본 그대로 시도
  }
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return null;
  return parseTranscriptText(await res.text());
}

async function fetchTrackText(videoId, track) {
  if (track.baseUrl) {
    const text = await fetchOneTrackUrl(track.baseUrl);
    if (text) return text;
    console.warn('[SFC transcript] baseUrl fetch empty, trying fallback timedtext URL', videoId);
  }
  // baseUrl이 없거나(list-endpoint 방식) baseUrl 결과가 비어 있으면 예전 방식으로 재시도
  const fallbackText = await fetchOneTrackUrl(buildFallbackTimedtextUrl(videoId, track));
  if (!fallbackText) console.warn('[SFC transcript] fallback timedtext URL also empty', videoId, track);
  return fallbackText;
}

// reason은 자막을 못 가져왔을 때 UI/콘솔에서 "어느 단계에서 실패했는지" 바로 알 수 있게 하는 진단용 값이다.
// 'no_tracks' | 'empty_track' | 'error' | 'ok'
export async function fetchTranscript(videoId) {
  try {
    let tracks = await fetchTracksFromWatchPage(videoId);
    if (!tracks.length) {
      tracks = await fetchTracksFromListEndpoint(videoId);
    }

    const track = pickTrack(tracks);
    if (!track) return { text: null, reason: 'no_tracks' };

    const text = await fetchTrackText(videoId, track);
    return text ? { text, reason: 'ok' } : { text: null, reason: 'empty_track' };
  } catch (err) {
    console.error('[SFC transcript] unexpected error', videoId, err);
    return { text: null, reason: 'error' };
  }
}
