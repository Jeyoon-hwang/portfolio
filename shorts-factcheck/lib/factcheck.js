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

// 이 프롬프트는 원래 두 줄이었는데, 실사용에서 멀쩡한 정보성 영상까지 "잡담"으로 처리해
// has_claim:false를 내는 일이 잦았다. 자막이 대부분 자동생성(ASR)이라 오탈자·문장 끊김이
// 심한 게 원인으로 보여서, "그건 정상이고 포기할 이유가 아니다"를 명시하고 거절 조건을
// 좁게 못박았다.
const VIDEO_CLAIM_SYSTEM_PROMPT = `너는 유튜브 영상 자막에서 영상이 시청자에게 전달하려는 핵심 내용이나 논조를 한두 문장으로 요약하는 도구다.

자막은 대부분 자동생성(ASR)이라 오탈자, 띄어쓰기 오류, 문장 끊김, 화자 구분 없음이 심하다.
**이건 정상이며 요약을 포기할 이유가 절대 아니다.** 문장이 매끄럽지 않아도 무슨 얘기를 하는
영상인지 알아볼 수 있으면 반드시 요약하라.

설명·정보 전달·주장·후기·경험담·논평·리뷰·강의·뉴스·해설처럼 **내용이 있는 영상이면 무조건
요약한다.** 말투가 가볍거나 반말이거나 유머가 섞여 있어도 내용이 있으면 잡담이 아니다.

요약할 게 없다(has_claim:false)고 판단해도 되는 경우는 **다음 세 가지뿐이다**:
1. 자막이 사실상 노래 가사뿐인 경우
2. "와", "대박", "ㅋㅋㅋ", "가보자고" 같은 감탄사·리액션만 있고 정보가 전혀 없는 경우
3. 자막이 너무 짧거나 깨져서 무슨 주제인지조차 알 수 없는 경우

애매하면 false가 아니라 **요약하는 쪽을 선택하라.**

출력은 반드시 JSON 객체 하나만 출력하라.
요약할 내용이 있으면: {"has_claim":true,"claim":"영상의 핵심 내용을 한두 문장으로"}
위 세 경우에 해당하면: {"has_claim":false}
마크다운 코드블록이나 백틱 없이 JSON 객체만 출력하라.`;

// 영상 자막에서 검증 가능한 사실 주장 여러 개를 뽑는다. 자막이 없으면 빈 배열.
export async function extractVideoClaims(transcript, apiKey, maxClaims) {
  if (!transcript) return [];
  const systemPrompt = VIDEO_CLAIMS_SYSTEM_PROMPT.replace('%MAX%', String(maxClaims));
  const userPrompt = `자막: ${transcript.slice(0, 20000)}`;

  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      const data = await callGemini(GEMINI_FLASH_LITE_MODEL, systemPrompt, userPrompt, apiKey, null, CLAIMS_LIST_SCHEMA);
      if (!isGeminiBlocked(data)) parsed = parseJsonObject(extractGeminiText(data));
    } catch {
      // 재시도
    }
  }

  if (!parsed || !Array.isArray(parsed.claims)) return [];
  return parsed.claims
    .filter((c) => typeof c === 'string' && c.trim())
    .map((c) => c.trim())
    .slice(0, maxClaims);
}

// 자막을 못 가져왔을 때(유튜브 자동생성 자막 다운로드가 봇 방지 조치에 막히는 경우가 잦다)의
// 대체 재료. 제목/설명은 자막보다 정보가 적어 부정확할 수 있음을 프롬프트에 명시한다.
const VIDEO_CLAIM_FROM_META_SYSTEM_PROMPT = `너는 유튜브 쇼츠의 제목과 설명만 보고 영상이 시청자에게 전달하려는 핵심 주장이나 논조를 한두 문장으로 요약하는 도구다.
자막을 못 가져와 제목/설명만으로 추정하는 것이므로, 실제 영상 내용과는 다를 수 있다는 점을 감안해 확실히 드러나는 내용만 요약하라.
제목/설명이 단순 홍보 문구, 해시태그 나열, 무의미한 감탄사뿐이라 요약할 만한 주장이 없으면 그렇다고 판단하라.
출력은 반드시 JSON 객체 하나만 출력하라.
주장이 있으면: {"has_claim":true,"claim":"영상의 핵심 주장을 한두 문장으로"}
없으면: {"has_claim":false}
마크다운 코드블록이나 백틱 없이 JSON 객체만 출력하라.`;

