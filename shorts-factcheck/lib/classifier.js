import { callGemini, extractGeminiText, isQuotaError, GEMINI_FLASH_LITE_MODEL } from './gemini.js';

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

// 응답 모양을 API 차원에서 고정한다. mimeType만 켜두면 모델이 배열 대신 객체로 감싸 보내는
// 일이 있고, 그러면 배치 전체가 파싱 실패로 "기타"가 돼버린다(실측으로 겪은 회귀다).
const CLASSIFICATION_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      i: { type: 'INTEGER' },
      c: { type: 'STRING', enum: VALID_CATEGORIES },
    },
    required: ['i', 'c'],
  },
};

function buildUserPrompt(batch) {
  return batch
    .map((c, i) => {
      const text = (c.textOriginal || '').replace(/\n+/g, ' ').slice(0, 500);
      // 답글은 원댓글 없이는 무슨 얘기인지 알 수 없는 경우가 많아 짧게 맥락을 붙여준다.
      const prefix = c.isReply && c.parentText
        ? `[답글, 원댓글: "${c.parentText.replace(/\n+/g, ' ').slice(0, 100)}"] `
        : '';
      return `${i}: ${prefix}${text}`;
    })
    .join('\n');
}

function parseClassificationArray(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    // responseMimeType으로 JSON을 강제하면 모델이 배열 대신 객체로 감싸서 주는 경우가 있다
    // ({"results":[...]} 등). 예전엔 이걸 파싱 실패로 보고 배치 전체를 기타로 흘려보냈다.
    if (parsed && typeof parsed === 'object') {
      const arr = Object.values(parsed).find((v) => Array.isArray(v));
      if (arr) return arr;
    }
    return null;
  } catch {
    return null;
  }
}

// 실패 원인을 밖으로 알린다. 예전엔 bare catch가 에러를 통째로 삼켜서, 배치가 전부 실패해도
// "왜"를 알 수 없었다 — API 거부인지, 응답이 비었는지, 파싱이 깨졌는지 구분이 안 됐다.
async function classifyBatch(batch, apiKey, onFailure) {
  const userPrompt = buildUserPrompt(batch);
  let lastReason = 'unknown';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await callGemini(GEMINI_FLASH_LITE_MODEL, SYSTEM_PROMPT, userPrompt, apiKey, null, CLASSIFICATION_SCHEMA);
      const text = extractGeminiText(data);
      const arr = parseClassificationArray(text);
      if (arr && arr.length) return arr;
      lastReason = text ? `파싱 실패 (응답 앞부분: "${text.slice(0, 120)}")` : '응답이 비어 있음';
    } catch (err) {
      lastReason = `호출 실패: ${err?.message || err}`;
    }
  }
  onFailure(lastReason);
  return null; // 실패한 배치는 misc 기본값을 유지한다
}

// 배치들을 병렬로 던진다 — 순차 처리 시 배치 수만큼 지연이 누적돼 "쇼츠 보는 시간의 절반"
// 안에 끝내야 한다는 속도 요구를 못 맞춘다.
export async function classifyComments(comments, apiKey) {
  // misc가 기본값이라 분류가 실패한 배치는 통째로 "기타"로 남는다. 예전엔 이게 아무 흔적도
  // 안 남아서 "댓글이 전부 기타"로 보일 때 분류가 깨진 건지 진짜 기타뿐인 건지 알 수 없었다.
  // 실패 배치 수와 영향받은 댓글 수를 세서 호출한 쪽에 돌려준다.
  const categories = new Array(comments.length).fill('misc');

  const batches = [];
  for (let start = 0; start < comments.length; start += BATCH_SIZE) {
    batches.push({ start, batch: comments.slice(start, start + BATCH_SIZE) });
  }

  const failureReasons = [];
  const results = await Promise.all(
    batches.map(({ batch }) => classifyBatch(batch, apiKey, (reason) => failureReasons.push(reason))),
  );

  let failedBatches = 0;
  let unclassified = 0;
  results.forEach((parsed, batchIndex) => {
    const { start, batch } = batches[batchIndex];
    if (!parsed) {
      failedBatches++;
      unclassified += batch.length;
      return;
    }
    for (const entry of parsed) {
      const idx = start + Number(entry?.i);
      // 모델이 "Rebuttal"처럼 대문자로 주거나 공백을 붙여 보내면 예전엔 그대로 버려져
      // 그 댓글만 조용히 기타가 됐다.
      const category = String(entry?.c || '').trim().toLowerCase();
      if (Number.isInteger(idx) && idx >= start && idx < categories.length && VALID_CATEGORIES.includes(category)) {
        categories[idx] = category;
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

  const firstReason = failureReasons[0] || 'unknown';
  const quotaExhausted = failedBatches > 0 && failureReasons.some(isQuotaError);
  const bgLog = failedBatches
    ? `댓글 분류 실패 배치 ${failedBatches}/${batches.length} — 댓글 ${unclassified}개가 "기타"로 남았습니다. 원인: ${firstReason}`
    : `댓글 분류 완료 (${batches.length}배치, ${comments.length}개)`;
  if (failedBatches) console.warn('[SFC classify]', bgLog);

  return {
    classified: comments.map((c, i) => ({ ...c, category: categories[i] })),
    distribution,
    percentages,
    bgLog,
    // 크레딧이 떨어진 거면 분포를 그럴듯하게 보여주는 게 오히려 거짓말이다 — 화면에 그대로 알린다.
    quotaExhausted,
  };
}
