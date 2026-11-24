'use strict';

const { findMarkerInOcrText, findMarkerInBytes } = require('./marker');
const ocr = require('./ocr');

// byte scan, then OCR (normal, then inverted for dark mode screenshots)

const MAX_SIDE = 4000; // OCR gets slow on huge images
const MIN_SIDE = 1000; // upscale small text

async function decodeImage(buffer) {
  const { loadImage } = require('@napi-rs/canvas');
  return loadImage(buffer);
}

function render(img, { invert }) {
  const { createCanvas } = require('@napi-rs/canvas');
  const longest = Math.max(img.width, img.height);
  let scale = 1;
  if (longest > MAX_SIDE) scale = MAX_SIDE / longest;
  else if (longest < MIN_SIDE) scale = Math.min(3, MIN_SIDE / longest);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    let g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (invert) g = 255 - g;
    px[i] = px[i + 1] = px[i + 2] = g;
    px[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toBuffer('image/png');
}

function isMostlyDark(img) {
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 64, 64);
  ctx.drawImage(img, 0, 0, 64, 64);
  const px = ctx.getImageData(0, 0, 64, 64).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  return sum / (px.length / 4) < 110;
}

async function ocrImageObject(img, marker) {
  const darkFirst = isMostlyDark(img);
  const passes = darkFirst ? [true, false] : [false, true];
  for (const invert of passes) {
    const text = await ocr.recognize(render(img, { invert }));
    const hit = findMarkerInOcrText(text, marker);
    if (hit.found) return { found: true, text, exact: hit.exact };
  }
  return { found: false };
}

async function inspectImage(buffer, { marker, ocrEnabled = true }) {
  if (findMarkerInBytes(buffer, marker)) return { found: true, location: 'image metadata', method: 'bytes' };
  if (!ocrEnabled) return { found: false, method: 'none', note: 'OCR disabled' };
  const img = await decodeImage(buffer); // throws on bad data
  const res = await ocrImageObject(img, marker);
  return res.found
    ? { found: true, location: res.exact ? 'image text (OCR)' : 'image text (OCR, approximate match)', method: 'ocr' }
    : { found: false, method: 'ocr' };
}

module.exports = { inspectImage, ocrImageObject, render };
