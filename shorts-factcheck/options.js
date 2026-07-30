const FIELD_IDS = ['youtubeApiKey', 'geminiApiKey', 'visionApiKey'];
const PANEL_STATE_KEY = 'sfcPanelState'; // content.js와 동일한 키를 공유한다

async function load() {
  const stored = await chrome.storage.local.get([...FIELD_IDS, PANEL_STATE_KEY]);
  for (const id of FIELD_IDS) {
    const el = document.getElementById(id);
    if (el && stored[id]) el.value = stored[id];
  }
  const panelEnabledEl = document.getElementById('panelEnabled');
  if (panelEnabledEl) panelEnabledEl.checked = stored[PANEL_STATE_KEY] !== 'hidden';
}

async function save() {
  const data = {};
  for (const id of FIELD_IDS) {
    data[id] = document.getElementById(id).value.trim();
  }
  const panelEnabledEl = document.getElementById('panelEnabled');
  if (panelEnabledEl) {
    data[PANEL_STATE_KEY] = panelEnabledEl.checked ? 'expanded' : 'hidden';
  }
  await chrome.storage.local.set(data);

  const status = document.getElementById('status');
  status.textContent = '저장되었습니다.';
  setTimeout(() => {
    status.textContent = '';
  }, 2000);
}

document.getElementById('save').addEventListener('click', save);
load();