// 영상 "논조 한 줄 요약"(VIDEO_CLAIM_SYSTEM_PROMPT)과 달리, 이건 실제로 웹 검색으로
// 맞는지 틀린지 따져볼 수 있는 개별 사실 주장들을 뽑아내는 용도다. 의견·감상·예측처럼
// 검증 불가능한 문장은 걸러야 헛된 판정(전부 "불충분")이 안 나온다.
const VIDEO_CLAIMS_SYSTEM_PROMPT = `너는 유튜브 영상 자막에서 "사실인지 검증 가능한 주장"만 골라내는 도구다.

자막은 대부분 자동생성(ASR)이라 오탈자·문장 끊김·화자 구분 없음이 심하다. 이건 정상이니
문장이 매끄럽지 않다는 이유로 건너뛰지 마라 — 무슨 말인지 알아볼 수 있으면 주장으로 뽑아라.

검증 가능한 주장이란 통계·수치, 역사적 사실, 특정 사건의 발생 여부, 인물·기관의 구체적 행위,
법·제도의 내용처럼 공개된 자료로 맞고 틀림을 따질 수 있는 문장이다.
다음은 제외하라: 개인 의견·감상("나는 ~라고 생각한다"), 미래 예측, 가치 판단("~해야 한다"),
농담·과장 표현, 너무 모호해서 무엇을 확인해야 할지 알 수 없는 문장.

각 주장은 자막의 표현을 그대로 베끼지 말고, 그 자체만 읽어도 무엇을 확인해야 하는지 알 수 있게
구체적으로 다시 써라 (예: "실업률이 엄청 높아요" → "남아프리카 공화국의 실업률은 30%를 넘는다").
지시 대명사("그 사건", "이 나라")는 자막 맥락을 참고해 실제 대상으로 바꿔라.

중요도(영상의 논지를 떠받치는 핵심일수록 앞)순으로 최대 %MAX% 개까지만 뽑아라.
검증 가능한 주장이 하나도 없으면 빈 배열을 출력하라.

출력은 반드시 JSON 객체 하나만 출력하라: {"claims":["주장1","주장2"]}
마크다운 코드블록이나 백틱 없이 JSON 객체만 출력하라.`;

const VERIFY_VIDEO_CLAIM_SYSTEM_PROMPT = `너는 팩트체크 판정관이다. 유튜브 영상이 시청자에게 말한 주장 하나가 주어진다.
그 주장이 실제로 맞는지 웹 검색 결과에 근거해 판정하라.

판정 등급은 다음 4개 중 하나만 사용한다: "사실", "거짓", "불충분", "부분적 사실".
영상이 말했다는 이유로 맞다고 전제하지 마라 — 오히려 이 도구의 목적은 영상의 오정보를 잡는 것이다.
주장의 큰 줄기는 맞는데 수치나 범위가 과장·축소됐다면 "부분적 사실"로 판정하고 무엇이 다른지 밝혀라.
근거가 부족하거나 검색 결과가 상충하면 억지로 사실/거짓으로 밀어붙이지 말고 반드시 "불충분"으로 판정하라.

충분히 검색한 뒤, 최종 답변으로 다른 설명 없이 아래 JSON 형식 하나만 마지막에 출력하라.
마크다운 코드블록이나 백틱은 쓰지 마라.
{"verdict":"사실|거짓|불충분|부분적 사실","reason":"판정 근거를 한두 문장으로 요약","sources":["https://...", "https://..."]}`;

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

