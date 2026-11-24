'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { findMarkerInText, findMarkerInOcrText, findMarkerInBytes } = require('../src/main/inspect/marker');
const { detectFileKind } = require('../src/main/inspect/file-type');
const { decodeRequestBody, findMarkerInBody } = require('../src/main/inspect/body-decoder');
const { inspectFile } = require('../src/main/inspect');
const ocr = require('../src/main/inspect/ocr');
const { DecisionService } = require('../src/main/guard/decision-service');
const { buildDialogContent } = require('../src/main/ui/confirm-dialog');
const { siteForUrl, siteForSubmitUrl } = require('../src/main/sites');

const FIX = path.join(__dirname, '..', 'fixtures');
const M = 'WALLED_SENSITIVE';

test.after(() => ocr.shutdown());

test('marker: exact, case-insensitive and normalised matching', () => {
  assert.equal(findMarkerInText('plain text', M).found, false);
  assert.equal(findMarkerInText('see WALLED_SENSITIVE here', M).found, true);
  assert.equal(findMarkerInText('walled_sensitive', M).found, true);
  assert.equal(findMarkerInText('WALLED​_SENSI⁠TIVE', M).found, true, 'zero-width characters are ignored');
  assert.equal(findMarkerInText('ＷＡＬＬＥＤ＿ＳＥＮＳＩＴＩＶＥ', M).found, true, 'full-width letters are normalised');
  assert.equal(findMarkerInText('WALLED SENSITIVE', M).found, false, 'typed text must contain the real marker');
  assert.equal(findMarkerInText('', M).found, false);
});

test('marker: OCR matching tolerates typical OCR noise but not unrelated words', () => {
  assert.equal(findMarkerInOcrText('Label: WALLED SENSITIVE', M).found, true);
  assert.equal(findMarkerInOcrText('WALLED_SENS1TIVE', M).found, true);
  assert.equal(findMarkerInOcrText('WA1LED-SENS1TIVE', M).found, true);
  assert.equal(findMarkerInOcrText('WALLED SENSITlVE', M).found, true, 'one misread letter');
  assert.equal(findMarkerInOcrText('WALLET SENSITIVITY report', M).found, false);
  assert.equal(findMarkerInOcrText('A sensitive wall', M).found, false);
});

test('marker: raw byte search covers UTF-8 and UTF-16', () => {
  assert.equal(findMarkerInBytes(Buffer.from('xx WALLED_SENSITIVE xx'), M), true);
  assert.equal(findMarkerInBytes(Buffer.from('WALLED_SENSITIVE', 'utf16le'), M), true);
  assert.equal(findMarkerInBytes(Buffer.from('nothing'), M), false);
});

test('file type: detected from magic bytes before name or MIME type', () => {
  const png = fs.readFileSync(path.join(FIX, 'sensitive-screenshot.png'));
  assert.equal(detectFileKind({ buffer: png, name: 'renamed.txt', mimeType: 'text/plain' }), 'image');
  const pdf = fs.readFileSync(path.join(FIX, 'sensitive-report.pdf'));
  assert.equal(detectFileKind({ buffer: pdf, name: 'x.bin' }), 'pdf');
  assert.equal(detectFileKind({ buffer: Buffer.from('hello'), name: 'a.md' }), 'text');
  assert.equal(detectFileKind({ buffer: Buffer.from([0x50, 0x4b, 3, 4, 0x14, 0, 0, 0, 8, 0, 0x21, 0x9c]), name: 'a.zip' }), 'unsupported');
  assert.equal(detectFileKind({ buffer: Buffer.from('plain UTF-16 text', 'utf16le'), name: 'noext' }), 'text');
});

