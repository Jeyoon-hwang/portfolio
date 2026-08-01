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

export async function callGemini(model, systemPrompt, userText, apiKey, tools, responseSchema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0 },
  };
  // 도구(웹 검색)를 안 쓰는 호출은 전부 JSON 한 덩어리를 기대하는 추출/분류 작업이다.
  // "JSON만 출력하라"고 프롬프트로 부탁하는 것만으로는 모델이 설명 문장을 덧붙이거나
  // 코드블록으로 감싸는 일이 있었고, 그러면 파싱이 깨져 결과가 통째로 버려졌다(실측:
  // 2796자짜리 뉴스 자막이 unparsed로 실패). responseMimeType으로 JSON을 강제하면
  // 이 실패 유형이 원천적으로 사라진다. 검색 그라운딩과는 같이 못 쓰므로 tools가 있으면 뺀다.
  //
  // 다만 mimeType만으로는 "JSON이긴 한데 어떤 모양인지"가 안 정해진다. 실제로 배열을
  // 기대하던 댓글 분류가 이걸 켠 뒤 객체로 감싸여 오면서 전부 파싱 실패한 적이 있다.
  // 모양이 중요한 호출은 responseSchema로 못박는다.
  const usingJsonMode = !tools;
  if (tools) {
    body.tools = tools;
  } else {
    body.generationConfig.responseMimeType = 'application/json';
    if (responseSchema) body.generationConfig.responseSchema = responseSchema;
  }

  const send = (payload) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

  let res = await send(body);

  // JSON 모드(responseMimeType/responseSchema)는 모델·API 버전에 따라 거부될 수 있다.
  // 실측으로 이걸 켠 직후 댓글 분류가 6/6 배치 전부 실패했는데, 에러가 위쪽 catch에
  // 삼켜져 원인이 안 보였다. 거부당하면 이 옵션들을 빼고 한 번 더 보낸다 — 예전에 잘 돌던
  // 경로 그대로라, JSON 모드를 못 쓰는 환경에서도 최소한 예전만큼은 동작한다.
  if (!res.ok && usingJsonMode) {
    const firstError = await res.text().catch(() => '');
    console.warn(`[SFC gemini] JSON 모드 거부됨 (${res.status}) — 옵션 없이 재시도합니다: ${firstError.slice(0, 200)}`);
    const fallbackBody = {
      ...body,
      generationConfig: { temperature: 0 },
    };
    res = await send(fallbackBody);
  }

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
// 크레딧 소진(429 RESOURCE_EXHAUSTED)은 코드 문제가 아니라 결제 문제인데, 겉으로는
// "댓글이 전부 기타" "영상 주장 없음"처럼 보여서 한참 엉뚱한 곳을 뒤지게 만든다.
// 이 상태를 따로 알아보고 화면에 그대로 말해주기 위한 판별자.
export function isQuotaError(message) {
  const text = String(message || '');
  return text.includes('429') || text.includes('RESOURCE_EXHAUSTED') || text.includes('credits are depleted');
}

export function isGeminiBlocked(data) {
  const candidate = data.candidates?.[0];
  return !!data.promptFeedback?.blockReason || !candidate || candidate.finishReason === 'SAFETY';
}
