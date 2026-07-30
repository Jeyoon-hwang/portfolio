// 댓글 반박 주장 추출(DeepSeek) + 웹서치 기반 팩트체크 판정(Claude) 담당 모듈.

// 2026년 7월 기준 실제 DeepSeek 모델 ID를 확인할 수 없어 'deepseek-chat'으로 지정했다.
const DEEPSEEK_MODEL = 'deepseek-chat';
// 팩트체크는 프로젝트 코어라 정확도를 우선한다. 오판정 방지를 위해 Opus 계열을 사용.
const CLAUDE_MODEL = 'claude-opus-5';
const CLAUDE_API_VERSION = '2023-06-01';
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

// Claude API는 브라우저(및 확장 프로그램 service worker)에서의 직접 호출을 기본적으로 막는다.
// 'anthropic-dangerous-direct-browser-access' 헤더를 명시해야 CORS가 통과한다.
async function callClaude(messages, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': CLAUDE_API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: VERIFY_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${text}`);
  }

  return res.json();
}

async function runClaudeWithWebSearch(userText, apiKey) {
  let messages = [{ role: 'user', content: userText }];
  let data = await callClaude(messages, apiKey);

  // 서버 사이드 웹서치 루프가 반복 한도에 도달하면 pause_turn으로 멈춘다.
  // 대화 이력을 그대로 이어 붙여 재요청하면 이어서 진행된다.
  let continuations = 0;
  while (data.stop_reason === 'pause_turn' && continuations < 2) {
    messages = [...messages, { role: 'assistant', content: data.content }];
    data = await callClaude(messages, apiKey);
    continuations++;
  }

  return data;
}

export async function verifyClaim(claim, apiKey) {
  const data = await runClaudeWithWebSearch(`주장: ${claim}`, apiKey);

  // Claude Opus 5는 안전 정책상 거부 시 200 응답 + stop_reason: "refusal"을 반환한다.
  if (data.stop_reason === 'refusal') {
    return { verdict: '불충분', reason: '정책상 이 주장은 판정할 수 없습니다.', sources: [] };
  }

  const searchSources = [];
  const textBlocks = [];
  for (const block of data.content || []) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === 'web_search_result' && r.url) {
          searchSources.push({ url: r.url, title: r.title || r.url });
        }
      }
    } else if (block.type === 'text') {
      textBlocks.push(block.text);
    }
  }

  const finalText = textBlocks[textBlocks.length - 1] || '';
  const parsed = parseJsonObject(finalText);

  if (parsed && VALID_VERDICTS.includes(parsed.verdict)) {
    const sources =
      Array.isArray(parsed.sources) && parsed.sources.length
        ? parsed.sources.slice(0, 5).map((u) => ({ url: u, title: u }))
        : searchSources.slice(0, 5);
    return { verdict: parsed.verdict, reason: parsed.reason || '', sources };
  }

  return {
    verdict: '불충분',
    reason: finalText.slice(0, 300) || '판정 결과를 해석하지 못했습니다.',
    sources: searchSources.slice(0, 5),
  };
}
