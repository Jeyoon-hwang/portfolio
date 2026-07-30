import { callGemini, extractGeminiText, GEMINI_FLASH_LITE_MODEL } from './gemini.js';

const BATCH_SIZE = 50;
const VALID_CATEGORIES = ['rebuttal', 'source', 'agree', 'misc'];

const SYSTEM_PROMPT = `너는 유튜브 쇼츠 댓글을 4개 카테고리 중 하나로 정확하게 분류하는 엄격한 분류기다.

카테고리:
- rebuttal: 영상이 보여주거나 주장하는 "구체적인 내용"(사건, 인물, 사실관계, 수치 등)을 콕 집어 "그거 틀렸다/사실이 아니다/오해다"라고 반박하거나 정정하는 댓글. 단순히 화가 났거나 비판적인 어조라는 이유만으로는 rebuttal이 아니다.
- source: 원본 출처, 원작자, 링크를 제보하는 댓글
- agree: 영상 내용에 대한 동조, 공감, 감탄, 재미있다는 반응
- misc: 위 셋에 해당하지 않는 모든 것 — 드립, 무관한 잡담, 욕설, 구체적 근거 없는 비아냥. 애매하면 rebuttal이 아니라 misc로 분류하라.

예시:
- "이거 2년 전에 이미 반박된 얘기임" → rebuttal
- "저기 나온 수치 출처가 없는데 실제로는 반대임" → rebuttal
- "ㅋㅋㅋㅋ 뭔 개소리야" → misc (구체적 반박 없이 비아냥만 있음)
- "이 영상 별로다" → misc (구체적 반박이 아니라 단순 평가)
- "원본: https://..." → source
- "미쳤다 진짜 대박" → agree

입력은 번호가 매겨진 댓글 목록이다. 각 댓글에 대해 인덱스와 카테고리만 JSON 배열로 반환하라.
출력 형식 예시: [{"i":0,"c":"agree"},{"i":1,"c":"rebuttal"}]
마크다운 코드블록이나 백틱을 절대 사용하지 말고 JSON 배열만 출력하라.`;

function buildUserPrompt(batch) {
  return batch
    .map((c, i) => `${i}: ${(c.textOriginal || '').replace(/\n+/g, ' ').slice(0, 500)}`)
    .join('\n');
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

async function classifyBatch(batch, apiKey) {
  const userPrompt = buildUserPrompt(batch);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await callGemini(GEMINI_FLASH_LITE_MODEL, SYSTEM_PROMPT, userPrompt, apiKey);
      const arr = parseClassificationArray(extractGeminiText(data));
      if (arr && arr.length) return arr;
    } catch {
      // 재시도
    }
  }
  return null; // 실패한 배치는 misc 기본값을 유지한다
}

// 배치들을 병렬로 던진다 — 순차 처리 시 배치 수만큼 지연이 누적돼 "쇼츠 보는 시간의 절반"
// 안에 끝내야 한다는 속도 요구를 못 맞춘다.
export async function classifyComments(comments, apiKey) {
  const categories = new Array(comments.length).fill('misc');

  const batches = [];
  for (let start = 0; start < comments.length; start += BATCH_SIZE) {
    batches.push({ start, batch: comments.slice(start, start + BATCH_SIZE) });
  }

  const results = await Promise.all(batches.map(({ batch }) => classifyBatch(batch, apiKey)));

  results.forEach((parsed, batchIndex) => {
    if (!parsed) return;
    const { start } = batches[batchIndex];
    for (const entry of parsed) {
      const idx = start + entry.i;
      if (idx < categories.length && VALID_CATEGORIES.includes(entry.c)) {
        categories[idx] = entry.c;
      }
    }
  });

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
