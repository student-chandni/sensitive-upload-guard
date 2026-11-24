'use strict';

const $ = (id) => document.getElementById(id);
const api = window.guard;

function renderStatus(s) {
  $('status-dot').className = `dot ${s.state}`;
  const titles = { running: 'Protection active', starting: 'Starting browser…', stopped: 'Browser not running', error: 'Could not start browser' };
  $('status-title').textContent = titles[s.state] || s.state;
  $('status-detail').textContent =
    s.state === 'running'
      ? `${s.product || 'Browser'} · ${s.tabs} tab${s.tabs === 1 ? '' : 's'}, ${s.guardedTabs} on ChatGPT/Perplexity`
      : s.state === 'error'
        ? s.error || ''
        : 'Prompts and uploads are only guarded in the protected browser window.';
  $('btn-start').classList.toggle('hidden', s.state === 'running' || s.state === 'starting');
  $('btn-stop').classList.toggle('hidden', s.state !== 'running');
  document.querySelectorAll('#site-buttons button').forEach((b) => (b.disabled = s.state === 'starting'));
}

function renderSettings(st) {
  $('opt-prompts').checked = st.inspectPrompts;
  $('opt-files').checked = st.inspectFiles;
  $('opt-ocr').checked = st.ocrEnabled;
  $('opt-color').value = st.responseColor;
  $('color-value').textContent = st.responseColor;
  $('marker-label').textContent = st.marker;
}

function describe(evt) {
  const t = new Date(evt.time).toLocaleTimeString();
  if (evt.kind === 'prompt') {
    const how = evt.via === 'remembered' ? 'same decision reused' : `${evt.layer === 'dom' ? 'caught in the page' : 'caught on the network'}`;
    return { title: `Prompt on ${evt.site}`, meta: `${t} · ${evt.length} chars · ${how}` };
  }
  const names = (evt.files || []).map((f) => `${f.name} (${f.status}${f.location ? `: ${f.location}` : ''})`).join(', ');
  return { title: `Upload to ${evt.site} via ${evt.source}`, meta: `${t} · ${names}${evt.via === 'clean' ? ' · no marker, passed through' : ''}` };
}

function addActivity(evt, prepend = true) {
  const list = $('activity');
  list.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  const { title, meta } = describe(evt);
  const badge = document.createElement('span');
  badge.className = `badge ${evt.decision}`;
  badge.textContent = evt.decision === 'allow' ? (evt.via === 'clean' ? 'CLEAN' : 'CONTINUED') : evt.via === 'timeout' ? 'TIMED OUT' : 'BLOCKED';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const m = document.createElement('div');
  m.className = 'meta';
  m.textContent = meta;
  li.append(badge, strong, m);
  if (prepend) list.prepend(li);
  else list.append(li);
}

async function init() {
  const state = await api.state();
  renderStatus(state.status);
  renderSettings(state.settings);
  for (const site of state.sites) {
    const b = document.createElement('button');
    b.textContent = `Open ${site.name}`;
    b.onclick = () => api.openSite(site.id);
    $('site-buttons').append(b);
  }
  state.activity.forEach((e) => addActivity(e, false));

  api.on('status', renderStatus);
  api.on('settings', renderSettings);
  api.on('activity', (e) => addActivity(e));

  $('btn-start').onclick = () => api.start();
  $('btn-stop').onclick = () => api.stop();
  $('btn-samples').onclick = () => api.openFolder('samples');
  $('btn-logs').onclick = () => api.openFolder('logs');
  $('opt-prompts').onchange = (e) => api.updateSettings({ inspectPrompts: e.target.checked });
  $('opt-files').onchange = (e) => api.updateSettings({ inspectFiles: e.target.checked });
  $('opt-ocr').onchange = (e) => api.updateSettings({ ocrEnabled: e.target.checked });
  $('opt-color').oninput = (e) => {
    $('color-value').textContent = e.target.value;
    api.updateSettings({ responseColor: e.target.value });
  };
}

init();
