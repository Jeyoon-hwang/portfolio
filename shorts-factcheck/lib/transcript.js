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
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
  if (!res.ok) return [];
  const html = await res.text();

  const jsonText = extractBalancedJson(html, 'ytInitialPlayerResponse');
  if (!jsonText) return [];

  let playerResponse;
  try {
    playerResponse = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks)) return [];

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
  const res = await fetch(`https://www.youtube.com/api/timedtext?type=list&v=${videoId}`);
  if (!res.ok) return [];
  return parseListTracks(await res.text());
}

async function fetchTrackText(videoId, track) {
  let url = track.baseUrl;
  if (!url) {
    const params = new URLSearchParams({ v: videoId, lang: track.langCode });
    if (track.kind) params.set('kind', track.kind);
    url = `https://www.youtube.com/api/timedtext?${params.toString()}`;
  }
  const res = await fetch(url);
  if (!res.ok) return null;
  return parseTranscriptText(await res.text());
}

export async function fetchTranscript(videoId) {
  try {
    let tracks = await fetchTracksFromWatchPage(videoId);
    if (!tracks.length) {
      tracks = await fetchTracksFromListEndpoint(videoId);
    }

    const track = pickTrack(tracks);
    if (!track) return null;

    const text = await fetchTrackText(videoId, track);
    return text || null;
  } catch {
    return null;
  }
}
