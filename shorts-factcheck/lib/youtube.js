const MAX_PAGES = 3;

export async function fetchComments(videoId, apiKey) {
  const comments = [];
  let pageToken = '';

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
    // part=replies를 추가해도 commentThreads.list 쿼터 비용(1유닛/페이지)은 그대로다.
    // 단, 스레드당 최대 5개의 "최신" 답글만 함께 온다 — 답글이 5개보다 많은 스레드는
    // 나머지를 보려면 comments.list?parentId=...를 스레드마다 추가로 불러야 해서
    // 쿼터가 스레드 수만큼 폭증한다. 대댓글 논쟁을 놓치지 않으면서 쿼터는 지키기 위한 절충.
    url.searchParams.set('part', 'snippet,replies');
    url.searchParams.set('videoId', videoId);
    url.searchParams.set('maxResults', '100');
    url.searchParams.set('order', 'relevance');
    url.searchParams.set('key', apiKey);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const reason = body?.error?.errors?.[0]?.reason;
      if (res.status === 403 && reason === 'commentsDisabled') {
        return { comments: [], error: 'comments_disabled' };
      }
      if (res.status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) {
        return { comments: [], error: 'quota_exceeded' };
      }
      throw new Error(`YouTube API error ${res.status}: ${body?.error?.message || res.statusText}`);
    }

    const data = await res.json();
    for (const item of data.items || []) {
      const top = item.snippet.topLevelComment.snippet;
      comments.push({
        textOriginal: top.textOriginal,
        likeCount: top.likeCount || 0,
        authorDisplayName: top.authorDisplayName,
        publishedAt: top.publishedAt,
      });

      // 답글(대댓글)에서도 반박/논쟁이 자주 벌어지므로 같은 댓글 풀에 포함시킨다.
      // 원댓글 맥락 없이는 답글만 보고 무슨 얘기인지 알 수 없는 경우가 많아 parentText로 남겨둔다.
      const replies = item.replies?.comments || [];
      for (const reply of replies) {
        const r = reply.snippet;
        comments.push({
          textOriginal: r.textOriginal,
          likeCount: r.likeCount || 0,
          authorDisplayName: r.authorDisplayName,
          publishedAt: r.publishedAt,
          isReply: true,
          parentText: top.textOriginal,
        });
      }
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return { comments, error: null };
}

export async function fetchUploadDate(videoId, apiKey) {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('id', videoId);
  url.searchParams.set('key', apiKey);

  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.items?.[0]?.snippet?.publishedAt || null;
}

// 자막 스크래핑이 유튜브의 자동생성 자막 봇 방지 조치에 막혀 실패했을 때, 공식 API로
// 안정적으로 얻을 수 있는 제목/설명을 영상 핵심 주장 추출의 대체 재료로 쓴다.
export async function fetchVideoSnippet(videoId, apiKey) {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('id', videoId);
  url.searchParams.set('key', apiKey);

  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const snippet = data.items?.[0]?.snippet;
  if (!snippet) return null;
  return { title: snippet.title || '', description: snippet.description || '' };
}
