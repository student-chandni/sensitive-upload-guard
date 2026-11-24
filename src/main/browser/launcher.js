'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

// Chrome 136+ refuses remote debugging on the default profile, so we use our own.

function candidates() {
  const env = process.env;
  if (process.platform === 'darwin') {
    const apps = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Google Chrome Canary'];
    const roots = ['/Applications', path.join(env.HOME || '', 'Applications')];
    return roots.flatMap((r) => apps.map((a) => path.join(r, `${a}.app`, 'Contents', 'MacOS', a)));
  }
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const rel = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
    ];
    return roots.flatMap((r) => rel.map((p) => path.join(r, ...p)));
  }
  const names = ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'brave-browser', 'chromium', 'chromium-browser'];
  const dirs = (env.PATH || '/usr/bin:/usr/local/bin').split(':').concat(['/snap/bin', '/usr/bin', '/opt/google/chrome']);
  return dirs.flatMap((d) => names.map((n) => path.join(d, n)));
}

function findBrowser(preferred) {
  if (preferred && fs.existsSync(preferred)) return preferred;
  return candidates().find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForDebugger(port, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`Browser exited during startup (code ${child.exitCode}). Is it already running with this profile?`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Browser did not open its DevTools endpoint in time (${lastErr?.message || 'timeout'})`);
}

async function launchBrowser({ profileDir, executable, startUrls = [] }) {
  const exe = findBrowser(executable);
  if (!exe) throw new Error('No Chromium-based browser found. Install Google Chrome, or set the browser path in settings.');
  fs.mkdirSync(profileDir, { recursive: true });
  // leftover from a crash
  try {
    fs.unlinkSync(path.join(profileDir, 'DevToolsActivePort'));
  } catch {
    /* none */
  }
  const port = await freePort();
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...startUrls,
  ];
  const child = spawn(exe, args, { stdio: 'ignore', detached: false });
  child.on('error', () => {});
  const version = await waitForDebugger(port, child);
  return { child, port, wsUrl: version.webSocketDebuggerUrl, executable: exe, profileDir, product: version.Browser };
}

async function attachToBrowser(port) {
  const version = await waitForDebugger(port, null, 3000);
  return { child: null, port, wsUrl: version.webSocketDebuggerUrl, product: version.Browser };
}

module.exports = { launchBrowser, attachToBrowser, findBrowser };
