// 댓글 반박 주장 추출 + 웹서치 기반 팩트체크 판정 담당 모듈. 둘 다 Gemini를 쓰되,
// 주장 추출은 저렴한 Flash-Lite, 최종 판정은 정확도가 중요해 Pro + 검색 그라운딩을 쓴다.
import { callGemini, extractGeminiText, isGeminiBlocked, GEMINI_FLASH_LITE_MODEL, GEMINI_PRO_MODEL } from './gemini.js';

const VALID_VERDICTS = ['사실', '거짓', '불충분', '부분적 사실'];

const EXTRACT_SYSTEM_PROMPT = `너는 유튜브 댓글에서 검증 가능한 사실 주장을 1개 추출하는 도구다.
댓글이 단순 욕설, 감정 표현, 검증 불가능한 개인 의견이면 주장이 없다고 판단하라.

영상 맥락이나 원댓글(답글인 경우) 맥락이 함께 주어질 수 있다. 댓글 자체만 보면 "누구의/어느 기관의/무슨 사건에 대한" 얘기인지
불분명한 경우, 주어진 맥락을 참고해 주장을 더 구체적으로 표현하라 (예: "게시글이 삭제됐다" → "OO시청 계곡 불법영업 논란 게시글이 삭제됐다").
단, 맥락에 실제로 나오지 않는 내용을 추측해서 채워넣지는 마라 — 맥락이 없거나 관련이 없으면 댓글 내용 그대로만 정리하라.

댓글이 "09:02 시점에 언급된 선거는..."처럼 영상의 특정 구간을 지칭하면, 그 구간 자막이 함께 주어질 수 있다.
이 경우 그 자막에 실제로 나오는 내용으로 "그 선거"/"이 사건" 같은 지시 표현을 구체적인 대상으로 바꿔라
(예: "그 선거는 부정선거가 아니다" + 해당 구간 자막이 "2024년 미국 대선을 보자" → "2024년 미국 대선은 부정선거가 아니다").

출력은 반드시 JSON 객체 하나만 출력하라.
주장이 있으면: {"has_claim":true,"claim":"검증 가능한 형태로 정리한 주장 한 문장"}
주장이 없으면: {"has_claim":false}
마크다운 코드블록이나 백틱 없이 JSON 객체만 출력하라.`;

const VIDEO_CLAIM_SYSTEM_PROMPT = `너는 유튜브 쇼츠 자막에서 영상이 시청자에게 전달하려는 핵심 주장이나 논조를 한두 문장으로 요약하는 도구다.
자막이 단순 노래 가사, 의미 없는 감탄사, 잡담이라 요약할 만한 주장이 없으면 그렇다고 판단하라.
출력은 반드시 JSON 객체 하나만 출력하라.
주장이 있으면: {"has_claim":true,"claim":"영상의 핵심 주장을 한두 문장으로"}
없으면: {"has_claim":false}
마크다운 코드블록이나 백틱 없이 JSON 객체만 출력하라.`;

// 자막을 못 가져왔을 때(유튜브 자동생성 자막 다운로드가 봇 방지 조치에 막히는 경우가 잦다)의
// 대체 재료. 제목/설명은 자막보다 정보가 적어 부정확할 수 있음을 프롬프트에 명시한다.
const VIDEO_CLAIM_FROM_META_SYSTEM_PROMPT = `너는 유튜브 쇼츠의 제목과 설명만 보고 영상이 시청자에게 전달하려는 핵심 주장이나 논조를 한두 문장으로 요약하는 도구다.
자막을 못 가져와 제목/설명만으로 추정하는 것이므로, 실제 영상 내용과는 다를 수 있다는 점을 감안해 확실히 드러나는 내용만 요약하라.
제목/설명이 단순 홍보 문구, 해시태그 나열, 무의미한 감탄사뿐이라 요약할 만한 주장이 없으면 그렇다고 판단하라.
출력은 반드시 JSON 객체 하나만 출력하라.
주장이 있으면: {"has_claim":true,"claim":"영상의 핵심 주장을 한두 문장으로"}
없으면: {"has_claim":false}
마크다운 코드블록이나 백틱 없이 JSON 객체만 출력하라.`;

