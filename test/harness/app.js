// fake chat app for e2e, logs what it gets to window.__events
window.__events = [];
const rec = (type, detail) => window.__events.push({ type, detail });

async function sendPrompt(text) {
  try {
    const res = await fetch('/api/conversation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ content: { parts: [text] } }] }) });
    rec('sent', { text, status: res.status });
    document.getElementById('composer').value = '';
  } catch (e) {
    rec('send-failed', { text, error: String(e) });
  }
}

const composer = document.getElementById('composer');
composer.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    rec('enter', composer.value);
    sendPrompt(composer.value);
  }
});
document.getElementById('send').addEventListener('click', () => {
  rec('click', composer.value);
  sendPrompt(composer.value);
});
document.getElementById('programmatic').addEventListener('click', () => sendPrompt('sent without the composer: WALLED_SENSITIVE'));

document.getElementById('file').addEventListener('change', (e) => rec('file-change', [...e.target.files].map((f) => f.name)));
document.getElementById('file').addEventListener('input', (e) => rec('file-input', [...e.target.files].map((f) => f.name)));
const dz = document.getElementById('dropzone');
dz.addEventListener('dragover', (e) => e.preventDefault());
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  rec('drop', [...e.dataTransfer.files].map((f) => f.name));
});
dz.addEventListener('dragleave', () => rec('dragleave', null));
document.getElementById('pastezone').addEventListener('paste', (e) => rec('paste', [...e.clipboardData.files].map((f) => f.name)));
