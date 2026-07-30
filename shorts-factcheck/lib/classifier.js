// 2026년 7월 기준 실제 DeepSeek 모델 ID를 확인할 수 없어 'deepseek-chat'으로 지정했다.
// 계정에서 사용 가능한 정확한 모델명(스펙상 "DeepSeek V4 Flash")으로 교체해서 쓸 것.
const DEEPSEEK_MODEL = 'deepseek-chat';
const BATCH_SIZE = 100;
const VALID_CATEGORIES = ['rebuttal', 'source', 'agree', 'misc'];

const SYSTEM_PROMPT = `너는 유튜브 쇼츠 댓글을 4개 카테고리 중 하나로 분류하는 분류기다.
카테고리:
- rebuttal: 영상 내용에 사실적으로 반박하거나 정정하는 댓글
- source: 원본 출처나 링크를 제보하는 댓글
- agree: 동조, 공감, 감탄
- misc: 드립, 무관한 잡담

입력은 번호가 매겨진 댓글 목록이다. 각 댓글에 대해 인덱스와 카테고리만 JSON 배열로 반환하라.
출력 형식 예시: [{"i":0,"c":"agree"},{"i":1,"c":"rebuttal"}]
마크다운 코드블록이나 백틱을 절대 사용하지 말고 JSON 배열만 출력하라.`;

function buildUserPrompt(batch) {
  return batch
    .map((c, i) => `${i}: ${(c.textOriginal || '').replace(/\n+/g, ' ').slice(0, 500)}`)
    .join('\n');
}

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

function parseClassificationArray(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try {
    const arr = JSON.parse(cleaned);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

export async function classifyComments(comments, apiKey) {
  const categories = new Array(comments.length).fill('misc');

  for (let start = 0; start < comments.length; start += BATCH_SIZE) {
    const batch = comments.slice(start, start + BATCH_SIZE);
    const userPrompt = buildUserPrompt(batch);

    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const raw = await callDeepSeek(SYSTEM_PROMPT, userPrompt, apiKey);
        const arr = parseClassificationArray(raw);
        if (arr && arr.length) parsed = arr;
      } catch {
        // 재시도 1회 후에도 실패하면 이 배치는 misc 기본값을 유지한다
      }
    }

    if (parsed) {
      for (const entry of parsed) {
        const idx = start + entry.i;
        if (idx < categories.length && VALID_CATEGORIES.includes(entry.c)) {
          categories[idx] = entry.c;
        }
      }
    }
  }

  const distribution = { rebuttal: 0, source: 0, agree: 0, misc: 0 };
  categories.forEach((c) => distribution[c]++);

  const total = categories.length || 1;
  const percentages = {};
  for (const key of VALID_CATEGORIES) {
    percentages[key] = Math.round((distribution[key] / total) * 100);
  }

  return {
    classified: comments.map((c, i) => ({ ...c, category: categories[i] })),
    distribution,
    percentages,
  };
}