const VERIFY_SYSTEM_PROMPT = `너는 팩트체크 판정관이다. 유튜브 쇼츠의 핵심 주장과, 그 영상에 달린 반박 댓글의 주장이 함께 주어질 수 있다
(영상 자막이 없어 영상 주장이 주어지지 않으면 반박 댓글 주장만 보고 판정하라).
반박 댓글의 주장이 실제로 맞는지 웹 검색 결과에 근거해 판정하라 — 영상 주장은 맥락 참고용이지, 영상이 맞다고 전제하지 마라.

반박 댓글이 영상의 특정 시점(예: "09:02")을 지칭하면, 그 구간의 실제 자막도 함께 주어질 수 있다. 이 자막을 근거로
"그 선거", "해당 사건"처럼 불분명한 지시 표현이 구체적으로 무엇을 가리키는지 먼저 파악한 뒤 판정하라 — 이 자막이
있는데도 무엇을 가리키는지 명확하다면, 대상을 특정할 수 없다는 이유만으로 "불충분"으로 판정하지 마라.

판정 등급은 다음 4개 중 하나만 사용한다: "사실", "거짓", "불충분", "부분적 사실".
이 도구는 오정보를 잡으려는 목적이므로, 근거가 부족하거나 검색 결과가 상충하면 억지로 사실/거짓으로 밀어붙이지 말고 반드시 "불충분"으로 판정하라.

충분히 검색한 뒤, 최종 답변으로 다른 설명 없이 아래 JSON 형식 하나만 마지막에 출력하라.
마크다운 코드블록이나 백틱은 쓰지 마라.
{"verdict":"사실|거짓|불충분|부분적 사실","reason":"판정 근거를 한두 문장으로 요약","sources":["https://...", "https://..."]}`;

function parseJsonObject(raw) {
  const cleaned = raw.replace(/```json|```/g, '');
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// "09:02"/"1:23:45" 같은 mm:ss·h:mm:ss 표기를 찾는다. 앞에 다른 숫자가 붙은 건(전화번호,
// 큰 숫자의 일부 등) 제외하려고 경계에 숫자가 없어야 한다는 조건을 둔다.
const TIMESTAMP_RE = /(?<!\d)(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?!\d)/;

// 댓글이 언급하는 영상 속 시점을 초 단위로 뽑아낸다. 못 찾으면 null.
export function findTimestampSeconds(text) {
  if (!text) return null;
  const m = TIMESTAMP_RE.exec(text);
  if (!m) return null;
  if (m[3] !== undefined) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number(m[1]) * 60 + Number(m[2]);
}

const TIMESTAMP_CONTEXT_BEFORE_SEC = 10;
const TIMESTAMP_CONTEXT_AFTER_SEC = 20;

// seconds 시점 전후의 자막만 잘라 이어붙인다. 영상 길이를 벗어난 시각이면(예: 1분짜리 쇼츠에
// "09:02"를 댓글이 언급 — 이 영상 얘기가 아니거나 오탐) 엉뚱한 구간을 붙이지 않도록 null을 준다.
export function buildTimestampContext(seconds, segments) {
  if (seconds == null || !Array.isArray(segments) || !segments.length) return null;
  const maxStart = segments.reduce((max, s) => Math.max(max, s.start), 0);
  if (seconds > maxStart + TIMESTAMP_CONTEXT_AFTER_SEC) return null;
  const matched = segments
    .filter((s) => s.start >= seconds - TIMESTAMP_CONTEXT_BEFORE_SEC && s.start <= seconds + TIMESTAMP_CONTEXT_AFTER_SEC)
    .map((s) => s.text);
  return matched.length ? matched.join(' ') : null;
}

export async function extractClaim(commentText, apiKey, context) {
  const lines = [];
  if (context?.videoClaim) lines.push(`영상 주장: ${context.videoClaim}`);
  if (context?.parentText) lines.push(`원댓글(이 댓글이 답글로 달린 대상): ${context.parentText.replace(/\n+/g, ' ').slice(0, 300)}`);
  if (context?.timestampContext) lines.push(`댓글이 지칭하는 시점의 영상 자막: ${context.timestampContext.slice(0, 1000)}`);
  lines.push(`댓글: ${(commentText || '').replace(/\n+/g, ' ').slice(0, 800)}`);
  const userPrompt = lines.join('\n');

  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      const data = await callGemini(GEMINI_FLASH_LITE_MODEL, EXTRACT_SYSTEM_PROMPT, userPrompt, apiKey);
      if (!isGeminiBlocked(data)) parsed = parseJsonObject(extractGeminiText(data));
    } catch {
      // 재시도
    }
  }

  if (parsed && parsed.has_claim && typeof parsed.claim === 'string' && parsed.claim.trim()) {
    return parsed.claim.trim();
  }
  return null;
}

