'use strict';

const { findMarkerInText, findMarkerInBytes } = require('./marker');

function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  // UTF-16 without a BOM: many NUL bytes in odd (LE) or even (BE) positions.
  let oddZeros = 0;
  let evenZeros = 0;
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) (i % 2 ? oddZeros++ : evenZeros++);
  if (oddZeros > n * 0.3) return buf.toString('utf16le');
  if (evenZeros > n * 0.3) {
    const swapped = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const utf8 = buf.toString('utf8');
  // lots of U+FFFD -> probably latin1
  const bad = (utf8.match(/�/g) || []).length;
  return bad > utf8.length * 0.01 ? buf.toString('latin1') : utf8;
}

async function inspectText(buffer, { marker }) {
  const text = decodeText(buffer);
  const hit = findMarkerInText(text, marker);
  if (hit.found) return { found: true, location: `line ${text.slice(0, hit.index).split('\n').length}`, method: 'text' };
  // just in case
  if (findMarkerInBytes(buffer, marker)) return { found: true, location: 'raw bytes', method: 'bytes' };
  return { found: false, method: 'text' };
}

module.exports = { inspectText, decodeText };
