// 쇼츠 페이지 감지, 패널 주입, 파이프라인 오케스트레이션, 프레임 캡처를 담당한다.
// 유튜브는 SPA라 스크롤로 쇼츠가 바뀌어도 페이지가 리로드되지 않는다.
// 그래서 여러 신호(yt-navigate-finish, popstate, title 변화, 폴링)를 겹쳐서 videoId 변경을 놓치지 않게 한다.
(function () {
  'use strict';

  const PANEL_ID = 'sfc-panel';
  const PANEL_STATE_KEY = 'sfcPanelState';
  let panelEl = null;
  let reopenBtnEl = null;
  let panelState = 'expanded'; // 'expanded' | 'minimized' | 'hidden' — 쇼츠 전체에 적용되는 전역 설정
  let currentVideoId = null;
  let lastAnalyzedVideoId = null; // 패널에 지금 표시된 내용이 어느 영상 것인지 (꺼진 동안 영상이 바뀌었는지 판단용)
  let currentSourceComments = [];
  let runToken = 0; // 빠른 스크롤 중 이전 분석 결과가 늦게 도착해 덮어쓰는 것을 방지
  let pollTimerId = null;
  let contextInvalidated = false;

  async function loadPanelState() {
    try {
      const stored = await chrome.storage.local.get(PANEL_STATE_KEY);
      if (stored[PANEL_STATE_KEY]) panelState = stored[PANEL_STATE_KEY];
    } catch {
      // 저장된 값을 못 읽으면 기본값(expanded) 유지
    }
  }

  async function savePanelState() {
    try {
      await chrome.storage.local.set({ [PANEL_STATE_KEY]: panelState });
    } catch {
      // 컨텍스트 무효화 등으로 저장 실패해도 화면 동작에는 지장 없으니 무시
    }
  }

  function getVideoIdFromLocation() {
    const shortsMatch = location.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shortsMatch) return shortsMatch[1];
    // 쇼츠 전용이던 것을 일반(롱폼) 영상의 /watch?v= 페이지에서도 동작하도록 확장한다.
    if (location.pathname === '/watch') {
      return new URLSearchParams(location.search).get('v') || null;
    }
    return null;
  }

  // 확장 프로그램이 재로드/업데이트되면 이미 페이지에 주입된 이전 content script 인스턴스는
  // chrome.runtime 접근이 끊긴다(페이지 새로고침 전까지). 이 경우를 감지해 조용히 멈춘다.
  function isExtensionContextValid() {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  }

  function handleContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    if (pollTimerId) {
      clearInterval(pollTimerId);
      pollTimerId = null;
    }
    if (panelEl) {
      panelEl.innerHTML =
        '<div class="sfc-section"><div class="sfc-section-body"><p class="sfc-note">확장 프로그램이 업데이트되었습니다. 이 탭을 새로고침(F5)하면 다시 정상 작동합니다.</p></div></div>';
    }
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      if (!isExtensionContextValid()) {
        handleContextInvalidated();
        reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
        return;
      }
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        });
      } catch (err) {
        handleContextInvalidated();
        reject(err);
      }
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ---------- 패널 DOM ----------

  function ensurePanel() {
    if (panelEl && document.documentElement.contains(panelEl)) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = PANEL_ID;
    panelEl.innerHTML = `
      <div class="sfc-panel-header">
        <span class="sfc-panel-title">🔍 영상 팩트체크</span>
        <div class="sfc-panel-controls">
          <button class="sfc-minimize-btn" type="button" title="최소화">─</button>
          <button class="sfc-close-btn" type="button" title="끄기">✕</button>
        </div>
      </div>
      <div class="sfc-panel-body"></div>
    `;
    document.documentElement.appendChild(panelEl);
    panelEl.addEventListener('click', onPanelClick);
    applyPanelState();
    return panelEl;
  }

  function removePanel() {
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
  }

  function applyPanelState() {
    if (!panelEl) return;
    if (panelState === 'hidden') {
      panelEl.style.display = 'none';
      showReopenButton();
      return;
    }
    panelEl.style.display = '';
    hideReopenButton();
    panelEl.classList.toggle('sfc-minimized', panelState === 'minimized');
    const minimizeBtn = panelEl.querySelector('.sfc-minimize-btn');
    if (minimizeBtn) minimizeBtn.textContent = panelState === 'minimized' ? '▢' : '─';
  }

  function showReopenButton() {
    if (reopenBtnEl) return;
    reopenBtnEl = document.createElement('button');
    reopenBtnEl.id = 'sfc-reopen-btn';
    reopenBtnEl.type = 'button';
    reopenBtnEl.title = '영상 팩트체크 다시 열기';
    reopenBtnEl.textContent = '🔍';
    reopenBtnEl.addEventListener('click', () => {
      panelState = 'expanded';
      savePanelState();
      applyPanelState();
      // 꺼져 있던 동안 영상이 바뀌었을 수 있으니, 지금 표시된 내용이 현재 영상 것이 아니면 다시 분석한다.
      if (currentVideoId && lastAnalyzedVideoId !== currentVideoId) {
        runToken++;
        startAnalysisFor(currentVideoId, runToken);
      }
    });
    document.documentElement.appendChild(reopenBtnEl);
  }

  function hideReopenButton() {
    if (reopenBtnEl) {
      reopenBtnEl.remove();
      reopenBtnEl = null;
    }
  }

  function renderSkeleton() {
    const body = panelEl.querySelector('.sfc-panel-body');
    body.innerHTML = `
      <div class="sfc-section" data-section="comments">
        <div class="sfc-section-header"><span>댓글 여론</span><button class="sfc-toggle" type="button">▾</button></div>
        <div class="sfc-section-body"><div class="sfc-skeleton"></div></div>
      </div>
      <div class="sfc-section" data-section="videocheck">
        <div class="sfc-section-header"><span>영상 주장 검증</span><button class="sfc-toggle" type="button">▾</button></div>
        <div class="sfc-section-body"><div class="sfc-skeleton"></div></div>
      </div>
      <div class="sfc-section" data-section="factcheck">
        <div class="sfc-section-header"><span>반박 댓글 팩트체크</span><button class="sfc-toggle" type="button">▾</button></div>
        <div class="sfc-section-body"><div class="sfc-skeleton"></div></div>
      </div>
      <div class="sfc-section" data-section="original">
        <div class="sfc-section-header"><span>원본 영상</span><button class="sfc-toggle" type="button">▾</button></div>
        <div class="sfc-section-body">
          <button class="sfc-find-original-btn" type="button">🔍 원본 영상 찾기</button>
          <div class="sfc-original-result"></div>
        </div>
      </div>
    `;
  }

  function setSectionBody(name, html) {
    const el = panelEl?.querySelector(`.sfc-section[data-section="${name}"] .sfc-section-body`);
    if (el) el.innerHTML = html;
  }

  function onPanelClick(e) {
    const minimizeBtn = e.target.closest('.sfc-minimize-btn');
    if (minimizeBtn) {
      panelState = panelState === 'minimized' ? 'expanded' : 'minimized';
      savePanelState();
      applyPanelState();
      return;
    }
    const closeBtn = e.target.closest('.sfc-close-btn');
    if (closeBtn) {
      panelState = 'hidden';
      savePanelState();
      applyPanelState();
      return;
    }
    const toggleBtn = e.target.closest('.sfc-toggle');
    if (toggleBtn) {
      toggleBtn.closest('.sfc-section')?.classList.toggle('sfc-collapsed');
      return;
    }
    const findBtn = e.target.closest('.sfc-find-original-btn');
    if (findBtn) {
      handleFindOriginal();
      return;
    }
    const optionsLink = e.target.closest('.sfc-open-options');
    if (optionsLink) {
      e.preventDefault();
      sendMessage({ type: 'OPEN_OPTIONS' });
    }
  }

  // ---------- 렌더링 ----------

  function missingKeyHtml(names) {
    return `<p class="sfc-note">${escapeHtml(names.join(', '))} API 키가 필요합니다. <a href="#" class="sfc-open-options">설정 페이지 열기</a></p>`;
  }

  const CATEGORY_COLORS = { rebuttal: '#e74c3c', source: '#3498db', agree: '#2ecc71', misc: '#95a5a6' };
  const CATEGORY_LABELS = { rebuttal: '반박', source: '제보', agree: '동조', misc: '기타' };
  const CATEGORY_ORDER = ['rebuttal', 'source', 'agree', 'misc'];

  function buildConicGradient(pct) {
    let acc = 0;
    return CATEGORY_ORDER.map((key) => {
      const start = acc;
      acc += pct[key] || 0;
      return `${CATEGORY_COLORS[key]} ${start}% ${acc}%`;
    }).join(', ');
  }

  // 카테고리별 좋아요 최다 댓글 1개씩을 "대표 댓글"로 뽑는다 — 어떤 게 반박으로 잡혔는지
  // 퍼센트 숫자만 봐서는 알 수 없다는 문제를 해결하기 위함.
  function pickRepresentativeComments(classified) {
    const result = {};
    for (const key of CATEGORY_ORDER) {
      const inCategory = classified.filter((c) => c.category === key);
      if (!inCategory.length) continue;
      inCategory.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
      result[key] = inCategory[0];
    }
    return result;
  }

  function renderCommentsSection(percentages, representative) {
    const gradient = buildConicGradient(percentages);
    const legend = CATEGORY_ORDER.map(
      (key) =>
        `<span class="sfc-legend-item"><i style="background:${CATEGORY_COLORS[key]}"></i>${CATEGORY_LABELS[key]} ${percentages[key] || 0}%</span>`,
    ).join('');

    const repHtml = CATEGORY_ORDER.filter((key) => representative && representative[key])
      .map((key) => {
        const c = representative[key];
        const full = (c.textOriginal || '').replace(/\n+/g, ' ');
        // 화면엔 말줄임표로 잘려 보이니, title로 hover 시 전체 댓글을 볼 수 있게 한다
        return `
          <div class="sfc-rep-comment">
            <span class="sfc-rep-tag" style="background:${CATEGORY_COLORS[key]}">${CATEGORY_LABELS[key]}</span>
            ${c.isReply ? '<span class="sfc-rep-reply-badge" title="답글(대댓글)입니다">↳답글</span>' : ''}
            <span class="sfc-rep-text" title="${escapeHtml(full)}">${escapeHtml(full.slice(0, 60))}</span>
            <span class="sfc-rep-likes">👍${c.likeCount || 0}</span>
          </div>
        `;
      })
      .join('');

    setSectionBody(
      'comments',
      `<div class="sfc-donut" style="background: conic-gradient(${gradient});"></div><div class="sfc-legend">${legend}</div>${
        repHtml ? `<div class="sfc-rep-list">${repHtml}</div>` : ''
      }`,
    );
  }

  const VERDICT_ICON = { 사실: '✅', 거짓: '❌', 불충분: '⚠️', '부분적 사실': '🔶' };

  // fetchTranscript/extractVideoClaim이 실패한 단계를 그대로 화면에 노출한다 —
  // 개발자 콘솔을 열지 않아도 어느 단계에서 막혔는지 바로 보고할 수 있게 하기 위함.
  const TRANSCRIPT_REASON_LABEL = {
    no_tracks: '자막 트랙을 찾지 못함',
    empty_track: '자막 파일을 찾았지만 내용을 받아오지 못함',
    error: '자막을 가져오는 중 오류 발생',
    no_claim: '자막은 확인했지만 뚜렷한 주장 없음(가사/잡담 등)',
  };

  // 영상 주장 검증과 반박 댓글 팩트체크는 판정 결과 모양이 같아서 항목 렌더링을 공유한다.
  // label만 "영상"/"반박"으로 달라진다.
  function renderVerdictItems(items, label) {
    return items
      .map((fc) => {
        const sources = (fc.sources || [])
          // 출처 title이 없으면 리다이렉트 URL 원문 대신 짧은 대체 라벨을 보여준다
          .map((s, i) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title || `참고 자료 ${i + 1}`)}</a>`)
          .join(' · ');
        return `
          <div class="sfc-factcheck-item">
            <div class="sfc-fc-verdict">${VERDICT_ICON[fc.verdict] || '⚠️'} ${label}: "${escapeHtml(fc.claim)}" → ${escapeHtml(fc.verdict)}</div>
            <div class="sfc-fc-reason">${escapeHtml(fc.reason || '')}</div>
            ${sources ? `<div class="sfc-fc-sources">${sources}</div>` : ''}
          </div>
        `;
      })
      .join('');
  }

  // 영상이 스스로 한 말이 맞는지를 보여주는 섹션. 댓글이 뭐라고 하든 무관하게 독립적으로
  // 판정한 결과라, 반박 댓글 섹션과 분리해서 맨 위에 둔다.
  function renderVideoCheckSection(videoFactchecks, videoClaim, transcriptReason, claimSource, videoCheckReason) {
    const reasonSuffix = !videoClaim && transcriptReason && transcriptReason !== 'ok'
      ? ` (${TRANSCRIPT_REASON_LABEL[transcriptReason] || transcriptReason})`
      : '';
    // 자막 다운로드가 막혀 제목/설명으로 대체 추정한 경우, 정확도가 자막보다 낮을 수 있다는
    // 걸 눈에 보이게 표시한다 — 자막에서 나온 것처럼 보이면 안 되기 때문.
    const sourceNote = claimSource === 'meta' ? ' <span class="sfc-video-claim-source">(자막 접근 제한 — 제목/설명 기반 추정)</span>' : '';
    const summaryHtml = videoClaim
      ? `<div class="sfc-video-claim"><strong>영상 주장</strong>${sourceNote} ${escapeHtml(videoClaim)}</div>`
      : `<p class="sfc-note sfc-video-claim-missing">영상 자막을 찾지 못해 영상 주장을 파악하지 못했습니다${escapeHtml(reasonSuffix)}.</p>`;

    if (videoFactchecks && videoFactchecks.length) {
      setSectionBody('videocheck', summaryHtml + renderVerdictItems(videoFactchecks, '영상'));
      return;
    }

    let note;
    if (videoCheckReason === 'no_claims') {
      note = '자막에서 사실 검증이 가능한 주장을 찾지 못했습니다 (의견·감상 위주의 영상).';
    } else if (claimSource === 'meta') {
      note = '자막을 받지 못해 제목/설명으로 논조만 추정했습니다 — 개별 주장 검증은 자막이 있어야 가능합니다.';
    } else if (!videoClaim) {
      note = '자막이 없어 영상 주장을 검증할 수 없습니다.';
    } else {
      note = '영상 주장 검증 결과가 없습니다.';
    }
    setSectionBody('videocheck', summaryHtml + `<p class="sfc-note">${escapeHtml(note)}</p>`);
  }

  function renderFactcheckSection(factchecks) {
    if (!factchecks || !factchecks.length) {
      setSectionBody('factcheck', '<p class="sfc-note">반박 댓글에서 검증 가능한 주장을 찾지 못했습니다.</p>');
      return;
    }
    setSectionBody('factcheck', renderVerdictItems(factchecks, '반박'));
  }

  function showOriginalMessage(msg) {
    const area = panelEl?.querySelector('.sfc-original-result');
    if (area) area.innerHTML = `<p class="sfc-note">${escapeHtml(msg)}</p>`;
  }

  function renderOriginalResult(result) {
    const area = panelEl?.querySelector('.sfc-original-result');
    if (!area) return;
    if (!result || !result.found) {
      area.innerHTML = '<p class="sfc-note">원본을 찾지 못했습니다. 이미 널리 퍼진 밈이거나 원본 노출이 거의 없는 영상일 수 있습니다.</p>';
      return;
    }
    area.innerHTML = result.items
      .map(
        (item) => `
          <div class="sfc-original-item">
            ${
              item.thumbnail
                ? `<img class="sfc-original-thumb" src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" />`
                : '<div class="sfc-original-thumb sfc-original-thumb-placeholder">🔗</div>'
            }
            <div class="sfc-original-info">
              <a href="${escapeHtml(item.url)}" title="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.domain)}</a>
              <div class="sfc-original-meta">
                ${item.uploadDate ? `<span class="sfc-original-date">${escapeHtml(new Date(item.uploadDate).toLocaleDateString('ko-KR'))}</span>` : ''}
                ${item.isOriginalGuess ? '<span class="sfc-original-badge">원본 추정</span>' : ''}
                ${item.matchCount > 1 ? `<span class="sfc-original-match" title="캡처한 프레임 중 ${item.matchCount}개에서 이 페이지가 검색됨">🎯${item.matchCount}프레임 일치</span>` : ''}
              </div>
            </div>
          </div>
        `,
      )
      .join('');
  }

  // ---------- 원본 찾기 (버튼 트리거 전용) ----------

  function getActiveVideoEl() {
    // 일반 영상(watch) 페이지에는 사이드바 추천 영상 미리보기용 <video>가 추가로 떠 있을 수 있어,
    // "화면에 보이는 아무 video"가 아니라 실제 플레이어 컨테이너를 먼저 찾는다.
    const primary = document.querySelector('#movie_player video, .html5-video-player video');
    if (primary) return primary;

    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return null;
    const visible = videos.find((v) => {
      const rect = v.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
    });
    return visible || videos[0];
  }

  function seekTo(video, time) {
    return new Promise((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        clearTimeout(timer);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = time;
      // seeked 이벤트가 오지 않는 경우를 대비한 안전장치
      const timer = setTimeout(() => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      }, 800);
    });
  }

  // 영상 전체에 고르게 펼쳐 최대 5장을 캡처한다. 한 시점 근처만 찍으면 그 장면이 자막/전환/
  // 블러로 흐릴 때 검색이 통째로 실패할 수 있고, 여러 프레임을 찍어둬야 배경지에서
  // 우연히 매칭된 무관한 후보와 실제로 여러 장면에서 반복 매칭되는 진짜 후보를
  // 투표(matchCount)로 구분할 수 있다.
  const FRAME_COUNT = 5;

  async function captureFrames(video) {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const originalTime = video.currentTime;
    const wasPaused = video.paused;

    let targets;
    if (duration > 2) {
      // 맨 처음/끝은 암전이나 인트로·아웃트로가 많아 10%~90% 구간에서만 고르게 뽑는다.
      const usableStart = duration * 0.1;
      const usableEnd = duration * 0.9;
      const span = usableEnd - usableStart;
      targets = Array.from({ length: FRAME_COUNT }, (_, i) => usableStart + (span * i) / (FRAME_COUNT - 1));
    } else {
      // 길이를 알 수 없거나 너무 짧은 영상은 현재 재생 지점 기준 앞뒤로 대체한다.
      targets = [0, -1, 1].map((off) => originalTime + off).filter((t) => t >= 0);
    }
    targets = [...new Set(targets.map((t) => Math.max(0, duration ? Math.min(t, duration) : t)))];

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    const ctx = canvas.getContext('2d');

    video.pause();
    const frames = [];
    for (const t of targets.length ? targets : [originalTime]) {
      await seekTo(video, t);
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
      } catch {
        // 캡처 실패한 프레임은 건너뛰고 확보 가능한 만큼만 사용
      }
    }
    await seekTo(video, originalTime);
    if (!wasPaused) video.play().catch(() => {});

    return frames;
  }

  async function handleFindOriginal() {
    const videoId = currentVideoId;
    if (!videoId) return;

    const cached = await sendMessage({ type: 'GET_CACHE', videoId });
    if (cached && cached.originalSearch) {
      renderOriginalResult(cached.originalSearch);
      return;
    }

    const video = getActiveVideoEl();
    if (!video || video.readyState < 2) {
      showOriginalMessage('영상을 아직 불러오지 못했습니다. 잠시 후 다시 시도하세요.');
      return;
    }

    showOriginalMessage('프레임 캡처 중...');
    const frames = await captureFrames(video);
    if (!frames.length) {
      showOriginalMessage('프레임을 캡처하지 못했습니다.');
      return;
    }

    showOriginalMessage('검색 중...');
    try {
      const result = await sendMessage({
        type: 'FIND_ORIGINAL',
        videoId,
        frames,
        sourceComments: currentSourceComments,
      });
      if (videoId === currentVideoId) renderOriginalResult(result);
    } catch (err) {
      if (contextInvalidated) return;
      if (videoId === currentVideoId) showOriginalMessage('검색 중 오류가 발생했습니다: ' + err.message);
    }
  }

  // ---------- 자막(transcript) 가져오기 ----------
  // background.js(서비스 워커)에서 fetch하면 chrome-extension:// 출처의 완전히 별도 컨텍스트라
  // credentials:'include'를 줘도 유튜브가 실제 브라우저 세션으로 인식하지 못해 다운로드가
  // 계속 빈 응답으로 오는 문제가 있었다. content script는 유튜브 페이지 자체(같은 origin)에서
  // 실행되므로 이 fetch들은 일반 페이지의 same-origin 요청과 동일하게 쿠키/세션이 자연스럽게
  // 실린다 — 그래서 이 부분만 content.js로 옮겼다. Gemini 호출(API 키 필요)은 여전히
  // background.js에서 한다.

  function decodeHtmlEntities(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  }

  // 댓글이 "09:02 시점에 언급된 선거는..."처럼 특정 시점을 지칭하는 경우, 그 구간의 실제
  // 자막을 함께 봐야 무엇을 가리키는지 판정할 수 있다. 그래서 이제 자막을 합친 평문(text)
  // 뿐 아니라 각 줄의 시작 시각(초 단위)도 segments로 같이 들고 다닌다.
  function parseTranscriptText(xml) {
    const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    const startRe = /\bstart="([\d.]+)"/;
    const parts = [];
    const segments = [];
    let m;
    while ((m = textRe.exec(xml))) {
      const text = decodeHtmlEntities(m[2]).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      parts.push(text);
      const startMatch = startRe.exec(m[1]);
      if (startMatch) segments.push({ start: parseFloat(startMatch[1]), text });
    }
    return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), segments };
  }

  // 실제 플레이어가 요청하는 자막은 XML이 아니라 json3 포맷({events:[{segs:[{utf8:"..."}]}]})으로
  // 오는 경우가 많다. 어느 쪽인지 모르니 JSON으로 먼저 시도하고, 아니면 XML로 폴백한다.
  function parseJson3Transcript(raw) {
    try {
      const data = JSON.parse(raw);
      const events = Array.isArray(data?.events) ? data.events : [];
      const parts = [];
      const segments = [];
      for (const ev of events) {
        if (!Array.isArray(ev.segs)) continue;
        const text = ev.segs
          .map((seg) => (seg && seg.utf8) || '')
          .join('')
          .replace(/\n+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!text) continue;
        parts.push(text);
        if (typeof ev.tStartMs === 'number') segments.push({ start: ev.tStartMs / 1000, text });
      }
      return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), segments };
    } catch {
      return { text: '', segments: [] };
    }
  }

  function parseAnyTranscriptFormat(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return { text: '', segments: [] };
    if (trimmed[0] === '{') {
      const parsed = parseJson3Transcript(trimmed);
      if (parsed.text) return parsed;
    }
    return parseTranscriptText(trimmed);
  }

  function pickTranscriptTrack(tracks) {
    if (!tracks.length) return null;
    const manual = tracks.filter((t) => !t.kind);
    const asr = tracks.filter((t) => t.kind === 'asr');
    return manual.find((t) => t.langCode === 'ko') || manual[0] || asr.find((t) => t.langCode === 'ko') || asr[0] || tracks[0];
  }

  // JSON.parse가 실패하지 않도록, 마커 뒤 첫 '{'부터 문자열 안의 중괄호는 무시하고
  // 실제로 짝이 맞는 지점까지 잘라낸다. 정규식으로 "};"까지 자르면 문자열 값 안에
  // 세미콜론/중괄호가 있을 때 잘못 잘린다.
  function extractBalancedJson(html, marker) {
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) return null;
    const start = html.indexOf('{', markerIdx);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return html.slice(start, i + 1);
      }
    }
    return null;
  }

  async function fetchTracksFromWatchPage(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
    });
    if (!res.ok) {
      console.warn('[SFC transcript] watch page fetch failed', videoId, res.status);
      return [];
    }
    const html = await res.text();

    const jsonText = extractBalancedJson(html, 'ytInitialPlayerResponse');
    if (!jsonText) {
      console.warn('[SFC transcript] ytInitialPlayerResponse marker not found', videoId);
      return [];
    }

    let playerResponse;
    try {
      playerResponse = JSON.parse(jsonText);
    } catch (err) {
      console.warn('[SFC transcript] ytInitialPlayerResponse JSON parse failed', videoId, err);
      return [];
    }

    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks)) {
      console.info('[SFC transcript] no captionTracks in playerResponse (video likely has no captions)', videoId);
      return [];
    }

    return tracks
      .filter((t) => t.baseUrl)
      .map((t) => ({ langCode: t.languageCode, kind: t.kind || null, baseUrl: t.baseUrl }));
  }

  // baseUrl은 페이지의 player.js가 이미 서명/토큰까지 계산해 완성해둔 URL이다.
  // 쿼리 파라미터를 하나라도 건드리면(순서 변경, 삭제 등) 서명 검증에 걸려 200 OK인데
  // 본문만 빈 채로 오므로, 절대 수정하지 않고 그대로 fetch한다.
  // baseUrl에 `exp=xpe`(또는 xpv)가 있으면 pot 없이는 200 OK + 0바이트가 온다.
  // 이 실험 플래그가 자막 pot 요구의 확정 신호다.
  function requiresPotToken(url) {
    const exp = /[?&]exp=([^&]*)/.exec(url || '');
    if (!exp) return false;
    return /\bxpe\b/.test(exp[1]) || /\bxpv\b/.test(exp[1]);
  }

  // pot/potc/c를 "추가"만 한다. baseUrl의 서명은 sparams에 나열된 파라미터에만 걸려
  // 있으므로 목록에 없는 값을 덧붙이는 건 서명을 깨지 않는다 — 실제 브라우저가 보내는
  // 요청도 서명과 pot을 함께 달고 나간다. (기존 파라미터 수정/삭제는 여전히 금지)
  // URL 객체로 다시 조립하면 기존 값이 재인코딩된다(예: sparams의 쉼표 → %2C). 서명이
  // 걸린 URL을 그렇게 건드리는 건 위험하므로, 원본 문자열은 한 글자도 손대지 않고 뒤에
  // 문자열로만 이어 붙인다.
  function appendPotParams(url, pot) {
    let extra = `pot=${encodeURIComponent(pot)}&potc=1`;
    if (!/[?&]c=/.test(url)) extra += '&c=WEB';
    return url + (url.indexOf('?') === -1 ? '?' : '&') + extra;
  }

  async function fetchOneTrackUrl(url, pot) {
    const finalUrl = pot ? appendPotParams(url, pot) : url;
    const res = await fetch(finalUrl);
    if (!res.ok) {
      console.warn('[SFC transcript] track fetch not ok', finalUrl, res.status);
      return { text: '', segments: [] };
    }
    const raw = await res.text();
    const parsed = parseTranscriptText(raw);
    if (!parsed.text) {
      console.warn(
        '[SFC transcript] track fetch ok but parsed empty (raw body length: ' + raw.length + ', pot: ' + (pot ? 'yes' : 'no') + ')',
        finalUrl,
      );
    }
    return parsed;
  }

  // background.js를 거쳐 유튜브 페이지의 메인 월드(content script의 격리된 세계가 아니라
  // 페이지 자신의 JS 컨텍스트)에서 window.ytInitialPlayerResponse(또는 플레이어 객체)를
  // 직접 읽어온다. 이렇게 얻은 baseUrl은 브라우저가 실제로 그 영상을 재생하며 player.js가
  // 만들어낸 것이라 서명/토큰이 완전하다 — 우리가 별도로 watch 페이지를 다시 fetch해서
  // 파싱한 것보다 훨씬 신뢰할 수 있다.
  async function fetchTracksFromMainWorld(videoId) {
    try {
      const res = await sendMessage({ type: 'GET_CAPTION_TRACKS', videoId });
      // background.js(서비스 워커) 콘솔에 찍힌 로그를 페이지 콘솔에도 다시 찍는다 —
      // 두 콘솔을 오가지 않고 한 곳에서 전체 흐름을 볼 수 있게 하기 위함.
      if (res?.bgLog) console.info('[SFC transcript][bg]', res.bgLog);
      return Array.isArray(res?.tracks) ? res.tracks : [];
    } catch (err) {
      console.warn('[SFC transcript] GET_CAPTION_TRACKS message failed', err?.message || err);
      return [];
    }
  }

  // 유튜브 웹플레이어 자신이 내부적으로 호출하는 Innertube player 엔드포인트를 그대로 쓴다.
  // 요청 시점 기준으로 새로 서명된 caption baseUrl을 돌려주므로, 우리가 다시 만든 watch 페이지
  // 스냅샷보다 신선하다. 이 키(WEB 클라이언트용)는 2020년 무렵부터 yt-dlp 등에서 공개적으로
  // 써온 값이라 언젠가 유튜브가 로테이션하거나 막을 수 있다 — 그러면 이 함수만 갱신하면 된다.
  // content script가 youtube.com origin에서 실행되므로 same-origin이라 CORS 문제가 없다.
  const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

  async function fetchTracksViaInnertube(videoId) {
    try {
      const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId,
          context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'ko' } },
        }),
      });
      if (!res.ok) {
        console.warn('[SFC transcript] innertube player call failed', res.status);
        return [];
      }
      const data = await res.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!Array.isArray(tracks)) return [];
      return tracks
        .filter((t) => t && t.baseUrl)
        .map((t) => ({ langCode: t.languageCode, kind: t.kind || null, baseUrl: t.baseUrl }));
    } catch (err) {
      console.warn('[SFC transcript] innertube player call errored', err?.message || err);
      return [];
    }
  }

  // main-world-hook.js(document_start, MAIN 월드)가 실제 timedtext 응답을 가로채면 document에
  // 커스텀 이벤트로 던진다. content.js는 격리된 세계라 그 파일과 변수를 공유할 수 없으니 이
  // 이벤트로만 통신한다. 리스너를 먼저 걸어둔 뒤에 트리거해야, 이벤트가 우리가 듣기 전에
  // 지나가 버리는 경쟁 상태를 피할 수 있다.
  function waitForCapturedCaption(videoId, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      function onEvent(e) {
        if (settled || !e.detail || e.detail.videoId !== videoId) return;
        settled = true;
        document.removeEventListener('sfc-caption-captured', onEvent);
        clearTimeout(timer);
        resolve(e.detail.text || null);
      }
      document.addEventListener('sfc-caption-captured', onEvent);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        document.removeEventListener('sfc-caption-captured', onEvent);
        resolve(null);
      }, timeoutMs);
      // 리스너와 타이머를 다 걸어둔 뒤에야 물어본다 — main-world-hook.js가 이미 버퍼링해둔
      // 캡처본이 있으면 이 dispatchEvent 호출 안에서 onEvent가 동기적으로 실행되며 즉시
      // resolve될 수 있는데, 그 시점에 timer가 아직 없으면 clearTimeout(timer)가 깨진다.
      // 유튜브가 재생 시작과 동시에 캡션을 미리 요청해버려 리스너를 걸기 전에 이미 지나간
      // 경우를 이렇게 구제한다.
      document.dispatchEvent(new CustomEvent('sfc-caption-query', { detail: { videoId } }));
    });
  }

  // main-world-hook.js가 페이지 자신의 요청에서 주워둔 pot을 받아온다. 이미 갖고 있으면
  // 즉시(동기적으로) 답이 오고, 아직이면 새 pot이 잡힐 때까지 timeoutMs만큼 기다린다.
  // pot은 videoId에 바인딩된 값이라 **다른 영상의 pot은 절대 통하지 않는다**(실측: 직전
  // 영상의 pot을 그대로 붙였더니 pot을 붙였는데도 본문이 0바이트로 왔다). 그래서 이 영상의
  // pot이 확실할 때(exact)만 바로 쓰고, 아직 없으면 타임아웃까지 기다렸다가 그때도 없으면
  // 마지막에나 남의 pot이라도 한 번 시도해본다(어차피 실패해도 다음 단계로 넘어갈 뿐이다).
  function requestPotToken(videoId, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      let staleFallback = null;
      function finish(pot, exact) {
        if (settled) return;
        settled = true;
        document.removeEventListener('sfc-pot-result', onResult);
        document.removeEventListener('sfc-pot-captured', onCaptured);
        clearTimeout(timer);
        resolve({ pot: pot || null, exact: !!exact });
      }
      function onResult(e) {
        if (!e.detail || !e.detail.pot) return;
        if (e.detail.exact) finish(e.detail.pot, true);
        else staleFallback = e.detail.pot; // 아직 확정 못 함 — 계속 기다린다
      }
      // 대기 중에 이 영상의 pot이 새로 잡히면 그 즉시 쓴다.
      function onCaptured(e) {
        if (!e.detail || !e.detail.pot) return;
        if (e.detail.videoId && videoId && e.detail.videoId === videoId) finish(e.detail.pot, true);
        else if (!e.detail.videoId) staleFallback = staleFallback || e.detail.pot;
      }
      document.addEventListener('sfc-pot-result', onResult);
      document.addEventListener('sfc-pot-captured', onCaptured);
      timer = setTimeout(() => finish(staleFallback, false), timeoutMs);
      document.dispatchEvent(new CustomEvent('sfc-pot-query', { detail: { videoId } }));
    });
  }

  // 자막 한 트랙을 pot까지 붙여서 받아온다. xpe/xpv가 붙어 있으면 pot 없이는 어차피 빈
  // 본문이므로 먼저 pot을 구해 한 번에 제대로 요청하고, 신호를 못 봤는데 결과가 비면
  // 그때 pot을 구해 한 번 더 시도한다.
  // pot을 못 구했을 때만 MAIN 월드가 실제로 뭘 봤는지 받아 찍는다. 원인이 "콜드 로드라
  // Innertube 요청 자체가 없었음"인지 "요청은 봤는데 pot이 안 들어있었음"인지 구분하려는 것.
  function logPotDiagnostics() {
    const onResult = (e) => {
      document.removeEventListener('sfc-pot-debug-result', onResult);
      const d = e.detail || {};
      console.info(
        '[SFC transcript][pot] 진단 — innertube 요청:',
        d.innertubePaths?.length ? d.innertubePaths.join(', ') : '(하나도 못 봄)',
        '| pot 수집: URL',
        d.potFromUrlCount,
        '/ 본문',
        d.potFromBodyCount,
        '| 본문 못 읽음:',
        d.bodyUnreadableCount,
        '| pot 보유 영상:',
        d.videoIdsWithPot?.length || 0,
      );
    };
    document.addEventListener('sfc-pot-debug-result', onResult);
    document.dispatchEvent(new CustomEvent('sfc-pot-debug-query'));
    setTimeout(() => document.removeEventListener('sfc-pot-debug-result', onResult), 1000);
  }

  async function fetchTrackWithPot(baseUrl, videoId) {
    let pot = null;
    if (requiresPotToken(baseUrl)) {
      const res = await requestPotToken(videoId, 2500);
      pot = res.pot;
      console.info(
        '[SFC transcript][pot] xpe/xpv detected — pot token:',
        !pot ? 'NOT available' : res.exact ? 'exact match for this video' : 'STALE (다른 영상 pot — 실패 예상)',
      );
      if (!pot) logPotDiagnostics();
    }

    let parsed = await fetchOneTrackUrl(baseUrl, pot);
    if (!parsed.text && !pot) {
      const res = await requestPotToken(videoId, 2500);
      if (res.pot) {
        console.info('[SFC transcript][pot] retrying empty response with pot token (exact:', res.exact, ')');
        parsed = await fetchOneTrackUrl(baseUrl, res.pot);
      }
    }
    if (parsed.text && pot) console.info('[SFC transcript][pot] caption download succeeded WITH pot token');
    return parsed;
  }

  // reason은 자막을 못 가져왔을 때 UI/콘솔에서 "어느 단계에서 실패했는지" 바로 알 수 있게 하는 진단용 값이다.
  // 'no_tracks' | 'empty_track' | 'error' | 'ok'
  async function fetchTranscript(videoId) {
    try {
      // 1) 메인 월드에서 라이브 페이지 상태 직접 읽기
      let tracks = await fetchTracksFromMainWorld(videoId);
      let source = 'mainWorld';
      console.info('[SFC transcript] mainWorld tracks:', tracks.length);
      // 2) watch 페이지를 다시 fetch해 정적 HTML에서 파싱 (SPA 전환 직후라 아직 갱신 안 된 경우 등의 폴백)
      if (!tracks.length) {
        tracks = await fetchTracksFromWatchPage(videoId);
        source = 'watchPageFetch';
        console.info('[SFC transcript] watchPageFetch tracks:', tracks.length);
      }
      // 3) Innertube player 엔드포인트 — 요청 시점 기준으로 새로 서명된 baseUrl을 준다
      if (!tracks.length) {
        tracks = await fetchTracksViaInnertube(videoId);
        source = 'innertube';
        console.info('[SFC transcript] innertube tracks:', tracks.length);
      }

      const track = pickTranscriptTrack(tracks);
      let parsed = { text: '', segments: [] };
      let noTracksAtAll = !track || !track.baseUrl;

      if (!noTracksAtAll) {
        console.info('[SFC transcript] using track from', source, '—', track.baseUrl.slice(0, 120));
        parsed = await fetchTrackWithPot(track.baseUrl, videoId);

        // 트랙은 찾았는데 다운로드가 비어 있으면 서명이 이미 만료됐을 가능성이 있다 —
        // Innertube에서 방금 새로 발급받은 baseUrl로 한 번만 더 시도한다.
        if (!parsed.text && source !== 'innertube') {
          const freshTracks = await fetchTracksViaInnertube(videoId);
          const freshTrack = pickTranscriptTrack(freshTracks);
          if (freshTrack?.baseUrl) {
            console.info('[SFC transcript] retrying download with fresh innertube baseUrl');
            parsed = await fetchTrackWithPot(freshTrack.baseUrl, videoId);
          }
        }
      } else {
        console.info('[SFC transcript] no track found via any URL-based method');
      }

      // 4) 마지막 수단 — pot 토큰은 우리가 만든 어떤 URL에도 실을 수 없으니, 유튜브 자신의
      // 코드가 캡션을 요청하도록 유도하고 main-world-hook.js(document_start부터 영구적으로
      // 걸려있는 후킹)가 가로챈 실제 요청을 이벤트로 받는다. 트랙 자체를 못 찾은 경우(no_tracks)
      // 에도 시도할 가치가 있다 — 우리 추출 방식이 못 찾았을 뿐, 플레이어 자신은 캡션 데이터를
      // 갖고 있을 수 있기 때문이다. 신뢰도가 가장 낮은 경로다.
      if (!parsed.text) {
        console.info('[SFC transcript][capture] trying real-caption capture as last resort');
        const capturePromise = waitForCapturedCaption(videoId, 4500);
        try {
          const triggerRes = await sendMessage({ type: 'CAPTURE_REAL_CAPTION', videoId });
          if (triggerRes?.bgLog) console.info('[SFC transcript][bg]', triggerRes.bgLog);
          console.info('[SFC transcript][capture] trigger result:', triggerRes?.triggered, triggerRes?.method);
        } catch (err) {
          console.warn('[SFC transcript][capture] trigger message failed', err?.message || err);
        }
        const capturedText = await capturePromise;
        if (capturedText) {
          parsed = parseAnyTranscriptFormat(capturedText);
          console.info('[SFC transcript][capture] parsed length:', parsed.text.length);
        } else {
          console.info('[SFC transcript][capture] no event captured within timeout');
        }

        // 캡처를 기다리는 동안(4.5초) 재생이 진행되면서 pot이 뒤늦게 잡혔을 수 있다.
        // 이미 쓴 시간이라 추가 대기 없이 물어보기만 하면 되므로 공짜 재시도다.
        if (!parsed.text && track?.baseUrl) {
          const late = await requestPotToken(videoId, 0);
          if (late.pot && late.exact) {
            console.info('[SFC transcript][pot] pot arrived late — retrying caption download');
            parsed = await fetchOneTrackUrl(track.baseUrl, late.pot);
          }
        }
      }

      if (parsed.text) return { text: parsed.text, segments: parsed.segments, reason: 'ok' };
      return { text: null, segments: [], reason: noTracksAtAll ? 'no_tracks' : 'empty_track' };
    } catch (err) {
      console.error('[SFC transcript] unexpected error', videoId, err);
      return { text: null, segments: [], reason: 'error' };
    }
  }

  // ---------- 분석 파이프라인 ----------

  async function runAnalysis(videoId, token) {
    const keysStatus = await sendMessage({ type: 'GET_KEYS_STATUS' });
    if (token !== runToken) return;

    const missing = ['youtube', 'gemini'].filter((k) => !keysStatus[k]);
    if (missing.length) {
      const labelMap = { youtube: 'YouTube', gemini: 'Gemini' };
      setSectionBody('comments', missingKeyHtml(missing.map((k) => labelMap[k])));
      setSectionBody('videocheck', '<p class="sfc-note">API 키를 먼저 설정하세요.</p>');
      setSectionBody('factcheck', '<p class="sfc-note">API 키를 먼저 설정하세요.</p>');
      return;
    }

    const cached = await sendMessage({ type: 'GET_CACHE', videoId });
    if (token !== runToken) return;
    if (cached && cached.percentages) {
      renderCommentsSection(cached.percentages, cached.representative || null);
      renderVideoCheckSection(
        cached.videoFactchecks || [],
        cached.videoClaim || null,
        cached.transcriptReason || null,
        cached.claimSource || null,
        cached.videoCheckReason || null,
      );
      renderFactcheckSection(cached.factchecks || []);
      currentSourceComments = cached.sourceComments || [];
      if (cached.originalSearch) renderOriginalResult(cached.originalSearch);
      return;
    }

    // 댓글 수집과 영상 자막 처리는 서로 독립적이라 동시에 쏜다. 팩트체크 단계에
    // 도달할 때쯤(댓글 수집 + 분류가 끝난 뒤)이면 이 가벼운 호출은 이미 끝나 있을 것이다.
    // 자막은 이 페이지(content script) 자체에서 가져오고, Gemini 추출만 background에 맡긴다.
    const commentsPromise = sendMessage({ type: 'GET_COMMENTS', videoId });
    // 반박 댓글이 "09:02 시점에 언급된..."처럼 특정 구간을 지칭할 때 그 구간 자막을 함께
    // 판정에 넣어줄 수 있도록, FACTCHECK_COMMENTS를 부를 때 같이 넘길 수 있게 바깥 스코프에
    // 잡아둔다 — videoClaimPromise 체인 안에서 fetchTranscript의 결과를 소비하며 채워진다.
    let transcriptSegments = [];
    let transcriptText = null;
    const videoClaimPromise = fetchTranscript(videoId)
      .catch(() => ({ text: null, segments: [], reason: 'error' }))
      .then(({ text, segments, reason }) => {
        transcriptSegments = segments || [];
        transcriptText = text || null;
        return sendMessage({ type: 'GET_VIDEO_CLAIM', videoId, transcript: text, transcriptReason: reason }).catch(() => ({
          videoClaim: null,
          transcriptReason: reason,
        }));
      });

    // 영상 주장 검증은 댓글과 완전히 독립적이다 — 댓글이 꺼져 있거나 수집에 실패해도
    // 자막만 있으면 계속 진행한다. 그래서 아래 조기 반환 경로들에서도 이걸 먼저 렌더한다.
    const videoCheckPromise = videoClaimPromise.then((claimRes) => {
      if (!transcriptText) return { videoFactchecks: [], reason: 'no_transcript' };
      return sendMessage({
        type: 'FACTCHECK_VIDEO',
        transcript: transcriptText,
        videoClaim: claimRes.videoClaim || null,
      }).catch(() => ({ videoFactchecks: [], reason: 'error' }));
    });

    async function renderVideoCheckNow() {
      const claimRes = await videoClaimPromise;
      const vcRes = await videoCheckPromise;
      if (token === runToken) {
        renderVideoCheckSection(
          vcRes.videoFactchecks || [],
          claimRes.videoClaim || null,
          claimRes.transcriptReason || null,
          claimRes.claimSource || null,
          vcRes.reason,
        );
      }
      return { claimRes, vcRes };
    }

    const commentsRes = await commentsPromise;
    if (token !== runToken) return;

    if (commentsRes.error === 'comments_disabled') {
      setSectionBody('comments', '<p class="sfc-note">댓글이 꺼진 영상입니다.</p>');
      setSectionBody('factcheck', '<p class="sfc-note">댓글이 없어 반박 댓글 팩트체크는 진행할 수 없습니다. 영상 주장 검증과 원본 찾기는 계속 사용할 수 있습니다.</p>');
      await renderVideoCheckNow();
      return;
    }
    if (commentsRes.error === 'quota_exceeded') {
      setSectionBody('comments', '<p class="sfc-note">YouTube API 일일 한도를 초과했습니다. 캐시된 결과만 표시됩니다.</p>');
      setSectionBody('factcheck', '<p class="sfc-note">일일 한도 초과로 진행할 수 없습니다.</p>');
      await renderVideoCheckNow();
      return;
    }
    if (commentsRes.error) {
      // 'missing_key'나 예상 못 한 예외(예: API 키 제한 설정 문제)를 "댓글 0개"로 오인하지 않도록 별도 처리
      setSectionBody('comments', `<p class="sfc-note">댓글을 불러오지 못했습니다: ${escapeHtml(commentsRes.message || commentsRes.error)}</p>`);
      setSectionBody('factcheck', '<p class="sfc-note">댓글을 불러오지 못해 팩트체크를 진행할 수 없습니다.</p>');
      await renderVideoCheckNow();
      return;
    }

    const comments = commentsRes.comments || [];
    if (!comments.length) {
      setSectionBody('comments', '<p class="sfc-note">댓글이 없습니다.</p>');
      setSectionBody('factcheck', '<p class="sfc-note">댓글이 없어 반박 댓글 팩트체크는 진행할 수 없습니다.</p>');
      await renderVideoCheckNow();
      return;
    }

    const classifyRes = await sendMessage({ type: 'CLASSIFY_COMMENTS', comments });
    if (token !== runToken) return;
    if (classifyRes.error) {
      setSectionBody('comments', `<p class="sfc-note">댓글 분류에 실패했습니다: ${escapeHtml(classifyRes.message || classifyRes.error)}</p>`);
      setSectionBody('factcheck', '<p class="sfc-note">댓글 분류 실패로 팩트체크를 진행할 수 없습니다.</p>');
      await renderVideoCheckNow();
      return;
    }
    const representative = pickRepresentativeComments(classifyRes.classified);
    const isCurrent = () => token === runToken;
    if (isCurrent()) renderCommentsSection(classifyRes.percentages, representative);

    const rebuttalComments = classifyRes.classified.filter((c) => c.category === 'rebuttal');
    currentSourceComments = classifyRes.classified.filter((c) => c.category === 'source').map((c) => c.textOriginal);

    // 자막 캡처(최대 4.5초+)까지 포함하면 여기서 스크롤이 다음 영상으로 넘어가 있는 경우가 흔하다.
    // 댓글 수집+분류 비용은 이미 지불했으니, 여기서부터는 결과를 버리지 않고 끝까지 계산해서
    // 캐시에는 반드시 저장한다 — 화면 렌더링만 "지금 보고 있는 영상일 때"로 제한한다. 그래야
    // 나중에 이 영상으로 다시 스크롤해 돌아왔을 때 처음부터(느린 캡처 단계 포함) 다시 하지 않고
    // 캐시에서 바로 보여줄 수 있다.
    const videoClaimRes = await videoClaimPromise;
    if (videoClaimRes.bgLog) console.info('[SFC transcript][bg]', videoClaimRes.bgLog);
    const videoClaim = videoClaimRes.videoClaim || null;
    const transcriptReason = videoClaimRes.transcriptReason || null;
    const claimSource = videoClaimRes.claimSource || null;

    // 영상 주장 검증과 반박 댓글 팩트체크는 서로 독립적이라 동시에 돌린다 — 둘 다 웹서치가
    // 붙은 느린 호출이라 순차로 하면 대기 시간이 그대로 두 배가 된다.
    const [videoCheck, fcRes] = await Promise.all([
      videoCheckPromise,
      rebuttalComments.length
        ? sendMessage({ type: 'FACTCHECK_COMMENTS', comments: rebuttalComments, videoClaim, transcriptSegments })
        : Promise.resolve({ factchecks: [] }),
    ]);

    if (isCurrent()) {
      renderVideoCheckSection(
        videoCheck.videoFactchecks || [],
        videoClaim,
        transcriptReason,
        claimSource,
        videoCheck.reason,
      );
    }

    if (fcRes.error) {
      if (isCurrent()) {
        setSectionBody('factcheck', `<p class="sfc-note">팩트체크에 실패했습니다: ${escapeHtml(fcRes.message || fcRes.error)}</p>`);
      }
      return; // 실패는 캐시하지 않는다 — 다시 시도할 기회를 남겨둔다
    }
    const factchecks = fcRes.factchecks || [];
    if (isCurrent()) renderFactcheckSection(factchecks);

    await sendMessage({
      type: 'SET_CACHE',
      videoId,
      data: {
        percentages: classifyRes.percentages,
        distribution: classifyRes.distribution,
        representative,
        factchecks,
        videoFactchecks: videoCheck.videoFactchecks || [],
        videoCheckReason: videoCheck.reason || null,
        videoClaim,
        transcriptReason,
        claimSource,
        sourceComments: currentSourceComments,
      },
    });
  }

  // ---------- videoId 변경 감지 (SPA 라우팅) ----------

  function onVideoChange(videoId) {
    currentVideoId = videoId;
    currentSourceComments = [];
    runToken++;
    const token = runToken;

    if (!videoId) {
      removePanel();
      hideReopenButton();
      return;
    }

    // 꺼진 상태에서는 API 호출도 하지 않는다 — currentVideoId만 갱신해두고
    // 다시 켤 때(🔍 버튼) 그 시점의 영상을 분석한다.
    if (panelState === 'hidden') {
      showReopenButton();
      return;
    }

    startAnalysisFor(videoId, token);
  }

  function startAnalysisFor(videoId, token) {
    lastAnalyzedVideoId = videoId;
    ensurePanel();
    renderSkeleton();
    runAnalysis(videoId, token).catch((err) => {
      if (contextInvalidated) return;
      if (token === runToken) setSectionBody('comments', `<p class="sfc-note">오류: ${escapeHtml(err.message)}</p>`);
    });
  }

  function checkRoute() {
    if (contextInvalidated) return;
    if (!isExtensionContextValid()) {
      handleContextInvalidated();
      return;
    }
    const videoId = getVideoIdFromLocation();
    if (videoId === currentVideoId) return;
    onVideoChange(videoId);
  }

  (async function init() {
    await loadPanelState(); // 첫 렌더 전에 저장된 최소화/끄기 상태부터 읽어온다

    document.addEventListener('yt-navigate-finish', checkRoute);
    window.addEventListener('popstate', checkRoute);

    const titleEl = document.querySelector('title');
    if (titleEl) {
      new MutationObserver(checkRoute).observe(titleEl, { childList: true });
    }

    // 위 이벤트들을 놓치는 경우를 위한 최후의 폴백 (SPA 라우팅 감지 실패는 전체 기능을 무너뜨리므로 이중 삼중으로 방어한다)
    pollTimerId = setInterval(checkRoute, 1000);

    checkRoute();
  })();
})();