// 자막이 없는 쇼츠(노래/밈 클립 등)가 많으므로 transcript가 null이면 그냥 null을 반환한다.
// 롱폼 영상까지 지원하면서 자막이 훨씬 길어질 수 있어, 쇼츠 기준(4000자)보다 넉넉히 늘렸다 —
// Flash-Lite는 컨텍스트가 넓어 비용/속도 영향은 미미하다.
export async function extractVideoClaim(transcript, apiKey) {
  if (!transcript) return null;
  const userPrompt = `자막: ${transcript.slice(0, 20000)}`;

  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      const data = await callGemini(GEMINI_FLASH_LITE_MODEL, VIDEO_CLAIM_SYSTEM_PROMPT, userPrompt, apiKey);
      if (!isGeminiBlocked(data)) parsed = parseJsonObject(extractGeminiText(data));
    } catch {
      // 재시도
    }
  }

  if (parsed && parsed.has_claim && typeof parsed.claim === 'string' && parsed.claim.trim()) {
    return parsed.claim.trim();
  }
  return null;
}

// 자막 다운로드가 실패했을 때(유튜브 자동생성 자막 봇 방지 조치 등) 제목/설명으로 대체 추정한다.
export async function extractVideoClaimFromMeta(title, description, apiKey) {
  if (!title && !description) return null;
  const userPrompt = `제목: ${(title || '').slice(0, 200)}\n설명: ${(description || '').slice(0, 2000)}`;

  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      const data = await callGemini(GEMINI_FLASH_LITE_MODEL, VIDEO_CLAIM_FROM_META_SYSTEM_PROMPT, userPrompt, apiKey);
      if (!isGeminiBlocked(data)) parsed = parseJsonObject(extractGeminiText(data));
    } catch {
      // 재시도
    }
  }

  if (parsed && parsed.has_claim && typeof parsed.claim === 'string' && parsed.claim.trim()) {
    return parsed.claim.trim();
  }
  return null;
}

export async function verifyClaim(claim, apiKey, videoClaim, timestampContext) {
  const lines = [];
  if (videoClaim) lines.push(`영상 주장: ${videoClaim}`);
  if (timestampContext) lines.push(`댓글이 지칭하는 시점의 영상 자막: ${timestampContext.slice(0, 1000)}`);
  lines.push(`반박 댓글 주장: ${claim}`);
  const userText = lines.join('\n');
  const data = await callGemini(GEMINI_PRO_MODEL, VERIFY_SYSTEM_PROMPT, userText, apiKey, [{ googleSearch: {} }]);

  if (isGeminiBlocked(data)) {
    return { verdict: '불충분', reason: '정책상 이 주장은 판정할 수 없습니다.', sources: [] };
  }

  const candidate = data.candidates[0];
  const finalText = extractGeminiText(data);
  // Gemini의 groundingMetadata가 주는 web.uri는 실제 사이트 URL이 아니라
  // vertexaisearch.cloud.google.com/grounding-api-redirect/... 형태의 리다이렉트다.
  // 클릭하면 실제 출처로 넘어가므로 링크로는 문제없지만, 화면에 보여줄 제목은
  // 이 긴 리다이렉트 문자열이 아니라 web.title(대개 사이트/기사명)을 써야 한다.
  const groundingSources = (candidate.groundingMetadata?.groundingChunks || [])
    .map((c) => c.web)
    .filter(Boolean)
    .map((w) => ({ url: w.uri, title: w.title || null }));

  const parsed = parseJsonObject(finalText);

  // groundingMetadata가 구조화된 실제 출처 정보라, 모델이 텍스트로 직접 적어낸
  // sources 배열(리다이렉트 URL을 그대로 베껴 적는 경우가 많음)보다 우선한다.
  if (parsed && VALID_VERDICTS.includes(parsed.verdict)) {
    const sources =
      groundingSources.length ? groundingSources.slice(0, 5)
      : Array.isArray(parsed.sources) && parsed.sources.length
        ? parsed.sources.slice(0, 5).map((u) => ({ url: u, title: null }))
        : [];
    return { verdict: parsed.verdict, reason: parsed.reason || '', sources };
  }

  return {
    verdict: '불충분',
    reason: finalText.slice(0, 300) || '판정 결과를 해석하지 못했습니다.',
    sources: groundingSources.slice(0, 5),
  };
}
