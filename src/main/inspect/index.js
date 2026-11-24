'use strict';

const crypto = require('crypto');
const { detectFileKind } = require('./file-type');
const { inspectText } = require('./text-inspector');
const { inspectPdf } = require('./pdf-inspector');
const { inspectImage } = require('./image-inspector');
const { findMarkerInBytes, DEFAULT_MARKER } = require('./marker');

// status: clean | sensitive | error (supported type but unreadable, settings decide)
async function inspectFile({ buffer, name, mimeType }, opts = {}) {
  const t0 = Date.now();
  const marker = opts.marker || DEFAULT_MARKER;
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const kind = detectFileKind({ buffer, name, mimeType });
  const base = { kind, sha256, size: buffer.length };

  try {
    let res;
    if (kind === 'text') res = await inspectText(buffer, { marker });
    else if (kind === 'pdf') res = await inspectPdf(buffer, { marker, ocrEnabled: opts.ocrEnabled !== false, maxOcrPages: opts.maxOcrPages });
    else if (kind === 'image') res = await inspectImage(buffer, { marker, ocrEnabled: opts.ocrEnabled !== false });
    else {
      // not a required format, raw scan only
      res = findMarkerInBytes(buffer, marker) ? { found: true, location: 'raw bytes', method: 'bytes' } : { found: false, method: 'bytes' };
    }
    return { ...base, status: res.found ? 'sensitive' : 'clean', location: res.location, method: res.method, ms: Date.now() - t0 };
  } catch (err) {
    const msg = /password/i.test(err?.name || err?.message || '') ? 'file is password-protected' : String(err?.message || err);
    return { ...base, status: 'error', error: msg, ms: Date.now() - t0 };
  }
}

module.exports = { inspectFile };
