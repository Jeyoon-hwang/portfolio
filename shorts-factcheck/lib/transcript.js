// 유튜브 비공식 timedtext 엔드포인트로 자막(자동/수동)을 가져와 텍스트로 합친다.
// 공식 API가 아니라 예고 없이 동작이 바뀌거나 막힐 수 있고, 자막이 없는 쇼츠(노래/밈 클립 등)는
// 애초에 조회할 자막 트랙 자체가 없어 null을 반환한다 — 호출부에서 반드시 null을 허용해야 한다.

function parseTracks(xml) {
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

function pickTrack(tracks) {
  if (!tracks.length) return null;
  const manual = tracks.filter((t) => !t.kind);
  const asr = tracks.filter((t) => t.kind === 'asr');
  return manual.find((t) => t.langCode === 'ko') || manual[0] || asr.find((t) => t.langCode === 'ko') || asr[0] || tracks[0];
}

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

export async function fetchTranscript(videoId) {
  try {
    const listRes = await fetch(`https://www.youtube.com/api/timedtext?type=list&v=${videoId}`);
    if (!listRes.ok) return null;
    const tracks = parseTracks(await listRes.text());
    const track = pickTrack(tracks);
    if (!track) return null;

    const params = new URLSearchParams({ v: videoId, lang: track.langCode });
    if (track.kind) params.set('kind', track.kind);
    const textRes = await fetch(`https://www.youtube.com/api/timedtext?${params.toString()}`);
    if (!textRes.ok) return null;

    const text = parseTranscriptText(await textRes.text());
    return text || null;
  } catch {
    return null;
  }
}
