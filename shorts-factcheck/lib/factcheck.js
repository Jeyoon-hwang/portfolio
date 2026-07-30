// 댓글 반박 주장 추출(DeepSeek) + 웹서치 기반 팩트체크 판정(Gemini) 담당 모듈.

// 2026년 7월 기준 실제 DeepSeek 모델 ID를 확인할 수 없어 'deepseek-chat'으로 지정했다.
const DEEPSEEK_MODEL = 'deepseek-chat';
// 팩트체크는 프로젝트 코어라 정확도를 우선한다.
// 2026년 7월 기준 실제 Gemini 모델 ID를 확인할 수 없어 임시 지정. 계정에서 쓸 수 있는 최신 모델명으로 교체할 것.
const GEMINI_MODEL = 'gemini-2.5-pro';
const VALID_VERDICTS = ['사실', '거짓', '불충분', '부분적 사실'];

const EXTRACT_SYSTEM_PROMPT = `너는 유튜브 댓글에서 검증 가능한 사실 주장을 1개 추출하는 도구다.
댓글이 단순 욕설, 감정 표현, 검증 불가능한 개인 의견이면 주장이 없다고 판단하라.
출력은 반드시 JSON 객체 하나만 출력하라.
주장이 있으면: {"has_claim":true,"claim":"검증 가능한 형태로 정리한 주장 한 문장"}
주장이 없으면: {"has_claim":false}
마크다운 코드블록이나 백틱 없이 JSON 객체만 출력하라.`;

const VERIFY_SYSTEM_PROMPT = `너는 팩트체크 판정관이다. 주어진 주장을 웹 검색 결과에 근거해 판정하라.

판정 등급은 다음 4개 중 하나만 사용한다: "사실", "거짓", "불충분", "부분적 사실".
이 도구는 오정보를 잡으려는 목적이므로, 근거가 부족하거나 검색 결과가 상충하면 억지로 사실/거짓으로 밀어붙이지 말고 반드시 "불충분"으로 판정하라.

충분히 검색한 뒤, 최종 답변으로 다른 설명 없이 아래 JSON 형식 하나만 마지막에 출력하라.
마크다운 코드블록이나 백틱은 쓰지 마라.
{"verdict":"사실|거짓|불충분|부분적 사실","reason":"판정 근거를 한두 문장으로 요약","sources":["https://...", "https://..."]}`;

async function callDeepSeek(systemPrompt, userPrompt, apiKey) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

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
      const raw = await callDeepSeek(EXTRACT_SYSTEM_PROMPT, userPrompt, apiKey);
      parsed = parseJsonObject(raw);
    } catch {
      // 재시도
    }
  }

  if (parsed && parsed.has_claim && typeof parsed.claim === 'string' && parsed.claim.trim()) {
    return parsed.claim.trim();
  }
  return null;
}

// googleSearch 그라운딩 툴 사용. 필드명은 Gemini API 버전에 따라 바뀔 수 있으니
// 응답에 groundingMetadata가 비어 있으면 이 부분(툴 키 이름)부터 확인할 것.
async function callGemini(userText, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: VERIFY_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0 },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }

  return res.json();
}

export async function verifyClaim(claim, apiKey) {
  const data = await callGemini(`주장: ${claim}`, apiKey);

  // 안전 정책상 차단되면 candidates가 비고 promptFeedback.blockReason이 채워진다.
  const candidate = data.candidates?.[0];
  if (data.promptFeedback?.blockReason || !candidate || candidate.finishReason === 'SAFETY') {
    return { verdict: '불충분', reason: '정책상 이 주장은 판정할 수 없습니다.', sources: [] };
  }

  const finalText = (candidate.content?.parts || []).map((p) => p.text || '').join('');
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
