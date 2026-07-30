// 댓글 반박 주장 추출 + 웹서치 기반 팩트체크 판정 담당 모듈. 둘 다 Gemini를 쓰되,
// 주장 추출은 저렴한 Flash-Lite, 최종 판정은 정확도가 중요해 Pro + 검색 그라운딩을 쓴다.
import { callGemini, extractGeminiText, isGeminiBlocked, GEMINI_FLASH_LITE_MODEL, GEMINI_PRO_MODEL } from './gemini.js';

const VALID_VERDICTS = ['사실', '거짓', '불충분', '부분적 사실'];

const EXTRACT_SYSTEM_PROMPT = `너는 유튜브 댓글에서 검증 가능한 사실 주장을 1개 추출하는 도구다.
댓글이 단순 욕설, 감정 표현, 검증 불가능한 개인 의견이면 주장이 없다고 판단하라.
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

const VERIFY_SYSTEM_PROMPT = `너는 팩트체크 판정관이다. 유튜브 쇼츠의 핵심 주장과, 그 영상에 달린 반박 댓글의 주장이 함께 주어질 수 있다
(영상 자막이 없어 영상 주장이 주어지지 않으면 반박 댓글 주장만 보고 판정하라).
반박 댓글의 주장이 실제로 맞는지 웹 검색 결과에 근거해 판정하라 — 영상 주장은 맥락 참고용이지, 영상이 맞다고 전제하지 마라.

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

export async function extractClaim(commentText, apiKey) {
  const userPrompt = `댓글: ${(commentText || '').replace(/\n+/g, ' ').slice(0, 800)}`;

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
export async function extractVideoClaim(transcript, apiKey) {
  if (!transcript) return null;
  const userPrompt = `자막: ${transcript.slice(0, 4000)}`;

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

export async function verifyClaim(claim, apiKey, videoClaim) {
  const userText = videoClaim ? `영상 주장: ${videoClaim}\n반박 댓글 주장: ${claim}` : `반박 댓글 주장: ${claim}`;
  const data = await callGemini(GEMINI_PRO_MODEL, VERIFY_SYSTEM_PROMPT, userText, apiKey, [{ googleSearch: {} }]);

  if (isGeminiBlocked(data)) {
    return { verdict: '불충분', reason: '정책상 이 주장은 판정할 수 없습니다.', sources: [] };
  }

  const candidate = data.candidates[0];
  const finalText = extractGeminiText(data);
  const groundingSources = (candidate.groundingMetadata?.groundingChunks || [])
    .map((c) => c.web)
    .filter(Boolean)
    .map((w) => ({ url: w.uri, title: w.title || w.uri }));

  const parsed = parseJsonObject(finalText);

  if (parsed && VALID_VERDICTS.includes(parsed.verdict)) {
    const sources =
      Array.isArray(parsed.sources) && parsed.sources.length
        ? parsed.sources.slice(0, 5).map((u) => ({ url: u, title: u }))
        : groundingSources.slice(0, 5);
    return { verdict: parsed.verdict, reason: parsed.reason || '', sources };
  }

  return {
    verdict: '불충분',
    reason: finalText.slice(0, 300) || '판정 결과를 해석하지 못했습니다.',
    sources: groundingSources.slice(0, 5),
  };
}
