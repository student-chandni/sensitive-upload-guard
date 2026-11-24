'use strict';

// e2e: real chrome + the app + a mock chat page (test/harness).
// Dialogs are answered through SUG_AUTO_DECISION_FILE since a script can't click them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { launchBrowser } = require('../src/main/browser/launcher');
const { CdpConnection } = require('../src/main/cdp/connection');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${!cond && extra ? `  -> ${extra}` : ''}`);
  if (!cond) failures++;
}

function startServer() {
  const received = [];
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/api/conversation')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    const file = path.join(__dirname, 'harness', req.url === '/' ? 'index.html' : path.basename(req.url.split('?')[0]));
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, received, url: `http://127.0.0.1:${srv.address().port}/` })));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sug-e2e-'));
  const decisionFile = path.join(tmp, 'decision');
  const setDecision = (d) => fs.writeFileSync(decisionFile, d);
  setDecision('deny');

  const { srv, received, url } = await startServer();
  const browser = await launchBrowser({ profileDir: path.join(tmp, 'chrome'), startUrls: ['about:blank'] });

  const dialogs = [];
  const electron = require('electron'); // path to the binary when required from Node
  const app = spawn(electron, [ROOT], {
    env: {
      ...process.env,
      SUG_TEST_HARNESS: url,
      SUG_ATTACH_PORT: String(browser.port),
      SUG_AUTO_DECISION_FILE: decisionFile,
      SUG_NO_WINDOW: '1',
      SUG_USER_DATA: path.join(tmp, 'userdata'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appOut = '';
  app.stdout.on('data', (d) => {
    appOut += d;
    for (const line of String(d).split('\n')) if (line.startsWith('[DIALOG]')) dialogs.push(line);
    if (process.env.VERBOSE) process.stdout.write(`    app| ${d}`);
  });
  app.stderr.on('data', (d) => {
    if (process.env.VERBOSE) process.stderr.write(`    app! ${d}`);
  });

  // wait for attach, then open the harness in a new tab
  for (let i = 0; i < 100 && !appOut.includes('connected to'); i++) await sleep(100);
  check('app attached to browser', appOut.includes('connected to'), appOut.slice(-400));

  const conn = await CdpConnection.connect(browser.wsUrl);
  const { targetId } = await conn.send('Target.createTarget', { url });
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => conn.send(m, p, sessionId);
  await sleep(1500);
  await S('Page.bringToFront');
  const evalMain = async (expr) => (await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  const events = () => evalMain('JSON.stringify(window.__events)').then(JSON.parse);
  const clearEvents = () => evalMain('window.__events.length = 0, true');
  const focus = (sel) => evalMain(`document.querySelector(${JSON.stringify(sel)}).focus(), true`);
  const setComposer = async (text) => {
    await evalMain(`(()=>{const c=document.querySelector('#composer'); c.value=''; c.focus(); return true})()`);
    await S('Input.insertText', { text });
  };
  const pressEnter = async () => {
    await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  };
  const clickEl = async (sel) => {
    const [x, y] = await evalMain(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  const resetState = async () => {
    await clearEvents();
    received.length = 0;
    dialogs.length = 0;
  };

  // prompts
  console.log('\nPrompts');
  await resetState();
  await setComposer('hello, nothing secret here');
  await pressEnter();
  await sleep(800);
  check('clean prompt is sent without a dialog', received.length === 1 && dialogs.length === 0, JSON.stringify({ received, dialogs }));

  await resetState();
  setDecision('deny');
  await setComposer('Q3 numbers WALLED_SENSITIVE please summarise');
  await pressEnter();
  await sleep(1200);
  check('marker prompt (Enter) shows a dialog', dialogs.length === 1 && /text prompt/.test(dialogs[0] || ''), JSON.stringify(dialogs));
  check('Cancel: prompt is not sent', received.length === 0, JSON.stringify(received));
  check('Cancel: text stays in the composer', (await evalMain(`document.querySelector('#composer').value`)).includes('WALLED_SENSITIVE'));

  await resetState();
  setDecision('allow');
  await focus('#composer');
  await pressEnter();
  await sleep(1500);
  check('marker prompt (Enter) + Continue: sent unchanged', received.length === 1 && received[0].includes('Q3 numbers WALLED_SENSITIVE please summarise'), JSON.stringify(received));
  check('Continue: exactly one dialog (network layer reuses the decision)', dialogs.length === 1, JSON.stringify(dialogs));

  await resetState();
  setDecision('deny');
  await setComposer('click path walled_sensitive lower-case');
  await clickEl('#send');
  await sleep(1200);
  check('marker prompt (Send button) + Cancel: dialog, not sent', dialogs.length === 1 && received.length === 0, JSON.stringify({ dialogs, received }));
  await resetState();
  setDecision('allow');
  await clickEl('#send');
  await sleep(1500);
  check('marker prompt (Send button) + Continue: sent', received.length === 1 && dialogs.length === 1, JSON.stringify({ dialogs, received }));

  await resetState();
  setDecision('deny');
  await setComposer('zero​width WALLED​_SENSITIVE trick');
  await pressEnter();
  await sleep(1200);
  check('marker hidden with a zero-width space is still caught', dialogs.length === 1 && received.length === 0, JSON.stringify({ dialogs, received }));

  await resetState();
  setDecision('deny');
  await clickEl('#programmatic');
  await sleep(1500);
  const ev = await events();
  check('network backstop catches a submission the DOM layer never saw', dialogs.length === 1 && received.length === 0 && ev.some((e) => e.type === 'send-failed'), JSON.stringify({ dialogs, received, ev }));

  // file input
  console.log('\nFiles (file picker)');
  const { root } = await S('DOM.getDocument', { depth: 0 });
  const { nodeId } = await S('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
  const pick = async (files) => {
    await evalMain(`document.querySelector('#file').value = '', true`);
    await S('DOM.setFileInputFiles', { nodeId, files: files.map((f) => path.join(FIX, f)) });
  };

  for (const [file, label] of [
    ['clean-notes.txt', 'clean text file'],
    ['clean-report.pdf', 'clean PDF'],
    ['clean-screenshot.png', 'clean image'],
  ]) {
    await resetState();
    await pick([file]);
    await sleep(2500);
    const e = await events();
    check(`${label}: reaches the page without a dialog`, dialogs.length === 0 && e.some((x) => x.type === 'file-change' && x.detail.includes(file)), JSON.stringify({ dialogs, e }));
  }

  for (const [file, label] of [
    ['sensitive-notes.txt', 'text file'],
    ['sensitive-report.pdf', 'PDF (text layer)'],
    ['sensitive-scanned.pdf', 'scanned PDF (OCR)'],
    ['sensitive-screenshot.png', 'PNG image (OCR)'],
    ['sensitive-photo.jpg', 'JPEG image (OCR)'],
  ]) {
    await resetState();
    setDecision('deny');
    await pick([file]);
    await sleep(4000);
    let e = await events();
    const inputEmpty = await evalMain(`document.querySelector('#file').files.length === 0`);
    check(`${label} + Cancel: dialog names the file, page never gets it`, dialogs.length === 1 && dialogs[0].includes(file) && !e.some((x) => x.type === 'file-change') && inputEmpty, JSON.stringify({ dialogs, e, inputEmpty }));

    await resetState();
    setDecision('allow');
    await pick([file]);
    await sleep(4000);
    e = await events();
    const order = e.filter((x) => x.type === 'file-input' || x.type === 'file-change').map((x) => x.type).join(',');
    check(`${label} + Continue: page gets the file (input, change)`, dialogs.length === 1 && order === 'file-input,file-change', JSON.stringify({ dialogs, e }));
  }

  await resetState();
  setDecision('deny');
  await pick(['clean-notes.txt', 'sensitive-data.csv']);
  await sleep(2500);
  check('multi-file upload: one dialog listing only the flagged file', dialogs.length === 1 && dialogs[0].includes('sensitive-data.csv') && dialogs[0].includes('1 other file'), JSON.stringify(dialogs));

  // drag and drop
  console.log('\nFiles (drag and drop, paste)');
  const [dx, dy] = await evalMain(`(()=>{const r=document.querySelector('#dropzone').getBoundingClientRect(); return [r.x+10, r.y+5]})()`);
  const drop = async (file) => {
    const data = { items: [], files: [path.join(FIX, file)], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await S('Input.dispatchDragEvent', { type, x: dx, y: dy, data });
  };
  await resetState();
  setDecision('deny');
  await drop('sensitive-report.pdf');
  await sleep(2500);
  let e = await events();
  check('drop sensitive PDF + Cancel: page never sees the drop', dialogs.length === 1 && !e.some((x) => x.type === 'drop'), JSON.stringify({ dialogs, e }));
  await resetState();
  setDecision('allow');
  await drop('sensitive-report.pdf');
  await sleep(2500);
  e = await events();
  check('drop sensitive PDF + Continue: page receives the file', dialogs.length === 1 && e.some((x) => x.type === 'drop' && x.detail.includes('sensitive-report.pdf')), JSON.stringify({ dialogs, e }));

  // paste is synthesised in the page, CDP can't paste files
  const paste = (name, content) =>
    evalMain(`(()=>{const dt=new DataTransfer(); dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, {type:'text/plain'}));
      document.querySelector('#pastezone').dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); return true})()`);
  await resetState();
  setDecision('deny');
  await paste('clip.txt', 'pasted WALLED_SENSITIVE content');
  await sleep(1500);
  e = await events();
  check('paste sensitive file + Cancel: blocked', dialogs.length === 1 && !e.some((x) => x.type === 'paste'), JSON.stringify({ dialogs, e }));
  await resetState();
  setDecision('allow');
  await paste('clip.txt', 'pasted WALLED_SENSITIVE content');
  await sleep(1500);
  e = await events();
  check('paste sensitive file + Continue: page receives it', dialogs.length === 1 && e.some((x) => x.type === 'paste' && x.detail.includes('clip.txt')), JSON.stringify({ dialogs, e }));

  // response colour
  console.log('\nResponse colour');
  const colors = await evalMain(`(()=>{const c=(s)=>getComputedStyle(document.querySelector(s)).color; return {answer:c('#answer'), bold:c('#answer b'), link:c('#answer a'), user:c('#question')}})()`);
  const green = 'rgb(15, 157, 88)';
  check('AI response text (and nested elements) recoloured', colors.answer === green && colors.bold === green && colors.link === green, JSON.stringify(colors));
  check('user messages are not recoloured', colors.user !== green, JSON.stringify(colors));

  conn.close();
  app.kill();
  await new Promise((r) => browser.child.once('exit', r) && browser.child.kill());
  srv.close();
  console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASSED'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
