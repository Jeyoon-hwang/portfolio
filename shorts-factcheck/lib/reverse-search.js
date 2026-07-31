// Google Cloud Vision Web Detection 기반 원본 영상 역방향 이미지 검색.
// 비용 참고: 이미지 1,000건당 약 $1.5 (Web Detection 기준).

export async function reverseSearch(frames, visionApiKey) {
  const requests = frames.map((base64) => ({
    image: { content: base64 },
    // 예전엔 10이었는데, 후보를 "아는 플랫폼만" 남기던 시절엔 그 이상 받아도 어차피 버려졌다.
    // 지금은 URL 모양으로 판단해 모르는 사이트도 받으므로, 후보를 넓게 받을수록 유튜브 밖
    // (인스타·틱톡·커뮤니티 등)의 원본을 찾을 확률이 올라간다. Vision 요금은 결과 개수가
    // 아니라 이미지 장수 기준이라 이걸 늘려도 비용은 그대로다.
    features: [{ type: 'WEB_DETECTION', maxResults: 25 }],
  }));

  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(visionApiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vision API error ${res.status}: ${text}`);
  }

  const data = await res.json();

  // 여러 프레임에서 공통으로 잡히는 후보일수록 신뢰도가 높다. 프레임 하나에서만 우연히
  // 매칭된 무관한 페이지(예: 비슷한 배경의 다른 영상)와, 실제로 여러 장면에서 반복
  // 매칭되는 진짜 원본 후보를 구분하기 위해 프레임별로 몇 번 등장했는지 투표수를 센다.
  const matchCounts = new Map();
  for (const result of data.responses || []) {
    const wd = result.webDetection;
    if (!wd) continue;
    const urlsInThisFrame = new Set();
    for (const page of wd.pagesWithMatchingImages || []) {
      if (page.url) urlsInThisFrame.add(page.url);
    }
    for (const img of wd.fullMatchingImages || []) {
      if (img.url) urlsInThisFrame.add(img.url);
    }
    for (const url of urlsInThisFrame) {
      matchCounts.set(url, (matchCounts.get(url) || 0) + 1);
    }
  }

  return Array.from(matchCounts.entries())
    .map(([url, matchCount]) => ({ url, matchCount }))
    .sort((a, b) => b.matchCount - a.matchCount);
}

export function extractYoutubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, '') === 'youtube.com') {
      if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
      const v = u.searchParams.get('v');
      if (v) return v;
    }
    if (u.hostname === 'youtu.be') {
      return u.pathname.slice(1) || null;
    }
  } catch {
    // 잘못된 URL은 무시
  }
  return null;
}

export function extractUrlsFromText(text) {
  const matches = (text || '').match(/https?:\/\/[^\s)\]]+/g);
  return matches || [];
}
