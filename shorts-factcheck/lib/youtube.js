const MAX_PAGES = 3;

export async function fetchComments(videoId, apiKey) {
  const comments = [];
  let pageToken = '';

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
    url.searchParams.set('part', 'snippet');
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