test('inspection: every fixture gets the expected verdict', async () => {
  const expected = {
    'clean-notes.txt': 'clean',
    'clean-report.pdf': 'clean',
    'clean-screenshot.png': 'clean',
    'clean-archive.bin': 'clean',
    'sensitive-notes.txt': 'sensitive',
    'sensitive-utf16.txt': 'sensitive',
    'sensitive-data.csv': 'sensitive',
    'sensitive-report.pdf': 'sensitive',
    'sensitive-scanned.pdf': 'sensitive',
    'sensitive-screenshot.png': 'sensitive',
    'sensitive-darkmode.png': 'sensitive',
    'sensitive-photo.jpg': 'sensitive',
  };
  for (const [name, status] of Object.entries(expected)) {
    const r = await inspectFile({ buffer: fs.readFileSync(path.join(FIX, name)), name }, { marker: M });
    assert.equal(r.status, status, `${name}: got ${r.status} (${r.location || r.error || ''})`);
  }
});

test('inspection: scanned PDF is found by OCR, text PDF by its text layer', async () => {
  const scanned = await inspectFile({ buffer: fs.readFileSync(path.join(FIX, 'sensitive-scanned.pdf')), name: 'a.pdf' }, { marker: M });
  assert.match(scanned.location, /OCR/);
  const text = await inspectFile({ buffer: fs.readFileSync(path.join(FIX, 'sensitive-report.pdf')), name: 'b.pdf' }, { marker: M });
  assert.equal(text.location, 'page 2 text');
});

test('inspection: a corrupt PDF is reported as an error, not as clean', async () => {
  const r = await inspectFile({ buffer: Buffer.from('%PDF-1.7\nthis is not really a pdf'), name: 'broken.pdf' }, { marker: M });
  assert.equal(r.status, 'error');
});

test('inspection: OCR can be switched off', async () => {
  const r = await inspectFile({ buffer: fs.readFileSync(path.join(FIX, 'sensitive-screenshot.png')), name: 'a.png' }, { marker: M, ocrEnabled: false });
  assert.equal(r.status, 'clean');
});

test('body decoder: JSON, nested JSON, form-encoded and multipart bodies', () => {
  const json = { postData: JSON.stringify({ messages: [{ content: { parts: ['hi WALLED_SENSITIVE'] } }] }) };
  assert.equal(findMarkerInBody(json, M).text, 'hi WALLED_SENSITIVE');

  const nested = { postData: JSON.stringify({ params: JSON.stringify({ query_str: 'q WALLED_SENSITIVE' }) }) };
  assert.equal(findMarkerInBody(nested, M).found, true);

  const form = { postData: 'conversationState=%7B%7D&prompt=hello+WALLED_SENSITIVE+there', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
  assert.equal(findMarkerInBody(form, M).text, 'hello WALLED_SENSITIVE there');

  const mp = {
    postData: '--b1\r\nContent-Disposition: form-data; name="q"\r\n\r\nsecret WALLED_SENSITIVE\r\n--b1--\r\n',
    headers: { 'content-type': 'multipart/form-data; boundary=b1' },
  };
  assert.equal(findMarkerInBody(mp, M).found, true);

  const entries = { postDataEntries: [{ bytes: Buffer.from('{"a":"WALLED_').toString('base64') }, { bytes: Buffer.from('SENSITIVE"}').toString('base64') }] };
  assert.equal(findMarkerInBody(entries, M).found, true, 'chunked postDataEntries are joined');

  const escaped = { postData: '{"q":"\\u0057ALLED_SENSITIVE"}' };
  assert.equal(findMarkerInBody(escaped, M).found, true, 'unicode-escaped JSON');

  assert.equal(findMarkerInBody({ postData: '{"q":"clean"}' }, M).found, false);
  assert.deepEqual(decodeRequestBody({}).strings, ['']);
});

test('sites: URL matching for pages and submission endpoints', () => {
  assert.equal(siteForUrl('https://chatgpt.com/c/123').id, 'chatgpt');
  assert.equal(siteForUrl('https://www.perplexity.ai/search/x').id, 'perplexity');
  assert.equal(siteForUrl('https://example.com/'), null);
  assert.equal(siteForSubmitUrl('https://chatgpt.com/backend-api/f/conversation').id, 'chatgpt');
  assert.equal(siteForSubmitUrl('https://chatgpt.com/unauth-mweb/conversation/updates?x=1').id, 'chatgpt');
  assert.equal(siteForSubmitUrl('https://www.perplexity.ai/rest/sse/perplexity_ask').id, 'perplexity');
  assert.equal(siteForSubmitUrl('https://chatgpt.com/backend-api/me'), null);
});

function makeService(answers) {
  const asked = [];
  const svc = new DecisionService({
    ask: async (req) => {
      asked.push(req);
      return answers.shift() || 'deny';
    },
    getSettings: () => ({ marker: M, onInspectionError: 'ask' }),
  });
  return { svc, asked };
}
const site = { name: 'ChatGPT' };

test('decisions: DOM layer always asks; network layer reuses a recent Continue', async () => {
  const { svc, asked } = makeService(['allow', 'allow']);
  assert.equal(await svc.decidePrompt({ site, text: 'hello WALLED_SENSITIVE', layer: 'dom' }), 'allow');
  // The same prompt arriving at the network layer (inside a JSON body) does not ask again.
  assert.equal(await svc.decidePrompt({ site, text: '{"x":"hello WALLED_SENSITIVE"}', layer: 'network', candidates: ['hello  WALLED_SENSITIVE'] }), 'allow');
  assert.equal(asked.length, 1);
  // A new submission through the UI asks again.
  assert.equal(await svc.decidePrompt({ site, text: 'hello WALLED_SENSITIVE', layer: 'dom' }), 'allow');
  assert.equal(asked.length, 2);
});

test('decisions: duplicate in-flight network requests share one dialog', async () => {
  const { svc, asked } = makeService(['deny']);
  const [a, b] = await Promise.all([
    svc.decidePrompt({ site, text: 'q WALLED_SENSITIVE', layer: 'network', candidates: ['q WALLED_SENSITIVE'] }),
    svc.decidePrompt({ site, text: 'q WALLED_SENSITIVE', layer: 'network', candidates: ['q WALLED_SENSITIVE'] }),
  ]);
  assert.deepEqual([a, b], ['deny', 'deny']);
  assert.equal(asked.length, 1);
});

test('decisions: dialogs are shown one at a time', async () => {
  let open = 0;
  let maxOpen = 0;
  const svc = new DecisionService({
    ask: async () => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((r) => setTimeout(r, 30));
      open--;
      return 'allow';
    },
    getSettings: () => ({ marker: M }),
  });
  await Promise.all(['a', 'b', 'c'].map((t) => svc.decidePrompt({ site, text: `${t} WALLED_SENSITIVE`, layer: 'dom' })));
  assert.equal(maxOpen, 1);
});

