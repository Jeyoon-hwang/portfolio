// 쇼츠 페이지 감지, 패널 주입, 파이프라인 오케스트레이션, 프레임 캡처를 담당한다.
// 유튜브는 SPA라 스크롤로 쇼츠가 바뀌어도 페이지가 리로드되지 않는다.
// 그래서 여러 신호(yt-navigate-finish, popstate, title 변화, 폴링)를 겹쳐서 videoId 변경을 놓치지 않게 한다.
(function () {
  'use strict';

  const PANEL_ID = 'sfc-panel';
  let panelEl = null;
  let currentVideoId = null;
  let currentSourceComments = [];
  let runToken = 0; // 빠른 스크롤 중 이전 분석 결과가 늦게 도착해 덮어쓰는 것을 방지
  let pollTimerId = null;
  let contextInvalidated = false;

  function getVideoIdFromLocation() {
    const m = location.pathname.match(/^\/shorts\/([^/?#]+)/);
    return m ? m[1] : null;
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
    document.documentElement.appendChild(panelEl);
    panelEl.addEventListener('click', onPanelClick);
    return panelEl;
  }

  function removePanel() {
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
  }

  function renderSkeleton() {
    panelEl.innerHTML = `
      <div class="sfc-section" data-section="comments">
        <div class="sfc-section-header"><span>댓글 여론</span><button class="sfc-toggle" type="button">▾</button></div>
        <div class="sfc-section-body"><div class="sfc-skeleton"></div></div>
      </div>
      <div class="sfc-section" data-section="factcheck">
        <div class="sfc-section-header"><span>팩트체크</span><button class="sfc-toggle" type="button">▾</button></div>
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

  function renderCommentsSection(percentages) {
    const gradient = buildConicGradient(percentages);
    const legend = CATEGORY_ORDER.map(
      (key) =>
        `<span class="sfc-legend-item"><i style="background:${CATEGORY_COLORS[key]}"></i>${CATEGORY_LABELS[key]} ${percentages[key] || 0}%</span>`,
    ).join('');
    setSectionBody(
      'comments',
      `<div class="sfc-donut" style="background: conic-gradient(${gradient});"></div><div class="sfc-legend">${legend}</div>`,
    );
  }

  const VERDICT_ICON = { 사실: '✅', 거짓: '❌', 불충분: '⚠️', '부분적 사실': '🔶' };

  function renderFactcheckSection(factchecks) {
    if (!factchecks || !factchecks.length) {
      setSectionBody('factcheck', '<p class="sfc-note">반박 댓글에서 검증 가능한 주장을 찾지 못했습니다.</p>');
      return;
    }
    const html = factchecks
      .map((fc) => {
        const sources = (fc.sources || [])
          .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a>`)
          .join(' · ');
        return `
          <div class="sfc-factcheck-item">
            <div class="sfc-fc-verdict">${VERDICT_ICON[fc.verdict] || '⚠️'} "${escapeHtml(fc.claim)}"</div>
            <div class="sfc-fc-reason">${escapeHtml(fc.reason || '')}</div>
            ${sources ? `<div class="sfc-fc-sources">${sources}</div>` : ''}
          </div>
        `;
      })
      .join('');
    setSectionBody('factcheck', html);
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
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.domain)}</a>
            ${item.uploadDate ? `<span class="sfc-original-date">${escapeHtml(new Date(item.uploadDate).toLocaleDateString('ko-KR'))}</span>` : ''}
            ${item.isOriginalGuess ? '<span class="sfc-original-badge">원본 추정</span>' : ''}
          </div>
        `,
      )
      .join('');
  }

  // ---------- 원본 찾기 (버튼 트리거 전용) ----------

  function getActiveVideoEl() {
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

  // 현재 시점 + 앞뒤로 살짝 떨어진 지점, 총 최대 3장. 1장만 캡처하면 흐린 프레임에 검색이 통째로 실패할 수 있다.
  async function captureFrames(video) {
    const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
    const originalTime = video.currentTime;
    const wasPaused = video.paused;

    const targets = [...new Set([0, -1, 1].map((off) => originalTime + off).filter((t) => t >= 0 && t <= duration))];

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

  // ---------- 분석 파이프라인 ----------

  async function runAnalysis(videoId, token) {
    const keysStatus = await sendMessage({ type: 'GET_KEYS_STATUS' });
    if (token !== runToken) return;

    const missing = ['youtube', 'gemini'].filter((k) => !keysStatus[k]);
    if (missing.length) {
      const labelMap = { youtube: 'YouTube', gemini: 'Gemini' };
      setSectionBody('comments', missingKeyHtml(missing.map((k) => labelMap[k])));
      setSectionBody('factcheck', '<p class="sfc-note">API 키를 먼저 설정하세요.</p>');
      return;
    }

    const cached = await sendMessage({ type: 'GET_CACHE', videoId });
    if (token !== runToken) return;
    if (cached && cached.percentages) {
      renderCommentsSection(cached.percentages);
      renderFactcheckSection(cached.factchecks || []);
      currentSourceComments = cached.sourceComments || [];
      if (cached.originalSearch) renderOriginalResult(cached.originalSearch);
      return;
    }

    const commentsRes = await sendMessage({ type: 'GET_COMMENTS', videoId });
    if (token !== runToken) return;

    if (commentsRes.error === 'comments_disabled') {
      setSectionBody('comments', '<p class="sfc-note">댓글이 꺼진 영상입니다.</p>');
      setSectionBody('factcheck', '<p class="sfc-note">댓글이 없어 팩트체크를 진행할 수 없습니다. 원본 찾기는 계속 사용할 수 있습니다.</p>');
      return;
    }
    if (commentsRes.error === 'quota_exceeded') {
      setSectionBody('comments', '<p class="sfc-note">YouTube API 일일 한도를 초과했습니다. 캐시된 결과만 표시됩니다.</p>');
      setSectionBody('factcheck', '<p class="sfc-note">일일 한도 초과로 진행할 수 없습니다.</p>');
      return;
    }
    if (commentsRes.error) {
      // 'missing_key'나 예상 못 한 예외(예: API 키 제한 설정 문제)를 "댓글 0개"로 오인하지 않도록 별도 처리
      setSectionBody('comments', `<p class="sfc-note">댓글을 불러오지 못했습니다: ${escapeHtml(commentsRes.message || commentsRes.error)}</p>`);
      setSectionBody('factcheck', '<p class="sfc-note">댓글을 불러오지 못해 팩트체크를 진행할 수 없습니다.</p>');
      return;
    }

    const comments = commentsRes.comments || [];
    if (!comments.length) {
      setSectionBody('comments', '<p class="sfc-note">댓글이 없습니다.</p>');
      setSectionBody('factcheck', '<p class="sfc-note">댓글이 없어 팩트체크를 진행할 수 없습니다.</p>');
      return;
    }

    const classifyRes = await sendMessage({ type: 'CLASSIFY_COMMENTS', comments });
    if (token !== runToken) return;
    if (classifyRes.error) {
      setSectionBody('comments', `<p class="sfc-note">댓글 분류에 실패했습니다: ${escapeHtml(classifyRes.message || classifyRes.error)}</p>`);
      setSectionBody('factcheck', '<p class="sfc-note">댓글 분류 실패로 팩트체크를 진행할 수 없습니다.</p>');
      return;
    }
    renderCommentsSection(classifyRes.percentages);

    const rebuttalComments = classifyRes.classified.filter((c) => c.category === 'rebuttal');
    currentSourceComments = classifyRes.classified.filter((c) => c.category === 'source').map((c) => c.textOriginal);

    let factchecks = [];
    if (rebuttalComments.length) {
      const fcRes = await sendMessage({ type: 'FACTCHECK_COMMENTS', comments: rebuttalComments });
      if (token !== runToken) return;
      if (fcRes.error) {
        setSectionBody('factcheck', `<p class="sfc-note">팩트체크에 실패했습니다: ${escapeHtml(fcRes.message || fcRes.error)}</p>`);
        return;
      }
      factchecks = fcRes.factchecks || [];
    }
    renderFactcheckSection(factchecks);

    await sendMessage({
      type: 'SET_CACHE',
      videoId,
      data: {
        percentages: classifyRes.percentages,
        distribution: classifyRes.distribution,
        factchecks,
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
      return;
    }

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
