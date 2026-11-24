'use strict';

// Live check against chatgpt/perplexity (logged out).
// node scripts/live-smoke.js [perplexity|chatgpt|all]   (PROFILE=dir to reuse a profile)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { launchBrowser } = require('../src/main/browser/launcher');
const { CdpConnection } = require('../src/main/cdp/connection');
const APP_SITES = require('../src/main/sites').SITES;

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures');
const which = process.argv[2] || 'all';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${!cond && extra ? `  -> ${String(extra).slice(0, 600)}` : ''}`);
  if (!cond) failures++;
};

const SITES = {
  perplexity: {
    url: 'https://www.perplexity.ai/',
    composer: '[contenteditable="true"]',
    send: 'button[aria-label="Submit"]',
    submitRe: /perplexity_ask/,
  },
  chatgpt: {
    url: 'https://chatgpt.com/',
    composer: '#prompt-textarea, textarea[name="prompt"], [contenteditable="true"]',
    send: '[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]',
    submitRe: /conversation/,
  },
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sug-live-'));
  const decisionFile = path.join(tmp, 'decision');
  const setDecision = (d) => fs.writeFileSync(decisionFile, d);
  setDecision('deny');
  const browser = await launchBrowser({ profileDir: process.env.PROFILE || path.join(tmp, 'chrome'), startUrls: ['about:blank'] });
  const dialogs = [];
  let appOut = '';
  const app = spawn(require('electron'), [ROOT], {
    env: { ...process.env, SUG_ATTACH_PORT: String(browser.port), SUG_AUTO_DECISION_FILE: decisionFile, SUG_NO_WINDOW: '1', SUG_USER_DATA: path.join(tmp, 'userdata'), SUG_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (d) => {
    appOut += d;
    for (const line of String(d).split('\n')) if (line.startsWith('[DIALOG]')) dialogs.push(line);
    if (process.env.VERBOSE) process.stdout.write(`    app| ${d}`);
  });
  for (let i = 0; i < 100 && !appOut.includes('connected to'); i++) await sleep(100);
  const conn = await CdpConnection.connect(browser.wsUrl);

  for (const [name, site] of Object.entries(SITES)) {
    if (which !== 'all' && which !== name) continue;
    console.log(`\n${name}`);
    const { targetId } = await conn.send('Target.createTarget', { url: site.url });
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => conn.send(m, p, sessionId);
    // requestWillBeSent fires before the guard can block a request, so pair it with
    // loadingFailed to tell submitted requests from blocked ones.
    const reqs = new Map();
    conn.on(`${sessionId}:Network.requestWillBeSent`, (p) => {
      if (p.request.method === 'POST' && site.submitRe.test(p.request.url)) reqs.set(p.requestId, { url: p.request.url, blocked: false });
    });
    conn.on(`${sessionId}:Network.loadingFailed`, (p) => {
      if (reqs.has(p.requestId) && /BLOCKED_BY_CLIENT/.test(p.errorText)) reqs.get(p.requestId).blocked = true;
    });
    const sent = {
      clear: () => reqs.clear(),
      submitted: () => [...reqs.values()].filter((r) => !r.blocked),
      blocked: () => [...reqs.values()].filter((r) => r.blocked),
      describe: () => JSON.stringify([...reqs.values()]),
    };
    const wsLeaks = [];
    conn.on(`${sessionId}:Network.webSocketFrameSent`, (p) => {
      if (/WALLED_SENSITIVE/i.test(p.response.payloadData || '')) wsLeaks.push(p.response.payloadData.slice(0, 120));
    });
    await S('Network.enable');
    await sleep(6000);
    await S('Page.bringToFront');
    const ev = async (expr) => (await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
    const type = async (text) => {
      await ev(`(()=>{const e=document.querySelector(${JSON.stringify(site.composer)}); e.focus(); document.execCommand('selectAll'); document.execCommand('delete'); if('value' in e && e.tagName==='TEXTAREA'){e.value=''} return true})()`);
      await S('Input.insertText', { text });
      await sleep(1200);
    };
    const click = async (sel) => {
      const pos = await ev(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(b=>b.getClientRects().length); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
      if (!pos) return false;
      for (const t of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type: t, x: pos[0], y: pos[1], button: 'left', clickCount: 1 });
      return true;
    };
    const composerText = () => ev(`(()=>{const e=document.querySelector(${JSON.stringify(site.composer)}); return e ? (e.value ?? e.innerText) : null})()`);

    // Cancel
    dialogs.length = 0;
    sent.clear();
    setDecision('deny');
    await type('Summarise this memo WALLED_SENSITIVE in one line');
    const clicked = await click(site.send);
    await sleep(2500);
    check('send button found', clicked);
    check('marker prompt -> dialog', dialogs.length === 1, dialogs.join('\n'));
    check('Cancel -> nothing submitted', sent.submitted().length === 0, sent.describe());
    check('Cancel -> stopped before any request (DOM layer)', sent.blocked().length === 0, sent.describe());
    check('Cancel -> text still in composer', String(await composerText()).includes('WALLED_SENSITIVE'));
    check('no WebSocket frame with the marker left the page while typing', wsLeaks.length === 0, wsLeaks.join(' | '));

    // Continue
    dialogs.length = 0;
    sent.clear();
    setDecision('allow');
    await click(site.send);
    await sleep(15000);
    check('Continue -> submitted', sent.submitted().length > 0, sent.describe());
    check('Continue -> one dialog only', dialogs.length === 1, dialogs.join('\n'));
    const answerSel = APP_SITES.find((x) => x.id === name).responseSelectors.join(', ');
    const color = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(answerSel)}); if(!e) return 'no answer element'; const t=e.querySelector('p,span,li')||e; return getComputedStyle(t).color})()`);
    check('AI response recoloured', color === 'rgb(15, 157, 88)', color);
    await S('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(tmp, `${name}.png`), Buffer.from(r.data, 'base64')));

    // File upload through the site's own <input type=file>, if the site allows it logged out.
    const { root } = await S('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = await S('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
    if (!nodeIds.length) {
      console.log('  SKIP  no file input on this page (sign-in needed?)');
      continue;
    }
    dialogs.length = 0;
    setDecision('deny');
    const target = nodeIds[nodeIds.length - 1];
    await S('DOM.setFileInputFiles', { nodeId: target, files: [path.join(FIX, 'sensitive-report.pdf')] });
    await sleep(3000);
    check('sensitive PDF via file input -> dialog', dialogs.length === 1 && dialogs[0].includes('sensitive-report.pdf'), dialogs.join('\n'));
    const chip = await ev(`document.body.innerText.includes('sensitive-report')`);
    check('Cancel -> site shows no attachment', !chip);
    console.log(`  screenshot: ${path.join(tmp, `${name}.png`)}`);
  }
  conn.close();
  app.kill();
  browser.child.kill();
  console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASSED'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
