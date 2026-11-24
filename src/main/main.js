'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { Settings } = require('./settings');
const { DecisionService } = require('./guard/decision-service');
const { Guard } = require('./guard/guard');
const { showConfirmDialog, buildDialogContent } = require('./ui/confirm-dialog');
const { SITES } = require('./sites');
const ocr = require('./inspect/ocr');

app.setName('Sensitive Upload Guard');
// has to be before requestSingleInstanceLock
if (process.env.SUG_USER_DATA) app.setPath('userData', process.env.SUG_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let settings;
let guard;
const activity = []; // for the panel
let auditStream = null;

function log(level, message) {
  if (level === 'debug' && !process.env.SUG_DEBUG) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  console.log(line);
  send('log', { level, message, time: Date.now() });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function recordEvent(evt) {
  activity.unshift(evt);
  activity.length = Math.min(activity.length, 200);
  // audit log: hashes only, never prompt text
  if (auditStream) auditStream.write(`${JSON.stringify(evt)}\n`);
  send('activity', evt);
  log('info', `decision: ${evt.kind} on ${evt.site} -> ${evt.decision} (${evt.via}${evt.layer ? `, ${evt.layer} layer` : ''}${evt.source ? `, ${evt.source}` : ''})`);
}

async function ask(req) {
  // e2e test hook: answer without showing the dialog
  let auto = process.env.SUG_AUTO_DECISION;
  if (process.env.SUG_AUTO_DECISION_FILE) {
    try {
      auto = fs.readFileSync(process.env.SUG_AUTO_DECISION_FILE, 'utf8').trim();
    } catch {
      auto = 'deny';
    }
  }
  if (auto === 'allow' || auto === 'deny') {
    const c = buildDialogContent(req);
    console.log(`[DIALOG] ${c.message} | ${c.detail.replace(/\n+/g, ' ⏎ ')} => auto-${auto}`);
    return auto;
  }
  log('info', `showing confirmation dialog (${req.kind} on ${req.siteName})`);
  return showConfirmDialog(req, { timeoutSec: settings.get('dialogTimeoutSec'), parent: win });
}

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 460,
    minHeight: 560,
    title: 'Sensitive Upload Guard',
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
  // dev only
  if (process.env.SUG_PANEL_SNAPSHOT) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => fs.writeFileSync(process.env.SUG_PANEL_SNAPSHOT, (await win.webContents.capturePage()).toPNG()), 2500),
    );
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function registerIpc() {
  ipcMain.handle('state', () => ({
    status: guard.status(),
    settings: settings.all(),
    activity,
    sites: SITES.map((s) => ({ id: s.id, name: s.name, url: s.startUrl })),
  }));
  ipcMain.handle('start', () => guard.start());
  ipcMain.handle('stop', () => guard.stop({ closeBrowser: true }));
  ipcMain.handle('open-site', (_e, id) => {
    const site = SITES.find((s) => s.id === id);
    if (site) return guard.openUrl(site.startUrl);
  });
  ipcMain.handle('update-settings', (_e, patch) => settings.update(patch));
  ipcMain.handle('open-folder', (_e, which) => {
    const dir = which === 'samples' ? path.join(__dirname, '..', '..', 'fixtures') : app.getPath('userData');
    return shell.openPath(dir);
  });
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
  auditStream = fs.createWriteStream(path.join(userData, 'logs', 'audit.jsonl'), { flags: 'a' });

  settings = new Settings(userData);
  const decisions = new DecisionService({ ask, getSettings: () => settings.all() });
  decisions.on('event', recordEvent);
  guard = new Guard({ decisions, settings, profileDir: process.env.SUG_PROFILE_DIR || path.join(userData, 'browser-profile'), log });
  guard.on('status', (s) => send('status', s));
  settings.on('change', (_k, all) => send('settings', all));

  registerIpc();
  if (!process.env.SUG_NO_WINDOW) createWindow();

  // load the OCR model early
  if (settings.get('ocrEnabled')) ocr.warmUp();

  const attachPort = Number(process.env.SUG_ATTACH_PORT) || undefined;
  if (process.env.SUG_AUTOSTART !== '0') guard.start({ attachPort });

  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('second-instance', () => {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  try {
    // don't leave an unguarded browser window behind
    await guard?.stop({ closeBrowser: settings?.get('closeBrowserOnQuit') !== false });
    await ocr.shutdown();
  } finally {
    auditStream?.end();
    app.exit(0);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.quit());

app.on('window-all-closed', () => {
  // closing the panel quits
  app.quit();
});
