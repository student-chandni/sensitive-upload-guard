'use strict';

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

function clean(text, max) {
  let s = String(text ?? '').replace(CONTROL_RE, '').replace(/\r\n?/g, '\n');
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// separate from electron so it can be unit tested
function buildDialogContent(req) {
  const site = req.siteName || 'the web app';
  if (req.kind === 'prompt') {
    return {
      title: 'Sensitive Upload Guard',
      message: `Sensitive content detected in a text prompt`,
      detail:
        `You are about to send a prompt to ${site} that contains the marker "${req.marker}".\n\n` +
        `Prompt:\n"${clean(req.prompt, 600)}"\n\n` +
        `Continue to send it unchanged, or Cancel to stop it so you can edit it.`,
    };
  }
  const files = req.files || [];
  const flagged = files.filter((f) => f.status !== 'clean');
  const lines = flagged.map((f) => {
    const why = f.status === 'error' ? `could not be inspected: ${f.error}` : `marker found in ${f.location}`;
    return `• ${clean(f.name || 'unnamed file', 120)} (${formatSize(f.size)}): ${why}`;
  });
  const allErrors = flagged.length && flagged.every((f) => f.status === 'error');
  const others = files.length - flagged.length;
  return {
    title: 'Sensitive Upload Guard',
    message: allErrors
      ? `A file could not be inspected for sensitive content`
      : `Sensitive content detected in ${flagged.length === 1 ? 'a file' : `${flagged.length} files`}`,
    detail:
      `You are about to upload to ${site}${req.source ? ` (${req.source})` : ''}:\n\n${lines.join('\n')}` +
      (others ? `\n\n${others} other file${others === 1 ? '' : 's'} in this upload ${others === 1 ? 'is' : 'are'} clean.` : '') +
      `\n\nContinue to upload ${files.length === 1 ? 'the file' : 'all files'} unchanged, or Cancel to stop the upload.`,
  };
}

// resolves 'allow' | 'deny' | 'timeout'
async function showConfirmDialog(req, { timeoutSec = 120, parent = null } = {}) {
  const { app, dialog } = require('electron');
  const content = buildDialogContent(req);
  const controller = new AbortController();
  const timer = timeoutSec > 0 ? setTimeout(() => controller.abort(), timeoutSec * 1000) : null;

  // otherwise it can open behind chrome
  if (process.platform === 'darwin') app.focus({ steal: true });
  else app.focus();
  const hasParent = parent && !parent.isDestroyed();
  if (hasParent) {
    if (parent.isMinimized()) parent.restore();
    parent.show();
    parent.focus();
  }

  const options = {
    type: 'warning',
    title: content.title,
    message: content.message,
    detail: content.detail,
    buttons: ['Cancel', 'Continue'],
    defaultId: 0, // enter = cancel
    cancelId: 0, // esc = cancel
    noLink: true,
    normalizeAccessKeys: true,
    signal: controller.signal,
  };
  try {
    // with a parent macOS shows a sheet, which is async so the timeout can close it.
    // a parentless alert blocks and can't be cancelled.
    const { response } = hasParent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return controller.signal.aborted ? 'timeout' : response === 1 ? 'allow' : 'deny';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { showConfirmDialog, buildDialogContent };