// 응답 모양을 API 차원에서 고정한다 — mimeType만으론 "JSON이긴 한데 어떤 모양인지"가
// 안 정해져서, 모델이 감싸거나 키 이름을 바꾸면 파싱이 통째로 실패한다.
// has_claim이 false면 claim은 없어도 되므로 required에서 뺀다.
const CLAIM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    has_claim: { type: 'BOOLEAN' },
    claim: { type: 'STRING' },
  },
  required: ['has_claim'],
};

const CLAIMS_LIST_SCHEMA = {
  type: 'OBJECT',
  properties: {
    claims: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['claims'],
};

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
      const data = await callGemini(GEMINI_FLASH_LITE_MODEL, EXTRACT_SYSTEM_PROMPT, userPrompt, apiKey, null, CLAIM_SCHEMA);
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
// { claim, detail }을 돌려준다. detail은 왜 못 뽑았는지 구분하기 위한 값이다 —
// 예전엔 "모델이 주장 없다고 판단"과 "응답을 못 받거나 파싱 실패"가 똑같이 null로 뭉개져서,
// 뉴스 영상인데도 주장이 안 잡히는 사례가 나왔을 때 원인을 좁힐 수가 없었다.
// 'ok' | 'no_claim' | 'unparsed' | 'blocked' | 'empty_transcript'
export async function extractVideoClaim(transcript, apiKey) {
  if (!transcript) return { claim: null, detail: 'empty_transcript' };
  const userPrompt = `자막: ${transcript.slice(0, 20000)}`;

  let parsed = null;
  let blocked = false;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      const data = await callGemini(GEMINI_FLASH_LITE_MODEL, VIDEO_CLAIM_SYSTEM_PROMPT, userPrompt, apiKey, null, CLAIM_SCHEMA);
      if (isGeminiBlocked(data)) blocked = true;
      else parsed = parseJsonObject(extractGeminiText(data));
    } catch {
      // 재시도
    }
  }

  if (parsed && parsed.has_claim && typeof parsed.claim === 'string' && parsed.claim.trim()) {
    return { claim: parsed.claim.trim(), detail: 'ok' };
  }
  if (parsed) return { claim: null, detail: 'no_claim' };
  return { claim: null, detail: blocked ? 'blocked' : 'unparsed' };
}

// 자막 다운로드가 실패했을 때(유튜브 자동생성 자막 봇 방지 조치 등) 제목/설명으로 대체 추정한다.
export async function extractVideoClaimFromMeta(title, description, apiKey) {
  if (!title && !description) return null;
  const userPrompt = `제목: ${(title || '').slice(0, 200)}\n설명: ${(description || '').slice(0, 2000)}`;

  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      const data = await callGemini(GEMINI_FLASH_LITE_MODEL, VIDEO_CLAIM_FROM_META_SYSTEM_PROMPT, userPrompt, apiKey, null, CLAIM_SCHEMA);
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
  return runVerification(VERIFY_SYSTEM_PROMPT, lines.join('\n'), apiKey);
}

// 영상 자체가 말하는 주장을 검증한다. 반박 댓글 검증과 판정 등급·출력 형식은 같지만,
// "댓글이 맞는지"가 아니라 "영상이 맞는지"를 묻는 것이라 프롬프트를 따로 둔다.
export async function verifyVideoClaim(claim, apiKey, videoSummary) {
  const lines = [];
  if (videoSummary) lines.push(`영상 전체 논조(맥락 참고용): ${videoSummary}`);
  lines.push(`영상이 말한 주장: ${claim}`);
  return runVerification(VERIFY_VIDEO_CLAIM_SYSTEM_PROMPT, lines.join('\n'), apiKey);
}

async function runVerification(systemPrompt, userText, apiKey) {
  const data = await callGemini(GEMINI_PRO_MODEL, systemPrompt, userText, apiKey, [{ googleSearch: {} }]);

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
