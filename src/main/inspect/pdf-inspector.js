'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { findMarkerInText, findMarkerInBytes } = require('./marker');
const { ocrImageObject } = require('./image-inspector');

// byte scan -> metadata + text layer + annotations -> OCR of pages with images

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

function standardFontDataUrl() {
  const dir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts');
  return pathToFileURL(dir + path.sep).href;
}

async function pageHasImages(page, OPS) {
  const ops = await page.getOperatorList();
  return ops.fnArray.some((fn) => fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject);
}

async function renderPage(page) {
  const { createCanvas } = require('@napi-rs/canvas');
  const base = page.getViewport({ scale: 1 });
  // About 200 DPI for a Letter/A4 page, capped so huge pages stay manageable.
  const scale = Math.min(2.8, 2400 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function inspectPdf(buffer, { marker, ocrEnabled = true, maxOcrPages = 10 }) {
  if (findMarkerInBytes(buffer, marker)) return { found: true, location: 'PDF raw content', method: 'bytes' };

  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: 0,
  });
  const doc = await loadingTask.promise;

  try {
    const meta = await doc.getMetadata().catch(() => null);
    if (meta) {
      const metaText = [JSON.stringify(meta.info || {}), meta.metadata ? JSON.stringify([...meta.metadata]) : ''].join(' ');
      if (findMarkerInText(metaText, marker).found) return { found: true, location: 'PDF metadata', method: 'text' };
    }

    const imagePages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // Items on one line can be split mid-word, so test both joined and space-separated text.
      const joined = content.items.map((it) => it.str || '').join('');
      const spaced = content.items.map((it) => it.str || '').join(' ');
      if (findMarkerInText(joined, marker).found || findMarkerInText(spaced, marker).found) {
        return { found: true, location: `page ${n} text`, method: 'text' };
      }
      const annots = await page.getAnnotations().catch(() => []);
      const annotText = annots.map((a) => [a.contentsObj?.str, a.fieldValue, a.alternativeText, a.title].filter(Boolean).join(' ')).join(' ');
      if (findMarkerInText(annotText, marker).found) return { found: true, location: `page ${n} annotations/forms`, method: 'text' };

      if (ocrEnabled && imagePages.length < maxOcrPages && (await pageHasImages(page, pdfjs.OPS))) imagePages.push(n);
    }

    for (const n of imagePages) {
      const page = await doc.getPage(n);
      const canvas = await renderPage(page);
      const res = await ocrImageObject(canvas, marker);
      if (res.found) return { found: true, location: `page ${n} image (OCR)`, method: 'ocr' };
    }
    return { found: false, method: imagePages.length ? 'text+ocr' : 'text', pages: doc.numPages };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

module.exports = { inspectPdf };
