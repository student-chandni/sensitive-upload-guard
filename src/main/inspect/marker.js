'use strict';

// Prompts / text layers: exact match after NFKC, case-folding and stripping zero-width chars.
// OCR output: letters only, confusion map, edit distance <= 1.

const DEFAULT_MARKER = 'WALLED_SENSITIVE';

// zero-width / bidi chars
const INVISIBLE_RE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .toUpperCase();
}

function findMarkerInText(text, marker = DEFAULT_MARKER) {
  if (!text) return { found: false, index: -1 };
  const hay = normalizeText(text);
  const needle = normalizeText(marker);
  const index = hay.indexOf(needle);
  return { found: index !== -1, index };
}

function hasMarker(text, marker = DEFAULT_MARKER) {
  return findMarkerInText(text, marker).found;
}

// common OCR confusions
const OCR_CONFUSIONS = { '0': 'O', '1': 'I', '|': 'I', '!': 'I', '5': 'S', '$': 'S', '3': 'E', '8': 'B', '7': 'T', '4': 'A' };

function lettersOnly(text) {
  let out = '';
  for (const ch of normalizeText(text)) {
    const mapped = OCR_CONFUSIONS[ch] || ch;
    if (mapped >= 'A' && mapped <= 'Z') out += mapped;
  }
  return out;
}

function boundedEditDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// 1 edit after mapping. 2 starts matching things like "WALLET SENSITIVITY".
function findMarkerInOcrText(text, marker = DEFAULT_MARKER, maxEdits = 1) {
  if (findMarkerInText(text, marker).found) return { found: true, exact: true, distance: 0 };
  const hay = lettersOnly(text);
  const needle = lettersOnly(marker);
  if (!needle || hay.length < needle.length - maxEdits) return { found: false, exact: false, distance: Infinity };
  let best = Infinity;
  for (let len = needle.length - maxEdits; len <= needle.length + maxEdits; len++) {
    if (len <= 0) continue;
    for (let i = 0; i + len <= hay.length; i++) {
      const d = boundedEditDistance(hay.slice(i, i + len), needle, maxEdits);
      if (d < best) best = d;
      if (best === 0) return { found: true, exact: false, distance: 0 };
    }
  }
  return { found: best <= maxEdits, exact: false, distance: best };
}

// utf8 + utf16le/be
function findMarkerInBytes(buf, marker = DEFAULT_MARKER) {
  if (!buf || !buf.length) return false;
  const variants = [marker, marker.toLowerCase()];
  for (const v of variants) {
    if (buf.indexOf(Buffer.from(v, 'utf8')) !== -1) return true;
    if (buf.indexOf(Buffer.from(v, 'utf16le')) !== -1) return true;
    const be = Buffer.from(v, 'utf16le');
    be.swap16();
    if (buf.indexOf(be) !== -1) return true;
  }
  return false;
}

module.exports = {
  DEFAULT_MARKER,
  normalizeText,
  findMarkerInText,
  hasMarker,
  findMarkerInOcrText,
  findMarkerInBytes,
  boundedEditDistance,
  lettersOnly,
};
