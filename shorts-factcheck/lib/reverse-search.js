// Google Cloud Vision Web Detection 기반 원본 영상 역방향 이미지 검색.
// 비용 참고: 이미지 1,000건당 약 $1.5 (Web Detection 기준).

export async function reverseSearch(frames, visionApiKey) {
  const requests = frames.map((base64) => ({
    image: { content: base64 },
    features: [{ type: 'WEB_DETECTION', maxResults: 10 }],
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
  const candidateUrls = new Set();

  for (const result of data.responses || []) {
    const wd = result.webDetection;
    if (!wd) continue;
    for (const page of wd.pagesWithMatchingImages || []) {
      if (page.url) candidateUrls.add(page.url);
    }
    for (const img of wd.fullMatchingImages || []) {
      if (img.url) candidateUrls.add(img.url);
    }
  }

  return Array.from(candidateUrls);
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
