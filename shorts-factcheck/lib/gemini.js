// Gemini generateContent 공통 호출 유틸.
// 댓글 분류, 주장 추출, 팩트체크 판정이 전부 이 함수를 통해 호출된다.
// 2026년 7월 기준 정확한 모델 ID를 확인할 수 없어 아래 두 모델명은 추정치다.
// 계정에서 사용 가능한 최신 모델명으로 교체할 것.
export const GEMINI_FLASH_LITE_MODEL = 'gemini-2.5-flash-lite';
export const GEMINI_PRO_MODEL = 'gemini-2.5-pro';

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