test('decisions: clean files pass without asking; errors ask (fail closed)', async () => {
  const { svc, asked } = makeService(['deny']);
  assert.equal(await svc.decideFiles({ site, source: 'file picker', results: [{ name: 'a.txt', status: 'clean', sha256: '1' }] }), 'allow');
  assert.equal(asked.length, 0);
  assert.equal(await svc.decideFiles({ site, source: 'file picker', results: [{ name: 'b.pdf', status: 'error', error: 'encrypted', sha256: '2' }] }), 'deny');
  assert.equal(asked.length, 1);
});

test('dialog text: says prompt vs file and names the prompt or file', () => {
  const p = buildDialogContent({ kind: 'prompt', siteName: 'Perplexity', prompt: 'my WALLED_SENSITIVE prompt‮', marker: M });
  assert.match(p.message, /text prompt/);
  assert.match(p.detail, /my WALLED_SENSITIVE prompt/);
  assert.doesNotMatch(p.detail, /‮/, 'bidi override characters are stripped');

  const f = buildDialogContent({
    kind: 'file',
    siteName: 'ChatGPT',
    source: 'drag and drop',
    files: [
      { name: 'memo.pdf', size: 2048, status: 'sensitive', location: 'page 2 text' },
      { name: 'ok.txt', size: 10, status: 'clean' },
    ],
  });
  assert.match(f.message, /in a file/);
  assert.match(f.detail, /memo\.pdf \(2\.0 KB\): marker found in page 2 text/);
  assert.match(f.detail, /1 other file in this upload is clean/);

  const long = buildDialogContent({ kind: 'prompt', siteName: 'X', prompt: 'a'.repeat(5000), marker: M });
  assert.ok(long.detail.length < 1000, 'long prompts are truncated');
});
