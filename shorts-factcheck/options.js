const FIELD_IDS = ['youtubeApiKey', 'geminiApiKey', 'visionApiKey'];

async function load() {
  const stored = await chrome.storage.local.get(FIELD_IDS);
  for (const id of FIELD_IDS) {
    const el = document.getElementById(id);
    if (el && stored[id]) el.value = stored[id];
  }
}

async function save() {
  const data = {};
  for (const id of FIELD_IDS) {
    data[id] = document.getElementById(id).value.trim();
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
