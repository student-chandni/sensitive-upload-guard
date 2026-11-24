'use strict';

const { findMarkerInText } = require('./marker');

// Pull text strings out of a request body (json / form / multipart / plain).

function collectJsonStrings(value, out, depth = 0) {
  if (depth > 40 || out.length > 5000) return;
  if (typeof value === 'string') {
    out.push(value);
    // Some APIs double-encode JSON inside a string field.
    if (value.length > 1 && (value[0] === '{' || value[0] === '[')) {
      try {
        collectJsonStrings(JSON.parse(value), out, depth + 1);
      } catch {
        /* not JSON */
      }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectJsonStrings(v, out, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectJsonStrings(v, out, depth + 1);
  }
}

function tryJson(text) {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    const out = [];
    collectJsonStrings(JSON.parse(t), out);
    return out;
  } catch {
    return null;
  }
}

function tryUrlEncoded(text) {
  if (!/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(text.trim())) return null;
  const out = [];
  for (const [, v] of new URLSearchParams(text)) {
    out.push(v);
    const nested = tryJson(v);
    if (nested) out.push(...nested);
  }
  return out;
}

function tryMultipart(text, contentType = '') {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
  if (!m) return null;
  const parts = text.split(`--${m[2]}`);
  const out = [];
  for (const part of parts) {
    const idx = part.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    const body = part.slice(idx + 4).replace(/\r\n$/, '');
    out.push(body);
    const nested = tryJson(body);
    if (nested) out.push(...nested);
  }
  return out;
}

function decodeRequestBody(request) {
  let raw = '';
  if (Array.isArray(request.postDataEntries) && request.postDataEntries.length) {
    raw = Buffer.concat(request.postDataEntries.map((e) => Buffer.from(e.bytes || '', 'base64'))).toString('utf8');
  } else if (typeof request.postData === 'string') {
    raw = request.postData;
  }
  const headers = request.headers || {};
  const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  const strings = tryJson(raw) || tryMultipart(raw, contentType) || tryUrlEncoded(raw) || [raw];
  return { raw, strings };
}

// returns the longest matching string, used as the prompt in the dialog
function findMarkerInBody(request, marker) {
  const { raw, strings } = decodeRequestBody(request);
  const hits = strings.filter((s) => findMarkerInText(s, marker).found);
  if (hits.length) return { found: true, text: hits.sort((a, b) => b.length - a.length)[0], strings };
  // e.g. \u-escaped json
  let unescaped = raw;
  try {
    unescaped = JSON.parse(`"${raw.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
  } catch {
    /* keep raw */
  }
  if (findMarkerInText(raw, marker).found || findMarkerInText(unescaped, marker).found) return { found: true, text: raw, strings };
  return { found: false, strings };
}

module.exports = { decodeRequestBody, findMarkerInBody };
