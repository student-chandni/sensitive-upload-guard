'use strict';

const path = require('path');

// 'pdf' | 'image' | 'text' | 'unsupported'. Magic bytes first, mime/ext only as fallback.

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.ico']);
const TEXT_EXTS = new Set([
  '.txt', '.text', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.conf',
  '.log', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.sql', '.r', '.swift', '.scala', '.lua', '.pl', '.tex',
  '.rtf', '.env', '.toml', '.properties', '.srt', '.vtt',
]);

function startsWith(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}

function sniffMagic(buf) {
  if (!buf || buf.length < 4) return null;
  // %PDF can be anywhere in the first 1KB
  if (buf.subarray(0, 1024).indexOf('%PDF-') !== -1) return 'pdf';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return 'image'; // PNG
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image'; // JPEG
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return 'image'; // GIF
  if (startsWith(buf, [0x42, 0x4d])) return 'image'; // BMP
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) return 'image'; // TIFF
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'image'; // WEBP
  if (startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4) && /^(avif|avis|heic|heix|mif1)/.test(buf.toString('latin1', 8, 12))) return 'image';
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00])) return 'image'; // ICO
  return null;
}

function looksLikeText(buf) {
  if (!buf.length) return true;
  if (startsWith(buf, [0xef, 0xbb, 0xbf]) || startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff])) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let control = 0;
  let zeros = 0;
  const zerosAt = [0, 0];
  sample.forEach((b, i) => {
    if (b === 0) {
      zeros++;
      zerosAt[i % 2]++;
    } else if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  });
  // UTF-16 without a BOM: zeros in almost every other byte, and only at one parity.
  const half = sample.length / 2;
  if (sample.length >= 8 && Math.max(...zerosAt) > half * 0.6 && Math.min(...zerosAt) < half * 0.05) return true;
  if (zeros > 0) return false;
  return control / sample.length < 0.02;
}

function detectFileKind({ buffer, name = '', mimeType = '' }) {
  const magic = sniffMagic(buffer);
  if (magic) return magic;
  const ext = path.extname(name).toLowerCase();
  const mime = String(mimeType).toLowerCase();
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf'; // probably damaged, pdf inspector reports it
  if (mime.startsWith('image/') || IMAGE_EXTS.has(ext)) {
    if (mime === 'image/svg+xml' || ext === '.svg') return 'text';
    return 'image';
  }
  if (mime.startsWith('text/') || TEXT_EXTS.has(ext) || /json|xml|javascript|csv|yaml/.test(mime) || ext === '.svg') return 'text';
  if (looksLikeText(buffer)) return 'text';
  return 'unsupported';
}

module.exports = { detectFileKind, sniffMagic, looksLikeText };
