// Gemini generateContent 공통 호출 유틸.
// 댓글 분류, 주장 추출, 팩트체크 판정이 전부 이 함수를 통해 호출된다.
//
// 2026-07-30 기준: gemini-2.5-pro는 이미 셧다운(2026-06-17)됐고, 그 후계였던
// gemini-3-pro-preview조차 벌써 또 셧다운(2026-03-09, gemini-3.1-pro-preview로 교체)됐다.
// Gemini 모델 세대교체가 몇 달 단위로 도는 상황이라 이 상수들은 또 깨질 수 있다.
// 404 + "no longer available" 에러가 나면 https://ai.google.dev/gemini-api/docs/models 에서
// 최신 모델 ID로 교체할 것.
export const GEMINI_FLASH_LITE_MODEL = 'gemini-3.1-flash-lite'; // 정식 GA
export const GEMINI_PRO_MODEL = 'gemini-3.1-pro-preview'; // preview — 다시 바뀔 수 있음

export async function callGemini(model, systemPrompt, userText, apiKey, tools) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0 },
  };
  if (tools) body.tools = tools;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }

  return res.json();
}

export function extractGeminiText(data) {
  const candidate = data.candidates?.[0];
  if (!candidate) return '';
  return (candidate.content?.parts || []).map((p) => p.text || '').join('');
}

// 안전 정책상 차단되면 candidates가 비고 promptFeedback.blockReason이 채워지거나,
// candidate.finishReason이 "SAFETY"로 온다.
export function isGeminiBlocked(data) {
  const candidate = data.candidates?.[0];
  return !!data.promptFeedback?.blockReason || !candidate || candidate.finishReason === 'SAFETY';
}
